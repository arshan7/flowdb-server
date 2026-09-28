import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { previewOrderClause } from "./previewOrder.js";

const columnNames = new Set(["id", "status", "created_at"]);
const pkNames = ["id"];

describe("previewOrderClause", () => {
  it("one key, primary key breaks ties", () => {
    assert.equal(
      previewOrderClause({ orderBy: { column: "status", direction: "desc" }, columnNames, pkNames }).clause,
      ' ORDER BY "status" DESC, "id" ASC',
    );
  });
  it("several keys in order, no duplicate tie-break", () => {
    const orderBy = [
      { column: "status", direction: "asc" },
      { column: "id", direction: "desc" },
    ];
    assert.equal(previewOrderClause({ orderBy, columnNames, pkNames }).clause, ' ORDER BY "status" ASC, "id" DESC');
  });
  it("rejects unknown columns and too many keys", () => {
    assert.match(previewOrderClause({ orderBy: { column: "nope" }, columnNames, pkNames }).error, /isn't a column/);
    const four = ["id", "status", "created_at", "id"].map((column) => ({ column }));
    assert.match(previewOrderClause({ orderBy: four, columnNames, pkNames }).error, /at most 3/);
  });
  it("an explicit tie-break replaces the primary key; nothing sorts to nothing", () => {
    assert.equal(
      previewOrderClause({ orderBy: { column: "status" }, orderTiebreak: "created_at", columnNames, pkNames }).clause,
      ' ORDER BY "status" ASC, "created_at" ASC',
    );
    assert.equal(previewOrderClause({ orderBy: null, columnNames, pkNames }).clause, "");
  });
});
