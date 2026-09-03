import { Webhook } from "svix";
import * as store from "../lib/tablespaceStore.js";
import { clerkEventToUser } from "../lib/clerkEvent.js";
import { sendWelcomeEmail } from "../lib/email.js";

// POST /webhooks/clerk - Clerk (via Svix) calls this on user lifecycle
// events so our own tablespace_users mirror stays in sync. Clerk remains
// the identity/auth source of truth; this table only carries app-specific
// data (email for display, org, role) and is what project ownership keys
// off (tablespace_projects.owner_user_id).
//
// Mounted in index.js BEFORE express.json(), with express.raw(): Svix
// signs the exact bytes, so the signature only verifies against the
// unparsed body. Deliberately outside the /api chain - no x-api-key, no
// requireAuth: the Svix signature IS the authentication.
//
// A bad signature / missing config -> 4xx so Clerk's dashboard shows a
// clear "rejected". A transient DB failure -> 5xx so Clerk retries.
export async function clerkWebhookHandler(req, res) {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    // eslint-disable-next-line no-console
    console.error("[clerk-webhook] CLERK_WEBHOOK_SECRET is not set - rejecting.");
    res.status(500).json({ error: "Webhook not configured." });
    return;
  }

  let evt;
  try {
    const payload = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body || "");
    // svix >= 2 verify() only asserts (throws on a bad signature) and
    // returns nothing - it does NOT parse the body for us, so parse it
    // ourselves once the signature has checked out.
    new Webhook(secret).verify(payload, {
      "svix-id": req.get("svix-id") || "",
      "svix-timestamp": req.get("svix-timestamp") || "",
      "svix-signature": req.get("svix-signature") || "",
    });
    evt = JSON.parse(payload);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[clerk-webhook] signature verification failed:", err.message);
    res.status(400).json({ error: "Invalid signature." });
    return;
  }

  try {
    switch (evt.type) {
      case "user.created":
      case "user.updated": {
        const u = clerkEventToUser(evt);
        if (!u.clerkUserId) {
          res.status(400).json({ error: "Event is missing a user id." });
          return;
        }
        const saved = await store.upsertUser(u);
        // Welcome email only on a genuinely new row (saved.isNew guards
        // against Clerk retries and the ensureUser fast-path). Fire and
        // forget - it must never fail the webhook. No-op unless
        // RESEND_API_KEY is configured.
        if (evt.type === "user.created" && saved?.isNew && u.email) {
          sendWelcomeEmail({ to: u.email, name: u.firstName }).catch((err) => {
            // eslint-disable-next-line no-console
            console.error("[clerk-webhook] welcome email failed:", err.message);
          });
        }
        break;
      }
      case "user.deleted": {
        // A hard-delete event may carry nothing beyond the id.
        const id = evt.data && evt.data.id;
        if (id) await store.deleteUser(id);
        break;
      }
      default:
        // Ack any event type we haven't subscribed to so Clerk stops
        // retrying it.
        break;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[clerk-webhook] handling ${evt?.type} failed:`, err.stack || err.message);
    res.status(500).json({ error: "Failed to process event." });
    return;
  }

  res.json({ received: true });
}
