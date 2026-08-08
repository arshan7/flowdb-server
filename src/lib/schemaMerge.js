// Deterministic three-way merge for a schema branch pair. Given a fork-
// point snapshot (base = the source branch's base_nodes/base_edges/
// base_enums, captured ONCE at fork time - see tablespaceStore.js's
// createBranch) plus the two sides' CURRENT content (ours = the target/
// parent branch, theirs = the source/child branch being merged in),
// returns a merged {nodes, edges, enums} plus a `conflicts` array
// describing every place the two sides genuinely disagreed and how it was
// auto-resolved.
//
// Never blocks on a human decision (this feature's explicit requirement) -
// every case below has one fixed, deterministic outcome. `conflicts` exists
// purely for a post-merge summary/toast, not to gate anything.
//
// Reuses schemaDiff.js's own field lists (COLUMN_FIELDS/EDGE_FIELDS/
// EDGE_DATA_FIELDS/CONSTRAINT_LIST_FIELDS) and its exact recursive equality
// (valuesEqual) so "did this change since the base" can never disagree
// between the diff viewer and this merge engine looking at the same three
// documents.
//
// Merge is only ever called for a branch and its DIRECT parent (enforced
// by the route, not here) - without a full commit-history DAG, there's no
// way to correctly compute a common ancestor for an arbitrary branch pair.
//
// KNOWN v1 LIMITATION (by design, not a bug - documented, not solved here):
// a branch's base_* columns are captured ONCE at fork time and never
// advanced. Merging the same pair a second time (after further edits on
// both sides following a first merge) re-uses that ORIGINAL base, which can
// misattribute already-merged changes as "both sides independently made
// this change." Fixing this needs merge-history tracking that advances the
// base after each merge - out of scope for this pass.

import {
  valuesEqual,
  COLUMN_FIELDS,
  EDGE_FIELDS,
  EDGE_DATA_FIELDS,
  CONSTRAINT_LIST_FIELDS,
} from "./schemaDiff.js";

// ---------------------------------------------------------------------------
// Field-level three-way merge - the primitive everything else is built on.
// ---------------------------------------------------------------------------

// One scalar (or deep-comparable object/array, via valuesEqual's own
// recursion) field, three-way merged. `conflict: true` means both sides
// changed it, to different values - theirs wins, but the caller records it.
export function mergeField(base, ours, theirs) {
  if (valuesEqual(ours, theirs)) return { value: theirs, conflict: false };
  if (valuesEqual(base, ours)) return { value: theirs, conflict: false }; // only theirs changed
  if (valuesEqual(base, theirs)) return { value: ours, conflict: false }; // only ours changed
  return { value: theirs, conflict: true }; // both changed, differently
}

const topGet = (item, field) => item?.[field];

// Merges one named group of scalar fields (a table's name/description, a
// column's COLUMN_FIELDS, ...) across base/ours/theirs. `get(item, field)`
// abstracts plain top-level access vs a nested accessor (edge .data.*
// fields reuse this with a different `get`, below). `ctx` is spread
// verbatim into any conflict record this produces - callers pass whatever
// identifying info (entityType, id, tableId, ...) is relevant for that
// entity type.
function mergeFieldGroup(base, ours, theirs, fields, get, ctx, conflicts) {
  const result = {};
  for (const field of fields) {
    const { value, conflict } = mergeField(
      get(base, field) ?? null,
      get(ours, field) ?? null,
      get(theirs, field) ?? null,
    );
    result[field] = value;
    if (conflict) conflicts.push({ type: "field-conflict", resolution: "theirs", ...ctx, field });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Id-keyed three-way LIST merge - reused for tables, columns, edges, enums,
// and constraint sub-lists. Implements every bullet of the merge policy
// exactly once; each entity type below only supplies "what does 'unchanged
// since base' mean for one of these" (fieldsEqual) and "how do I merge one
// item that survives in all three" (merge).
// ---------------------------------------------------------------------------
function mergeIdKeyedList(base, ours, theirs, { merge, fieldsEqual, entityType, conflicts, ctxExtra = {} }) {
  const baseById = new Map((base || []).map((i) => [i.id, i]));
  const oursById = new Map((ours || []).map((i) => [i.id, i]));
  const theirsById = new Map((theirs || []).map((i) => [i.id, i]));
  // Set() preserves insertion order - base's own order first, then any
  // genuinely new id from ours, then any genuinely new id from theirs. Not
  // load-bearing for correctness, just a deterministic, stable output order.
  const allIds = new Set([...baseById.keys(), ...oursById.keys(), ...theirsById.keys()]);
  const result = [];

  for (const id of allIds) {
    const b = baseById.get(id) ?? null;
    const o = oursById.get(id) ?? null;
    const t = theirsById.get(id) ?? null;

    if (!b) {
      // Never existed at the fork point.
      if (o && t) {
        // Both sides independently created an item with this exact id -
        // effectively impossible with this app's nanoid ids, but handled
        // deterministically rather than left ambiguous: theirs wins, same
        // tie-break as every genuine field conflict below, and it's
        // recorded so it's never silent.
        result.push(t);
        conflicts.push({
          type: "field-conflict", entityType, ...ctxExtra, id,
          resolution: "theirs (both sides independently added this id)",
        });
        continue;
      }
      result.push(o || t); // added by exactly one side - just there now
      continue;
    }
    if (!o && !t) continue; // present in base, gone from both sides - stays deleted
    if (!o && t) {
      // Ours (target) deleted it.
      if (fieldsEqual(b, t)) continue; // theirs never touched it - respect the deletion
      result.push(t); // theirs modified it after ours deleted it - modification wins
      conflicts.push({
        type: "modify-delete", entityType, ...ctxExtra, id,
        resolution: "kept theirs (modified after target deleted)",
      });
      continue;
    }
    if (o && !t) {
      // Theirs (source) deleted it.
      if (fieldsEqual(b, o)) continue; // ours never touched it - apply the deletion
      result.push(o); // ours modified it after theirs deleted it - modification wins
      conflicts.push({
        type: "modify-delete", entityType, ...ctxExtra, id,
        resolution: "kept ours (modified after source deleted)",
      });
      continue;
    }
    result.push(merge(b, o, t, id)); // present in all three - ordinary field merge
  }
  return result;
}

// ---------------------------------------------------------------------------
// Set-based three-way merge for a flat array with no per-item id (enum
// `values`, a composite primary key's column-id list). A value is either
// present or absent - there's no partial "modified" state the way an
// object has, so there's never a genuine conflict to record here: the only
// way one side's removal gets overridden is the OTHER side still having
// it, which is indistinguishable from "never removed" from final state
// alone - same reasoning schemaDiff.js's own diffConstraints comment gives
// for treating primaryKey as an order-insensitive set.
function mergeSet(base, ours, theirs) {
  const b = new Set(base || []);
  const o = new Set(ours || []);
  const t = new Set(theirs || []);
  const result = [];
  for (const v of new Set([...b, ...o, ...t])) {
    const keptByBoth = o.has(v) && t.has(v);
    const addedFresh = !b.has(v) && (o.has(v) || t.has(v));
    if (keptByBoth || addedFresh) result.push(v);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Constraints (table-level: primaryKey + the id-keyed checkConstraints/
// indexes/uniqueConstraints sub-lists) - reuses CONSTRAINT_LIST_FIELDS,
// schemaDiff.js's own per-list field set.
// ---------------------------------------------------------------------------
function mergeConstraints(tableId, base, ours, theirs, conflicts) {
  base = base || {};
  ours = ours || {};
  theirs = theirs || {};
  const merged = {
    primaryKey: mergeSet(base.primaryKey, ours.primaryKey, theirs.primaryKey),
  };
  for (const [list, fields] of Object.entries(CONSTRAINT_LIST_FIELDS)) {
    merged[list] = mergeIdKeyedList(base[list], ours[list], theirs[list], {
      entityType: "constraint",
      ctxExtra: { tableId, list },
      fieldsEqual: (a, b) => fields.every((f) => valuesEqual(a?.[f] ?? null, b?.[f] ?? null)),
      merge: (b, o, t, id) => ({
        id,
        ...mergeFieldGroup(b, o, t, fields, topGet, { entityType: "constraint", tableId, list, id }, conflicts),
      }),
      conflicts,
    });
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Columns - COLUMN_FIELDS reused verbatim from schemaDiff.js.
// ---------------------------------------------------------------------------
function mergeColumns(tableId, base, ours, theirs, conflicts) {
  return mergeIdKeyedList(base, ours, theirs, {
    entityType: "column",
    ctxExtra: { tableId },
    fieldsEqual: (a, b) => COLUMN_FIELDS.every((f) => valuesEqual(a?.[f] ?? null, b?.[f] ?? null)),
    merge: (b, o, t, id) => ({
      id,
      ...mergeFieldGroup(b, o, t, COLUMN_FIELDS, topGet, { entityType: "column", tableId, id }, conflicts),
    }),
    conflicts,
  });
}

// ---------------------------------------------------------------------------
// Tables (tableNode entries only - see mergeNodes below for note/zone
// nodes). name/description are simple fields; columns and constraints
// recurse into their own id-keyed merges. Position/width/height/style are
// presentation, never merged field-by-field - `survivor` below (ours if
// this table exists there, else theirs for a brand-new table) supplies
// them via plain spread, giving "always keep O's position; a newly-added
// table keeps T's position since O has none" for free, with no special
// case needed.
// ---------------------------------------------------------------------------
function mergeTable(base, ours, theirs, id, conflicts) {
  const nameFields = mergeFieldGroup(
    { name: base?.data?.label ?? "", description: base?.data?.description ?? "" },
    { name: ours?.data?.label ?? "", description: ours?.data?.description ?? "" },
    { name: theirs?.data?.label ?? "", description: theirs?.data?.description ?? "" },
    ["name", "description"],
    topGet,
    { entityType: "table", id },
    conflicts,
  );
  const columns = mergeColumns(id, base?.data?.columns, ours?.data?.columns, theirs?.data?.columns, conflicts);
  const constraints = mergeConstraints(id, base?.data?.constraints, ours?.data?.constraints, theirs?.data?.constraints, conflicts);

  const survivor = ours || theirs; // presentation passthrough - position/width/height/style/color/etc.
  return {
    ...survivor,
    id,
    data: { ...survivor.data, label: nameFields.name, description: nameFields.description, columns, constraints },
  };
}

function tableContentEqual(a, b) {
  return (
    valuesEqual(a?.data?.label ?? "", b?.data?.label ?? "") &&
    valuesEqual(a?.data?.description ?? "", b?.data?.description ?? "") &&
    valuesEqual(a?.data?.columns ?? [], b?.data?.columns ?? []) &&
    valuesEqual(a?.data?.constraints ?? {}, b?.data?.constraints ?? {})
  );
}

// ---------------------------------------------------------------------------
// noteNode/zoneNode - free-form canvas annotations schemaDiff.js never
// diffs at all (no established per-field list like COLUMN_FIELDS exists
// for them). Their entire `data` is merged as ONE opaque field - mergeField
// already handles deep objects via valuesEqual's own recursion, so this is
// not a special case, just a field group of size one. Position/width/
// height/style follow the same "presentation, always keep the survivor
// that already existed" rule as tables.
// ---------------------------------------------------------------------------
function mergeAnnotationNode(base, ours, theirs, id, conflicts) {
  const { value: data, conflict } = mergeField(base?.data ?? null, ours?.data ?? null, theirs?.data ?? null);
  if (conflict) conflicts.push({ type: "field-conflict", entityType: (ours || theirs).type, id, field: "data", resolution: "theirs" });
  const survivor = ours || theirs;
  return { ...survivor, id, data };
}

const isTableNode = (n) => n?.type === "tableNode";

function mergeNodes(baseNodes, oursNodes, theirsNodes, conflicts) {
  const split = (nodes) => ({
    tables: (nodes || []).filter(isTableNode),
    other: (nodes || []).filter((n) => !isTableNode(n)),
  });
  const b = split(baseNodes);
  const o = split(oursNodes);
  const t = split(theirsNodes);

  const mergedTables = mergeIdKeyedList(b.tables, o.tables, t.tables, {
    entityType: "table",
    fieldsEqual: tableContentEqual,
    merge: (bt, ot, tt, id) => mergeTable(bt, ot, tt, id, conflicts),
    conflicts,
  });
  const mergedOther = mergeIdKeyedList(b.other, o.other, t.other, {
    entityType: "node",
    fieldsEqual: (a, bb) => valuesEqual(a?.data ?? null, bb?.data ?? null),
    merge: (bn, on, tn, id) => mergeAnnotationNode(bn, on, tn, id, conflicts),
    conflicts,
  });
  // Tables first, then notes/zones - a deliberate, harmless reordering
  // relative to the original interleaved array (paint order only; xyflow
  // positions nodes by their own `position` field, never array index).
  return [...mergedTables, ...mergedOther];
}

// ---------------------------------------------------------------------------
// Edges - EDGE_FIELDS (top-level) + EDGE_DATA_FIELDS (nested under .data),
// both reused verbatim from schemaDiff.js. type/animated/markerEnd are
// presentation (always this app's own fixed convention, never user-edited
// directly) - same "prefer ours, else theirs" passthrough as table position.
// ---------------------------------------------------------------------------
function edgeContentEqual(a, b) {
  return (
    EDGE_FIELDS.every((f) => valuesEqual(a?.[f] ?? null, b?.[f] ?? null)) &&
    EDGE_DATA_FIELDS.every((f) => valuesEqual(a?.data?.[f] ?? null, b?.data?.[f] ?? null))
  );
}

const dataGet = (item, field) => item?.data?.[field];

function mergeEdgeItem(base, ours, theirs, id, conflicts) {
  const top = mergeFieldGroup(base, ours, theirs, EDGE_FIELDS, topGet, { entityType: "edge", id }, conflicts);
  const data = mergeFieldGroup(base, ours, theirs, EDGE_DATA_FIELDS, dataGet, { entityType: "edge", id, group: "data" }, conflicts);
  const survivor = ours || theirs;
  return { ...survivor, id, ...top, data: { ...survivor.data, ...data } };
}

function mergeEdges(base, ours, theirs, conflicts) {
  return mergeIdKeyedList(base, ours, theirs, {
    entityType: "edge",
    fieldsEqual: edgeContentEqual,
    merge: (b, o, t, id) => mergeEdgeItem(b, o, t, id, conflicts),
    conflicts,
  });
}

// ---------------------------------------------------------------------------
// Enums - name is an ordinary field; values is the flat set-merge above,
// not per-field (matches diffEnums' own "values" is a whole-array field,
// not id-keyed sub-items).
// ---------------------------------------------------------------------------
function enumContentEqual(a, b) {
  return valuesEqual(a?.name ?? "", b?.name ?? "") && valuesEqual(a?.values ?? [], b?.values ?? []);
}

function mergeEnumItem(base, ours, theirs, id, conflicts) {
  const { name } = mergeFieldGroup(base, ours, theirs, ["name"], topGet, { entityType: "enum", id }, conflicts);
  const values = mergeSet(base?.values, ours?.values, theirs?.values);
  return { id, name, values };
}

function mergeEnums(base, ours, theirs, conflicts) {
  return mergeIdKeyedList(base, ours, theirs, {
    entityType: "enum",
    fieldsEqual: enumContentEqual,
    merge: (b, o, t, id) => mergeEnumItem(b, o, t, id, conflicts),
    conflicts,
  });
}

// ---------------------------------------------------------------------------
export function mergeSchemas(base, ours, theirs) {
  const conflicts = [];
  const nodes = mergeNodes(base?.nodes, ours?.nodes, theirs?.nodes, conflicts);
  const edges = mergeEdges(base?.edges, ours?.edges, theirs?.edges, conflicts);
  const enums = mergeEnums(base?.enums, ours?.enums, theirs?.enums, conflicts);

  // A table both/either side deleted can leave an edge from the OTHER,
  // unrelated side's still-current content dangling - the same table-
  // delete-cascades-to-its-edges rule schemaStore.js's own deleteNode
  // already applies on the canvas, just re-applied here since nodes and
  // edges are merged independently above.
  const nodeIds = new Set(nodes.map((n) => n.id));
  const cleanEdges = edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

  return { nodes, edges: cleanEdges, enums, conflicts };
}
