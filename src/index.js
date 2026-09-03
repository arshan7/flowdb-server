import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { clerkMiddleware, requireAuth } from "@clerk/express";
import { introspectRouter } from "./routes/introspect.js";
import { tablespaceRouter } from "./routes/tablespace.js";
import { clerkWebhookHandler } from "./routes/clerkWebhook.js";
import { requireApiKey } from "./middleware/apiKey.js";
import { startSyncScheduler } from "./lib/syncScheduler.js";
import { startQueryCacheSweeper } from "./lib/queryCache.js";
import { pool } from "./lib/db.js";

// A rejected promise with no handler is almost always a specific request
// that failed to clean up - log it (previously this could take the whole
// process down on Node >=15 with no line saying why) but keep serving.
process.on("unhandledRejection", (reason) => {
  // eslint-disable-next-line no-console
  console.error("[server] unhandled rejection:", reason instanceof Error ? reason.stack : reason);
});
// An uncaught exception means the process is in an unknown state (Node's
// own guidance) - log it and exit non-zero so Render restarts a clean one,
// rather than limping on.
process.on("uncaughtException", (err) => {
  // eslint-disable-next-line no-console
  console.error("[server] uncaught exception, exiting:", err.stack || err.message);
  process.exit(1);
});

const app = express();

// Behind Render's proxy - trust one hop so express-rate-limit keys on the
// real client IP (X-Forwarded-For) rather than the proxy's.
app.set("trust proxy", 1);

// This is a JSON API, not an HTML app: helmet's defaults minus the
// content/frame policies that only matter for a page. Mainly this sets
// nosniff, no-referrer, HSTS, and drops X-Powered-By.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
);

// Clerk -> our DB user sync. Registered BEFORE express.json(): Svix signs
// the exact request bytes, so verification needs the raw, unparsed body.
// Deliberately outside the /api chain - no x-api-key, no requireAuth; the
// Svix signature is the authentication (see routes/clerkWebhook.js).
app.post("/webhooks/clerk", express.raw({ type: "*/*", limit: "1mb" }), clerkWebhookHandler);

app.use(express.json({ limit: "1mb" }));

// A broad ceiling on every route, and a much tighter one on /introspect -
// it opens an outbound connection to an attacker-chosen host, so it's the
// path worth throttling hardest if the shared key ever leaks.
const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests, slow down." },
});
const introspectLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many introspection requests, slow down." },
});

// ALLOWED_ORIGIN should be the deployed frontend's exact origin in production
// (e.g. https://your-app.vercel.app) - defaulting to "*" only so local dev
// against a not-yet-configured server doesn't stall on a CORS error before
// there's even an origin to lock it to.
//
// PATCH/PUT/DELETE added alongside the original GET/POST for the new
// tablespaceRouter below (project rename/favorite, diagram save, checkpoint
// delete) - introspect.js only ever needed GET/POST.
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN || "*",
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
    // Authorization carries the Clerk session token the frontend now sends
    // on every call alongside the existing x-api-key.
    allowedHeaders: ["Content-Type", "x-api-key", "Authorization"],
  }),
);

// Unauthenticated on purpose - Render (and any uptime monitor) needs to reach
// this without a secret, and it reveals nothing about the service beyond
// "it's running". Kept above clerkMiddleware so it never depends on Clerk
// being configured.
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Populates req.auth for every route below from the Clerk session token
// (reads CLERK_SECRET_KEY from the environment). Does not itself reject
// anonymous requests - requireAuth() on the routers does that.
app.use(clerkMiddleware());

app.use("/api", apiLimiter);
app.use("/api/introspect", introspectLimiter);
// Two gates, in order: the shared x-api-key (a coarse origin filter that
// predates auth) then a valid Clerk session (per-user identity).
app.use("/api", requireApiKey, requireAuth(), introspectRouter);
app.use("/api", requireApiKey, requireAuth(), tablespaceRouter);

app.use((req, res) => {
  res.status(404).json({ error: "Not found." });
});

// App-level backstop: tablespaceRouter has its own error handler, but
// anything that reaches Express without one (introspectRouter, a future
// route that forgets `wrap`) lands here as a generic 500 - never a stack
// trace to the client.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error("[server] request failed:", err.stack || err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: "Internal server error." });
});

const port = process.env.PORT || 4000;
const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`flowdb-server listening on port ${port}`);
});

startSyncScheduler();
startQueryCacheSweeper();

// Render (and most PaaS) send SIGTERM on deploy/scale-down and then
// SIGKILL after a grace period. Stop taking new connections, let in-flight
// requests finish, and close the DB pool so nothing is left half-open.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] ${signal} received, shutting down`);
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
    // Don't hang forever if a connection won't drain.
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
