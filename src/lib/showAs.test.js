import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanShowAs, showAsExpr } from "./showAs.js";
import { compileQuery } from "./queryEngine.js";

const month = { sql: "DATE_TRUNC('month', \"o\".\"at\")", time: true };
const status = { sql: '"o"."status"', time: false };

test("cleanShowAs keeps known modes for the report's own measures", () => {
  assert.deepEqual(cleanShowAs({ m1: "percent", m2: "bogus", x: "running" }, ["m1", "m2"]), { m1: "percent" });
  assert.deepEqual(cleanShowAs("nope", ["m1"]), {});
});

test("percent of total divides by the sum over every row", () => {
  assert.equal(showAsExpr("COUNT(*)", "percent", []), "((COUNT(*))::float8 / NULLIF(SUM(COUNT(*)) OVER (), 0))");
});

test("running total and change go down the date group, restarting per other group", () => {
  const run = showAsExpr("SUM(x)", "running", [status, month]);
  assert.match(run, /PARTITION BY "o"."status" ORDER BY DATE_TRUNC\('month'/);
  assert.match(run, /ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW\)$/);
  assert.match(showAsExpr("SUM(x)", "change", [month]), /^\(\(SUM\(x\)\) - LAG\(SUM\(x\)\) OVER \(ORDER BY/);
  assert.match(showAsExpr("SUM(x)", "percentChange", [month]), /NULLIF\(LAG/);
});

test("running total without a group is refused", () => {
  assert.throws(() => showAsExpr("SUM(x)", "running", []), /grouped/);
});

test("compileQuery applies showAs to the named measure only", () => {
  const { sql } = compileQuery({
    tableName: "orders",
    measures: [
      { id: "n", aggregation: "count" },
      { id: "s", aggregation: "sum", columnName: "total" },
    ],
    dimensions: [{ id: "st", tableName: "orders", columnName: "status" }],
    showAs: { n: "percent" },
  });
  assert.match(sql, /SUM\(COUNT\(\*\)\) OVER \(\), 0\)\) AS "n"/);
  assert.doesNotMatch(sql, /OVER[^,]*AS "s"/);
});
