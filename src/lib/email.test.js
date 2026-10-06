import test from "node:test";
import assert from "node:assert/strict";
import { buildSubscriptionEmail, buildWelcomeEmail, sendWelcomeEmail } from "./email.js";

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

test("buildAlertEmail - escapes values, caps rows, links the report", async () => {
  const { buildAlertEmail } = await import("./email.js");
  const rows = Array.from({ length: 25 }, (_, i) => ({ s: i === 0 ? "<b>x</b>" : `r${i}`, n: i }));
  const { subject, html, text } = buildAlertEmail({ reportName: "Paid orders", what: "has results", columns: [{ id: "s", label: "Status" }, { id: "n", label: "N" }], rows, reportUrl: "https://app/r/1" });
  assert.equal(subject, "Alert: Paid orders has results");
  assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;"));
  assert.ok(!html.includes("<b>x</b>"));
  assert.ok(html.includes("and 5 more rows"));
  assert.ok(text.includes("Open the report: https://app/r/1"));
});

test("subscription email: each report's first rows, failures named, link", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ n: i }));
  const e = buildSubscriptionEmail({
    dashboardName: "Sales",
    tiles: [
      { name: "Orders", columns: [{ id: "n", label: "N" }], rows },
      { name: "Broken", error: "relation does not exist" },
    ],
    dashboardUrl: "https://app/d/1",
    attached: true,
  });
  assert.equal(e.subject, "Sales - dashboard");
  assert.match(e.html, /…and 2 more rows in the attachment/);
  assert.match(e.html, /Couldn&#39;t run|Couldn't run: relation does not exist/);
  assert.match(e.text, /Open the dashboard: https:\/\/app\/d\/1/);
});
