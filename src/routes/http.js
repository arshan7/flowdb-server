import { userIdOf } from "../lib/auth.js";
import { describeQueryError } from "../lib/introspectErrors.js";
import { logger } from "../lib/logger.js";

// Wraps an async route handler so a rejected promise reaches Express's
// error-handling middleware below instead of becoming an unhandled
// rejection - Express 4 (this app's version) doesn't do this itself.
export const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Every route that RUNS a query against a Connected source's database
// funnels its failure here. A friendly error (raised deliberately upstream)
// keeps its own message; anything else goes through describeQueryError,
// which - unlike describeIntrospectError - never claims the connection
// failed when it was really the SQL.
export function sendQueryError(res, tag, err) {
  logger.error(`[sources] ${tag} failed`, err);
  if (err.isFriendly) {
    res.status(400).json({ error: err.message });
    return;
  }
  const { status, error } = describeQueryError(err);
  res.status(status).json({ error });
}

// The signed-in Clerk user id, guaranteed present: every /api route is
// behind requireAuth() (see index.js), so getAuth(req).userId is always a
// real "user_..." string by the time any handler here runs.
export const uid = (req) => userIdOf(req);
