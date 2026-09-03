import test from "node:test";
import assert from "node:assert/strict";
import { requireApiKey } from "./apiKey.js";

// Minimal Express req/res/next doubles.
function run({ header, apiKey }) {
  const prev = process.env.API_KEY;
  if (apiKey === undefined) delete process.env.API_KEY;
  else process.env.API_KEY = apiKey;

  const req = { get: (name) => (name.toLowerCase() === "x-api-key" ? header : undefined) };
  let status = null;
  let body = null;
  let nexted = false;
  const res = {
    status(code) {
      status = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };
  requireApiKey(req, res, () => {
    nexted = true;
  });

  if (prev === undefined) delete process.env.API_KEY;
  else process.env.API_KEY = prev;
  return { status, body, nexted };
}

test("passes through when the header matches", () => {
  const r = run({ header: "s3cret", apiKey: "s3cret" });
  assert.equal(r.nexted, true);
  assert.equal(r.status, null);
});

test("401s on a wrong key", () => {
  const r = run({ header: "wrong", apiKey: "s3cret" });
  assert.equal(r.nexted, false);
  assert.equal(r.status, 401);
});

test("401s on a missing header (no length crash)", () => {
  const r = run({ header: undefined, apiKey: "s3cret" });
  assert.equal(r.nexted, false);
  assert.equal(r.status, 401);
});

test("401s when the header is a prefix of the key (constant-time compare still rejects)", () => {
  const r = run({ header: "s3cr", apiKey: "s3cret" });
  assert.equal(r.nexted, false);
  assert.equal(r.status, 401);
});

test("500s when API_KEY is not configured (fails closed)", () => {
  const r = run({ header: "anything", apiKey: undefined });
  assert.equal(r.nexted, false);
  assert.equal(r.status, 500);
});
