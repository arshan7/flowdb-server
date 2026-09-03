import { createHash, timingSafeEqual } from "node:crypto";

// Anyone who can reach this endpoint can make the server open a connection to
// an arbitrary database using credentials they supply - the endpoint itself
// is the abuse surface, not just a particular database. A shared-secret
// header is the minimum bar before this goes anywhere public: the frontend
// sends it on every request, and requests without a match are rejected
// before a connection is ever attempted.
//
// The header is compared in constant time - a plain `!==` leaks how many
// leading bytes matched via response timing, which is enough to recover a
// secret byte-by-byte over many requests. Comparing SHA-256 digests keeps
// both sides a fixed 32 bytes, so timingSafeEqual never has to branch on
// length (which would itself be a small oracle).
function safeEqual(a, b) {
  const da = createHash("sha256").update(String(a)).digest();
  const db = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(da, db);
}

export function requireApiKey(req, res, next) {
  const expected = process.env.API_KEY;
  if (!expected) {
    // Failing open (no key configured -> allow everything) would make it
    // trivially easy to forget to set API_KEY on a fresh Render deploy and
    // not notice - fail closed instead, with an error that says exactly why.
    res.status(500).json({ error: "Server misconfigured: API_KEY is not set." });
    return;
  }
  const provided = req.get("x-api-key");
  if (!provided || !safeEqual(provided, expected)) {
    res.status(401).json({ error: "Missing or invalid API key." });
    return;
  }
  next();
}
