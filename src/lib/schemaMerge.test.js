import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSchemas } from "./schemaMerge.js";

function table(id, name, columns = [], extra = {}) {
  return { id, type: "tableNode", position: { x: 0, y: 0 }, data: { label: name, columns, ...extra } };
}
function column(id, name, type, extra = {}) {
  return { id, name, type, isPrimaryKey: false, isForeignKey: false, notNull: false, isUnique: false, isIndex: false, ...extra };
}
function edge(id, source, target, extra = {}) {
  return { id, source, target, data: { sourceCardinality: "1", targetCardinality: "N", ...extra } };
}
function baseSchema() {
  return {
    nodes: [table("t1", "users", [column("c1", "id", "uuid", { isPrimaryKey: true }), column("c2", "email", "text")])],
    edges: [],
    enums: [{ id: "e1", name: "status", values: ["active", "inactive"] }],
  };
}
function clone(schema) {
  return JSON.parse(JSON.stringify(schema));
}

test("added only in theirs -> included, no conflict", () => {
  const base = baseSchema();
  const ours = clone(base);
  const theirs = clone(base);
  theirs.nodes.push(table("t2", "orders"));

  const result = mergeSchemas(base, ours, theirs);
  assert.equal(result.nodes.length, 2);
  assert.ok(result.nodes.some((n) => n.id === "t2"));
  assert.equal(result.conflicts.length, 0);
});

test("added only in ours -> kept, no-op, no conflict", () => {
  const base = baseSchema();
  const ours = clone(base);
  ours.nodes.push(table("t2", "orders"));
  const theirs = clone(base);

  const result = mergeSchemas(base, ours, theirs);
  assert.equal(result.nodes.length, 2);
  assert.equal(result.conflicts.length, 0);
});

test("deleted by both -> stays deleted", () => {
  const base = { ...baseSchema(), nodes: [...baseSchema().nodes, table("t2", "orders")] };
  const ours = baseSchema();
  const theirs = baseSchema();

  const result = mergeSchemas(base, ours, theirs);
  assert.equal(result.nodes.find((n) => n.id === "t2"), undefined);
  assert.equal(result.conflicts.length, 0);
});

test("deleted by ours, untouched by theirs -> stays deleted, no conflict", () => {
  const base = { ...baseSchema(), nodes: [...baseSchema().nodes, table("t2", "orders")] };
  const ours = baseSchema(); // ours deleted t2
  const theirs = clone(base); // theirs never touched t2

  const result = mergeSchemas(base, ours, theirs);
  assert.equal(result.nodes.find((n) => n.id === "t2"), undefined);
  assert.equal(result.conflicts.length, 0);
});

test("deleted by theirs, untouched by ours -> deletion applied, no conflict", () => {
  const base = { ...baseSchema(), nodes: [...baseSchema().nodes, table("t2", "orders")] };
  const ours = clone(base); // ours never touched t2
  const theirs = baseSchema(); // theirs deleted t2

  const result = mergeSchemas(base, ours, theirs);
  assert.equal(result.nodes.find((n) => n.id === "t2"), undefined);
  assert.equal(result.conflicts.length, 0);
});

test("deleted by ours but modified by theirs -> modification wins (un-deleted), one modify-delete conflict", () => {
  const base = { ...baseSchema(), nodes: [...baseSchema().nodes, table("t2", "orders")] };
  const ours = baseSchema(); // ours deleted t2
  const theirs = clone(base);
  theirs.nodes.find((n) => n.id === "t2").data.label = "purchase_orders"; // theirs renamed it

  const result = mergeSchemas(base, ours, theirs);
  const t2 = result.nodes.find((n) => n.id === "t2");
  assert.ok(t2, "t2 should survive - the modification wins over the deletion");
  assert.equal(t2.data.label, "purchase_orders");
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].type, "modify-delete");
});

test("deleted by theirs but modified by ours -> modification wins (kept ours), one modify-delete conflict", () => {
  const base = { ...baseSchema(), nodes: [...baseSchema().nodes, table("t2", "orders")] };
  const ours = clone(base);
  ours.nodes.find((n) => n.id === "t2").data.label = "purchase_orders"; // ours renamed it
  const theirs = baseSchema(); // theirs deleted t2

  const result = mergeSchemas(base, ours, theirs);
  const t2 = result.nodes.find((n) => n.id === "t2");
  assert.ok(t2, "t2 should survive - the modification wins over the deletion");
  assert.equal(t2.data.label, "purchase_orders");
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].type, "modify-delete");
});

test("same field changed on both sides to different values -> theirs wins, one field-conflict", () => {
  const base = baseSchema();
  const ours = clone(base);
  ours.nodes[0].data.label = "customers";
  const theirs = clone(base);
  theirs.nodes[0].data.label = "clients";

  const result = mergeSchemas(base, ours, theirs);
  const t1 = result.nodes.find((n) => n.id === "t1");
  assert.equal(t1.data.label, "clients"); // theirs wins
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].type, "field-conflict");
  assert.equal(result.conflicts[0].field, "name");
});

test("table renamed on one side + unrelated column added on the other -> merges cleanly, zero conflicts", () => {
  const base = baseSchema();
  const ours = clone(base);
  ours.nodes[0].data.label = "customers"; // ours renames the table
  const theirs = clone(base);
  theirs.nodes[0].data.columns.push(column("c3", "created_at", "timestamp")); // theirs adds an unrelated column

  const result = mergeSchemas(base, ours, theirs);
  const t1 = result.nodes.find((n) => n.id === "t1");
  assert.equal(t1.data.label, "customers"); // ours' rename survives
  assert.ok(t1.data.columns.some((c) => c.id === "c3")); // theirs' new column survives too
  assert.equal(result.conflicts.length, 0, "different fields changed on each side - never a real conflict");
});

test("enum values: one-sided removal is respected, both-sided additions are kept", () => {
  const base = baseSchema();
  const ours = clone(base);
  ours.enums[0].values = ours.enums[0].values.filter((v) => v !== "inactive"); // ours removes "inactive"
  ours.enums[0].values.push("pending"); // ours adds "pending"
  const theirs = clone(base);
  theirs.enums[0].values.push("archived"); // theirs adds "archived", never touches "inactive"

  const result = mergeSchemas(base, ours, theirs);
  const statusEnum = result.enums.find((e) => e.id === "e1");
  assert.ok(!statusEnum.values.includes("inactive"), "ours' removal should be respected");
  assert.ok(statusEnum.values.includes("pending"), "ours' addition should survive");
  assert.ok(statusEnum.values.includes("archived"), "theirs' addition should survive");
  assert.ok(statusEnum.values.includes("active"), "untouched value should survive");
});

test("a table deleted by both sides drops its still-referenced edge too (dangling-edge cleanup)", () => {
  const base = {
    nodes: [table("t1", "users"), table("t2", "orders")],
    edges: [edge("e1", "t1", "t2")],
    enums: [],
  };
  const ours = { nodes: [table("t1", "users")], edges: [edge("e1", "t1", "t2")], enums: [] }; // ours deleted t2 but the stale edge wasn't cleaned up in this hypothetical ours state
  const theirs = { nodes: [table("t1", "users")], edges: [edge("e1", "t1", "t2")], enums: [] }; // theirs also deleted t2

  const result = mergeSchemas(base, ours, theirs);
  assert.equal(result.nodes.find((n) => n.id === "t2"), undefined);
  assert.equal(result.edges.length, 0, "an edge pointing at a table absent from the merge result must be dropped");
});

test("missing nodes/edges/enums arrays on any side don't throw", () => {
  assert.doesNotThrow(() => mergeSchemas({}, {}, {}));
  const result = mergeSchemas({}, {}, {});
  assert.deepEqual(result.nodes, []);
  assert.deepEqual(result.edges, []);
  assert.deepEqual(result.enums, []);
  assert.deepEqual(result.conflicts, []);
});
