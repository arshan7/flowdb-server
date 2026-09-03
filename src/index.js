import "dotenv/config";
import express from "express";
import cors from "cors";
import { introspectRouter } from "./routes/introspect.js";
import { tablespaceRouter } from "./routes/tablespace.js";
import { requireApiKey } from "./middleware/apiKey.js";
import { startSyncScheduler } from "./lib/syncScheduler.js";
import { startQueryCacheSweeper } from "./lib/queryCache.js";
import { pool } from "./lib/db.js";

// A rejected promise or a thrown error with no local handler would
// otherwise take the whole process down (Node >=15) with no line in the
// log saying why. Log it and keep serving - a single bad request must not
// end the server for everyone else.
process.on("unhandledRejection", (reason) => {
  // eslint-disable-next-line no-console
  console.error("[server] unhandled rejection:", reason instanceof Error ? reason.stack : reason);
});
process.on("uncaughtException", (err) => {
  // eslint-disable-next-line no-console
  console.error("[server] uncaught exception:", err.stack || err.message);
});

const app = express();

app.use(express.json({ limit: "1mb" }));

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
  }),
);

// Unauthenticated on purpose - Render (and any uptime monitor) needs to reach
// this without a secret, and it reveals nothing about the service beyond
// "it's running".
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.use("/api", requireApiKey, introspectRouter);
app.use("/api", requireApiKey, tablespaceRouter);

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
