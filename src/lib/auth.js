import { clerkMiddleware, getAuth } from "@clerk/express";

// Local end-to-end testing only: with DEV_AUTH_USER set (and never in
// production) every request is that user and Clerk is skipped entirely.
const DEV_USER = process.env.NODE_ENV !== "production" ? process.env.DEV_AUTH_USER || null : null;

export const devAuthUser = DEV_USER;

export function authMiddleware() {
  return DEV_USER ? (req, res, next) => next() : clerkMiddleware();
}

export function userIdOf(req) {
  return DEV_USER ?? getAuth(req).userId;
}
