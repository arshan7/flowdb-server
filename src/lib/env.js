// Centralized, fail-fast environment validation. Individual modules
// (db.js, crypto.js, apiKey.js, clerkWebhook.js) each already guard their
// own required var at the point of use, but that means a deploy missing
// one of them "succeeds" and only breaks the first time a request hits
// that specific path - this runs once at boot, before anything else, so
// a misconfigured deploy crash-loops immediately with one clear message
// naming every missing var, instead of surfacing as a scattered pile of
// unrelated-looking 500s later.
const REQUIRED = [
  "DATABASE_URL",
  "API_KEY",
  "CONNECTION_ENCRYPTION_KEY",
  "CLERK_SECRET_KEY",
  "CLERK_PUBLISHABLE_KEY",
  "CLERK_WEBHOOK_SECRET",
];

export function assertRequiredEnv() {
  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    // Uses console.error directly, not the shared logger - this check must
    // run and fail before anything else in the app (including the logger's
    // own setup) is trusted to work.
    // eslint-disable-next-line no-console
    console.error(
      `[env] Missing required environment variable(s): ${missing.join(", ")}. See .env.example.`,
    );
    process.exit(1);
  }
}
