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
