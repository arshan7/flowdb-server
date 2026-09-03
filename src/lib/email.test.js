import test from "node:test";
import assert from "node:assert/strict";
import { buildWelcomeEmail, sendWelcomeEmail } from "./email.js";

test("buildWelcomeEmail: personalised greeting + CTA link", () => {
  const { subject, html, text } = buildWelcomeEmail({ name: "Ada", appUrl: "https://app.example.com" });
  assert.equal(subject, "Welcome to Tablespace");
  assert.match(html, /Hi Ada,/);
  assert.match(html, /href="https:\/\/app\.example\.com"/);
  assert.match(text, /Hi Ada,/);
  assert.match(text, /https:\/\/app\.example\.com/);
});

test("buildWelcomeEmail: falls back to a generic greeting with no name", () => {
  for (const name of [undefined, "", "   "]) {
    const { html, text } = buildWelcomeEmail({ name, appUrl: "https://x.test" });
    assert.match(html, /Hi,/);
    assert.match(text, /^Hi,/);
  }
});

test("sendWelcomeEmail: no recipient -> skipped, never throws", async () => {
  assert.deepEqual(await sendWelcomeEmail({}), { sent: false, skipped: "no recipient" });
});

test("sendWelcomeEmail: without RESEND_API_KEY -> skipped, never throws", async () => {
  const had = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    const r = await sendWelcomeEmail({ to: "someone@example.com", name: "Grace" });
    assert.equal(r.sent, false);
    assert.equal(r.skipped, "not configured");
  } finally {
    if (had !== undefined) process.env.RESEND_API_KEY = had;
  }
});
