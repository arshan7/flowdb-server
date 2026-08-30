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
export function reconcileSchema(existingBranch, introspected, ledger) {
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

    if (existing.data?.sourceOrigin === "synced") {
      // Already synced in an earlier pass - left completely untouched.
      // (v1 deliberately doesn't refresh an existing synced table's own
      // columns/constraints on resync - doing that correctly means
      // preserving column ids by name-match AND remapping every
      // `references.columnId` pointer that used the introspected batch's
      // fresh ids, which is real enough complexity to earn its own pass
      // rather than risk getting subtly wrong here. New tables and
      // conflicts - what was actually asked for - are unaffected by this.)
      //
      // The ONE exception: back-fill data.schema on a node synced before
      // multi-schema existed (schema-less). It's a single scalar, no id
      // remapping, and without it every pre-existing connected source
      // stays unqualified in FROM/JOIN forever (a `shop` table compiled as
      // bare "orders" -> 42P01). A resync now heals it in place.
      if (existing.data?.schema == null && incoming.data?.schema != null) {
        const idx = nextNodes.indexOf(existing);
        if (idx !== -1) {
          nextNodes[idx] = { ...existing, data: { ...existing.data, schema: incoming.data.schema } };
        }
      }
      introspectedIdToFinalId.set(incoming.id, existing.id);
    } else {
      conflicts.push({ name: key, reason: `A manual table named "${key}" already exists.` });
    }
  }

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

    const sourceHandle = incomingEdge.sourceHandle?.replace(incomingEdge.source, sourceId);
    const targetHandle = incomingEdge.targetHandle?.replace(incomingEdge.target, targetId);
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

  return {
    nodes: nextNodes,
    edges: nextEdges,
    enums: nextEnums,
    added,
    conflicts,
    ledger: { tables: [...ledgerTables], edges: [...ledgerEdges] },
  };
}
