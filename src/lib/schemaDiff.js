// Pure diff engine, no DB access: given two branches' {nodes, edges, enums},
// returns exactly what changed between them. Deliberately excludes
// canvas-only fields (position, style, width/height, node type noteNode/
// zoneNode) - those are layout, not schema, and must never appear as a
// false-positive "modification" just because someone dragged a table
// around. Diffs by stable id throughout (tables/columns/edges/enums all
// already carry stable ids in the frontend's own data model - see
// FlowDB's schemaMigrations.js/syncEdgeReference), never by array position
// or name, so a rename shows up as a modification, not a remove+add pair.

// Exported so schemaMerge.js's three-way merge can use the exact same
// recursive equality to decide "did this change since the base" - the diff
// viewer and the merge engine must never disagree about what counts as a
// change.
export function valuesEqual(a, b) {
  if (a === b) return true;
  // Past the `a === b` check, one being nullish means equal only if the
  // other is too (null and undefined count as the same "no value" here).
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => valuesEqual(a[k], b[k]));
}

// Exported for schemaMerge.js to reuse verbatim - one field list, two
// consumers (diffing and merging), so they can never drift apart.
export const COLUMN_FIELDS = [
  "name", "type", "typeParams", "default", "comment",
  "isPrimaryKey", "isForeignKey", "references", "notNull", "isUnique", "isIndex",
];

function diffColumns(baseCols, compareCols) {
  const baseById = new Map((baseCols || []).map((c) => [c.id, c]));
  const compareById = new Map((compareCols || []).map((c) => [c.id, c]));
  const added = [];
  const removed = [];
  const modified = [];
  for (const [id, c] of compareById) {
    if (!baseById.has(id)) added.push({ id, name: c.name, type: c.type });
  }
  for (const [id, c] of baseById) {
    if (!compareById.has(id)) removed.push({ id, name: c.name, type: c.type });
  }
  for (const [id, baseCol] of baseById) {
    const compareCol = compareById.get(id);
    if (!compareCol) continue;
    const fieldChanges = COLUMN_FIELDS
      .map((field) => ({ field, from: baseCol[field] ?? null, to: compareCol[field] ?? null }))
      .filter((c) => !valuesEqual(c.from, c.to));
    if (fieldChanges.length) modified.push({ id, name: compareCol.name || baseCol.name, fieldChanges });
  }
  return { added, removed, modified };
}

// Generic id-keyed list diff for constraint sub-items (check constraints,
// indexes, unique constraints) - each carries its own stable `id`.
function diffIdKeyedList(baseList, compareList, fields) {
  const baseById = new Map((baseList || []).map((i) => [i.id, i]));
  const compareById = new Map((compareList || []).map((i) => [i.id, i]));
  const added = [];
  const removed = [];
  const modified = [];
  for (const [id, item] of compareById) if (!baseById.has(id)) added.push(item);
  for (const [id, item] of baseById) if (!compareById.has(id)) removed.push(item);
  for (const [id, baseItem] of baseById) {
    const compareItem = compareById.get(id);
    if (!compareItem) continue;
    const fieldChanges = fields
      .map((field) => ({ field, from: baseItem[field] ?? null, to: compareItem[field] ?? null }))
      .filter((c) => !valuesEqual(c.from, c.to));
    if (fieldChanges.length) modified.push({ id, fieldChanges });
  }
  return { added, removed, modified };
}

// Exported so schemaMerge.js's mergeConstraints can reuse the exact same
// per-list field sets - "what counts as a change" to a check constraint/
// index/unique constraint can never drift between diffing and merging.
export const CONSTRAINT_LIST_FIELDS = {
  checkConstraints: ["name", "expression"],
  indexes: ["name", "columnNames", "isUnique"],
  uniqueConstraints: ["name", "columnNames"],
};

function diffConstraints(base, compare) {
  base = base || {};
  compare = compare || {};
  const changes = [];
  // Composite PK order isn't surfaced anywhere in the UI - treated as a set
  // so pure reordering is never a false-positive change.
  const basePk = new Set(base.primaryKey || []);
  const comparePk = new Set(compare.primaryKey || []);
  const pkAdded = [...comparePk].filter((id) => !basePk.has(id));
  const pkRemoved = [...basePk].filter((id) => !comparePk.has(id));
  if (pkAdded.length || pkRemoved.length) changes.push({ field: "primaryKey", added: pkAdded, removed: pkRemoved });

  for (const [field, fields] of Object.entries(CONSTRAINT_LIST_FIELDS)) {
    const d = diffIdKeyedList(base[field], compare[field], fields);
    if (d.added.length || d.removed.length || d.modified.length) changes.push({ field, ...d });
  }
  return changes;
}

function diffTable(baseTable, compareTable) {
  const fieldChanges = [];
  const baseName = baseTable.data?.label || "";
  const compareName = compareTable.data?.label || "";
  if (baseName !== compareName) fieldChanges.push({ field: "name", from: baseName, to: compareName });
  const baseDesc = baseTable.data?.description || "";
  const compareDesc = compareTable.data?.description || "";
  if (baseDesc !== compareDesc) fieldChanges.push({ field: "description", from: baseDesc, to: compareDesc });

  const columns = diffColumns(baseTable.data?.columns, compareTable.data?.columns);
  const constraintChanges = diffConstraints(baseTable.data?.constraints, compareTable.data?.constraints);
  const hasChanges =
    fieldChanges.length || columns.added.length || columns.removed.length || columns.modified.length || constraintChanges.length;
  if (!hasChanges) return null;
  return { id: compareTable.id, name: compareName || baseName, fieldChanges, columns, constraintChanges };
}

function diffTables(baseNodes, compareNodes) {
  const summarize = (t) => ({ id: t.id, name: t.data?.label || "Untitled table", columnCount: (t.data?.columns || []).length });
  const baseById = new Map((baseNodes || []).filter((n) => n.type === "tableNode").map((t) => [t.id, t]));
  const compareById = new Map((compareNodes || []).filter((n) => n.type === "tableNode").map((t) => [t.id, t]));
  const added = [];
  const removed = [];
  const modified = [];
  for (const [id, t] of compareById) if (!baseById.has(id)) added.push(summarize(t));
  for (const [id, t] of baseById) if (!compareById.has(id)) removed.push(summarize(t));
  for (const [id, baseTable] of baseById) {
    const compareTable = compareById.get(id);
    if (!compareTable) continue;
    const d = diffTable(baseTable, compareTable);
    // Unchanged tables are deliberately never included - the point of a
    // diff is to be small; most tables between two branches are unchanged.
    if (d) modified.push(d);
  }
  return { added, removed, modified };
}

// Both exported for schemaMerge.js's mergeEdgeItem to reuse verbatim.
export const EDGE_FIELDS = ["source", "target", "sourceHandle", "targetHandle"];
export const EDGE_DATA_FIELDS = ["sourceCardinality", "targetCardinality", "label", "isIdentifying"];

function diffEdges(baseEdges, compareEdges, baseNodes, compareNodes) {
  const baseNodeById = new Map((baseNodes || []).map((n) => [n.id, n]));
  const compareNodeById = new Map((compareNodes || []).map((n) => [n.id, n]));
  const summarize = (e, nodeById) => ({
    id: e.id,
    sourceTable: nodeById.get(e.source)?.data?.label || e.source,
    targetTable: nodeById.get(e.target)?.data?.label || e.target,
    sourceCardinality: e.data?.sourceCardinality,
    targetCardinality: e.data?.targetCardinality,
    label: e.data?.label || "",
  });
  const baseById = new Map((baseEdges || []).map((e) => [e.id, e]));
  const compareById = new Map((compareEdges || []).map((e) => [e.id, e]));
  const added = [];
  const removed = [];
  const modified = [];
  for (const [id, e] of compareById) if (!baseById.has(id)) added.push(summarize(e, compareNodeById));
  for (const [id, e] of baseById) if (!compareById.has(id)) removed.push(summarize(e, baseNodeById));
  for (const [id, baseEdge] of baseById) {
    const compareEdge = compareById.get(id);
    if (!compareEdge) continue;
    const fieldChanges = [
      ...EDGE_FIELDS.filter((f) => baseEdge[f] !== compareEdge[f]).map((f) => ({ field: f, from: baseEdge[f], to: compareEdge[f] })),
      ...EDGE_DATA_FIELDS
        .map((f) => ({ field: f, from: baseEdge.data?.[f] ?? null, to: compareEdge.data?.[f] ?? null }))
        .filter((c) => !valuesEqual(c.from, c.to)),
    ];
    if (fieldChanges.length) modified.push({ ...summarize(compareEdge, compareNodeById), fieldChanges });
  }
  return { added, removed, modified };
}

function diffEnums(baseEnums, compareEnums) {
  const baseById = new Map((baseEnums || []).map((e) => [e.id, e]));
  const compareById = new Map((compareEnums || []).map((e) => [e.id, e]));
  const added = [];
  const removed = [];
  const modified = [];
  for (const [id, e] of compareById) if (!baseById.has(id)) added.push({ id, name: e.name, values: e.values || [] });
  for (const [id, e] of baseById) if (!compareById.has(id)) removed.push({ id, name: e.name, values: e.values || [] });
  for (const [id, baseEnum] of baseById) {
    const compareEnum = compareById.get(id);
    if (!compareEnum) continue;
    const fieldChanges = [];
    if (baseEnum.name !== compareEnum.name) fieldChanges.push({ field: "name", from: baseEnum.name, to: compareEnum.name });
    const bv = baseEnum.values || [];
    const cv = compareEnum.values || [];
    if (!valuesEqual(bv, cv)) {
      fieldChanges.push({
        field: "values", from: bv, to: cv,
        added: cv.filter((v) => !bv.includes(v)),
        removed: bv.filter((v) => !cv.includes(v)),
      });
    }
    if (fieldChanges.length) modified.push({ id, name: compareEnum.name, fieldChanges });
  }
  return { added, removed, modified };
}

export function diffSchemas(base, compare) {
  const tables = diffTables(base.nodes, compare.nodes);
  const relationships = diffEdges(base.edges, compare.edges, base.nodes, compare.nodes);
  const enums = diffEnums(base.enums, compare.enums);
  return {
    tables,
    relationships,
    enums,
    summary: {
      tablesAdded: tables.added.length,
      tablesRemoved: tables.removed.length,
      tablesModified: tables.modified.length,
      relationshipsAdded: relationships.added.length,
      relationshipsRemoved: relationships.removed.length,
      relationshipsModified: relationships.modified.length,
      enumsAdded: enums.added.length,
      enumsRemoved: enums.removed.length,
      enumsModified: enums.modified.length,
    },
    identical:
      [tables, relationships, enums].every((d) => !d.added.length && !d.removed.length && !d.modified.length),
  };
}
