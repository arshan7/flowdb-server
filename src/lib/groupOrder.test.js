import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groupOrderClause } from "./groupOrder.js";
import { previewWhereClause } from "./previewFilters.js";

const cols = new Map([
  ["city", "text"],
  ["total", "numeric"],
  ["placed_at", "timestamp"],
]);

describe("groupOrderClause", () => {
  it("biggest groups first by default", () => {
    assert.equal(groupOrderClause(null, "city", cols).clause, 'count(*) DESC, "city" ASC');
  });
  it("by value and by a column total", () => {
    assert.equal(
      groupOrderClause({ by: "value", direction: "desc" }, "city", cols).clause,
      '"city" DESC NULLS LAST',
    );
    assert.equal(
      groupOrderClause({ by: "agg", column: "total", fn: "sum", direction: "asc" }, "city", cols).clause,
      'sum("total") ASC NULLS LAST, count(*) DESC, "city" ASC',
    );
  });
  it("rejects unknown columns, functions and directions", () => {
    assert.ok(groupOrderClause({ by: "agg", column: "nope", fn: "sum", direction: "asc" }, "city", cols).error);
    assert.ok(groupOrderClause({ by: "agg", column: "total", fn: "drop", direction: "asc" }, "city", cols).error);
    assert.ok(groupOrderClause({ by: "value", direction: "sideways" }, "city", cols).error);
  });
});

describe("day filters on timestamp columns", () => {
  it("is any of compares by day", () => {
    const params = [];
    const wc = previewWhereClause(
      { column: "placed_at", operator: "in", value: ["2024-01-05", "2024-02-01"] },
      null,
      cols,
      "orders",
      params,
    );
    assert.equal(wc.clause, ' WHERE "orders"."placed_at"::date = ANY($1::date[])');
    assert.deepEqual(params, [["2024-01-05", "2024-02-01"]]);
  });
  it("is compares by day; text columns keep the plain compare", () => {
    const p1 = [];
    assert.equal(
      previewWhereClause({ column: "placed_at", operator: "eq", value: "2024-01-05" }, null, cols, "orders", p1).clause,
      ' WHERE "orders"."placed_at"::date = $1::date',
    );
    const p2 = [];
    assert.equal(
      previewWhereClause({ column: "city", operator: "in", value: ["2024-01-05"] }, null, cols, "orders", p2).clause,
      ' WHERE "orders"."city"::text = ANY($1)',
    );
  });
});
