import test from "node:test";
import assert from "node:assert/strict";
import { describeIntrospectError, describeQueryError } from "./introspectErrors.js";

test("describeIntrospectError maps connect-time codes, falls back to 'failed to connect'", () => {
  assert.match(describeIntrospectError({ code: "ENOTFOUND" }), /reach that database host/);
  assert.match(describeIntrospectError({ code: "28P01" }), /Authentication failed/);
  assert.equal(describeIntrospectError({ code: "SOMETHING_ELSE" }), "Failed to connect to that database.");
});

test("describeQueryError never says the connection failed", () => {
  for (const code of ["42883", "42P01", "22P02", "57014", "42601", "ZZZZZ"]) {
    const { error } = describeQueryError({ code, message: "boom" });
    assert.doesNotMatch(error, /connect/i, `code ${code} leaked a 'connect' message`);
  }
});

test("describeQueryError: type mismatch (42883) -> 400 + the pg detail", () => {
  const r = describeQueryError({ code: "42883", message: "operator does not exist: uuid = text" });
  assert.equal(r.status, 400);
  assert.match(r.error, /incompatible column types/);
  assert.match(r.error, /operator does not exist: uuid = text/);
});

test("describeQueryError: missing table/column (42P01) -> 409 + resync hint", () => {
  const r = describeQueryError({ code: "42703", message: 'column "foo" does not exist' });
  assert.equal(r.status, 409);
  assert.match(r.error, /Re-sync the source/);
});

test("describeQueryError: statement timeout (57014) -> 504", () => {
  assert.equal(describeQueryError({ code: "57014" }).status, 504);
});

test("describeQueryError: unknown code -> 502, generic, no crash on a missing message", () => {
  const r = describeQueryError({ code: "99999" });
  assert.equal(r.status, 502);
  assert.match(r.error, /could not run against the source database/);
});

test("describeQueryError trims and caps a huge pg message", () => {
  const { error } = describeQueryError({ code: "42883", message: "x".repeat(5000) });
  assert.ok(error.length < 400);
});
