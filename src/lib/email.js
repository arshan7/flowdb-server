import { Resend } from "resend";

// Transactional email via Resend. Entirely optional: with no RESEND_API_KEY
// set, every send is a logged no-op, so the webhook path that calls this
// still works unchanged in local dev and on any deploy that hasn't
// configured email yet.
//
// Env:
//   RESEND_API_KEY      - enables sending (from the Resend dashboard)
//   WELCOME_EMAIL_FROM  - e.g. "Tablespace <welcome@yourdomain.com>";
//                         defaults to Resend's shared test sender, which
//                         only delivers to the Resend account owner
//   APP_URL             - link target for the email's CTA; falls back to
//                         ALLOWED_ORIGIN, then localhost

const FROM_FALLBACK = "Tablespace <onboarding@resend.dev>";

let client = null;
let warnedNoKey = false;

function getClient() {
  if (client) return client;
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  client = new Resend(key);
  return client;
}

function appUrl() {
  return process.env.APP_URL || process.env.ALLOWED_ORIGIN || "http://localhost:5173";
}

// Pure - builds the message, no I/O. Unit-tested in email.test.js.
export function buildWelcomeEmail({ name, appUrl: url }) {
  const greeting = name && name.trim() ? `Hi ${name.trim()},` : "Hi,";
  const subject = "Welcome to Tablespace";
  const text = [
    greeting,
    "",
    "Thanks for creating a Tablespace account. You can now design database",
    "schemas, build semantic models, and put together reports and dashboards",
    "- all in one canvas.",
    "",
    `Open Tablespace: ${url}`,
    "",
    "If you didn't create this account, you can ignore this email.",
    "",
    "- The Tablespace team",
  ].join("\n");

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 8px;">
                <span style="display:inline-block;width:26px;height:26px;line-height:26px;text-align:center;border-radius:6px;background:#3b6cf6;color:#ffffff;font-weight:700;font-size:15px;">T</span>
                <span style="font-size:15px;font-weight:600;color:#14171f;vertical-align:middle;margin-left:8px;">Tablespace</span>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 32px 4px;">
                <h1 style="margin:0;font-size:20px;font-weight:600;color:#14171f;">Welcome to Tablespace</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 32px 0;color:#3f4552;font-size:14px;line-height:1.6;">
                <p style="margin:0 0 12px;">${greeting}</p>
                <p style="margin:0 0 12px;">Thanks for creating an account. You can now design database schemas, build semantic models, and put together reports and dashboards &mdash; all in one canvas.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 28px;">
                <a href="${url}" style="display:inline-block;background:#3b6cf6;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 20px;border-radius:6px;">Open Tablespace</a>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 24px;border-top:1px solid #eef0f3;color:#8a93a3;font-size:12px;line-height:1.6;">
                If you didn&rsquo;t create this account, you can safely ignore this email.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, html, text };
}

// Fire-and-forget from the webhook. Resolves to { sent, skipped?, error? }
// and never throws - a failed welcome email must not fail user creation.
export async function sendWelcomeEmail({ to, name } = {}) {
  if (!to) return { sent: false, skipped: "no recipient" };
  const resend = getClient();
  if (!resend) {
    if (!warnedNoKey) {
      // eslint-disable-next-line no-console
      console.log("[email] RESEND_API_KEY not set - welcome emails are disabled.");
      warnedNoKey = true;
    }
    return { sent: false, skipped: "not configured" };
  }
  const { subject, html, text } = buildWelcomeEmail({ name, appUrl: appUrl() });
  try {
    const { error } = await resend.emails.send({
      from: process.env.WELCOME_EMAIL_FROM || FROM_FALLBACK,
      to,
      subject,
      html,
      text,
    });
    if (error) {
      // eslint-disable-next-line no-console
      console.error("[email] welcome send rejected:", error.message || error);
      return { sent: false, error: error.message || String(error) };
    }
    return { sent: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[email] welcome send threw:", err.message);
    return { sent: false, error: err.message };
  }
}
