import test from "node:test";
import assert from "node:assert/strict";
import { clerkEventToUser } from "./clerkEvent.js";

test("clerkEventToUser: user.created picks the primary email + first name", () => {
  const evt = {
    type: "user.created",
    data: {
      id: "user_2abc",
      first_name: "Ada",
      primary_email_address_id: "idn_2",
      email_addresses: [
        { id: "idn_1", email_address: "old@example.com" },
        { id: "idn_2", email_address: "ada@example.com" },
      ],
    },
  };
  assert.deepEqual(clerkEventToUser(evt), {
    clerkUserId: "user_2abc",
    email: "ada@example.com",
    orgId: null,
    firstName: "Ada",
  });
});

test("clerkEventToUser: falls back to the first email when no primary id matches", () => {
  const evt = {
    type: "user.updated",
    data: {
      id: "user_9",
      primary_email_address_id: "idn_missing",
      email_addresses: [{ id: "idn_a", email_address: "grace@example.com" }],
    },
  };
  assert.equal(clerkEventToUser(evt).email, "grace@example.com");
});

test("clerkEventToUser: no email addresses -> email null, id still extracted", () => {
  const evt = { type: "user.created", data: { id: "user_x" } };
  assert.deepEqual(clerkEventToUser(evt), {
    clerkUserId: "user_x",
    email: null,
    orgId: null,
    firstName: null,
  });
});

test("clerkEventToUser: reads org id from the first organization membership", () => {
  const evt = {
    type: "user.created",
    data: {
      id: "user_o",
      email_addresses: [],
      organization_memberships: [{ organization: { id: "org_123" } }],
    },
  };
  assert.equal(clerkEventToUser(evt).orgId, "org_123");
});

test("clerkEventToUser: tolerates a missing/empty payload", () => {
  const empty = { clerkUserId: null, email: null, orgId: null, firstName: null };
  assert.deepEqual(clerkEventToUser({}), empty);
  assert.deepEqual(clerkEventToUser({ data: null }), empty);
});
