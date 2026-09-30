import { nanoid } from "nanoid";

// Pure schema-reconciliation logic, split out from syncSource.js so it can
// be unit-tested without a live Postgres (syncSource.js pulls in the store,
// which needs DATABASE_URL at import time). syncSource.js is the IO
// orchestrator; everything here is a plain function of its inputs.

// New synced tables are placed in a simple grid below whatever's already
// on the canvas - not a real dagre layout (that's a client-only util,
// dagreLayout.js, and pulling it into the server is more machinery than
// this needs). "Auto-arrange" in FloatingToolbar.jsx is one click away
// for anyone who wants it tidied up properly afterward.
const GRID_COLUMNS = 5;
const GRID_SPACING_X = 320;
const GRID_SPACING_Y = 220;
const GRID_MARGIN_Y = 300;

function maxNodeY(nodes) {
  let max = 0;
  for (const n of nodes) {
    const y = n.position?.y ?? 0;
    if (y > max) max = y;
  }
  return max;
}

// Stable identity for a table across sync passes and in the ledger. A
// multi-schema source can hold two tables of the same name in different
// schemas, so the schema is part of the key - EXCEPT for "public", which
// stays a bare name so every ledger and edge signature written before
// multi-schema sources existed (all single-schema, all public) keeps
// matching without a migration. Doubles as the display name in the
// "added"/"conflicts" report.
export function tableKey(schema, name) {
  return schema && schema !== "public" ? `${schema}.${name}` : name;
}

// Reconstructs the same handle id TableNode.jsx generates for a column
// (mirrors schemaStore.js's own findColumnByHandle) so a column can be
// resolved back from an edge's stored handle without parsing the id
// string apart - nanoid ids can contain dashes, so splitting is unreliable.
function findColumnByHandle(node, handle) {
  if (!node || !handle) return null;
  return (node.data?.columns || []).find(
    (col) => `${node.id}-${col.id}-source` === handle || `${node.id}-${col.id}-target` === handle,
  );
}

// The database's facts about a column; everything else (display name, role,
// comment) is the app's own and survives a refresh.
const DB_COLUMN_FIELDS = ["name", "type", "typeParams", "default", "notNull", "isUnique", "isPrimaryKey", "isForeignKey", "references", "isIndex"];

// Refreshes each already-synced table's columns from the introspected copy:
// matched by name so column ids (and every edge / reference to them) stay,
// new columns come in, dropped ones go. Returns introspected column id ->
// final column id, for remapping references and edge handles.
function refreshColumns(nextNodes, refreshed, nodeIdMap) {
  const colIdMap = new Map();
  for (const { idx, incoming } of refreshed) {
    const byName = new Map((nextNodes[idx].data?.columns || []).map((c) => [c.name, c]));
    for (const c of incoming.data?.columns || []) colIdMap.set(c.id, byName.get(c.name)?.id ?? c.id);
  }
  const remapRef = (ref) => {
    if (!ref) return null;
    const tableId = nodeIdMap.get(ref.tableId);
    return tableId ? { tableId, columnId: colIdMap.get(ref.columnId) ?? ref.columnId } : null;
  };
  for (const { idx, incoming } of refreshed) {
    const node = nextNodes[idx];
    const byName = new Map((node.data?.columns || []).map((c) => [c.name, c]));
    const columns = (incoming.data?.columns || []).map((c) => {
      const kept = byName.get(c.name) || {};
      const next = { ...kept, id: colIdMap.get(c.id) };
      for (const f of DB_COLUMN_FIELDS) next[f] = c[f] ?? null;
      const dbRef = c.isForeignKey ? remapRef(c.references) : null;
      if (dbRef) next.references = dbRef;
      // No FK in the database: a link the app keeps (a virtual link, or one
      // drawn by hand before virtual links existed) stays, marked virtual.
      else if (kept.isForeignKey && kept.references?.tableId) next.references = { ...kept.references, virtual: true };
      else next.references = null;
      next.isForeignKey = !!next.references;
      if (c.autoIncrement) next.autoIncrement = true;
      else delete next.autoIncrement;
      return next;
    });
    const ic = incoming.data?.constraints;
    const constraints = ic
      ? {
          ...node.data.constraints,
          ...ic,
          primaryKey: columns.filter((c) => c.isPrimaryKey).map((c) => c.id),
          uniqueConstraints: (ic.uniqueConstraints || []).map((u) => ({
            ...u,
            columnIds: u.columnIds.map((id) => colIdMap.get(id) ?? id),
          })),
        }
      : node.data.constraints;
    nextNodes[idx] = { ...node, data: { ...node.data, columns, ...(constraints && { constraints }) } };
  }
  // References from newly added tables into refreshed ones.
  for (let i = 0; i < nextNodes.length; i += 1) {
    const n = nextNodes[i];
    if (!n.data?.columns?.some((c) => c.references && colIdMap.has(c.references.columnId))) continue;
    nextNodes[i] = {
      ...n,
      data: {
        ...n.data,
        columns: n.data.columns.map((c) =>
          c.references && colIdMap.has(c.references.columnId)
            ? {
                ...c,
                references: {
                  tableId: nodeIdMap.get(c.references.tableId) ?? c.references.tableId,
                  columnId: colIdMap.get(c.references.columnId),
                },
              }
            : c,
        ),
      },
    };
  }
  return colIdMap;
}

// An introspected edge handle rebuilt with the final node and column ids.
function remapHandle(introNode, handle, finalNodeId, colIdMap, side) {
  const col = findColumnByHandle(introNode, handle);
  if (!col) return handle?.replace(introNode?.id ?? "", finalNodeId);
  return `${finalNodeId}-${colIdMap.get(col.id) ?? col.id}-${side}`;
}

// A stable, name-based identity for a relationship - "orders.customer_id
// -> customers.id" - independent of the transient node/column ids a fresh
// introspection mints every single run. This is what the sync ledger
// stores and compares against, since ids alone give no way to recognize
// "this is the same relationship I synced last time" across two
// completely separate introspection passes.
function edgeSignature(nodesById, edge) {
  const sourceNode = nodesById.get(edge.source);
  const targetNode = nodesById.get(edge.target);
  const sourceColumn = findColumnByHandle(sourceNode, edge.sourceHandle);
  const targetColumn = findColumnByHandle(targetNode, edge.targetHandle);
  if (!sourceNode || !targetNode || !sourceColumn || !targetColumn) return null;
  const s = `${tableKey(sourceNode.data.schema, sourceNode.data.label)}.${sourceColumn.name}`;
  const t = `${tableKey(targetNode.data.schema, targetNode.data.label)}.${targetColumn.name}`;
  return `${s}->${t}`;
}

// Pull-only, additive reconciliation - never pushes anything back to the
// live database, and never silently overwrites a table the user made by
// hand. Every synced table is tagged `data.sourceOrigin === "synced"` (the
// only place that tag is written or read); anything without it - whether
// truly hand-built, or just predates this feature - is treated as
// user-owned and left alone. A same-named incoming table hitting one of
// those is a CONFLICT, not an overwrite: it's skipped entirely and
// reported back, same reasoning schemaMerge.js uses for real edit
// conflicts elsewhere in this app (a fixed, deterministic policy, never a
// silent guess).
//
// `ledger` ({tables: [...names], edges: [...signatures]}) is what makes a
// deliberate removal STAY removed: the current schema state alone can't
// tell "never seen before" apart from "synced once, then the user deleted
// it" - both simply look like "not there." A name/signature the ledger
// already has is never re-added, no matter how many times it still shows
// up in a fresh introspection. The ledger only ever grows.
// `scopeSchema`: the one schema this sync read (null = every schema). Only
// synced tables inside it can be "dropped in the database".
export function reconcileSchema(existingBranch, introspected, ledger, { scopeSchema = null } = {}) {
  const existingNodes = existingBranch.nodes || [];
  const existingEdges = existingBranch.edges || [];
  const existingEnums = existingBranch.enums || [];
  const ledgerTables = new Set(ledger?.tables || []);
  const ledgerEdges = new Set(ledger?.edges || []);

  const existingByKey = new Map(
    existingNodes
      .filter((n) => n.type === "tableNode")
      .map((n) => [tableKey(n.data?.schema, n.data?.label), n]),
  );
  const introspectedNodesById = new Map(introspected.nodes.map((n) => [n.id, n]));

  const added = [];
  const conflicts = [];
  // Old (introspected-batch) node id -> final node id - needed to remap
  // edges below, since an edge from THIS sync can connect a brand new
  // table to one that was already synced in an earlier pass. Tables that
  // hit a conflict, OR that the ledger says were deliberately removed,
  // are never added to this map, which is exactly what makes an edge
  // touching one get dropped further down.
  const introspectedIdToFinalId = new Map();
  const nextNodes = [...existingNodes];
  // Synced tables whose columns get refreshed from the database below.
  const refreshed = [];
  let gridIndex = 0;
  const startY = maxNodeY(existingNodes) + GRID_MARGIN_Y;

  for (const incoming of introspected.nodes) {
    const name = incoming.data?.label;
    const key = tableKey(incoming.data?.schema, name);
    let existing = existingByKey.get(key);
    // A node synced before multi-schema existed is keyed by its bare name
    // (tableKey(null, name) === name). If the qualified key missed, match
    // that legacy node so a resync back-fills its schema rather than
    // adding a duplicate - but only when it's genuinely schema-less, never
    // a real public-tagged node (which must not absorb a "shop.x").
    if (!existing && key !== name) {
      const legacy = existingByKey.get(name);
      if (legacy && legacy.data?.schema == null) existing = legacy;
    }

    if (!existing) {
      if (ledgerTables.has(key)) continue; // synced before, user removed it - stays removed

      const position = {
        x: (gridIndex % GRID_COLUMNS) * GRID_SPACING_X,
        y: startY + Math.floor(gridIndex / GRID_COLUMNS) * GRID_SPACING_Y,
      };
      gridIndex += 1;
      const newNode = { ...incoming, position, data: { ...incoming.data, sourceOrigin: "synced" } };
      introspectedIdToFinalId.set(incoming.id, newNode.id);
      nextNodes.push(newNode);
      added.push(key);
      ledgerTables.add(key);
      continue;
    }

    // A table counts as already-synced if it carries the tag OR the sync
    // ledger already lists its key. The ledger only ever gains a key when
    // reconcile itself synced that table (`ledgerTables.add` below), so a
    // ledger hit on an untagged node means it was synced by a build that
    // predates the `sourceOrigin` tag - NOT that the user built it by hand.
    // Without this, that node is misread as a manual table forever: every
    // resync reports it as a phantom conflict, and "View data" / the live-
    // DB icon never light up for it because nothing ever writes the tag.
    if (existing.data?.sourceOrigin === "synced" || ledgerTables.has(key)) {
      // Already synced in an earlier pass - its columns are refreshed from
      // the database after this loop (refreshColumns: matched by name, ids
      // kept), since the live table is the source of truth for them.
      //
      // Two in-place heals, both single scalars with no id remapping:
      //   - back-fill data.sourceOrigin on a node synced before the tag
      //     existed, so it's recognised as a live table from here on
      //   - back-fill data.schema on a node synced before multi-schema
      //     existed (schema-less), else it's compiled as a bare unqualified
      //     name in FROM/JOIN forever (a `shop` table as bare "orders" ->
      //     42P01)
      const patch = {};
      if (existing.data?.sourceOrigin !== "synced") patch.sourceOrigin = "synced";
      if (existing.data?.schema == null && incoming.data?.schema != null) {
        patch.schema = incoming.data.schema;
      }
      const idx = nextNodes.indexOf(existing);
      if (idx !== -1) {
        nextNodes[idx] = { ...existing, data: { ...existing.data, ...patch } };
        refreshed.push({ idx, incoming });
      }
      introspectedIdToFinalId.set(incoming.id, existing.id);
      // Keep the ledger authoritative even when the match was tag-only.
      ledgerTables.add(key);
    } else {
      conflicts.push({ name: key, reason: `A manual table named "${key}" already exists.` });
    }
  }

  const colIdMap = refreshColumns(nextNodes, refreshed, introspectedIdToFinalId);
  const refreshedIds = new Set(refreshed.map((r) => nextNodes[r.idx].id));

  // Additive only - an edge already present (matched by endpoint node ids
  // + column names) is left exactly as-is, never re-created/updated. Any
  // edge touching a conflicted/removed-and-ignored table has no valid
  // final id to remap to and is correctly dropped here. A signature the
  // ledger already has - synced before, then deliberately deleted - is
  // never re-added either, same reasoning as tables above.
  const existingEdgeKeys = new Set(
    existingEdges.map((e) => `${e.source}|${e.target}|${e.sourceHandle || ""}|${e.targetHandle || ""}`),
  );
  const nextEdges = [...existingEdges];
  for (const incomingEdge of introspected.edges) {
    const sourceId = introspectedIdToFinalId.get(incomingEdge.source);
    const targetId = introspectedIdToFinalId.get(incomingEdge.target);
    if (!sourceId || !targetId) continue;

    const sourceHandle = remapHandle(introspectedNodesById.get(incomingEdge.source), incomingEdge.sourceHandle, sourceId, colIdMap, "source");
    const targetHandle = remapHandle(introspectedNodesById.get(incomingEdge.target), incomingEdge.targetHandle, targetId, colIdMap, "target");
    const key = `${sourceId}|${targetId}|${sourceHandle || ""}|${targetHandle || ""}`;
    if (existingEdgeKeys.has(key)) continue;

    const signature = edgeSignature(introspectedNodesById, incomingEdge);
    if (signature && ledgerEdges.has(signature)) continue;

    nextEdges.push({
      ...incomingEdge,
      id: `e${sourceId}-${targetId}-${nanoid(6)}`,
      source: sourceId,
      target: targetId,
      sourceHandle,
      targetHandle,
      // sourceColumnHandle/targetColumnHandle must stay identical to the
      // top-level handles above - schemaStore.js's findColumnByHandle
      // (syncEdgeReference, deleteEdge, reverseEdgeDirection) reads THESE
      // fields, not the top-level ones, to resolve an edge back to a
      // column.
      data: {
        ...incomingEdge.data,
        sourceTableId: sourceId,
        targetTableId: targetId,
        sourceColumnHandle: sourceHandle,
        targetColumnHandle: targetHandle,
      },
    });
    existingEdgeKeys.add(key);
    if (signature) ledgerEdges.add(signature);
  }

  // Enums: additive by name only - an existing enum (whatever its origin)
  // is never overwritten, so a user's own edits to an enum's values can
  // never be silently clobbered by a resync.
  const existingEnumNames = new Set(existingEnums.map((e) => e.name));
  const nextEnums = [...existingEnums];
  for (const incomingEnum of introspected.enums) {
    if (existingEnumNames.has(incomingEnum.name)) continue;
    nextEnums.push(incomingEnum);
    existingEnumNames.add(incomingEnum.name);
  }

  // Synced tables the database no longer has: out of the design, and out of
  // the ledger so a table re-created later comes back.
  const introspectedKeys = new Set(introspected.nodes.map((n) => tableKey(n.data?.schema, n.data?.label)));
  const inScope = (n) => scopeSchema == null || (n.data?.schema ?? scopeSchema) === scopeSchema;
  const removed = [];
  const removedIds = new Set();
  for (const n of nextNodes) {
    if (n.type !== "tableNode" || n.data?.sourceOrigin !== "synced" || !inScope(n)) continue;
    const key = tableKey(n.data?.schema ?? (scopeSchema || null), n.data?.label);
    if (introspectedKeys.has(key) || introspectedKeys.has(n.data?.label)) continue;
    removed.push(key);
    removedIds.add(n.id);
    ledgerTables.delete(key);
    for (const sig of [...ledgerEdges]) {
      if (sig.startsWith(`${key}.`) || sig.includes(`->${key}.`)) ledgerEdges.delete(sig);
    }
  }
  const keptNodes = removedIds.size
    ? nextNodes
        .filter((n) => !removedIds.has(n.id))
        .map((n) =>
          n.data?.columns?.some((c) => removedIds.has(c.references?.tableId))
            ? {
                ...n,
                data: {
                  ...n.data,
                  columns: n.data.columns.map((c) =>
                    removedIds.has(c.references?.tableId) ? { ...c, references: null, isForeignKey: false } : c,
                  ),
                },
              }
            : n,
        )
    : nextNodes;

  // A line whose column left a refreshed table (dropped in the database) goes
  // too; lines into refreshed tables are flagged virtual unless the database
  // has the link.
  const nodesById = new Map(keptNodes.map((n) => [n.id, n]));
  const liveEdges = nextEdges.filter((e) => {
    if (removedIds.has(e.source) || removedIds.has(e.target)) return false;
    for (const [nodeId, handle] of [
      [e.source, e.data?.sourceColumnHandle || e.sourceHandle],
      [e.target, e.data?.targetColumnHandle || e.targetHandle],
    ]) {
      if (refreshedIds.has(nodeId) && handle && !findColumnByHandle(nodesById.get(nodeId), handle)) return false;
    }
    return true;
  }).map((e) => {
    if (!refreshedIds.has(e.target)) return e;
    const col = findColumnByHandle(nodesById.get(e.target), e.data?.targetColumnHandle || e.targetHandle);
    const virtual = !col?.references || !!col.references.virtual;
    return !!e.data?.virtual === virtual ? e : { ...e, data: { ...e.data, virtual } };
  });

  return {
    nodes: keptNodes,
    edges: liveEdges,
    enums: nextEnums,
    added,
    removed,
    conflicts,
    ledger: { tables: [...ledgerTables], edges: [...ledgerEdges] },
  };
}
