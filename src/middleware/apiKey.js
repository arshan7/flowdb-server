// Anyone who can reach this endpoint can make the server open a connection to
// an arbitrary database using credentials they supply - the endpoint itself
// is the abuse surface, not just a particular database. A shared-secret
// header is the minimum bar before this goes anywhere public: the frontend
// sends it on every request, and requests without a match are rejected
// before a connection is ever attempted.
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
  if (provided !== expected) {
    res.status(401).json({ error: "Missing or invalid API key." });
    return;
  }
  next();
}
