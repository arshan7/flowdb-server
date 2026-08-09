import { nanoid } from "nanoid";
import { introspectPostgres } from "./pgIntrospect.js";
import { toTablespaceSchema } from "./toTablespaceSchema.js";
import * as store from "./tablespaceStore.js";

// New synced tables are placed in a simple grid below whatever's already
// on the canvas - not a real dagre layout (that's a client-only util,
// dagreLayout.js, and pulling it into the server is more machinery than
// this needs). "Auto-arrange" in FloatingToolbar.jsx is one click away
// for anyone who wants it tidied up properly afterward.
const GRID_COLUMNS = 5;
const GRID_SPACING_X = 320;
const GRID_SPACING_Y = 220;
const GRID_MARGIN_Y = 300;

// Tagged so callers (the connect/sync routes) can tell "syncSource's own,
// already-user-facing message" apart from a raw pg driver error, which
// needs describeIntrospectError.js's mapping instead - a raw pg error
// generally lacks a `.code` a route could reliably switch on instead (the
// "does not support SSL" failure is a plain Error with no code at all).
function friendlyError(message) {
  const err = new Error(message);
  err.isFriendly = true;
  return err;
}

function maxNodeY(nodes) {
  let max = 0;
  for (const n of nodes) {
    const y = n.position?.y ?? 0;
    if (y > max) max = y;
  }
  return max;
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
  return `${sourceNode.data.label}.${sourceColumn.name}->${targetNode.data.label}.${targetColumn.name}`;
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

  const existingByName = new Map(
    existingNodes.filter((n) => n.type === "tableNode").map((n) => [n.data?.label, n]),
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
    const existing = existingByName.get(name);

    if (!existing) {
      if (ledgerTables.has(name)) continue; // synced before, user removed it - stays removed

      const position = {
        x: (gridIndex % GRID_COLUMNS) * GRID_SPACING_X,
        y: startY + Math.floor(gridIndex / GRID_COLUMNS) * GRID_SPACING_Y,
      };
      gridIndex += 1;
      const newNode = { ...incoming, position, data: { ...incoming.data, sourceOrigin: "synced" } };
      introspectedIdToFinalId.set(incoming.id, newNode.id);
      nextNodes.push(newNode);
      added.push(name);
      ledgerTables.add(name);
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
      introspectedIdToFinalId.set(incoming.id, existing.id);
    } else {
      conflicts.push({ name, reason: `A manual table named "${name}" already exists.` });
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

// Orchestrates one full sync for a single Connected source: decrypt ->
// introspect the live database -> reconcile against the source's MAIN
// branch only (forks are for experimentation, never sync targets - a
// fork's whole point is diverging from main on purpose) -> save -> stamp
// last_synced_at. Shared by both the on-demand "Sync now" route and the
// periodic scheduler (syncScheduler.js), so the two can never drift into
// different reconciliation behavior.
export async function syncSource(sourceId) {
  const secrets = await store.getSourceConnectionSecrets(sourceId);
  if (!secrets) {
    throw friendlyError("This source isn't connected.");
  }

  const raw = await introspectPostgres(secrets.connectionString, secrets.schema);
  const introspected = toTablespaceSchema(raw);

  const branch = await store.getMainBranch(sourceId);
  if (!branch) {
    throw friendlyError("This source has no main branch to sync into.");
  }

  const ledger = await store.getSourceSyncLedger(sourceId);
  const result = reconcileSchema(branch, introspected, ledger);
  await store.saveBranch(sourceId, branch.id, {
    nodes: result.nodes,
    edges: result.edges,
    enums: result.enums,
    pages: branch.pages,
    schemaVersion: branch.schemaVersion,
  });
  await store.saveSourceSyncLedger(sourceId, result.ledger);
  await store.markSourceSynced(sourceId);

  return { added: result.added, conflicts: result.conflicts };
}
