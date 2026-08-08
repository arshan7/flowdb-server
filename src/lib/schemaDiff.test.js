import { test } from "node:test";
import assert from "node:assert/strict";
import { diffSchemas } from "./schemaDiff.js";

function table(id, name, columns = []) {
  return { id, type: "tableNode", position: { x: 0, y: 0 }, data: { label: name, columns } };
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

test("identical schemas produce an empty, identical diff", () => {
  const schema = baseSchema();
  const diff = diffSchemas(schema, JSON.parse(JSON.stringify(schema)));
  assert.equal(diff.identical, true);
  assert.deepEqual(diff.summary, {
    tablesAdded: 0, tablesRemoved: 0, tablesModified: 0,
    relationshipsAdded: 0, relationshipsRemoved: 0, relationshipsModified: 0,
    enumsAdded: 0, enumsRemoved: 0, enumsModified: 0,
  });
});

test("a pure position/style change is never a false-positive diff", () => {
  const base = baseSchema();
  const compare = JSON.parse(JSON.stringify(base));
  compare.nodes[0].position = { x: 500, y: 900 };
  compare.nodes[0].style = { border: "2px solid red" };
  compare.nodes[0].width = 400;
  const diff = diffSchemas(base, compare);
  assert.equal(diff.identical, true);
});

test("a table added shows up in tables.added, not as a modification", () => {
  const base = baseSchema();
  const compare = { ...base, nodes: [...base.nodes, table("t2", "orders", [column("c3", "id", "uuid")])] };
  const diff = diffSchemas(base, compare);
  assert.equal(diff.tables.added.length, 1);
  assert.equal(diff.tables.added[0].name, "orders");
  assert.equal(diff.tables.modified.length, 0);
  assert.equal(diff.identical, false);
});

test("a table removed shows up in tables.removed", () => {
  const base = { ...baseSchema(), nodes: [...baseSchema().nodes, table("t2", "orders")] };
  const compare = baseSchema();
  const diff = diffSchemas(base, compare);
  assert.equal(diff.tables.removed.length, 1);
  assert.equal(diff.tables.removed[0].name, "orders");
});

test("a table renamed (same id) shows up as modified, not remove+add", () => {
  const base = baseSchema();
  const compare = JSON.parse(JSON.stringify(base));
  compare.nodes[0].data.label = "customers";
  const diff = diffSchemas(base, compare);
  assert.equal(diff.tables.added.length, 0);
  assert.equal(diff.tables.removed.length, 0);
  assert.equal(diff.tables.modified.length, 1);
  assert.deepEqual(diff.tables.modified[0].fieldChanges, [{ field: "name", from: "users", to: "customers" }]);
});

test("a column added/removed/type-changed all surface distinctly within a modified table", () => {
  const base = baseSchema();
  const compare = JSON.parse(JSON.stringify(base));
  // remove email, change id's type, add a new column
  compare.nodes[0].data.columns = [
    column("c1", "id", "bigint", { isPrimaryKey: true }),
    column("c4", "created_at", "timestamp"),
  ];
  const diff = diffSchemas(base, compare);
  const modifiedTable = diff.tables.modified[0];
  assert.equal(modifiedTable.columns.added.length, 1);
  assert.equal(modifiedTable.columns.added[0].name, "created_at");
  assert.equal(modifiedTable.columns.removed.length, 1);
  assert.equal(modifiedTable.columns.removed[0].name, "email");
  assert.equal(modifiedTable.columns.modified.length, 1);
  assert.equal(modifiedTable.columns.modified[0].id, "c1");
  assert.deepEqual(modifiedTable.columns.modified[0].fieldChanges, [{ field: "type", from: "uuid", to: "bigint" }]);
});

test("a relationship added/removed/cardinality-changed", () => {
  const base = { ...baseSchema(), edges: [edge("e1", "t1", "t2")] };
  const addedCompare = { ...baseSchema(), edges: [edge("e1", "t1", "t2"), edge("e2", "t2", "t1")] };
  assert.equal(diffSchemas(base, addedCompare).relationships.added.length, 1);

  const removedCompare = baseSchema();
  assert.equal(diffSchemas(base, removedCompare).relationships.removed.length, 1);

  const changedCompare = { ...baseSchema(), edges: [edge("e1", "t1", "t2", { sourceCardinality: "N" })] };
  const changedDiff = diffSchemas(base, changedCompare);
  assert.equal(changedDiff.relationships.modified.length, 1);
  assert.deepEqual(changedDiff.relationships.modified[0].fieldChanges, [{ field: "sourceCardinality", from: "1", to: "N" }]);
});

test("an enum value added/removed", () => {
  const base = baseSchema();
  const compare = JSON.parse(JSON.stringify(base));
  compare.enums[0].values = ["active", "suspended"];
  const diff = diffSchemas(base, compare);
  assert.equal(diff.enums.modified.length, 1);
  const valuesChange = diff.enums.modified[0].fieldChanges.find((c) => c.field === "values");
  assert.deepEqual(valuesChange.added, ["suspended"]);
  assert.deepEqual(valuesChange.removed, ["inactive"]);
});

test("missing nodes/edges/enums arrays on either side don't throw", () => {
  assert.doesNotThrow(() => diffSchemas({}, {}));
  assert.equal(diffSchemas({}, {}).identical, true);
});
