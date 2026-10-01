import { test } from "node:test";
import assert from "node:assert/strict";
import { typeOfField } from "./pgTypes.js";

test("typeOfField names common types and falls back to unknown", () => {
  assert.equal(typeOfField({ dataTypeID: 1700 }), "numeric");
  assert.equal(typeOfField({ dataTypeID: 1184 }), "timestamptz");
  assert.equal(typeOfField({ dataTypeID: 99999 }), "unknown");
  assert.equal(typeOfField(undefined), "unknown");
});
