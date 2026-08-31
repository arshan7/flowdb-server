import { test } from "node:test";
import assert from "node:assert/strict";
import { compileQuery, resolveNativeVars, quoteTable, compileFilterCondition } from "./queryEngine.js";

// Slice 1 (reporting parity) - date bucketing, sort, row limit, and the
// distinct/median aggregations. compileQuery takes an already-resolved
// spec (real table/column names, ids as aliases) - the route's job is to
// produce that; these tests only cover the SQL it emits from one.

const dim = (id, columnName, extra = {}) => ({ id, tableName: "orders", columnName, ...extra });
const measure = (id, aggregation, columnName = null) => ({ id, aggregation, columnName });

test("raw dimension - no bucket, grouped on the plain column", () => {
  const { sql } = compileQuery({
    tableName: "orders",
    dimensions: [dim("d1", "status")],
    measures: [measure("m1", "count")],
  });
  assert.match(sql, /"orders"\."status" AS "d1"/);
  assert.match(sql, /GROUP BY "orders"\."status"/);
  assert.doesNotMatch(sql, /DATE_TRUNC/);
});

test("month bucket - DATE_TRUNC in both SELECT and GROUP BY, same expression", () => {
  const { sql } = compileQuery({
    tableName: "orders",
    dimensions: [dim("d1", "created_at", { bucket: "month" })],
    measures: [measure("m1", "count")],
  });
  assert.match(sql, /DATE_TRUNC\('month', "orders"\."created_at"\) AS "d1"/);
  assert.match(sql, /GROUP BY DATE_TRUNC\('month', "orders"\."created_at"\)/);
});

test("unknown bucket unit throws (no such thing reaches the SQL string)", () => {
  assert.throws(
    () =>
      compileQuery({
        tableName: "orders",
        dimensions: [dim("d1", "created_at", { bucket: "fortnight" })],
        measures: [measure("m1", "count")],
      }),
    /Unsupported time grouping/,
  );
});

test("orderBy - emits ORDER BY on the alias, before LIMIT, direction from the fixed map", () => {
  const { sql } = compileQuery({
    tableName: "orders",
    dimensions: [dim("d1", "status")],
    measures: [measure("m1", "count")],
    orderBy: { field: "m1", direction: "desc" },
  });
  assert.match(sql, /ORDER BY "m1" DESC LIMIT/);
});

test("orderBy - an unrecognized direction falls back to ASC rather than injecting", () => {
  const { sql } = compileQuery({
    tableName: "orders",
    dimensions: [dim("d1", "status")],
    measures: [measure("m1", "count")],
    orderBy: { field: "d1", direction: "sideways; DROP TABLE" },
  });
  assert.match(sql, /ORDER BY "d1" ASC LIMIT/);
});

test("rowLimit - clamps the LIMIT window and is reported back as windowSize", () => {
  const { sql, params, windowSize } = compileQuery({
    tableName: "orders",
    dimensions: [dim("d1", "status")],
    measures: [measure("m1", "count")],
    pageSize: 100,
    rowLimit: 12,
  });
  assert.equal(windowSize, 12);
  // LIMIT is the last-pushed-but-one param (LIMIT $n, OFFSET $n+1); the
  // lookahead makes it windowSize + 1.
  assert.equal(params[params.length - 2], 13);
  assert.match(sql, /LIMIT \$\d+ OFFSET \$\d+$/);
});

test("rowLimit - a later page can't reach past the cap (windowSize floors at 0)", () => {
  const { windowSize } = compileQuery({
    tableName: "orders",
    dimensions: [dim("d1", "status")],
    measures: [measure("m1", "count")],
    pageSize: 100,
    offset: 12,
    rowLimit: 12,
  });
  assert.equal(windowSize, 0);
});

test("distinct aggregation - COUNT(DISTINCT col)", () => {
  const { sql } = compileQuery({
    tableName: "orders",
    dimensions: [dim("d1", "status")],
    measures: [measure("m1", "distinct", "customer_id")],
  });
  assert.match(sql, /COUNT\(DISTINCT "orders"\."customer_id"\) AS "m1"/);
});

test("median aggregation - PERCENTILE_CONT(0.5) WITHIN GROUP", () => {
  const { sql } = compileQuery({
    tableName: "orders",
    dimensions: [dim("d1", "status")],
    measures: [measure("m1", "median", "total")],
  });
  assert.match(sql, /PERCENTILE_CONT\(0\.5\) WITHIN GROUP \(ORDER BY "orders"\."total"\) AS "m1"/);
});

// --- Slice 4: native SQL variable binding ---

test("resolveNativeVars - each {{name}} becomes a positional param, value pulled from the map", () => {
  const { sql, params } = resolveNativeVars("SELECT * FROM orders WHERE status = {{status}}", { status: "paid" });
  assert.equal(sql, "SELECT * FROM orders WHERE status = $1");
  assert.deepEqual(params, ["paid"]);
});

test("resolveNativeVars - a repeated name reuses the same param index", () => {
  const { sql, params } = resolveNativeVars("SELECT {{x}} , {{x}} + 1 , {{y}}", { x: 10, y: 20 });
  assert.equal(sql, "SELECT $1 , $1 + 1 , $2");
  assert.deepEqual(params, [10, 20]);
});

test("resolveNativeVars - a missing value binds NULL, never interpolates text", () => {
  const { sql, params } = resolveNativeVars("SELECT * FROM t WHERE a = {{missing}}", {});
  assert.equal(sql, "SELECT * FROM t WHERE a = $1");
  assert.deepEqual(params, [null]);
});

test("resolveNativeVars - whitespace inside the braces is tolerated", () => {
  const { sql } = resolveNativeVars("WHERE d > {{  start_date  }}", { start_date: "2026-01-01" });
  assert.equal(sql, "WHERE d > $1");
});

// Slice 2 (multi-schema sources) - a base/join table from a non-public
// schema is schema-qualified in FROM / JOIN, but column refs stay bare
// (they bind to the range-table entry the qualified FROM created).

test("quoteTable - schema prefix only for a non-public, non-empty schema", () => {
  assert.equal(quoteTable(null, "orders"), '"orders"');
  assert.equal(quoteTable("public", "orders"), '"orders"');
  assert.equal(quoteTable("shop", "orders"), '"shop"."orders"');
  assert.equal(quoteTable("we ird", 'ta"ble'), '"we ird"."ta""ble"');
});

test("tableSchema - base table is schema-qualified in FROM, columns stay bare", () => {
  const { sql } = compileQuery({
    tableName: "orders",
    tableSchema: "shop",
    dimensions: [dim("d1", "status")],
    measures: [measure("m1", "sum", "total")],
  });
  assert.match(sql, /FROM "shop"\."orders"/);
  assert.match(sql, /"orders"\."status" AS "d1"/);
  assert.match(sql, /SUM\("orders"\."total"\) AS "m1"/);
  assert.match(sql, /GROUP BY "orders"\."status"/);
});

test("tableSchema - a public base table is unchanged (no prefix)", () => {
  const { sql } = compileQuery({
    tableName: "orders",
    tableSchema: "public",
    dimensions: [dim("d1", "status")],
    measures: [measure("m1", "count")],
  });
  assert.match(sql, /FROM "orders"/);
  assert.doesNotMatch(sql, /"public"\."orders"/);
});

test("join tableSchema - JOIN target is schema-qualified, ON columns are bare", () => {
  const { sql } = compileQuery({
    tableName: "orders",
    tableSchema: "shop",
    dimensions: [dim("d1", "status")],
    measures: [measure("m1", "count")],
    joins: [
      { tableName: "customers", tableSchema: "shop", baseColumn: "customer_id", joinColumn: "id" },
    ],
  });
  assert.match(sql, /FROM "shop"\."orders" JOIN "shop"\."customers" ON "orders"\."customer_id" = "customers"\."id"/);
});

test("compileFilterCondition - isnull / notnull bind no parameter", () => {
  const p1 = [];
  assert.equal(compileFilterCondition("orders", "shipped_at", "isnull", undefined, p1), '"orders"."shipped_at" IS NULL');
  assert.equal(p1.length, 0);

  const p2 = [];
  assert.equal(compileFilterCondition("orders", "shipped_at", "notnull", undefined, p2), '"orders"."shipped_at" IS NOT NULL');
  assert.equal(p2.length, 0);
});

test("compileFilterCondition - value operators still bind $N in order", () => {
  const params = [];
  assert.equal(compileFilterCondition("orders", "status", "eq", "paid", params), '"orders"."status" = $1');
  assert.equal(compileFilterCondition("orders", "name", "contains", "ann", params), '"orders"."name" ILIKE $2');
  assert.deepEqual(params, ["paid", "%ann%"]);
});

test("compileFilterCondition - 'in' binds one stringified array, compared as text", () => {
  const params = [];
  assert.equal(
    compileFilterCondition("orders", "status", "in", ["paid", "shipped"], params),
    '"orders"."status"::text = ANY($1)',
  );
  // a bare scalar and numeric codes both normalise to a string array
  assert.equal(compileFilterCondition("bookings", "state", "in", 7, params), '"bookings"."state"::text = ANY($2)');
  assert.deepEqual(params, [["paid", "shipped"], ["7"]]);
});

test("bucket + sort + limit + distinct compose in one query", () => {
  const { sql, windowSize } = compileQuery({
    tableName: "orders",
    dimensions: [dim("d1", "created_at", { bucket: "month" })],
    measures: [measure("m1", "distinct", "customer_id")],
    orderBy: { field: "d1", direction: "asc" },
    pageSize: 50,
    rowLimit: 24,
  });
  assert.match(sql, /DATE_TRUNC\('month', "orders"\."created_at"\)/);
  assert.match(sql, /COUNT\(DISTINCT "orders"\."customer_id"\)/);
  assert.match(sql, /GROUP BY DATE_TRUNC\('month', "orders"\."created_at"\) ORDER BY "d1" ASC LIMIT/);
  assert.equal(windowSize, 24);
});
