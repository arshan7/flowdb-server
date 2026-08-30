import { Router } from "express";
import * as store from "../lib/tablespaceStore.js";
import { diffSchemas } from "../lib/schemaDiff.js";
import { mergeSchemas } from "../lib/schemaMerge.js";
import { syncSource } from "../lib/syncSource.js";
import { describeIntrospectError } from "../lib/introspectErrors.js";
import {
  compileQuery,
  runQuery,
  runNativeQuery,
  resolveNativeVars,
  paginateRows,
  quoteTable,
  quoteIdent,
  compileFilterCondition,
  ALLOWED_PAGE_SIZES,
  DEFAULT_PAGE_SIZE,
  MAX_ROWS,
} from "../lib/queryEngine.js";
import { cacheKey, getCachedQuery, setCachedQuery } from "../lib/queryCache.js";
import { legacyToTokens, parseFormula } from "../lib/formulaExpr.js";
import { resolveJoins, findJoinPath, buildForwardJoinGraph, chainTo } from "../lib/joinResolve.js";
import { compileModel, compileModelReport } from "../lib/modelEngine.js";

// Reporting-parity slice 1 - `distinct` (COUNT DISTINCT) and `median`
// (PERCENTILE_CONT 0.5) join the simple-measure aggregations. They're
// NOT in QUERY_TERM_AGGREGATIONS below: neither composes through
// compileTermExpr's pre-aggregate-then-LEFT-JOIN machinery, so a formula
// term can't pick them (a simple base-table measure, and a measure-ref
// term pointing at one, still can - both stay on the base table).
const QUERY_AGGREGATIONS = new Set(["count", "sum", "avg", "min", "max", "distinct", "median"]);
// Post-4.4b - "value" (a directly-related table's column, read as-is, not
// really aggregated) is a term-only concept, deliberately NOT in
// QUERY_AGGREGATIONS - it's checked separately in resolveTerm, where the
// join direction can also be validated (see that function's own comment).
const QUERY_TERM_AGGREGATIONS = new Set(["count", "sum", "avg", "min", "max", "value"]);
const QUERY_OPERATORS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "in"]);
// Slice 1 - date/timestamp dimension bucketing units. Mirrors
// queryEngine.js's own BUCKETS map (kept as a plain Set here, same as
// ALLOWED_PAGE_SIZES appears in more than one place) - the route validates
// against this, the engine re-derives the actual date_trunc unit.
const QUERY_BUCKETS = new Set(["day", "week", "month", "quarter", "year"]);
const QUERY_SORT_DIRECTIONS = new Set(["asc", "desc"]);
// Data-browse /preview row filters - plain-language operators ("is", "is
// not", "contains", "greater than"..., "is empty", "is not empty") map to
// these keys, then through the shared compileFilterCondition.
// "isnull"/"notnull" bind no value.
const PREVIEW_OPERATORS = new Set(["eq", "neq", "contains", "gt", "gte", "lt", "lte", "isnull", "notnull"]);

// Slice 5 - resolve a stored Model row into { sql, params, columns } using
// the branch's canvas nodes (same node/join/column resolution the /query
// route does for a table report). `columns` is the model's output column
// names for a builder model, null for a SQL model (not knowable without
// running it). Returns { error } on any dangling reference. Pure - no I/O.
// `defaultSchema` (the source's pinned connection_schema, or null for an
// all-schemas source) is the FROM/JOIN schema fallback for any base/join
// node that predates schema tagging - node.data.schema always wins.
function resolveModelSql(model, branch, defaultSchema = null) {
  if (model.kind === "sql") {
    if (!model.sql || !model.sql.trim()) return { error: "This model has no SQL." };
    const defaults = {};
    for (const v of model.sqlVars || []) defaults[v.name] = v.defaultValue ?? "";
    const { sql, params } = resolveNativeVars(model.sql, defaults);
    return compileModel({ kind: "sql", sql, params });
  }
  const allTableNodes = (branch?.nodes || []).filter((n) => n.type === "tableNode");
  const nodesById = new Map(allTableNodes.map((n) => [n.id, n]));
  const base = nodesById.get(model.baseTableId);
  if (!base) return { error: "This model's base table no longer exists." };

  // `joins` entries are either a plain tableId string (FK-resolved, the
  // common case) or an explicit spec { tableId, baseColumnId, joinColumnId }
  // for a table with no defined relationship - the user picked the join
  // keys themselves in the Model builder.
  const rawJoins = Array.isArray(model.joins) ? model.joins : [];
  const fkJoinIds = rawJoins.filter((j) => typeof j === "string");
  const manualJoins = rawJoins.filter((j) => j && typeof j === "object");
  const jr = resolveJoins(base, fkJoinIds, allTableNodes, nodesById, defaultSchema);
  if (jr.error) return { error: jr.error };
  const joinClauses = [...jr.joinClauses];
  const joinNodes = [...jr.joinNodes];
  for (const mj of manualJoins) {
    const jn = nodesById.get(mj.tableId);
    if (!jn || jn.type !== "tableNode") return { error: "This model joins a table that no longer exists." };
    const bCol = (base.data?.columns || []).find((c) => c.id === mj.baseColumnId);
    const jCol = (jn.data?.columns || []).find((c) => c.id === mj.joinColumnId);
    if (!bCol || !jCol) return { error: "This model's join references a column that no longer exists." };
    if (!joinNodes.some((n) => n.id === jn.id)) joinNodes.push(jn);
    joinClauses.push({
      tableName: jn.data.label,
      tableSchema: jn.data.schema ?? defaultSchema,
      fromTableName: base.data.label,
      baseColumn: bCol.name,
      joinColumn: jCol.name,
    });
  }
  const nodeFor = (tid) => (tid === base.id ? base : joinNodes.find((n) => n.id === tid));

  const columns = [];
  for (const c of model.columns || []) {
    // A custom column - a row-level arithmetic formula over the model's
    // other columns. Its token stream is resolved + parsed here (every
    // column ref validated against a real node/column) into the tree
    // modelEngine.compileScalarExpr walks; a raw client string never
    // reaches the SQL.
    if (c && c.kind === "expr") {
      const alias = (c.alias || "").trim();
      if (!alias) return { error: "A custom column needs a name." };
      const tree = resolveColumnFormula(c.tokens, nodeFor);
      if (!tree) return { error: `The custom column "${alias}" has an incomplete or invalid formula.` };
      columns.push({ kind: "exprTree", tree, alias });
      continue;
    }
    const n = nodeFor(c.tableId);
    const col = (n?.data?.columns || []).find((x) => x.id === c.columnId);
    if (!n || !col) return { error: "This model references a column that no longer exists." };
    // Only FROM/JOIN positions need a schema prefix; a column ref like
    // "table"."col" binds to the range-table entry regardless of schema.
    columns.push({ tableName: n.data.label, columnName: col.name, alias: (c.alias || "").trim() || col.name });
  }
  if (columns.length === 0) return { error: "This model exposes no columns." };

  const filters = [];
  for (const f of model.filters || []) {
    const n = nodeFor(f.tableId);
    const col = (n?.data?.columns || []).find((x) => x.id === f.columnId);
    if (!n || !col || !QUERY_OPERATORS.has(f.operator)) return { error: "This model has an invalid filter." };
    filters.push({ tableName: n.data.label, columnName: col.name, operator: f.operator, value: f.value });
  }

  try {
    return compileModel({
      kind: "builder",
      baseTableName: base.data.label,
      baseTableSchema: base.data.schema ?? defaultSchema,
      joinClauses,
      columns,
      filters,
    });
  } catch (err) {
    return { error: err.message };
  }
}

// Resolve a model custom column's flat token stream (value / op / paren,
// the same shape a calculated measure's formula uses) into the nested tree
// formulaExpr.parseFormula returns. Row-level: a "value" token is either a
// constant number or a plain column reference - no aggregation. Every
// column ref is checked against a real node/column via `nodeFor`; returns
// null on any dangling ref, unknown operator, or grammar violation, so the
// caller can reject the model rather than emit half a formula.
function resolveColumnFormula(tokens, nodeFor) {
  if (!Array.isArray(tokens) || tokens.length === 0 || tokens.length > MAX_FORMULA_TOKENS) return null;
  const resolved = [];
  for (const t of tokens) {
    if (!t || typeof t !== "object") return null;
    if (t.kind === "op") {
      if (!QUERY_CALC_OPERATORS.has(t.value)) return null;
      resolved.push(t);
    } else if (t.kind === "paren") {
      if (t.value !== "(" && t.value !== ")") return null;
      resolved.push(t);
    } else if (t.kind === "value") {
      const term = t.term || {};
      if (term.type === "constant") {
        const n = Number(term.value);
        if (!Number.isFinite(n)) return null;
        resolved.push({ kind: "value", node: { constant: n } });
      } else {
        const node = nodeFor(term.tableId);
        const col = (node?.data?.columns || []).find((x) => x.id === term.columnId);
        if (!node || !col) return null;
        resolved.push({ kind: "value", node: { column: { tableName: node.data.label, columnName: col.name } } });
      }
    } else {
      return null;
    }
  }
  return parseFormula(resolved);
}
// Phase 4.4b - calculated measures' arithmetic operator.
const QUERY_CALC_OPERATORS = new Set(["+", "-", "*", "/"]);
// Bigger formulas - a calculated measure's formula is a flat token stream
// (value/op/paren, read left to right like a real formula bar), bounded -
// a sane defensive cap, not a client-configurable one, same spirit as
// MAX_ROWS/ALLOWED_PAGE_SIZES. Mirrors MetricFieldDrawer.jsx/measureExpr.js's
// own MAX_FORMULA_TOKENS so the UI self-limits before a formula could ever
// reach this, but this is the real, server-enforced bound - independent
// of what the UI offers, since these routes never trust client-shaped
// structure.
const MAX_FORMULA_TOKENS = 61;
// A "measure" value token references another measure, resolved
// recursively (resolveMeasureAsTerm) - `depth` counts how many such
// reference-hops a resolution has gone through, capped here regardless of
// how long a chain of distinct real measures a payload references
// (bounded in practice by the visiting-set cycle check, but that alone
// doesn't stop a very long non-cyclic chain from recursing deep).
const MAX_EXPR_DEPTH = 6;

// A report can carry a `dataset` = { baseTableId, joins, columns, filters }
// - joins / calculated columns / cross-table filters shaped inline in the
// report builder rather than in a separate Model. It's persisted as a
// builder model the report OWNS: never listed in the Models gallery,
// deleted with the report. Its columns/joins are soft references
// validated at query time by resolveModelSql, same as a real Model's.
function isDatasetSpec(d) {
  return !!d && typeof d === "object" && !!d.baseTableId && Array.isArray(d.columns) && d.columns.length > 0;
}
async function syncOwnedDataset(sourceId, reportId, dataset) {
  if (isDatasetSpec(dataset)) {
    return store.upsertOwnedModel(sourceId, reportId, {
      baseTableId: dataset.baseTableId,
      joins: Array.isArray(dataset.joins) ? dataset.joins : [],
      columns: dataset.columns,
      filters: Array.isArray(dataset.filters) ? dataset.filters : [],
    });
  }
  await store.deleteOwnedModel(sourceId, reportId);
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
    const { name, createdAt } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required." });
      return;
    }
    try {
      const project = await store.createProject({ name: name.trim(), createdAt });
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
    const { name, type, template } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required." });
      return;
    }
    try {
      const source = await store.createSource(req.params.id, {
        name: name.trim(),
        type,
        // Optional starter-schema seed (validated client-side, same as it
        // was for project creation before templates moved here).
        template: template && typeof template === "object" ? template : undefined,
      });
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
      // Slice 5 - a report reads from a table OR a Model. When `modelId`
      // is set, `dimensions`/`measures` are the model-column shape
      // ([{id, column, bucket?}] / [{id, aggregation, column}]) and
      // `filters` reference `column` by name - no semantic model exists.
      modelId,
      // Direct-on-table report: `tableId` + `direct: true` uses the SAME
      // column-shaped dims/measures/filters as a model, but resolved
      // against the table's own physical columns and compiled straight
      // against it (single table, no joins - joins are a Model's job).
      direct = false,
      dimensions: modelDimensions = [],
      measures: modelMeasures = [],
      joinTableIds = [],
      measureIds = [],
      dimensionIds = [],
      filters = [],
      offset = 0,
      pageSize = DEFAULT_PAGE_SIZE,
      // Slice 1 - per-report view options. dimensionBuckets:
      // { <dimensionId>: "day"|"week"|"month"|"quarter"|"year" };
      // orderBy: { field, direction } or null; rowLimit: int or null.
      dimensionBuckets = {},
      orderBy = null,
      rowLimit = null,
    } = req.body || {};
    if (!tableId && !modelId) {
      res.status(400).json({ error: "tableId or modelId is required." });
      return;
    }
    if (rowLimit != null && (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > MAX_ROWS)) {
      res.status(400).json({ error: `rowLimit must be an integer between 1 and ${MAX_ROWS}.` });
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

    // Slice 5 - model-sourced report. The model compiles to a subquery;
    // dims/measures aggregate over its OUTPUT columns (validated against
    // the compiled column list for a builder model; a SQL model's columns
    // aren't known here, so Postgres reports an unknown column itself).
    if (modelId) {
      const model = await store.getModel(req.params.sourceId, modelId);
      if (!model) {
        res.status(404).json({ error: "Model not found." });
        return;
      }
      const compiledModel = resolveModelSql(model, branch, secrets.schema ?? null);
      if (compiledModel.error) {
        res.status(400).json({ error: compiledModel.error });
        return;
      }
      const known = compiledModel.columns ? new Set(compiledModel.columns) : null;
      const checkCol = (col) => !known || known.has(col);

      const rDims = [];
      for (const d of modelDimensions) {
        if (!d || typeof d.column !== "string" || !checkCol(d.column)) {
          res.status(400).json({ error: `Unknown model column "${d?.column}".` });
          return;
        }
        if (d.bucket && !QUERY_BUCKETS.has(d.bucket)) {
          res.status(400).json({ error: `Unsupported time grouping "${d.bucket}".` });
          return;
        }
        rDims.push({ id: d.id, column: d.column, bucket: d.bucket || null, label: d.label });
      }
      const rMeasures = [];
      for (const m of modelMeasures) {
        if (!m || !QUERY_AGGREGATIONS.has(m.aggregation)) {
          res.status(400).json({ error: `Invalid aggregation "${m?.aggregation}".` });
          return;
        }
        if (m.aggregation !== "count" && (typeof m.column !== "string" || !checkCol(m.column))) {
          res.status(400).json({ error: `Unknown model column "${m?.column}".` });
          return;
        }
        rMeasures.push({ id: m.id, aggregation: m.aggregation, column: m.aggregation === "count" ? null : m.column, label: m.label });
      }
      const rFilters = [];
      for (const f of filters) {
        if (!f || !QUERY_OPERATORS.has(f.operator) || typeof f.column !== "string" || !checkCol(f.column)) {
          res.status(400).json({ error: "Invalid filter." });
          return;
        }
        rFilters.push({ column: f.column, operator: f.operator, value: f.value });
      }
      let resolvedOrderBy = null;
      if (orderBy && orderBy.field) {
        const sortable = new Set([...rDims, ...rMeasures].map((c) => c.id));
        if (!sortable.has(orderBy.field)) {
          res.status(400).json({ error: "Can't sort by a field that isn't in the report." });
          return;
        }
        resolvedOrderBy = { field: orderBy.field, direction: QUERY_SORT_DIRECTIONS.has(orderBy.direction) ? orderBy.direction : "asc" };
      }

      let mCompiled;
      try {
        mCompiled = compileModelReport({
          modelSql: compiledModel.sql,
          modelParams: compiledModel.params,
          dimensions: rDims,
          measures: rMeasures,
          filters: rFilters,
          orderBy: resolvedOrderBy,
          rowLimit,
          offset,
          pageSize,
        });
      } catch (err) {
        res.status(400).json({ error: err.message });
        return;
      }
      try {
        const key = cacheKey(req.params.sourceId, `model:${modelId}:${mCompiled.sql}`, mCompiled.params);
        let rawRows = getCachedQuery(key)?.rows;
        const cached = !!rawRows;
        if (!rawRows) {
          rawRows = await runQuery(secrets.connectionString, mCompiled.sql, mCompiled.params);
          setCachedQuery(key, rawRows);
        }
        const { rows, hasMore } = paginateRows(rawRows, mCompiled.windowSize);
        res.json({
          columns: [...rDims, ...rMeasures].map((c) => ({ id: c.id, label: c.label || c.column || c.aggregation })),
          rows,
          hasMore,
          sql: mCompiled.sql,
          params: mCompiled.params,
          cached,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[sources] model query failed:", err.code || err.message);
        res.status(err.isFriendly ? 400 : 502).json({ error: describeIntrospectError(err) });
      }
      return;
    }

    const nodesById = new Map((branch?.nodes || []).map((n) => [n.id, n]));
    const node = nodesById.get(tableId);
    if (!node || node.type !== "tableNode") {
      res.status(404).json({ error: "Table not found." });
      return;
    }

    // --- Direct-on-table report. Same column-shaped body as a model
    // report, but every dimension/measure/filter names a PHYSICAL column,
    // validated here against node.data.columns, then handed to the exact
    // same compileQuery the semantic path uses. One table, no joins.
    if (direct) {
      const colsByName = new Map((node.data?.columns || []).map((c) => [c.name, c]));
      const directSchema = node.data.schema ?? secrets.schema ?? null;

      const rDims = [];
      for (const d of modelDimensions) {
        const col = d && typeof d.column === "string" ? colsByName.get(d.column) : null;
        if (!col) {
          res.status(400).json({ error: `Unknown column "${d?.column}".` });
          return;
        }
        const rd = {
          id: d.id || d.column,
          label: d.label || col.name,
          tableName: node.data.label,
          columnName: col.name,
          columnType: col.type,
        };
        if (d.bucket) {
          if (!QUERY_BUCKETS.has(d.bucket)) {
            res.status(400).json({ error: `Unsupported time grouping "${d.bucket}".` });
            return;
          }
          if (col.type !== "date" && col.type !== "timestamp") {
            res.status(400).json({ error: `"${col.name}" isn't a date column, so it can't be grouped by ${d.bucket}.` });
            return;
          }
          rd.bucket = d.bucket;
        }
        rDims.push(rd);
      }

      const rMeasures = [];
      for (const m of modelMeasures) {
        if (!m || !QUERY_AGGREGATIONS.has(m.aggregation)) {
          res.status(400).json({ error: `Invalid aggregation "${m?.aggregation}".` });
          return;
        }
        if (m.aggregation === "count") {
          rMeasures.push({ id: m.id, label: m.label || "Count", aggregation: "count", columnName: null });
          continue;
        }
        const col = typeof m.column === "string" ? colsByName.get(m.column) : null;
        if (!col) {
          res.status(400).json({ error: `Unknown column "${m?.column}".` });
          return;
        }
        rMeasures.push({ id: m.id, label: m.label || `${m.aggregation} of ${col.name}`, aggregation: m.aggregation, columnName: col.name });
      }

      if (rDims.length === 0 && rMeasures.length === 0) {
        res.status(400).json({ error: "Pick at least one column to group by, or a measure." });
        return;
      }

      const rFilters = [];
      for (const f of filters) {
        const col = f && typeof f.column === "string" ? colsByName.get(f.column) : null;
        if (!col || !QUERY_OPERATORS.has(f.operator)) {
          res.status(400).json({ error: "Invalid filter." });
          return;
        }
        rFilters.push({ tableName: node.data.label, columnName: col.name, operator: f.operator, value: f.value });
      }

      let directOrderBy = null;
      if (orderBy && orderBy.field) {
        const ids = new Set([...rDims, ...rMeasures].map((c) => c.id));
        if (!ids.has(orderBy.field)) {
          res.status(400).json({ error: "Can't sort by a field that isn't in the report." });
          return;
        }
        directOrderBy = { field: orderBy.field, direction: QUERY_SORT_DIRECTIONS.has(orderBy.direction) ? orderBy.direction : "asc" };
      }

      let directCompiled;
      try {
        directCompiled = compileQuery({
          tableName: node.data.label,
          tableSchema: directSchema,
          measures: rMeasures,
          dimensions: rDims,
          filters: rFilters,
          joins: [],
          offset,
          pageSize,
          orderBy: directOrderBy,
          rowLimit,
        });
      } catch (err) {
        res.status(400).json({ error: err.message });
        return;
      }

      try {
        const key = cacheKey(req.params.sourceId, `direct:${tableId}:${directCompiled.sql}`, directCompiled.params);
        let rawRows = getCachedQuery(key)?.rows;
        const cached = !!rawRows;
        if (!rawRows) {
          rawRows = await runQuery(secrets.connectionString, directCompiled.sql, directCompiled.params);
          setCachedQuery(key, rawRows);
        }
        const { rows, hasMore } = paginateRows(rawRows, directCompiled.windowSize);
        res.json({
          columns: [...rDims, ...rMeasures].map((c) => ({ id: c.id, label: c.label })),
          rows,
          hasMore,
          sql: directCompiled.sql,
          params: directCompiled.params,
          cached,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[sources] direct query failed:", err.code || err.message);
        res.status(err.isFriendly ? 400 : 502).json({ error: describeIntrospectError(err) });
      }
      return;
    }

    // Every joinTableId is verified against a REAL relationship to the base
    // table (resolveJoins, shared with the Model compiler) - the client
    // only ever claims a table id, never the join columns. Direct 1-hop
    // first, then a forward many-to-one chain.
    const allTableNodes = (branch?.nodes || []).filter((n) => n.type === "tableNode");
    // FROM/JOIN schema fallback for nodes that predate schema tagging:
    // node.data.schema wins, else the source's pinned connection_schema
    // (null for an all-schemas source). A resync back-fills the nodes.
    const defaultSchema = secrets.schema ?? null;
    const jr = resolveJoins(node, joinTableIds, allTableNodes, nodesById, defaultSchema);
    if (jr.error) {
      res.status(400).json({ error: jr.error });
      return;
    }
    const { joinClauses, joinNodes } = jr;
    // Forward (many-to-one) reachability graph from the base table - used
    // by a calculated measure's multi-hop "value" term (resolveTerm ->
    // chainTo below). Same helper resolveJoins builds internally; built
    // once here so the term resolver can share it.
    const forwardGraph = buildForwardJoinGraph(node, allTableNodes);

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
        return { id: dim.id, label: dim.label || col.name, columnName: col.name, columnType: col.type, tableName: src.data.label };
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

    // Phase 4.4b - a calculated measure's terms resolve like a simple
    // measure's own aggregation/columnId. Post-4.4b, four extensions,
    // each guarded independently:
    //
    // 1. A term's stored `tableId` can name a table related to the base
    //    one - directly (same findJoinPath check joinTableIds above
    //    already goes through) or, for `aggregation: "value"` only,
    //    through a multi-hop all-many-to-one chain (buildForwardJoinGraph
    //    above) - a client claiming an unreachable table is rejected
    //    either way. Omitted/equal to the base table id keeps today's
    //    exact behavior for every calculated measure saved before this
    //    existed.
    // 2. `aggregation: "value"` (read a column directly, no real
    //    aggregation) is safe unconditionally on the base table itself
    //    (it's the same row) and, cross-table, whenever the forward graph
    //    can reach the term's table at all - since that graph only ever
    //    follows many-to-one edges, reachability there already IS the
    //    safety check (no separate direction check needed - a
    //    `join_to_base` first hop, or ANY "many" hop further along a
    //    chain, simply isn't in this graph, so chainTo returns null and
    //    the term is rejected the same way an unrelated table would be).
    // 3. Every OTHER cross-table aggregation (count/sum/avg/min/max)
    //    stays exactly 1-hop, either direction, via findJoinPath -
    //    unchanged from before. Multi-hop AGGREGATION (as opposed to a
    //    multi-hop VALUE read) is a harder, still-unbuilt problem - see
    //    the plan doc.
    // 4. A term's own `filters` (only meaningful cross-table - e.g. "only
    //    completed bookings") resolve against the TERM's table, not the
    //    base table's `findDimension`/filter machinery above, since
    //    they're scoped to what's being pre-aggregated, not the outer
    //    query's own WHERE clause.
    //
    // `tableName`/`chain`/`filters` on the resolved term are what
    // queryEngine.js's compileTermExpr() uses to decide whether it needs
    // the pre-aggregate-then-LEFT-JOIN treatment - see its own comment.
    //
    // Relationships + formula builder - a term now carries an explicit
    // `type` ("column" | "constant" | "measure"); older stored terms
    // (saved before this existed) never had one, so it's inferred the
    // same way this route always distinguished a measure reference
    // (`term.measureId !== undefined`) from a column term - identical
    // behavior for every measure saved before this, no data migration.
    // "constant" is new: a typed-in number, no table/column involved at
    // all - just validated as finite and handed straight to
    // compileTermExpr as a parameterized literal.
    const resolveTerm = (term, visiting, depth) => {
      if (!term) return null;
      const type = term.type || (term.measureId !== undefined ? "measure" : "column");

      if (type === "constant") {
        return typeof term.value === "number" && Number.isFinite(term.value) ? { kind: "constant", value: term.value } : null;
      }
      if (type === "measure") {
        return term.measureId ? resolveMeasureAsTerm(term.measureId, visiting, depth + 1) : null;
      }

      if (!QUERY_TERM_AGGREGATIONS.has(term.aggregation)) return null;

      let termNode = node;
      let chain = null;
      if (term.tableId && term.tableId !== node.id) {
        termNode = nodesById.get(term.tableId);
        if (!termNode || termNode.type !== "tableNode") return null;
        if (term.aggregation === "value") {
          chain = chainTo(forwardGraph, nodesById, term.tableId);
          if (!chain) return null;
          // Back-fill schema on legacy (pre-tagging) hop nodes.
          chain = chain.map((h) => ({ ...h, tableSchema: h.tableSchema ?? defaultSchema }));
        } else {
          const path = findJoinPath(node, termNode);
          if (!path) return null;
          chain = [
            {
              tableId: termNode.id,
              tableName: termNode.data.label,
              tableSchema: termNode.data.schema ?? defaultSchema,
              baseColumn: path.baseColumn,
              joinColumn: path.joinColumn,
              fromTableId: node.id,
            },
          ];
        }
      }
      // "value" on the base table itself needs no chain/join at all -
      // it's already that row's own column (see aggExpr/compileTermExpr).

      const termColumnsById =
        termNode === node ? baseColumnsById : new Map((termNode.data?.columns || []).map((c) => [c.id, c]));

      const filters = [];
      for (const f of term.filters || []) {
        const col = termColumnsById.get(f?.columnId);
        if (!col || !QUERY_OPERATORS.has(f.operator)) return null;
        if (f.operator === "in" && !Array.isArray(f.value)) return null;
        filters.push({ columnName: col.name, operator: f.operator, value: f.value });
      }

      const termSchema = termNode.data.schema ?? defaultSchema;
      if (term.aggregation === "count") {
        return { aggregation: "count", columnName: null, tableName: termNode.data.label, tableSchema: termSchema, chain, filters };
      }
      const col = termColumnsById.get(term.columnId);
      return col
        ? { aggregation: term.aggregation, columnName: col.name, tableName: termNode.data.label, tableSchema: termSchema, chain, filters }
        : null;
    };

    // Bigger formulas - resolves a formula's flat token stream (value/op/
    // paren, read left to right like a real formula bar) into the nested
    // `{kind:"calculated", termA, termB, operator}` tree queryEngine.js
    // already compiles - real operator precedence and real parentheses
    // instead of the old flat left-to-right-only chain, via formulaExpr.js's
    // parseFormula (kept separate so that pure parsing logic has its own
    // unit tests, same as schemaDiff.js/schemaMerge.js). Every value token
    // is resolved through resolveTerm FIRST, here, before parseFormula ever
    // sees it - the only place a raw client id turns into a real
    // column/table name - so the parser itself only ever sees already-
    // validated nodes plus a fixed vocabulary of operator/paren symbols;
    // there is still no path from client-supplied text to the SQL string.
    // Shared by both a top-level calculated measure and one referenced AS a
    // term (resolveMeasureAsTerm below).
    const resolveFormula = (rawTokens, visiting, depth) => {
      if (depth > MAX_EXPR_DEPTH) return null;
      if (!Array.isArray(rawTokens) || rawTokens.length === 0 || rawTokens.length > MAX_FORMULA_TOKENS) return null;

      const resolved = [];
      for (const t of rawTokens) {
        if (!t || typeof t !== "object") return null;
        if (t.kind === "op") {
          if (!QUERY_CALC_OPERATORS.has(t.value)) return null;
          resolved.push(t);
        } else if (t.kind === "paren") {
          if (t.value !== "(" && t.value !== ")") return null;
          resolved.push(t);
        } else if (t.kind === "value") {
          const valueNode = resolveTerm(t.term, visiting, depth);
          if (!valueNode) return null;
          resolved.push({ kind: "value", node: valueNode });
        } else {
          return null;
        }
      }

      return parseFormula(resolved);
    };

    // Post-4.4b - a calculated measure's term can reference ANOTHER
    // measure on this same table instead of aggregating a column
    // directly (e.g. "net earnings" built from "gross earnings", itself
    // built from "completed sessions"). Resolved by recursively
    // inlining the referenced measure's own already-validated expression
    // - see queryEngine.js's compileTermExpr for why inlining (rather
    // than a separate query layer) is both simpler and just as correct.
    // `visiting` is the set of measure ids already on the current
    // resolution path - a measure appearing twice on its own path means
    // a cycle (A -> B -> A), rejected outright rather than infinitely
    // recursing or silently picking one expansion.
    const resolveMeasureAsTerm = (measureId, visiting, depth) => {
      if (depth > MAX_EXPR_DEPTH) return null;
      if (visiting.has(measureId)) return null;
      const measure = (baseSemanticModel.measures || []).find((m) => m.id === measureId);
      if (!measure) return null;
      const nextVisiting = new Set(visiting).add(measureId);

      if (measure.kind === "calculated") {
        return resolveFormula(measure.tokens || legacyToTokens(measure), nextVisiting, depth);
      }
      if (!QUERY_AGGREGATIONS.has(measure.aggregation)) return null;
      if (measure.aggregation === "count") {
        return { aggregation: "count", columnName: null, tableName: node.data.label, chain: null, filters: [] };
      }
      const col = baseColumnsById.get(measure.columnId);
      return col
        ? { aggregation: measure.aggregation, columnName: col.name, tableName: node.data.label, chain: null, filters: [] }
        : null;
    };

    const measures = measureIds.map((id) => {
      const measure = (baseSemanticModel.measures || []).find((m) => m.id === id);
      if (!measure) {
        unknown.push(id);
        return null;
      }

      if (measure.kind === "calculated") {
        const visiting = new Set([measure.id]);
        const expr = resolveFormula(measure.tokens || legacyToTokens(measure), visiting, 0);
        if (!expr) {
          unknown.push(id);
          return null;
        }
        // expr is always a `{kind:"calculated", operator, termA, termB}`
        // node (resolveFormula never returns a bare leaf - see its own
        // comment) - queryEngine.js reads those three fields directly off
        // the measure object, unchanged from before this existed.
        return { id: measure.id, label: measure.label || "Calculated", ...expr };
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

    // Slice 1 - apply a bucket to any resolved dimension the report asked
    // to group by a time unit. Only valid on a date/timestamp column and
    // only from the fixed unit set; anything else is a 400 rather than a
    // silently-ignored option.
    for (const [dimId, unit] of Object.entries(dimensionBuckets || {})) {
      if (!unit) continue;
      const dim = dimensions.find((d) => d && d.id === dimId);
      if (!dim) {
        res.status(400).json({ error: `Can't bucket unknown dimension "${dimId}".` });
        return;
      }
      if (!QUERY_BUCKETS.has(unit)) {
        res.status(400).json({ error: `Unsupported time grouping "${unit}".` });
        return;
      }
      if (dim.columnType !== "date" && dim.columnType !== "timestamp") {
        res.status(400).json({ error: `"${dim.label}" isn't a date column, so it can't be grouped by ${unit}.` });
        return;
      }
      dim.bucket = unit;
    }

    // Slice 1 - a single sort key. `field` must be one of THIS query's own
    // resolved dimension/measure ids (each is a real SELECT alias), so
    // compileQuery can emit `ORDER BY "<alias>"` with no client string in
    // the SQL. direction comes from a fixed set.
    let resolvedOrderBy = null;
    if (orderBy && orderBy.field) {
      const sortableIds = new Set([...dimensions, ...measures].filter(Boolean).map((c) => c.id));
      if (!sortableIds.has(orderBy.field)) {
        res.status(400).json({ error: "Can't sort by a field that isn't in the report." });
        return;
      }
      const direction = QUERY_SORT_DIRECTIONS.has(orderBy.direction) ? orderBy.direction : "asc";
      resolvedOrderBy = { field: orderBy.field, direction };
    }

    let compiled;
    try {
      compiled = compileQuery({
        tableName: node.data.label,
        tableSchema: node.data.schema ?? defaultSchema,
        measures,
        dimensions,
        filters: resolvedFilters,
        joins: joinClauses,
        offset,
        pageSize,
        orderBy: resolvedOrderBy,
        rowLimit,
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
      return;
    }

    try {
      // Phase 4.4c - keyed by the exact compiled SQL+params (already
      // deterministic per resolved spec, offset/pageSize included), scoped
      // by sourceId. A repeated Run/reopen of the same report within the
      // TTL window skips the live database entirely.
      const key = cacheKey(req.params.sourceId, compiled.sql, compiled.params);
      let rawRows = getCachedQuery(key)?.rows;
      const cached = !!rawRows;
      if (!rawRows) {
        rawRows = await runQuery(secrets.connectionString, compiled.sql, compiled.params);
        setCachedQuery(key, rawRows);
      }
      const { rows, hasMore } = paginateRows(rawRows, compiled.windowSize);
      res.json({
        columns: [...dimensions, ...measures].map((c) => ({ id: c.id, label: c.label })),
        rows,
        hasMore,
        sql: compiled.sql,
        params: compiled.params,
        cached,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[sources] query failed:", err.code || err.message);
      res.status(err.isFriendly ? 400 : 502).json({ error: describeIntrospectError(err) });
    }
  }),
);

// Slice 4 - native SQL. No semantic-model resolution: the client sends raw
// SELECT text with {{vars}}, resolveNativeVars turns those into bound $N
// params, and runNativeQuery runs it inside a READ ONLY transaction
// wrapped in `SELECT * FROM (<sql>) LIMIT/OFFSET` (see its comment for the
// three safety layers). Same source-scoping and 30s result cache as the
// semantic route.
tablespaceRouter.post(
  "/sources/:sourceId/query/native",
  wrap(async (req, res) => {
    const { sql, vars = {}, offset = 0, pageSize = DEFAULT_PAGE_SIZE } = req.body || {};
    if (!sql || typeof sql !== "string" || !sql.trim()) {
      res.status(400).json({ error: "sql is required." });
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

    const { sql: boundSql, params } = resolveNativeVars(sql, vars && typeof vars === "object" ? vars : {});
    try {
      const key = cacheKey(req.params.sourceId, `native:${boundSql}:${offset}:${pageSize}`, params);
      let raw = getCachedQuery(key);
      const cached = !!raw;
      if (!raw) {
        const out = await runNativeQuery(secrets.connectionString, boundSql, params, { offset, pageSize });
        raw = { rows: out.rows, fields: out.fields.map((f) => f.name) };
        setCachedQuery(key, raw);
      }
      const { rows, hasMore } = paginateRows(raw.rows, pageSize);
      res.json({
        columns: (raw.fields || []).map((name) => ({ id: name, label: name })),
        rows,
        hasMore,
        sql: boundSql,
        params,
        cached,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[sources] native query failed:", err.code || err.message);
      // A user SQL mistake (syntax, unknown column, write in a read-only
      // txn) is a 400 with the DB's own message - that's the feedback they
      // need; it never contains the connection string.
      res.status(400).json({ error: err.message || "Query failed." });
    }
  }),
);

// Slice 5 - preview a physical table's rows (the "Data" browse layer).
// Read-only, hard row cap. The browse UI (DataBrowseScreen) drives paging
// (`offset`/`pageSize`), a single sort key (`orderBy: {column, direction}`),
// and plain-language row filters (`filters: [{column, operator, value}]`)
// from here. Every column name is re-validated against the modeled node's
// own columns before it reaches the SQL string; filter values bind as
// params via compileFilterCondition (shared with the report engine); and
// runNativeQuery still wraps the whole thing in a READ ONLY txn plus an
// un-removable LIMIT/OFFSET.
tablespaceRouter.post(
  "/sources/:sourceId/preview",
  wrap(async (req, res) => {
    const { tableId, offset = 0, pageSize = 50, orderBy = null, filters = [] } = req.body || {};
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
    if (!Array.isArray(filters)) {
      res.status(400).json({ error: "filters must be an array." });
      return;
    }
    const secrets = await store.getSourceConnectionSecrets(req.params.sourceId);
    if (!secrets) {
      res.status(400).json({ error: "This source isn't connected." });
      return;
    }
    const branch = await store.getMainBranch(req.params.sourceId);
    const node = (branch?.nodes || []).find((n) => n.id === tableId && n.type === "tableNode");
    if (!node) {
      res.status(404).json({ error: "Table not found." });
      return;
    }

    // A client-named column never reaches the SQL: only a column the
    // modeled table actually has can be sorted or filtered on. `label` is
    // the FROM range-table name - compileFilterCondition qualifies as
    // "label"."col", which binds to it whatever schema the FROM used.
    const columnNames = new Set((node.data?.columns || []).map((c) => c.name));
    const label = node.data.label;
    const params = [];
    const whereParts = [];
    for (const f of filters) {
      if (!f || typeof f.column !== "string" || !columnNames.has(f.column) || !PREVIEW_OPERATORS.has(f.operator)) {
        res.status(400).json({ error: "Invalid filter." });
        return;
      }
      whereParts.push(compileFilterCondition(label, f.column, f.operator, f.value, params));
    }

    let orderClause = "";
    if (orderBy && typeof orderBy === "object" && typeof orderBy.column === "string" && orderBy.column) {
      if (!columnNames.has(orderBy.column)) {
        res.status(400).json({ error: `Can't sort by "${orderBy.column}" - it isn't a column of this table.` });
        return;
      }
      orderClause = ` ORDER BY ${quoteIdent(orderBy.column)} ${orderBy.direction === "desc" ? "DESC" : "ASC"}`;
    }

    try {
      // node.data.schema is authoritative; fall back to the source's pinned
      // connection_schema for a single-schema source whose nodes predate
      // schema tagging (a resync back-fills them - see reconcile.js).
      const from = quoteTable(node.data.schema ?? secrets.schema ?? null, label);
      const inner = `SELECT * FROM ${from}${whereParts.length ? ` WHERE ${whereParts.join(" AND ")}` : ""}${orderClause}`;
      const out = await runNativeQuery(secrets.connectionString, inner, params, { offset, pageSize });
      const { rows, hasMore } = paginateRows(out.rows, pageSize);
      res.json({
        columns: (out.fields || []).map((f) => ({ id: f.name, label: f.name })),
        rows,
        hasMore,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[sources] preview failed:", err.code || err.message);
      res.status(err.isFriendly ? 400 : 502).json({ error: describeIntrospectError(err) });
    }
  }),
);

// Slice 5 - run a Model and return its rows: the Model builder's live
// preview (body carries the unsaved `model` shape) and the report
// builder's "what columns does this model expose" describe (body carries
// `modelId` + a small `limit`).
tablespaceRouter.post(
  "/sources/:sourceId/models/query",
  wrap(async (req, res) => {
    // `limit` is the report builder's tiny "describe columns" probe; the
    // Model builder's live preview sends `pageSize` + `offset` + `orderBy`
    // ({ ordinal, direction }) so it can page and sort like the Data grid.
    const { model: bodyModel, modelId, limit, offset = 0, pageSize, orderBy = null } = req.body || {};
    const size = ALLOWED_PAGE_SIZES.includes(pageSize)
      ? pageSize
      : Math.max(1, Math.min(Number(limit) || 50, 200));
    if (!Number.isInteger(offset) || offset < 0 || offset + size > MAX_ROWS) {
      res.status(400).json({ error: `offset must be a non-negative integer, and offset + pageSize can't exceed ${MAX_ROWS}.` });
      return;
    }
    const secrets = await store.getSourceConnectionSecrets(req.params.sourceId);
    if (!secrets) {
      res.status(400).json({ error: "This source isn't connected." });
      return;
    }
    const branch = await store.getMainBranch(req.params.sourceId);
    const model = modelId ? await store.getModel(req.params.sourceId, modelId) : bodyModel;
    if (!model) {
      res.status(400).json({ error: "A model or modelId is required." });
      return;
    }
    const compiled = resolveModelSql(model, branch, secrets.schema ?? null);
    if (compiled.error) {
      res.status(400).json({ error: compiled.error });
      return;
    }

    // Sort by 1-based OUTPUT-column position, not name - a builder model
    // can expose two columns with the same alias, and position is
    // unambiguous. Validated against the compiled column count for a
    // builder model; a SQL model's columns aren't known here, so Postgres
    // rejects an out-of-range position itself.
    let sql = compiled.sql;
    if (orderBy && typeof orderBy === "object" && Number.isInteger(orderBy.ordinal) && orderBy.ordinal >= 1) {
      const maxOrdinal = Array.isArray(compiled.columns) ? compiled.columns.length : null;
      if (maxOrdinal && orderBy.ordinal > maxOrdinal) {
        res.status(400).json({ error: "Can't sort by a column that isn't in this model." });
        return;
      }
      sql = `SELECT * FROM (${compiled.sql}) AS _ms ORDER BY ${orderBy.ordinal} ${orderBy.direction === "desc" ? "DESC" : "ASC"}`;
    }

    try {
      const out = await runNativeQuery(secrets.connectionString, sql, compiled.params, { offset, pageSize: size });
      const { rows, hasMore } = paginateRows(out.rows, size);
      res.json({
        columns: (out.fields || []).map((f) => ({ id: f.name, label: f.name })),
        rows,
        hasMore,
        sql: compiled.sql,
        params: compiled.params,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[sources] model preview failed:", err.code || err.message);
      res.status(400).json({ error: err.message || "Model query failed." });
    }
  }),
);

// --- Models (slice 5): saved curated datasets. Same source-scoped shape
// as reports (create / full PUT / partial PATCH-meta / delete).
tablespaceRouter.get(
  "/sources/:sourceId/models",
  wrap(async (req, res) => {
    res.json(await store.listModels(req.params.sourceId));
  }),
);

tablespaceRouter.get(
  "/sources/:sourceId/models/:modelId",
  wrap(async (req, res) => {
    const model = await store.getModel(req.params.sourceId, req.params.modelId);
    if (!model) {
      res.status(404).json({ error: "Model not found." });
      return;
    }
    res.json(model);
  }),
);

function validateModelBody(b) {
  if (!b.name || typeof b.name !== "string" || !b.name.trim()) return "name is required.";
  if (b.kind === "sql") {
    if (!b.sql || typeof b.sql !== "string" || !b.sql.trim()) return "sql is required for a SQL model.";
  } else {
    if (!b.baseTableId) return "A builder model needs a base table.";
    if (!Array.isArray(b.columns) || b.columns.length === 0) return "A builder model needs at least one column.";
  }
  return null;
}

tablespaceRouter.post(
  "/sources/:sourceId/models",
  wrap(async (req, res) => {
    const b = req.body || {};
    const bad = validateModelBody(b);
    if (bad) {
      res.status(400).json({ error: bad });
      return;
    }
    try {
      const model = await store.createModel(req.params.sourceId, { ...b, name: b.name.trim() });
      res.status(201).json(model);
    } catch (err) {
      if (err.code === "23505") {
        res.status(409).json({ error: `A model named "${b.name.trim()}" already exists for this source.` });
        return;
      }
      throw err;
    }
  }),
);

tablespaceRouter.put(
  "/sources/:sourceId/models/:modelId",
  wrap(async (req, res) => {
    const b = req.body || {};
    const bad = validateModelBody(b);
    if (bad) {
      res.status(400).json({ error: bad });
      return;
    }
    const model = await store.updateModel(req.params.sourceId, req.params.modelId, { ...b, name: b.name.trim() });
    if (!model) {
      res.status(404).json({ error: "Model not found." });
      return;
    }
    res.json(model);
  }),
);

tablespaceRouter.patch(
  "/sources/:sourceId/models/:modelId",
  wrap(async (req, res) => {
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) {
      if (typeof b.name !== "string" || !b.name.trim()) {
        res.status(400).json({ error: "name must be a non-empty string." });
        return;
      }
      patch.name = b.name.trim();
    }
    if (b.collectionId !== undefined) patch.collectionId = b.collectionId === null ? null : Number(b.collectionId);
    if (b.isFavorite !== undefined) patch.isFavorite = !!b.isFavorite;
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "Nothing to update - send name, collectionId, and/or isFavorite." });
      return;
    }
    try {
      const model = await store.updateModelMeta(req.params.sourceId, req.params.modelId, patch);
      if (!model) {
        res.status(404).json({ error: "Model not found." });
        return;
      }
      res.json(model);
    } catch (err) {
      if (err.code === "23505") {
        res.status(409).json({ error: `A model named "${patch.name}" already exists for this source.` });
        return;
      }
      throw err;
    }
  }),
);

tablespaceRouter.delete(
  "/sources/:sourceId/models/:modelId",
  wrap(async (req, res) => {
    const deleted = await store.deleteModel(req.params.sourceId, req.params.modelId);
    if (!deleted) {
      res.status(404).json({ error: "Model not found." });
      return;
    }
    res.json({ success: true });
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
    const b = req.body || {};
    if (!b.name || typeof b.name !== "string" || !b.name.trim()) {
      res.status(400).json({ error: "name is required." });
      return;
    }
    const isSql = b.kind === "sql";
    const hasDataset = isDatasetSpec(b.dataset);
    // Slice 4/5 - a semantic report needs a base table, a Model, or an
    // inline dataset; a SQL report needs its SQL text instead.
    if (!isSql && !b.tableId && !b.modelId && !hasDataset) {
      res.status(400).json({ error: "tableId, modelId, or a dataset is required." });
      return;
    }
    if (isSql && (!b.sql || typeof b.sql !== "string" || !b.sql.trim())) {
      res.status(400).json({ error: "sql is required for a SQL report." });
      return;
    }
    try {
      const report = await store.createReport(req.params.sourceId, {
        name: b.name.trim(),
        kind: isSql ? "sql" : "semantic",
        tableId: b.modelId || hasDataset ? null : b.tableId,
        modelId: b.modelId ?? null,
        joinTableIds: b.joinTableIds,
        dimensionIds: b.dimensionIds,
        measureIds: b.measureIds,
        filters: b.filters,
        chartType: b.chartType,
        pageSize: b.pageSize,
        dimensionBuckets: b.dimensionBuckets,
        orderBy: b.orderBy,
        rowLimit: b.rowLimit,
        sql: b.sql,
        sqlVars: b.sqlVars,
        collectionId: b.collectionId,
      });
      // The owned dataset model needs the new report's id, so it's linked
      // in a second step.
      if (hasDataset) {
        const ownedId = await syncOwnedDataset(req.params.sourceId, report.id, b.dataset);
        res.status(201).json(await store.setReportModelId(req.params.sourceId, report.id, ownedId));
        return;
      }
      res.status(201).json(report);
    } catch (err) {
      if (err.code === "23505") {
        res.status(409).json({ error: `A report named "${b.name.trim()}" already exists for this source.` });
        return;
      }
      throw err;
    }
  }),
);

// Slice 4 - the "organisation" mutation: rename, move to a collection
// (collectionId, null = unfiled), and/or star. Any subset; distinct from
// PUT's full query-definition replace.
tablespaceRouter.patch(
  "/sources/:sourceId/reports/:reportId",
  wrap(async (req, res) => {
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) {
      if (typeof b.name !== "string" || !b.name.trim()) {
        res.status(400).json({ error: "name must be a non-empty string." });
        return;
      }
      patch.name = b.name.trim();
    }
    if (b.collectionId !== undefined) patch.collectionId = b.collectionId === null ? null : Number(b.collectionId);
    if (b.isFavorite !== undefined) patch.isFavorite = !!b.isFavorite;
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "Nothing to update - send name, collectionId, and/or isFavorite." });
      return;
    }
    try {
      const report = await store.updateReportMeta(req.params.sourceId, req.params.reportId, patch);
      if (!report) {
        res.status(404).json({ error: "Report not found." });
        return;
      }
      res.json(report);
    } catch (err) {
      if (err.code === "23505") {
        res.status(409).json({ error: `A report named "${patch.name}" already exists for this source.` });
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
    const b = req.body || {};
    const isSql = b.kind === "sql";
    const hasDataset = isDatasetSpec(b.dataset);
    if (!isSql && !b.tableId && !b.modelId && !hasDataset) {
      res.status(400).json({ error: "tableId, modelId, or a dataset is required." });
      return;
    }
    if (isSql && (!b.sql || typeof b.sql !== "string" || !b.sql.trim())) {
      res.status(400).json({ error: "sql is required for a SQL report." });
      return;
    }
    // Confirm the report exists before touching its owned dataset - an
    // owned model FK-references a real report id.
    if (!(await store.getReport(req.params.sourceId, req.params.reportId))) {
      res.status(404).json({ error: "Report not found." });
      return;
    }
    // Resolve the inline dataset first so the report can point straight at
    // the owned model (or have any stale owned model cleaned up).
    const ownedModelId = await syncOwnedDataset(req.params.sourceId, req.params.reportId, b.dataset);
    const report = await store.updateReport(req.params.sourceId, req.params.reportId, {
      kind: isSql ? "sql" : "semantic",
      tableId: b.modelId || hasDataset ? null : b.tableId,
      modelId: hasDataset ? ownedModelId : (b.modelId ?? null),
      joinTableIds: b.joinTableIds,
      dimensionIds: b.dimensionIds,
      measureIds: b.measureIds,
      filters: b.filters,
      chartType: b.chartType,
      pageSize: b.pageSize,
      dimensionBuckets: b.dimensionBuckets,
      orderBy: b.orderBy,
      rowLimit: b.rowLimit,
      sql: b.sql,
      sqlVars: b.sqlVars,
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

// --- Dashboards (ROADMAP.md Phase 4.5): a named, ordered list of report
// ids, rendered client-side as a grid. Same source-scoped/no-stored-
// result-data shape reports already use - see tablespaceStore.js's own
// comment. report_ids isn't validated against real report rows here
// (soft reference, same contract a report's own table_id/dimension_ids
// have) - the client fetches each report and skips ones that 404.

tablespaceRouter.get(
  "/sources/:sourceId/dashboards",
  wrap(async (req, res) => {
    res.json(await store.listDashboards(req.params.sourceId));
  }),
);

tablespaceRouter.get(
  "/sources/:sourceId/dashboards/:dashboardId",
  wrap(async (req, res) => {
    const dashboard = await store.getDashboard(req.params.sourceId, req.params.dashboardId);
    if (!dashboard) {
      res.status(404).json({ error: "Dashboard not found." });
      return;
    }
    res.json(dashboard);
  }),
);

tablespaceRouter.post(
  "/sources/:sourceId/dashboards",
  wrap(async (req, res) => {
    const { name, reportIds, layout, textTiles, parameters, collectionId } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required." });
      return;
    }
    try {
      const dashboard = await store.createDashboard(req.params.sourceId, {
        name: name.trim(),
        reportIds,
        layout,
        textTiles,
        parameters,
        collectionId,
      });
      res.status(201).json(dashboard);
    } catch (err) {
      if (err.code === "23505") {
        res.status(409).json({ error: `A dashboard named "${name.trim()}" already exists for this source.` });
        return;
      }
      throw err;
    }
  }),
);

// Slice 4 - rename / move to a collection / star (any subset), same shape
// as the reports PATCH.
tablespaceRouter.patch(
  "/sources/:sourceId/dashboards/:dashboardId",
  wrap(async (req, res) => {
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) {
      if (typeof b.name !== "string" || !b.name.trim()) {
        res.status(400).json({ error: "name must be a non-empty string." });
        return;
      }
      patch.name = b.name.trim();
    }
    if (b.collectionId !== undefined) patch.collectionId = b.collectionId === null ? null : Number(b.collectionId);
    if (b.isFavorite !== undefined) patch.isFavorite = !!b.isFavorite;
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "Nothing to update - send name, collectionId, and/or isFavorite." });
      return;
    }
    try {
      const dashboard = await store.updateDashboardMeta(req.params.sourceId, req.params.dashboardId, patch);
      if (!dashboard) {
        res.status(404).json({ error: "Dashboard not found." });
        return;
      }
      res.json(dashboard);
    } catch (err) {
      if (err.code === "23505") {
        res.status(409).json({ error: `A dashboard named "${patch.name}" already exists for this source.` });
        return;
      }
      throw err;
    }
  }),
);

// --- Collections (slice 4): source-scoped folders for reports + dashboards.
tablespaceRouter.get(
  "/sources/:sourceId/collections",
  wrap(async (req, res) => {
    res.json(await store.listCollections(req.params.sourceId));
  }),
);

tablespaceRouter.post(
  "/sources/:sourceId/collections",
  wrap(async (req, res) => {
    const { name, parentId } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required." });
      return;
    }
    const collection = await store.createCollection(req.params.sourceId, {
      name: name.trim(),
      parentId: parentId ?? null,
    });
    res.status(201).json(collection);
  }),
);

tablespaceRouter.patch(
  "/sources/:sourceId/collections/:collectionId",
  wrap(async (req, res) => {
    const { name } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required." });
      return;
    }
    const collection = await store.renameCollection(req.params.sourceId, req.params.collectionId, name.trim());
    if (!collection) {
      res.status(404).json({ error: "Collection not found." });
      return;
    }
    res.json(collection);
  }),
);

tablespaceRouter.delete(
  "/sources/:sourceId/collections/:collectionId",
  wrap(async (req, res) => {
    const deleted = await store.deleteCollection(req.params.sourceId, req.params.collectionId);
    if (!deleted) {
      res.status(404).json({ error: "Collection not found." });
      return;
    }
    res.json({ success: true });
  }),
);

tablespaceRouter.put(
  "/sources/:sourceId/dashboards/:dashboardId",
  wrap(async (req, res) => {
    // Slice 3 - partial: any subset of membership / grid layout / text
    // tiles / filter params. Each, if present, must be an array.
    const body = req.body || {};
    const patch = {};
    for (const key of ["reportIds", "layout", "textTiles", "parameters"]) {
      if (body[key] === undefined) continue;
      if (!Array.isArray(body[key])) {
        res.status(400).json({ error: `${key} must be an array.` });
        return;
      }
      patch[key] = body[key];
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "Nothing to update - send reportIds, layout, textTiles, and/or parameters." });
      return;
    }
    const dashboard = await store.updateDashboard(req.params.sourceId, req.params.dashboardId, patch);
    if (!dashboard) {
      res.status(404).json({ error: "Dashboard not found." });
      return;
    }
    res.json(dashboard);
  }),
);

tablespaceRouter.delete(
  "/sources/:sourceId/dashboards/:dashboardId",
  wrap(async (req, res) => {
    const deleted = await store.deleteDashboard(req.params.sourceId, req.params.dashboardId);
    if (!deleted) {
      res.status(404).json({ error: "Dashboard not found." });
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
