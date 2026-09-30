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

test("reconcileSchema - resync back-fills data.schema on a legacy schema-less synced node (no duplicate)", () => {
  // Node synced before multi-schema existed: data.schema is absent.
  const legacy = tableNode("e1", undefined, "orders", [], "synced");
  const existing = { nodes: [legacy], edges: [], enums: [] };
  // Fresh introspection of a schema='shop' source now tags every table.
  const introspected = { nodes: [tableNode("n1", "shop", "orders")], edges: [], enums: [] };
  const result = reconcileSchema(existing, introspected, { tables: ["orders"], edges: [] });

  assert.equal(result.nodes.length, 1, "must not add a duplicate");
  assert.equal(result.nodes[0].id, "e1", "keeps the original node id");
  assert.equal(result.nodes[0].data.schema, "shop", "schema is back-filled");
  assert.deepEqual(result.added, [], "nothing counted as newly added");
});

test("reconcileSchema - back-fill never overwrites an explicit public tag with a shop tag", () => {
  const pub = tableNode("e1", "public", "orders", [], "synced");
  const existing = { nodes: [pub], edges: [], enums: [] };
  // A stray shop.orders from a sync scoped to the shop schema.
  const introspected = { nodes: [tableNode("n1", "shop", "orders")], edges: [], enums: [] };
  const result = reconcileSchema(existing, introspected, { tables: [], edges: [] }, { scopeSchema: "shop" });

  const byName = result.nodes.map((n) => `${n.data.schema}.${n.data.label}`).sort();
  // public.orders is untouched; shop.orders is added as its own node.
  assert.deepEqual(byName, ["public.orders", "shop.orders"]);
});

// A node with no sourceOrigin at all - what a table synced by a build from
// before the tag existed looks like on disk. (tableNode() can't express
// this: passing undefined for its `origin` arg just triggers the "synced"
// default.)
function untaggedNode(id, schema, label) {
  return {
    id,
    type: "tableNode",
    position: { x: 0, y: 0 },
    data: { label, schema, columns: [] },
  };
}

test("reconcileSchema - resync heals a ledger-known node that predates the sourceOrigin tag", () => {
  // Synced by an old build: the key is in the ledger, but data.sourceOrigin
  // was never written. Must be recognised as synced (not a manual-table
  // conflict) and get the tag back-filled in place so "View data" works.
  const existing = { nodes: [untaggedNode("e1", "public", "orders")], edges: [], enums: [] };
  const introspected = { nodes: [tableNode("n1", "public", "orders")], edges: [], enums: [] };
  const result = reconcileSchema(existing, introspected, { tables: ["orders"], edges: [] });

  assert.equal(result.nodes.length, 1, "no duplicate");
  assert.equal(result.nodes[0].id, "e1", "keeps the original node id");
  assert.equal(result.nodes[0].data.sourceOrigin, "synced", "tag is back-filled");
  assert.deepEqual(result.conflicts, [], "not reported as a conflict");
  assert.deepEqual(result.added, [], "nothing counted as newly added");
});

test("reconcileSchema - an untagged node NOT in the ledger is still a conflict", () => {
  // Genuinely hand-built table that happens to share a name with an
  // incoming live table: the ledger has never seen it, so the manual-table
  // protection still holds and nothing is silently absorbed or tagged.
  const existing = { nodes: [untaggedNode("e1", "public", "orders")], edges: [], enums: [] };
  const introspected = { nodes: [tableNode("n1", "public", "orders")], edges: [], enums: [] };
  const result = reconcileSchema(existing, introspected, { tables: [], edges: [] });

  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].name, "orders");
  assert.equal(result.nodes[0].data.sourceOrigin, undefined, "manual table left untagged");
  assert.deepEqual(result.added, []);
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

test("reconcileSchema - refreshes a synced table's columns from the database, keeping ids and app fields", () => {
  const c = (id, name, type, extra = {}) => ({ id, name, type, typeParams: null, notNull: false, isUnique: false, isPrimaryKey: false, isForeignKey: false, references: null, default: "", ...extra });
  const customers = tableNode("tc", "public", "customers", [c("cid", "id", "bigint", { isPrimaryKey: true })]);
  const orders = tableNode("to", "public", "orders", [
    c("oid", "id", "bigint", { isPrimaryKey: true }),
    c("ocust", "customer_id", "bigint", { isForeignKey: true, references: { tableId: "tc", columnId: "cid" } }),
    c("ostat", "status", "text", { displayName: "Order status", semanticType: "category" }),
    c("onote", "note", "text"),
  ]);
  const edge = {
    id: "e1", source: "tc", target: "to", sourceHandle: "tc-cid-source", targetHandle: "to-ocust-target",
    data: { sourceColumnHandle: "tc-cid-source", targetColumnHandle: "to-ocust-target" },
  };
  const noteEdge = { id: "e2", source: "tc", target: "to", sourceHandle: "tc-cid-source", targetHandle: "to-onote-target" };
  // Database now: status became integer + required, note dropped, total added.
  const iCustomers = tableNode("n1", "public", "customers", [c("x1", "id", "bigint", { isPrimaryKey: true })]);
  const iOrders = tableNode("n2", "public", "orders", [
    c("x2", "id", "bigint", { isPrimaryKey: true }),
    c("x3", "customer_id", "bigint", { isForeignKey: true, references: { tableId: "n1", columnId: "x1" } }),
    c("x4", "status", "integer", { notNull: true }),
    c("x5", "total", "decimal", { typeParams: { precision: 10, scale: 2 } }),
  ]);
  const iEdge = { id: "ie", source: "n1", target: "n2", sourceHandle: "n1-x1-source", targetHandle: "n2-x3-target", data: {} };
  const result = reconcileSchema(
    { nodes: [customers, orders], edges: [edge, noteEdge], enums: [] },
    { nodes: [iCustomers, iOrders], edges: [iEdge], enums: [] },
    { tables: ["customers", "orders"], edges: ["customers.id->orders.customer_id"] },
  );
  const cols = result.nodes.find((n) => n.id === "to").data.columns;
  assert.deepEqual(cols.map((x) => [x.id, x.name, x.type]), [
    ["oid", "id", "bigint"],
    ["ocust", "customer_id", "bigint"],
    ["ostat", "status", "integer"],
    ["x5", "total", "decimal"],
  ]);
  const status = cols.find((x) => x.name === "status");
  assert.equal(status.notNull, true);
  assert.equal(status.displayName, "Order status", "app-only fields survive");
  assert.equal(status.semanticType, "category");
  assert.deepEqual(cols[1].references, { tableId: "tc", columnId: "cid" }, "references use final ids");
  assert.deepEqual(result.edges.map((e) => e.id), ["e1"], "the dropped column's line goes, no duplicate line");
});

const col = (id, name, extra = {}) => ({ id, name, type: "bigint", typeParams: null, notNull: false, isUnique: false, isPrimaryKey: false, isForeignKey: false, references: null, default: "", ...extra });

test("reconcileSchema - a table dropped in the database leaves the design and the ledger", () => {
  const users = tableNode("tu", "public", "users", [col("u1", "id", { isPrimaryKey: true })]);
  const posts = tableNode("tp", "public", "posts", [col("p1", "id"), col("p2", "user_id", { isForeignKey: true, references: { tableId: "tu", columnId: "u1" } })]);
  const drawn = tableNode("td", "public", "sketch", [], "manual");
  const edge = { id: "e", source: "tu", target: "tp", sourceHandle: "tu-u1-source", targetHandle: "tp-p2-target", data: {} };
  const result = reconcileSchema(
    { nodes: [users, posts, drawn], edges: [edge], enums: [] },
    { nodes: [tableNode("n2", "public", "posts", [col("x1", "id"), col("x2", "user_id")])], edges: [], enums: [] },
    { tables: ["users", "posts"], edges: ["users.id->posts.user_id"] },
  );
  assert.deepEqual(result.removed, ["users"]);
  assert.deepEqual(result.nodes.map((n) => n.id).sort(), ["td", "tp"], "hand-drawn tables stay");
  assert.equal(result.edges.length, 0);
  assert.deepEqual(result.ledger.tables, ["posts"]);
  assert.deepEqual(result.ledger.edges, []);
  const userId = result.nodes.find((n) => n.id === "tp").data.columns.find((c) => c.name === "user_id");
  assert.equal(userId.references, null, "no link to a table that's gone");
});

test("reconcileSchema - a link the database doesn't have stays, as a virtual link", () => {
  const users = tableNode("tu", "public", "users", [col("u1", "id", { isPrimaryKey: true })]);
  const posts = tableNode("tp", "public", "posts", [
    col("p1", "id"),
    col("p2", "user_id", { isForeignKey: true, references: { tableId: "tu", columnId: "u1" } }),
  ]);
  const edge = { id: "e", source: "tu", target: "tp", sourceHandle: "tu-u1-source", targetHandle: "tp-p2-target", data: {} };
  const result = reconcileSchema(
    { nodes: [users, posts], edges: [edge], enums: [] },
    {
      nodes: [
        tableNode("n1", "public", "users", [col("x0", "id", { isPrimaryKey: true })]),
        tableNode("n2", "public", "posts", [col("x1", "id"), col("x2", "user_id")]),
      ],
      edges: [],
      enums: [],
    },
    { tables: ["users", "posts"], edges: [] },
  );
  const userId = result.nodes.find((n) => n.id === "tp").data.columns.find((c) => c.name === "user_id");
  assert.deepEqual(userId.references, { tableId: "tu", columnId: "u1", virtual: true });
  assert.equal(userId.isForeignKey, true);
  assert.equal(result.edges[0].data.virtual, true);
});
