import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileSchema, tableKey } from "./reconcile.js";

test("tableKey - public stays a bare name, other schemas are qualified", () => {
  assert.equal(tableKey("public", "orders"), "orders");
  assert.equal(tableKey(null, "orders"), "orders");
  assert.equal(tableKey(undefined, "orders"), "orders");
  assert.equal(tableKey("shop", "orders"), "shop.orders");
});

function tableNode(id, schema, label, columns = [], origin = "synced") {
  return {
    id,
    type: "tableNode",
    position: { x: 0, y: 0 },
    data: { label, schema, sourceOrigin: origin, columns },
  };
}

test("reconcileSchema - same table name in two schemas both get added", () => {
  const introspected = {
    nodes: [tableNode("n1", "public", "orders"), tableNode("n2", "shop", "orders")],
    edges: [],
    enums: [],
  };
  const result = reconcileSchema({ nodes: [], edges: [], enums: [] }, introspected, { tables: [], edges: [] });

  assert.deepEqual(result.added.sort(), ["orders", "shop.orders"]);
  assert.deepEqual(result.ledger.tables.sort(), ["orders", "shop.orders"]);
  assert.equal(result.nodes.length, 2);
});

test("reconcileSchema - a ledger entry for shop.orders keeps only that one removed", () => {
  const introspected = {
    nodes: [tableNode("n1", "public", "orders"), tableNode("n2", "shop", "orders")],
    edges: [],
    enums: [],
  };
  // shop.orders was synced before then deleted by the user; public.orders is new.
  const result = reconcileSchema(
    { nodes: [], edges: [], enums: [] },
    introspected,
    { tables: ["shop.orders"], edges: [] },
  );

  assert.deepEqual(result.added, ["orders"]);
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].data.schema, "public");
});

test("reconcileSchema - a public-schema resync is byte-for-byte the old behavior (bare ledger keys)", () => {
  const existing = {
    nodes: [tableNode("e1", "public", "orders", [], "synced")],
    edges: [],
    enums: [],
  };
  const introspected = { nodes: [tableNode("n1", "public", "orders")], edges: [], enums: [] };
  const result = reconcileSchema(existing, introspected, { tables: ["orders"], edges: [] });

  // Already-synced public table: nothing added, ledger key stays the bare name.
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.ledger.tables, ["orders"]);
});
