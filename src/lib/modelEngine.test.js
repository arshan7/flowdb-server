import { test } from "node:test";
import assert from "node:assert/strict";
import { compileModel, compileModelReport } from "./modelEngine.js";

// Slice 5 - the Model compiler. compileModel takes already-resolved names
// (the route does node lookup + resolveJoins); compileModelReport wraps
// its output as a subquery and aggregates over it.

test("compileModel builder - aliased SELECT + JOIN + WHERE, no aggregation", () => {
  const { sql, params, columns } = compileModel({
    kind: "builder",
    baseTableName: "orders",
    joinClauses: [{ tableName: "customers", fromTableName: "orders", baseColumn: "customer_id", joinColumn: "id" }],
    columns: [
      { tableName: "orders", columnName: "status", alias: "status" },
      { tableName: "orders", columnName: "total", alias: "total" },
      { tableName: "customers", columnName: "name", alias: "customer" },
    ],
    filters: [{ tableName: "orders", columnName: "status", operator: "neq", value: "cancelled" }],
  });
  assert.match(sql, /^SELECT "orders"\."status" AS "status", "orders"\."total" AS "total", "customers"\."name" AS "customer" FROM "orders"/);
  assert.match(sql, /JOIN "customers" ON "orders"\."customer_id" = "customers"\."id"/);
  assert.match(sql, /WHERE "orders"\."status" <> \$1$/);
  assert.deepEqual(params, ["cancelled"]);
  assert.deepEqual(columns, ["status", "total", "customer"]);
});

test("compileModel sql - passed through, columns unknown", () => {
  const out = compileModel({ kind: "sql", sql: "SELECT a, b FROM t WHERE a = $1", params: [7] });
  assert.equal(out.sql, "SELECT a, b FROM t WHERE a = $1");
  assert.deepEqual(out.params, [7]);
  assert.equal(out.columns, null);
});

test("compileModel builder - no columns throws", () => {
  assert.throws(() => compileModel({ kind: "builder", baseTableName: "orders", columns: [] }), /at least one column/);
});

test("compileModelReport - subquery FROM, _tsm refs, modelParams ordered first", () => {
  const { sql, params } = compileModelReport({
    modelSql: 'SELECT status, total FROM "orders" WHERE status <> $1',
    modelParams: ["cancelled"],
    dimensions: [{ id: "d1", column: "status" }],
    measures: [{ id: "m1", aggregation: "sum", column: "total" }],
    pageSize: 50,
  });
  assert.match(sql, /FROM \(SELECT status, total FROM "orders" WHERE status <> \$1\) AS "_tsm"/);
  assert.match(sql, /"_tsm"\."status" AS "d1"/);
  assert.match(sql, /SUM\("_tsm"\."total"\) AS "m1"/);
  assert.match(sql, /GROUP BY "_tsm"\."status" LIMIT \$2 OFFSET \$3/);
  assert.equal(params[0], "cancelled"); // model param stays $1
  assert.equal(params[1], 51); // pageSize + 1
});

test("compileModelReport - bucket + sort + rowLimit still apply over the model", () => {
  const { sql, windowSize } = compileModelReport({
    modelSql: "SELECT created_at, id FROM t",
    modelParams: [],
    dimensions: [{ id: "d1", column: "created_at", bucket: "month" }],
    measures: [{ id: "m1", aggregation: "count", column: null }],
    orderBy: { field: "d1", direction: "desc" },
    pageSize: 100,
    rowLimit: 6,
  });
  assert.match(sql, /DATE_TRUNC\('month', "_tsm"\."created_at"\) AS "d1"/);
  assert.match(sql, /GROUP BY DATE_TRUNC\('month', "_tsm"\."created_at"\) ORDER BY "d1" DESC LIMIT/);
  assert.equal(windowSize, 6);
});

test("compileModelReport - dimensions only emits DISTINCT, no GROUP BY", () => {
  const { sql } = compileModelReport({
    modelSql: "SELECT a FROM t",
    dimensions: [{ id: "d1", column: "a" }],
    measures: [],
  });
  assert.match(sql, /SELECT DISTINCT "_tsm"\."a" AS "d1" FROM \(SELECT a FROM t\) AS "_tsm"/);
  assert.doesNotMatch(sql, /GROUP BY/);
});
