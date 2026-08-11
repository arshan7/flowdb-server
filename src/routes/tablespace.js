import { Router } from "express";
import * as store from "../lib/tablespaceStore.js";
import { diffSchemas } from "../lib/schemaDiff.js";
import { mergeSchemas } from "../lib/schemaMerge.js";
import { syncSource } from "../lib/syncSource.js";
import { describeIntrospectError } from "../lib/introspectErrors.js";
import {
  compileQuery,
  runQuery,
  paginateRows,
  ALLOWED_PAGE_SIZES,
  DEFAULT_PAGE_SIZE,
  MAX_ROWS,
} from "../lib/queryEngine.js";

const QUERY_AGGREGATIONS = new Set(["count", "sum", "avg", "min", "max"]);
const QUERY_OPERATORS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "contains"]);
// Phase 4.4b - calculated measures' arithmetic operator.
const QUERY_CALC_OPERATORS = new Set(["+", "-", "*", "/"]);

// Phase 4.4a - direct (1-hop) join resolution for /sources/:sourceId/query.
// Reuses column.references (the same source of truth syncEdgeReference/
// schemaStore.js already writes for the canvas's own relationship edges)
// rather than re-deriving a join path from edge cardinality strings.
// Checks both FK directions since either table could hold the foreign
// key. If multiple FK paths exist between the same two tables, the first
// one found wins - a known v1 simplification (no picker for which path).
function findJoinPath(baseNode, joinNode) {
  const baseColumns = baseNode.data?.columns || [];
  const joinColumns = joinNode.data?.columns || [];

  for (const col of baseColumns) {
    if (col.isForeignKey && col.references?.tableId === joinNode.id) {
      const target = joinColumns.find((c) => c.id === col.references.columnId);
      if (target) return { baseColumn: col.name, joinColumn: target.name };
    }
  }
  for (const col of joinColumns) {
    if (col.isForeignKey && col.references?.tableId === baseNode.id) {
      const target = baseColumns.find((c) => c.id === col.references.columnId);
      if (target) return { baseColumn: target.name, joinColumn: col.name };
    }
  }
  return null;
}

export const tablespaceRouter = Router();

// Wraps an async route handler so a rejected promise reaches Express's
// error-handling middleware below instead of becoming an unhandled
// rejection - Express 4 (this app's version) doesn't do this itself.
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

tablespaceRouter.get(
  "/projects",
  wrap(async (req, res) => {
    res.json(await store.listProjects());
  }),
);

tablespaceRouter.post(
  "/projects",
  wrap(async (req, res) => {
    const { name, template, createdAt } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required." });
      return;
    }
    try {
      const project = await store.createProject({ name: name.trim(), template, createdAt });
      res.status(201).json(project);
    } catch (err) {
      if (err.code === "23505") {
        res.status(409).json({ error: `A project named "${name.trim()}" already exists` });
        return;
      }
      throw err;
    }
  }),
);

tablespaceRouter.get(
  "/projects/:id",
  wrap(async (req, res) => {
    const project = await store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    res.json(project);
  }),
);

tablespaceRouter.patch(
  "/projects/:id",
  wrap(async (req, res) => {
    const project = await store.updateProject(req.params.id, req.body || {});
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    res.json(project);
  }),
);

tablespaceRouter.delete(
  "/projects/:id",
  wrap(async (req, res) => {
    const deleted = await store.deleteProject(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    res.json({ success: true });
  }),
);

// --- Sources: the connected systems living inside one project (ROADMAP.md
// Phase 3 - a Neon database, a Supabase project, a Mongo project, etc, each
// its own full canvas). Nested under /projects/:id since a source only ever
// makes sense in the context of the project that owns it, but branches and
// checkpoints below are scoped by source ALONE (not project+source) since
// source_id is already the sufficient, unambiguous key for those.

tablespaceRouter.get(
  "/projects/:id/sources",
  wrap(async (req, res) => {
    res.json(await store.listSources(req.params.id));
  }),
);

tablespaceRouter.post(
  "/projects/:id/sources",
  wrap(async (req, res) => {
    const { name, type } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required." });
      return;
    }
    try {
      const source = await store.createSource(req.params.id, { name: name.trim(), type });
      res.status(201).json(source);
    } catch (err) {
      if (err.code === "23505") {
        res.status(409).json({ error: `A source named "${name.trim()}" already exists in this project.` });
        return;
      }
      throw err;
    }
  }),
);

tablespaceRouter.get(
  "/projects/:id/sources/:sourceId",
  wrap(async (req, res) => {
    const source = await store.getSource(req.params.sourceId);
    if (!source || String(source.projectId) !== String(req.params.id)) {
      res.status(404).json({ error: "Source not found." });
      return;
    }
    res.json(source);
  }),
);

tablespaceRouter.patch(
  "/projects/:id/sources/:sourceId",
  wrap(async (req, res) => {
    const { name } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required." });
      return;
    }
    const existing = await store.getSource(req.params.sourceId);
    if (!existing || String(existing.projectId) !== String(req.params.id)) {
      res.status(404).json({ error: "Source not found." });
      return;
    }
    try {
      const source = await store.renameSource(req.params.sourceId, name.trim());
      res.json(source);
    } catch (err) {
      if (err.code === "23505") {
        res.status(409).json({ error: `A source named "${name.trim()}" already exists in this project.` });
        return;
      }
      throw err;
    }
  }),
);

tablespaceRouter.delete(
  "/projects/:id/sources/:sourceId",
  wrap(async (req, res) => {
    const existing = await store.getSource(req.params.sourceId);
    if (!existing || String(existing.projectId) !== String(req.params.id)) {
      res.status(404).json({ error: "Source not found." });
      return;
    }
    await store.deleteSource(req.params.sourceId);
    res.json({ success: true });
  }),
);

// --- Connected sources: linking a source to a real live Postgres/MySQL
// database (flowdb-server's own introspection only speaks Postgres wire
// protocol today - MySQL is a client-side type label with no live path
// yet). Connecting triggers an immediate full sync; after that,
// syncScheduler.js keeps it current periodically, and /sync below is the
// on-demand version of the exact same operation. See syncSource.js for
// the full pull-only, additive reconciliation rules.

tablespaceRouter.post(
  "/projects/:id/sources/:sourceId/connection",
  wrap(async (req, res) => {
    const { connectionString, schema } = req.body || {};
    if (!connectionString || typeof connectionString !== "string") {
      res.status(400).json({ error: "connectionString is required." });
      return;
    }
    const existing = await store.getSource(req.params.sourceId);
    if (!existing || String(existing.projectId) !== String(req.params.id)) {
      res.status(404).json({ error: "Source not found." });
      return;
    }
    await store.setSourceConnection(req.params.sourceId, { connectionString, schema });
    try {
      const result = await syncSource(req.params.sourceId);
      res.status(201).json(result);
    } catch (err) {
      // The connection was saved, but the first sync failed (bad
      // credentials, unreachable host, empty schema, etc.) - roll the
      // source back to disconnected rather than leaving it stuck
      // "Connected" with a connection string that's never actually been
      // proven to work.
      await store.clearSourceConnection(req.params.sourceId);
      // eslint-disable-next-line no-console
      console.error("[sources] connect failed:", err.code || err.message);
      res.status(502).json({ error: err.isFriendly ? err.message : describeIntrospectError(err) });
    }
  }),
);

tablespaceRouter.delete(
  "/projects/:id/sources/:sourceId/connection",
  wrap(async (req, res) => {
    const existing = await store.getSource(req.params.sourceId);
    if (!existing || String(existing.projectId) !== String(req.params.id)) {
      res.status(404).json({ error: "Source not found." });
      return;
    }
    const source = await store.clearSourceConnection(req.params.sourceId);
    res.json(source);
  }),
);

tablespaceRouter.post(
  "/sources/:sourceId/sync",
  wrap(async (req, res) => {
    try {
      const result = await syncSource(req.params.sourceId);
      res.json(result);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[sources] sync failed:", err.code || err.message);
      res
        .status(err.isFriendly ? 400 : 502)
        .json({ error: err.isFriendly ? err.message : describeIntrospectError(err) });
    }
  }),
);

// Clears the sync ledger only - doesn't touch the branch's own nodes/edges
// or run a sync itself. A previously-removed table/relationship stays
// exactly as removed until the next actual "Sync now" (or the periodic
// one) re-pulls it.
tablespaceRouter.post(
  "/sources/:sourceId/sync/reset",
  wrap(async (req, res) => {
    await store.resetSourceSyncLedger(req.params.sourceId);
    res.json({ success: true });
  }),
);

// Phase 4.2 (single table) / 4.4a (direct joins + SQL transparency) - runs
// a report query against a Connected source's real live database. The
// request only ever carries ids referencing entries already saved in a
// table's own semanticModel (set via SemanticLayerScreen.jsx) or real
// tables it's directly related to - every table/column name actually used
// in the compiled SQL is resolved HERE, server-side, against stored data,
// never taken from the request body directly. `aggregation`/filter
// `operator` are re-validated against a fixed set even though the editor
// UI already only ever writes one of these - the branch's own nodes JSONB
// has no other validation on save (see saveBranch), so a hand-crafted
// request could otherwise have written anything into
// semanticModel.aggregation before this route ever reads it back.
tablespaceRouter.post(
  "/sources/:sourceId/query",
  wrap(async (req, res) => {
    const {
      tableId,
      joinTableIds = [],
      measureIds = [],
      dimensionIds = [],
      filters = [],
      offset = 0,
      pageSize = DEFAULT_PAGE_SIZE,
    } = req.body || {};
    if (!tableId) {
      res.status(400).json({ error: "tableId is required." });
      return;
    }
    if (!ALLOWED_PAGE_SIZES.includes(pageSize)) {
      res.status(400).json({ error: `pageSize must be one of ${ALLOWED_PAGE_SIZES.join(", ")}.` });
      return;
    }
    if (!Number.isInteger(offset) || offset < 0 || offset + pageSize > MAX_ROWS) {
      res.status(400).json({ error: `offset must be a non-negative integer, and offset + pageSize can't exceed ${MAX_ROWS}.` });
      return;
    }

    const secrets = await store.getSourceConnectionSecrets(req.params.sourceId);
    if (!secrets) {
      res.status(400).json({ error: "This source isn't connected." });
      return;
    }

    const branch = await store.getMainBranch(req.params.sourceId);
    const nodesById = new Map((branch?.nodes || []).map((n) => [n.id, n]));
    const node = nodesById.get(tableId);
    if (!node || node.type !== "tableNode") {
      res.status(404).json({ error: "Table not found." });
      return;
    }

    // Every joinTableId is verified against a REAL foreign-key
    // relationship to the base table - the client only ever claims a
    // table id, never the join columns themselves.
    const joinNodes = [];
    const joinClauses = [];
    for (const joinTableId of joinTableIds) {
      const joinNode = nodesById.get(joinTableId);
      if (!joinNode || joinNode.type !== "tableNode") {
        res.status(400).json({ error: `Table ${joinTableId} not found.` });
        return;
      }
      const path = findJoinPath(node, joinNode);
      if (!path) {
        res.status(400).json({
          error: `"${joinNode.data?.label}" isn't directly related to "${node.data?.label}".`,
        });
        return;
      }
      joinNodes.push(joinNode);
      joinClauses.push({ tableName: joinNode.data.label, baseColumn: path.baseColumn, joinColumn: path.joinColumn });
    }

    // Dimensions/filters may reference the base table or any validated
    // join table; measures resolve against the base table ONLY (see
    // queryEngine.js's own comment on why - avoids join-fanout
    // double-counting an aggregate).
    const dimensionSources = [node, ...joinNodes];
    const findDimension = (id) => {
      for (const src of dimensionSources) {
        const model = src.data?.semanticModel || {};
        const dim = (model.dimensions || []).find((d) => d.id === id);
        if (!dim) continue;
        const col = (src.data?.columns || []).find((c) => c.id === dim.columnId);
        if (!col) continue;
        return { id: dim.id, label: dim.label || col.name, columnName: col.name, tableName: src.data.label };
      }
      return null;
    };

    const baseSemanticModel = node.data?.semanticModel || { dimensions: [], measures: [] };
    const baseColumnsById = new Map((node.data?.columns || []).map((c) => [c.id, c]));
    const unknown = [];

    const dimensions = dimensionIds.map((id) => {
      const resolved = findDimension(id);
      if (!resolved) unknown.push(id);
      return resolved;
    });

    // Phase 4.4b - a calculated measure's terms resolve exactly like a
    // simple measure's own aggregation/columnId (base table only, same
    // join-fanout reasoning) - this just does that resolution twice.
    const resolveTerm = (term) => {
      if (!term || !QUERY_AGGREGATIONS.has(term.aggregation)) return null;
      if (term.aggregation === "count") return { aggregation: "count", columnName: null };
      const col = baseColumnsById.get(term.columnId);
      return col ? { aggregation: term.aggregation, columnName: col.name } : null;
    };

    const measures = measureIds.map((id) => {
      const measure = (baseSemanticModel.measures || []).find((m) => m.id === id);
      if (!measure) {
        unknown.push(id);
        return null;
      }

      if (measure.kind === "calculated") {
        if (!QUERY_CALC_OPERATORS.has(measure.operator)) {
          unknown.push(id);
          return null;
        }
        const termA = resolveTerm(measure.termA);
        const termB = resolveTerm(measure.termB);
        if (!termA || !termB) {
          unknown.push(id);
          return null;
        }
        return {
          id: measure.id,
          label: measure.label || "Calculated",
          kind: "calculated",
          operator: measure.operator,
          termA,
          termB,
        };
      }

      if (!QUERY_AGGREGATIONS.has(measure.aggregation)) {
        unknown.push(id);
        return null;
      }
      if (measure.aggregation === "count") {
        return { id: measure.id, label: measure.label || "Count", aggregation: "count", columnName: null };
      }
      const col = baseColumnsById.get(measure.columnId);
      if (!col) {
        unknown.push(id);
        return null;
      }
      return { id: measure.id, label: measure.label || col.name, aggregation: measure.aggregation, columnName: col.name };
    });

    const resolvedFilters = [];
    for (const f of filters) {
      const dim = findDimension(f?.dimensionId);
      if (!dim || !QUERY_OPERATORS.has(f.operator)) {
        res.status(400).json({ error: "Invalid filter." });
        return;
      }
      resolvedFilters.push({ columnName: dim.columnName, tableName: dim.tableName, operator: f.operator, value: f.value });
    }

    if (unknown.length) {
      res.status(400).json({ error: `Unknown dimension/measure id(s): ${unknown.join(", ")}` });
      return;
    }

    let compiled;
    try {
      compiled = compileQuery({
        tableName: node.data.label,
        measures,
        dimensions,
        filters: resolvedFilters,
        joins: joinClauses,
        offset,
        pageSize,
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
      return;
    }

    try {
      const rawRows = await runQuery(secrets.connectionString, compiled.sql, compiled.params);
      const { rows, hasMore } = paginateRows(rawRows, pageSize);
      res.json({
        columns: [...dimensions, ...measures].map((c) => ({ id: c.id, label: c.label })),
        rows,
        hasMore,
        sql: compiled.sql,
        params: compiled.params,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[sources] query failed:", err.code || err.message);
      res.status(err.isFriendly ? 400 : 502).json({ error: describeIntrospectError(err) });
    }
  }),
);

// --- Reports (ROADMAP.md Phase 4.4): saved, reusable query definitions
// against a source's semantic model. Scoped by sourceId alone, same
// reasoning as /sources/:sourceId/query above - a report's fields only
// ever resolve against that source's main branch regardless of which
// branch is currently checked out client-side.

tablespaceRouter.get(
  "/sources/:sourceId/reports",
  wrap(async (req, res) => {
    res.json(await store.listReports(req.params.sourceId));
  }),
);

tablespaceRouter.get(
  "/sources/:sourceId/reports/:reportId",
  wrap(async (req, res) => {
    const report = await store.getReport(req.params.sourceId, req.params.reportId);
    if (!report) {
      res.status(404).json({ error: "Report not found." });
      return;
    }
    res.json(report);
  }),
);

tablespaceRouter.post(
  "/sources/:sourceId/reports",
  wrap(async (req, res) => {
    const { name, tableId, joinTableIds, dimensionIds, measureIds, filters, chartType, pageSize } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required." });
      return;
    }
    if (!tableId) {
      res.status(400).json({ error: "tableId is required." });
      return;
    }
    try {
      const report = await store.createReport(req.params.sourceId, {
        name: name.trim(),
        tableId,
        joinTableIds,
        dimensionIds,
        measureIds,
        filters,
        chartType,
        pageSize,
      });
      res.status(201).json(report);
    } catch (err) {
      if (err.code === "23505") {
        res.status(409).json({ error: `A report named "${name.trim()}" already exists for this source.` });
        return;
      }
      throw err;
    }
  }),
);

tablespaceRouter.patch(
  "/sources/:sourceId/reports/:reportId",
  wrap(async (req, res) => {
    const { name } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required." });
      return;
    }
    try {
      const report = await store.renameReport(req.params.sourceId, req.params.reportId, name.trim());
      if (!report) {
        res.status(404).json({ error: "Report not found." });
        return;
      }
      res.json(report);
    } catch (err) {
      if (err.code === "23505") {
        res.status(409).json({ error: `A report named "${name.trim()}" already exists for this source.` });
        return;
      }
      throw err;
    }
  }),
);

// IA redesign (post-4.4a) - full-definition update, distinct from PATCH's
// rename-only. Used by the Report Builder's "Save" once it has a real
// edit context (opened from a gallery card) - see updateReport's own
// comment in tablespaceStore.js for why name isn't touched here.
tablespaceRouter.put(
  "/sources/:sourceId/reports/:reportId",
  wrap(async (req, res) => {
    const { tableId, joinTableIds, dimensionIds, measureIds, filters, chartType, pageSize } = req.body || {};
    if (!tableId) {
      res.status(400).json({ error: "tableId is required." });
      return;
    }
    const report = await store.updateReport(req.params.sourceId, req.params.reportId, {
      tableId,
      joinTableIds,
      dimensionIds,
      measureIds,
      filters,
      chartType,
      pageSize,
    });
    if (!report) {
      res.status(404).json({ error: "Report not found." });
      return;
    }
    res.json(report);
  }),
);

tablespaceRouter.delete(
  "/sources/:sourceId/reports/:reportId",
  wrap(async (req, res) => {
    const deleted = await store.deleteReport(req.params.sourceId, req.params.reportId);
    if (!deleted) {
      res.status(404).json({ error: "Report not found." });
      return;
    }
    res.json({ success: true });
  }),
);

// --- Branches: one source's schema-definition lines. Scoped by sourceId
// alone below /sources/:sourceId, not nested under /projects, since a
// source_id is already the unambiguous owner.

tablespaceRouter.get(
  "/sources/:sourceId/branches",
  wrap(async (req, res) => {
    res.json(await store.listBranches(req.params.sourceId));
  }),
);

// Literal-path routes below (/branches/main, /branches/diff) MUST be
// registered before the generic /branches/:branchId route further down -
// Express matches routes in registration order, and :branchId would
// otherwise bind to the literal string "main"/"diff" first.
tablespaceRouter.get(
  "/sources/:sourceId/branches/main",
  wrap(async (req, res) => {
    const branch = await store.getMainBranch(req.params.sourceId);
    if (!branch) {
      res.status(404).json({ error: "This source has no main branch yet." });
      return;
    }
    res.json(branch);
  }),
);

tablespaceRouter.get(
  "/sources/:sourceId/branches/diff",
  wrap(async (req, res) => {
    const { base, compare } = req.query;
    if (!base || !compare) {
      res.status(400).json({ error: "base and compare query params are required." });
      return;
    }
    const [baseBranch, compareBranch] = await Promise.all([
      store.getBranch(req.params.sourceId, base),
      store.getBranch(req.params.sourceId, compare),
    ]);
    if (!baseBranch || !compareBranch) {
      res.status(404).json({ error: "One or both branches were not found." });
      return;
    }
    res.json({
      base: { id: baseBranch.id, name: baseBranch.name },
      compare: { id: compareBranch.id, name: compareBranch.name },
      ...diffSchemas(baseBranch, compareBranch),
    });
  }),
);

tablespaceRouter.post(
  "/sources/:sourceId/branches",
  wrap(async (req, res) => {
    const { name, sourceBranchId } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required." });
      return;
    }
    if (!sourceBranchId) {
      res.status(400).json({ error: "sourceBranchId is required." });
      return;
    }
    try {
      const branch = await store.createBranch(req.params.sourceId, { name: name.trim(), sourceBranchId });
      if (!branch) {
        res.status(404).json({ error: "Source branch not found." });
        return;
      }
      res.status(201).json(branch);
    } catch (err) {
      if (err.code === "23505") {
        res.status(409).json({ error: `A branch named "${name.trim()}" already exists.` });
        return;
      }
      throw err;
    }
  }),
);

tablespaceRouter.get(
  "/sources/:sourceId/branches/:branchId",
  wrap(async (req, res) => {
    const branch = await store.getBranch(req.params.sourceId, req.params.branchId);
    if (!branch) {
      res.status(404).json({ error: "Branch not found." });
      return;
    }
    res.json(branch);
  }),
);

tablespaceRouter.put(
  "/sources/:sourceId/branches/:branchId",
  wrap(async (req, res) => {
    const { nodes, edges, enums, pages, schemaVersion } = req.body || {};
    const branch = await store.saveBranch(req.params.sourceId, req.params.branchId, {
      nodes: nodes || [],
      edges: edges || [],
      enums: enums || [],
      pages: pages || [],
      schemaVersion: schemaVersion || 1,
    });
    if (!branch) {
      res.status(404).json({ error: "Branch not found." });
      return;
    }
    res.json(branch);
  }),
);

tablespaceRouter.patch(
  "/sources/:sourceId/branches/:branchId",
  wrap(async (req, res) => {
    const { name } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required." });
      return;
    }
    try {
      const branch = await store.renameBranch(req.params.sourceId, req.params.branchId, name.trim());
      if (!branch) {
        res.status(404).json({ error: "Branch not found." });
        return;
      }
      res.json(branch);
    } catch (err) {
      if (err.code === "23505") {
        res.status(409).json({ error: `A branch named "${name.trim()}" already exists.` });
        return;
      }
      throw err;
    }
  }),
);

// Merge is only ever branch -> its DIRECT parent - see schemaMerge.js's own
// header comment for why an arbitrary branch pair has no correct merge
// base without a full commit DAG, which this app deliberately doesn't have.
tablespaceRouter.post(
  "/sources/:sourceId/branches/:targetBranchId/merge",
  wrap(async (req, res) => {
    const { sourceBranchId } = req.body || {};
    if (!sourceBranchId) {
      res.status(400).json({ error: "sourceBranchId is required." });
      return;
    }
    const [targetBranch, sourceBranch] = await Promise.all([
      store.getBranch(req.params.sourceId, req.params.targetBranchId),
      store.getBranchWithBase(req.params.sourceId, sourceBranchId),
    ]);
    if (!targetBranch || !sourceBranch) {
      res.status(404).json({ error: "One or both branches were not found." });
      return;
    }
    if (String(sourceBranch.parentBranchId) !== String(targetBranch.id)) {
      res.status(400).json({
        error: `"${sourceBranch.name}" isn't a direct child of "${targetBranch.name}" - merge is only supported between a branch and the exact parent it forked from.`,
      });
      return;
    }
    if (sourceBranch.baseNodes == null) {
      res.status(400).json({
        error: `"${sourceBranch.name}" has no recorded fork point (it predates automatic merge, or is the main branch), so an automatic merge can't be computed for it.`,
      });
      return;
    }

    const { nodes, edges, enums, conflicts } = mergeSchemas(
      { nodes: sourceBranch.baseNodes, edges: sourceBranch.baseEdges, enums: sourceBranch.baseEnums },
      { nodes: targetBranch.nodes, edges: targetBranch.edges, enums: targetBranch.enums },
      { nodes: sourceBranch.nodes, edges: sourceBranch.edges, enums: sourceBranch.enums },
    );
    // Before-vs-after diff of the TARGET branch, reusing schemaDiff.js's own
    // summary shape - gives the frontend toast tablesAdded/Removed/Modified
    // etc. for free instead of re-deriving counts from `conflicts`.
    const { summary } = diffSchemas(targetBranch, { nodes, edges, enums });

    const branch = await store.saveBranch(req.params.sourceId, targetBranch.id, {
      nodes, edges, enums,
      // Merge only ever reconciles nodes/edges/enums (see schemaMerge.js) -
      // the target's own pages are preserved as-is, not overwritten with an
      // empty array just because this save call doesn't otherwise touch them.
      pages: targetBranch.pages,
      schemaVersion: Math.max(targetBranch.schemaVersion, sourceBranch.schemaVersion),
    });
    // The SOURCE branch is left completely untouched - matches git's own
    // default (merging never modifies the branch merged in).
    res.json({ branch, conflicts, summary });
  }),
);

tablespaceRouter.delete(
  "/sources/:sourceId/branches/:branchId",
  wrap(async (req, res) => {
    // Pre-fetch rather than relying solely on the store's is_main=false
    // guard, so "it's the main branch" (400) and "it doesn't exist" (404)
    // return distinct, accurate statuses instead of one ambiguous 404.
    const branch = await store.getBranch(req.params.sourceId, req.params.branchId);
    if (!branch) {
      res.status(404).json({ error: "Branch not found." });
      return;
    }
    if (branch.isMain) {
      res.status(400).json({ error: "The main branch can't be deleted." });
      return;
    }
    const deleted = await store.deleteBranch(req.params.sourceId, req.params.branchId);
    if (!deleted) {
      res.status(404).json({ error: "Branch not found." });
      return;
    }
    res.json({ success: true });
  }),
);

tablespaceRouter.get(
  "/sources/:sourceId/checkpoints",
  wrap(async (req, res) => {
    res.json(await store.listCheckpoints(req.params.sourceId));
  }),
);

tablespaceRouter.post(
  "/sources/:sourceId/checkpoints",
  wrap(async (req, res) => {
    const { label, nodes, edges, enums } = req.body || {};
    if (!label || typeof label !== "string") {
      res.status(400).json({ error: "label is required." });
      return;
    }
    const checkpoint = await store.createCheckpoint(req.params.sourceId, {
      label,
      nodes: nodes || [],
      edges: edges || [],
      enums: enums || [],
    });
    res.status(201).json(checkpoint);
  }),
);

tablespaceRouter.get(
  "/sources/:sourceId/checkpoints/:checkpointId",
  wrap(async (req, res) => {
    const checkpoint = await store.getCheckpoint(req.params.sourceId, req.params.checkpointId);
    if (!checkpoint) {
      res.status(404).json({ error: "Checkpoint not found." });
      return;
    }
    res.json(checkpoint);
  }),
);

tablespaceRouter.delete(
  "/sources/:sourceId/checkpoints/:checkpointId",
  wrap(async (req, res) => {
    const deleted = await store.deleteCheckpoint(req.params.sourceId, req.params.checkpointId);
    if (!deleted) {
      res.status(404).json({ error: "Checkpoint not found." });
      return;
    }
    res.json({ success: true });
  }),
);

// eslint-disable-next-line no-unused-vars
tablespaceRouter.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error("[tablespace] request failed:", err.message);
  res.status(500).json({ error: "Internal server error." });
});
