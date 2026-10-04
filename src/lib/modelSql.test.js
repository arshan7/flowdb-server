import { test } from "node:test";
import assert from "node:assert/strict";
import { loadJoinedModels, resolveModelSql } from "./modelSql.js";

const node = (id, label, columns) => ({ id, type: "tableNode", data: { label, columns } });
const orders = node("t_o", "orders", [
  { id: "o_id", name: "id" },
  { id: "o_cust", name: "customer_id", isForeignKey: true, references: { tableId: "t_c", columnId: "c_id" } },
  { id: "o_ref", name: "ref" },
]);
const customers = node("t_c", "customers", [{ id: "c_id", name: "id" }, { id: "c_name", name: "name" }]);
const notes = node("t_n", "notes", [{ id: "n_ref", name: "order_ref" }, { id: "n_text", name: "text" }]);
const branch = { nodes: [orders, customers, notes] };
const model = (joins) => ({
  kind: "builder",
  baseTableId: "t_o",
  joins,
  columns: [
    { tableId: "t_o", columnId: "o_id" },
    { tableId: "t_c", columnId: "c_name" },
  ],
});

test("resolveModelSql - a plain id string is an inner relationship join (saved before join types)", () => {
  const { sql } = resolveModelSql(model(["t_c"]), branch);
  assert.match(sql, /FROM "orders" JOIN "customers"/);
});

test("resolveModelSql - { tableId, type } is a relationship join with that type", () => {
  const { sql } = resolveModelSql(model([{ tableId: "t_c", type: "left" }]), branch);
  assert.match(sql, /FROM "orders" LEFT JOIN "customers" ON "orders"\."customer_id" = "customers"\."id"/);
});

test("resolveModelSql - a manual join keeps its pairs and takes its type", () => {
  const m = model([{ tableId: "t_c", type: "left" }, { tableId: "t_n", type: "full", pairs: [{ baseColumnId: "o_ref", joinColumnId: "n_ref" }] }]);
  m.columns.push({ tableId: "t_n", columnId: "n_text" });
  const { sql, error } = resolveModelSql(m, branch);
  assert.equal(error, undefined);
  assert.match(sql, /FULL JOIN "notes" ON "orders"\."ref" = "notes"\."order_ref"/);
});

test("resolveModelSql - a typed formula column compiles with [column] and [table.column] refs", () => {
  const m = model([{ tableId: "t_c", type: "left" }]);
  m.columns.push({ kind: "expr", alias: "label", text: 'Upper([customers.name]) & " #" & Text([id])' });
  const { sql, params, error } = resolveModelSql(m, branch);
  assert.equal(error, undefined);
  assert.match(sql, /concat\(concat\(UPPER\(\("customers"\."name"\)::text\)|concat\(concat\(UPPER\("customers"\."name"\)/);
  assert.match(sql, /\("orders"\."id"\)::text/);
  assert.deepEqual(params, [" #"]);
  const bad = resolveModelSql({ ...m, columns: [...m.columns.slice(0, 2), { kind: "expr", alias: "x", text: "[nope] + 1" }] }, branch);
  assert.match(bad.error, /The custom column "x": There's no column called \[nope\]/);
});

test("row filters by output column read the finished rows", () => {
  const r = resolveModelSql(
    {
      kind: "builder",
      baseTableId: "t1",
      columns: [{ tableId: "t1", columnId: "c1" }, { tableId: "t1", columnId: "c2" }],
      filters: [{ column: "status", operator: "eq", value: "paid" }],
    },
    { nodes: [node("t1", "orders", [{ id: "c1", name: "status", type: "text" }, { id: "c2", name: "total", type: "numeric" }])] },
  );
  assert.equal(r.error, undefined);
  assert.match(r.sql, /^SELECT \* FROM \(SELECT .* FROM "orders"\) AS "_tsr" WHERE "_tsr"."status" = \$1$/);
  assert.deepEqual(r.params, ["paid"]);
});

// A saved Model joined into another: customer totals with a status filter (a bound value).
const custTotals = {
  name: "Customer totals",
  kind: "builder",
  baseTableId: "t_c",
  joins: [],
  columns: [{ tableId: "t_c", columnId: "c_id", alias: "customer" }, { tableId: "t_c", columnId: "c_name" }],
  filters: [{ column: "name", operator: "neq", value: "test" }],
};

test("a joined Model compiles as a subquery, its placeholders after the outer ones", () => {
  const m = {
    kind: "builder",
    baseTableId: "t_o",
    joins: [{ modelId: 9, type: "left", pairs: [{ baseColumnId: "o_cust", column: "customer" }] }],
    columns: [{ tableId: "t_o", columnId: "o_id" }, { modelId: 9, column: "name", alias: "customer_name" }],
    filters: [{ column: "id", operator: "gt", value: 5 }],
  };
  const { sql, params, error, columns } = resolveModelSql(m, branch, null, new Map([["9", custTotals]]));
  assert.equal(error, undefined);
  assert.match(sql, /LEFT JOIN \(SELECT \* FROM \(SELECT .* FROM "customers"\) AS "_tsr" WHERE .*\$1.*\) AS "model_9" ON "orders"\."customer_id" = "model_9"\."customer"/);
  assert.match(sql, /"model_9"\."name" AS "customer_name"/);
  assert.match(sql, /WHERE .*\$2/);
  assert.deepEqual(params, ["test", 5]);
  assert.deepEqual(columns, ["id", "customer_name"]);
});

test("a joined Model that's gone, or a column it doesn't have, is an error", () => {
  const m = { kind: "builder", baseTableId: "t_o", joins: [{ modelId: 9, pairs: [{ baseColumnId: "o_cust", column: "nope" }] }], columns: [{ tableId: "t_o", columnId: "o_id" }] };
  assert.match(resolveModelSql(m, branch, null, new Map()).error, /no longer exists/);
  assert.match(resolveModelSql(m, branch, null, new Map([["9", custTotals]])).error, /no longer exists/);
});

test("loadJoinedModels fetches nested joins once and stops on a cycle", async () => {
  const rows = { 1: { joins: [{ modelId: 2 }] }, 2: { joins: [{ modelId: 1 }] } };
  const asked = [];
  const out = await loadJoinedModels({ joins: [{ modelId: 1 }] }, async (id) => (asked.push(id), rows[id]));
  assert.deepEqual([...out.keys()], ["1", "2"]);
  assert.deepEqual(asked, [1, 2]);
});

test("a formula reads a joined Model's column by [Model.column] or a unique [column]", () => {
  const m = {
    kind: "builder",
    baseTableId: "t_o",
    joins: [{ modelId: 9, pairs: [{ baseColumnId: "o_cust", column: "customer" }] }],
    columns: [
      { tableId: "t_o", columnId: "o_id" },
      { kind: "expr", alias: "who", text: "[Customer totals.name] & \" #\" & [customer]" },
    ],
  };
  const { sql, error } = resolveModelSql(m, branch, null, new Map([["9", custTotals]]));
  assert.equal(error, undefined);
  assert.match(sql, /"model_9"\."name"/);
  assert.match(sql, /"model_9"\."customer"/);
});
