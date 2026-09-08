import * as Sentry from "@sentry/node";

// Entirely optional, same pattern email.js already uses for RESEND_API_KEY:
// with no DSN set, this is a no-op and every report() call just falls
// through to the existing console.error - nothing else changes. Set
// SENTRY_DSN to turn it on; see .env.example.
const DSN = process.env.SENTRY_DSN;
let initialized = false;

export function initErrorReporting() {
  if (!DSN || initialized) return;
  Sentry.init({
    dsn: DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 0,
  });
  initialized = true;
}

export function reportError(error) {
  if (initialized) Sentry.captureException(error);
}

export const errorReportingInitialized = () => initialized;
