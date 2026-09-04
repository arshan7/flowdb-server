// FK-relationship join resolution over a branch's canvas nodes. Extracted
// from tablespace.js (slice 5) so the Model compiler in queryEngine.js can
// use the exact same path-finding the /query route already does - a
// builder Model's joins must resolve identically to a report's.
//
// All of it reads `column.references` (the same source of truth
// schemaStore.js writes for the canvas's own relationship edges) rather
// than re-deriving a path from edge cardinality strings.

// Phase 4.4a - direct (1-hop) join between two table nodes, checking both
// FK directions since either side could hold the key. First path found
// wins if several exist (no picker yet). `direction`: "base_to_join" =
// base holds the FK (each base row -> at most one joined row);
// "join_to_base" = joined side holds it (base row -> possibly many).
export function findJoinPath(baseNode, joinNode) {
  const baseColumns = baseNode.data?.columns || [];
  const joinColumns = joinNode.data?.columns || [];

  for (const col of baseColumns) {
    if (col.isForeignKey && col.references?.tableId === joinNode.id) {
      const target = joinColumns.find((c) => c.id === col.references.columnId);
      if (target) return { baseColumn: col.name, joinColumn: target.name, direction: "base_to_join" };
    }
  }
  for (const col of joinColumns) {
    if (col.isForeignKey && col.references?.tableId === baseNode.id) {
      const target = baseColumns.find((c) => c.id === col.references.columnId);
      if (target) return { baseColumn: target.name, joinColumn: col.name, direction: "join_to_base" };
    }
  }
  return null;
}

// Post-4.4b - forward (many-to-one) FK neighbours only. A chain built from
// these stays "each base row -> at most one row at the far end",
// transitively, no matter how many hops.
export function getForwardNeighbors(node, allNodes) {
  const neighbors = [];
  for (const col of node.data?.columns || []) {
    if (!col.isForeignKey || !col.references?.tableId) continue;
    const target = allNodes.find((n) => n.id === col.references.tableId);
    if (!target) continue;
    const targetCol = (target.data?.columns || []).find((c) => c.id === col.references.columnId);
    if (!targetCol) continue;
    neighbors.push({ node: target, baseColumn: col.name, joinColumn: targetCol.name });
  }
  return neighbors;
}

// Tables whose OWN FK points AT `node` (each of node's rows may have many
// on that side - e.g. an order's line items). The reverse-direction half
// of findJoinPath's 1-hop check, generalized to every candidate table at
// once. Used ONLY by buildJoinResolutionGraph below, and only to seed the
// very first hop - never to extend a chain further.
function getReverseNeighbors(node, allNodes) {
  const neighbors = [];
  for (const other of allNodes) {
    if (other.id === node.id) continue;
    for (const col of other.data?.columns || []) {
      if (!col.isForeignKey || col.references?.tableId !== node.id) continue;
      const target = (node.data?.columns || []).find((c) => c.id === col.references.columnId);
      if (!target) continue;
      neighbors.push({ node: other, baseColumn: target.name, joinColumn: col.name });
    }
  }
  return neighbors;
}

// One BFS from `baseNode` over forward edges only - shortest path to each
// reachable table (Cube.dev's ambiguity resolution); `visited` doubles as
// cycle protection. Every hop, including the first, is many-to-one from
// `baseNode`'s own perspective, so a table in this graph is guaranteed
// "at most one row at the far end" per base row, transitively - this is
// the property resolveTerm relies on for a calculated measure's scalar
// "value" term (see tablespace.js's own comment there) and must stay
// exactly this strict. Do not widen this one - see
// buildJoinResolutionGraph below for the general-join version.
export function buildForwardJoinGraph(baseNode, allNodes) {
  const parent = new Map(); // tableId -> { fromTableId, baseColumn, joinColumn }
  const order = []; // tableIds in BFS-discovery (= dependency-safe) order
  const visited = new Set([baseNode.id]);
  const queue = [baseNode];
  while (queue.length) {
    const current = queue.shift();
    for (const { node: neighborNode, baseColumn, joinColumn } of getForwardNeighbors(current, allNodes)) {
      if (visited.has(neighborNode.id)) continue;
      visited.add(neighborNode.id);
      parent.set(neighborNode.id, { fromTableId: current.id, baseColumn, joinColumn });
      order.push(neighborNode.id);
      queue.push(neighborNode);
    }
  }
  return { parent, order };
}

// The graph resolveJoins actually walks: buildForwardJoinGraph's forward
// chain from baseNode, PLUS every table reached by the single reverse hop
// off baseNode (a one-to-many related table, e.g. an order's line items),
// continued forward-only from there. A one-to-many table already fans out
// a base row into several - a further many-to-one hop from it (line items
// -> products) doesn't compound that, it only enriches rows that already
// exist, the same guarantee a pure-forward chain gives. A second reverse
// hop is deliberately never seeded (only baseNode's own reverse neighbours
// are looked up, nothing downstream of them) - that WOULD compound an
// ambiguous fan-out.
//
// Deliberately a SEPARATE function from buildForwardJoinGraph, not a
// widening of it in place: that one is also used directly (tablespace.js)
// to gate a calculated measure's scalar "value" term, where a one-to-many
// hop anywhere in the chain must stay unreachable - mixing the two graphs
// would silently let a fan-out path through as if it were single-valued.
function buildJoinResolutionGraph(baseNode, allNodes) {
  const parent = new Map();
  const order = [];
  const visited = new Set([baseNode.id]);
  const queue = [];
  for (const { node, baseColumn, joinColumn } of [
    ...getForwardNeighbors(baseNode, allNodes),
    ...getReverseNeighbors(baseNode, allNodes),
  ]) {
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    parent.set(node.id, { fromTableId: baseNode.id, baseColumn, joinColumn });
    order.push(node.id);
    queue.push(node);
  }
  while (queue.length) {
    const current = queue.shift();
    for (const { node: neighborNode, baseColumn, joinColumn } of getForwardNeighbors(current, allNodes)) {
      if (visited.has(neighborNode.id)) continue;
      visited.add(neighborNode.id);
      parent.set(neighborNode.id, { fromTableId: current.id, baseColumn, joinColumn });
      order.push(neighborNode.id);
      queue.push(neighborNode);
    }
  }
  return { parent, order };
}

// Resolve a list of requested join table ids against `baseNode` - direct
// (1-hop, either FK direction) first, then a forward multi-hop chain (see
// buildJoinResolutionGraph above - this is the wider of the two graphs;
// fan-out is an accepted, expected property of a model/report join, not a
// safety hazard the way it is for a scalar term). Returns { joinClauses,
// joinNodes } on success or { error: <message> }. `joinClauses` is the
// shape compileQuery / compileModel consume: { tableName, fromTableName,
// baseColumn, joinColumn }. Shared by the /query route and the Model
// compiler so a report's joins and a builder Model's joins resolve by the
// exact same rules. `joinedTableNames` dedupes hops shared by more than
// one requested chain.
export function resolveJoins(baseNode, joinTableIds, allTableNodes, nodesById, defaultSchema = null) {
  const forwardGraph = buildJoinResolutionGraph(baseNode, allTableNodes);
  const joinNodes = [];
  const joinClauses = [];
  const joinedTableNames = new Set();
  for (const joinTableId of joinTableIds || []) {
    const joinNode = nodesById.get(joinTableId);
    if (!joinNode || joinNode.type !== "tableNode") return { error: `Table ${joinTableId} not found.` };
    const direct = findJoinPath(baseNode, joinNode);
    const chain = direct
      ? [
          {
            tableId: joinNode.id,
            tableName: joinNode.data.label,
            baseColumn: direct.baseColumn,
            joinColumn: direct.joinColumn,
            fromTableId: baseNode.id,
          },
        ]
      : chainTo(forwardGraph, nodesById, joinTableId);
    if (!chain) {
      return {
        error: `"${joinNode.data?.label}" isn't reachable from "${baseNode.data?.label}" through a direct or many-to-one relationship.`,
      };
    }
    for (const hop of chain) {
      // Dedupe by table id, not label - two schemas in one source can hold
      // a same-named table, and a by-label lookup would attach the wrong
      // node (and its wrong schema) to the JOIN.
      const hopNode = nodesById.get(hop.tableId) || allTableNodes.find((n) => n.data?.label === hop.tableName);
      const hopKey = hop.tableId || hop.tableName;
      if (joinedTableNames.has(hopKey)) continue;
      joinedTableNames.add(hopKey);
      const fromTableName = hop.fromTableId === baseNode.id ? baseNode.data.label : nodesById.get(hop.fromTableId)?.data?.label;
      joinClauses.push({
        tableName: hop.tableName,
        tableSchema: hopNode?.data?.schema ?? defaultSchema,
        fromTableName,
        baseColumn: hop.baseColumn,
        joinColumn: hop.joinColumn,
      });
      if (hopNode) joinNodes.push(hopNode);
    }
  }
  return { joinClauses, joinNodes };
}

// Walks `graph.parent` back from `targetId` to the base, returning the
// chain base-to-target. null if unreachable via an all-forward path.
export function chainTo(graph, nodesById, targetId) {
  if (!graph.parent.has(targetId)) return null;
  const hops = [];
  let cur = targetId;
  while (graph.parent.has(cur)) {
    const { fromTableId, baseColumn, joinColumn } = graph.parent.get(cur);
    const curNode = nodesById.get(cur);
    const tableName = curNode?.data?.label;
    if (!tableName) return null;
    hops.unshift({
      tableId: cur,
      tableName,
      tableSchema: curNode?.data?.schema ?? null,
      baseColumn,
      joinColumn,
      fromTableId,
    });
    cur = fromTableId;
  }
  return hops;
}
