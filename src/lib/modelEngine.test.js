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

test("compileModel builder - multi-schema: base + join tables are schema-qualified in FROM/JOIN", () => {
  const { sql } = compileModel({
    kind: "builder",
    baseTableName: "orders",
    baseTableSchema: "shop",
    joinClauses: [
      { tableName: "customers", tableSchema: "shop", fromTableName: "orders", baseColumn: "customer_id", joinColumn: "id" },
      { tableName: "users", tableSchema: "public", fromTableName: "orders", baseColumn: "user_id", joinColumn: "id" },
    ],
    columns: [
      { tableName: "orders", columnName: "status", alias: "status" },
      { tableName: "customers", columnName: "name", alias: "customer" },
    ],
  });
  assert.match(sql, /FROM "shop"\."orders"/);
  assert.match(sql, /JOIN "shop"\."customers" ON "orders"\."customer_id" = "customers"\."id"/);
  // public join table keeps the bare form.
  assert.match(sql, /JOIN "users" ON "orders"\."user_id" = "users"\."id"/);
  // column refs never carry the schema.
  assert.match(sql, /"orders"\."status" AS "status"/);
});

test("compileModel builder - no columns throws", () => {
  assert.throws(() => compileModel({ kind: "builder", baseTableName: "orders", columns: [] }), /at least one column/);
});

test("compileModel builder - custom column expression, constants parameterised in column order", () => {
  // (revenue - cost) * 1.08, left-associative like the composer reads it.
  const tree = {
    kind: "calculated",
    operator: "*",
    termA: {
      kind: "calculated",
      operator: "-",
      termA: { column: { tableName: "orders", columnName: "revenue" } },
      termB: { column: { tableName: "orders", columnName: "cost" } },
    },
    termB: { constant: 1.08 },
  };
  const { sql, params, columns } = compileModel({
    kind: "builder",
    baseTableName: "orders",
    columns: [
      { tableName: "orders", columnName: "id", alias: "id" },
      { kind: "exprTree", tree, alias: "margin" },
    ],
    filters: [{ tableName: "orders", columnName: "status", operator: "eq", value: "paid" }],
  });
  assert.match(sql, /\(\("orders"\."revenue" - "orders"\."cost"\) \* \$1\) AS "margin"/);
  // expr constant occupies $1 (SELECT order), the filter value $2 (WHERE after).
  assert.match(sql, /WHERE "orders"\."status" = \$2$/);
  assert.deepEqual(params, [1.08, "paid"]);
  assert.deepEqual(columns, ["id", "margin"]);
});

test("compileModel builder - custom column division guards with NULLIF", () => {
  const tree = {
    kind: "calculated",
    operator: "/",
    termA: { column: { tableName: "orders", columnName: "total" } },
    termB: { column: { tableName: "orders", columnName: "qty" } },
  };
  const { sql } = compileModel({
    kind: "builder",
    baseTableName: "orders",
    columns: [{ kind: "exprTree", tree, alias: "unit_price" }],
  });
  assert.match(sql, /\("orders"\."total" \/ NULLIF\("orders"\."qty", 0\)\) AS "unit_price"/);
});

test("compileModel builder - text concat custom column emits concat() with a bound literal", () => {
  // first_name & " " & last_name  ->  concat(concat(first, $1), last)
  const tree = {
    kind: "calculated",
    operator: "&",
    termA: {
      kind: "calculated",
      operator: "&",
      termA: { column: { tableName: "customers", columnName: "first_name" } },
      termB: { text: " " },
    },
    termB: { column: { tableName: "customers", columnName: "last_name" } },
  };
  const { sql, params, columns } = compileModel({
    kind: "builder",
    baseTableName: "customers",
    columns: [{ kind: "exprTree", tree, alias: "full_name" }],
  });
  assert.match(
    sql,
    /concat\(concat\("customers"\."first_name", \$1\), "customers"\."last_name"\) AS "full_name"/,
  );
  assert.deepEqual(params, [" "]);
  assert.deepEqual(columns, ["full_name"]);
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
