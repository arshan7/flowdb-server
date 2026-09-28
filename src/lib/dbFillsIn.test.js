import { test } from "node:test";
import assert from "node:assert/strict";
import { dbFillsIn } from "./dbFillsIn.js";

test("dbFillsIn - the database supplies defaults, identity and integer keys", () => {
  assert.equal(dbFillsIn({ name: "created_at", notNull: true, default: "now()" }), true);
  assert.equal(dbFillsIn({ name: "id", notNull: true, default: "", autoIncrement: true }), true);
  assert.equal(dbFillsIn({ name: "id", type: "bigint", isPrimaryKey: true, default: "" }), true);
  assert.equal(dbFillsIn({ name: "code", type: "text", isPrimaryKey: true, default: "" }), false);
  assert.equal(dbFillsIn({ name: "title", type: "text", notNull: true, default: "" }), false);
});
