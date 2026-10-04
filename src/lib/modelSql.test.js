import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveModelSql } from "./modelSql.js";

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
