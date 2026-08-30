import { test } from "node:test";
import assert from "node:assert/strict";
import { toTablespaceSchema } from "./toTablespaceSchema.js";

// Minimal raw-introspection fixtures - only the fields toTablespaceSchema
// actually reads.
function raw(over = {}) {
  return {
    schemas: ["public", "shop"],
    tables: [],
    columns: [],
    primaryKeys: [],
    foreignKeys: [],
    uniqueConstraints: [],
    checkConstraints: [],
    indexes: [],
    enums: [],
    ...over,
  };
}

test("toTablespaceSchema - two schemas may hold a same-named table; each becomes its own node", () => {
  const { nodes } = toTablespaceSchema(
    raw({
      tables: [
        { table_schema: "public", table_name: "orders" },
        { table_schema: "shop", table_name: "orders" },
      ],
      columns: [
        { table_schema: "public", table_name: "orders", column_name: "id", data_type: "int4", is_nullable: "NO" },
        { table_schema: "shop", table_name: "orders", column_name: "sku", data_type: "text", is_nullable: "NO" },
      ],
    }),
  );

  assert.equal(nodes.length, 2);
  const bySchema = Object.fromEntries(nodes.map((n) => [n.data.schema, n]));
  assert.deepEqual(Object.keys(bySchema).sort(), ["public", "shop"]);
  assert.equal(bySchema.public.data.label, "orders");
  assert.deepEqual(bySchema.public.data.columns.map((c) => c.name), ["id"]);
  assert.deepEqual(bySchema.shop.data.columns.map((c) => c.name), ["sku"]);
});

test("toTablespaceSchema - a cross-schema foreign key resolves to a real edge", () => {
  const { nodes, edges } = toTablespaceSchema(
    raw({
      tables: [
        { table_schema: "public", table_name: "users" },
        { table_schema: "shop", table_name: "orders" },
      ],
      columns: [
        { table_schema: "public", table_name: "users", column_name: "id", data_type: "int4", is_nullable: "NO" },
        { table_schema: "shop", table_name: "orders", column_name: "user_id", data_type: "int4", is_nullable: "NO" },
      ],
      foreignKeys: [
        {
          constraint_name: "orders_user_id_fkey",
          from_schema: "shop",
          from_table: "orders",
          from_column: "user_id",
          to_schema: "public",
          to_table: "users",
          to_column: "id",
        },
      ],
    }),
  );

  assert.equal(edges.length, 1);
  const users = nodes.find((n) => n.data.label === "users");
  const orders = nodes.find((n) => n.data.label === "orders");
  assert.equal(edges[0].source, users.id);
  assert.equal(edges[0].target, orders.id);
  const fkCol = orders.data.columns.find((c) => c.name === "user_id");
  assert.equal(fkCol.isForeignKey, true);
  assert.equal(fkCol.references.tableId, users.id);
});

test("toTablespaceSchema - PK/unique/check/index rows are matched by schema + table", () => {
  const { nodes } = toTablespaceSchema(
    raw({
      tables: [
        { table_schema: "a", table_name: "t" },
        { table_schema: "b", table_name: "t" },
      ],
      columns: [
        { table_schema: "a", table_name: "t", column_name: "id", data_type: "int4", is_nullable: "NO" },
        { table_schema: "b", table_name: "t", column_name: "id", data_type: "int4", is_nullable: "NO" },
      ],
      primaryKeys: [{ table_schema: "a", table_name: "t", column_name: "id" }],
    }),
  );

  const a = nodes.find((n) => n.data.schema === "a");
  const b = nodes.find((n) => n.data.schema === "b");
  assert.equal(a.data.columns[0].isPrimaryKey, true);
  assert.equal(a.data.constraints.primaryKey.length, 1);
  // The same-named table in schema b must be untouched.
  assert.equal(b.data.columns[0].isPrimaryKey, false);
  assert.equal(b.data.constraints.primaryKey.length, 0);
});
