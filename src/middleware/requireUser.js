import { getAuth } from "@clerk/express";

// Rejects any request without a valid Clerk session with a plain JSON 401.
//
// This is the non-deprecated replacement for @clerk/express's own
// requireAuth() - that one issues an HTML redirect to a sign-in URL, which
// is useless to the SPA's fetch() layer (and unreadable across CORS).
// clerkMiddleware() (mounted globally in index.js) has already populated
// req.auth from the token by the time this runs; we just check it.
export function requireUser(req, res, next) {
  if (!getAuth(req).userId) {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }
  next();
}
