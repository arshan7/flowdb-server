import { Router } from "express";
import * as store from "../lib/tablespaceStore.js";
import { logger } from "../lib/logger.js";
import { compileQuery, runQuery, runNativeQuery, resolveNativeVars, paginateRows, countQueryOf, quoteQualified, streamQuery, withoutPageWindow, ALLOWED_PAGE_SIZES, DEFAULT_PAGE_SIZE, MAX_ROWS } from "../lib/queryEngine.js";
import { streamExport, EXPORT_FORMATS, EXPORT_ROW_CAP } from "../lib/exporter.js";
import { cacheKey, getCachedQuery, setCachedQuery } from "../lib/queryCache.js";
import { typeOfField } from "../lib/pgTypes.js";
import { legacyToTokens, parseFormula } from "../lib/formulaExpr.js";
import { resolveJoins, findJoinPath, buildForwardJoinGraph, chainTo } from "../lib/joinResolve.js";
import { compileModelReport, kindOfColumnType } from "../lib/modelEngine.js";
import { QUERY_OPERATORS } from "../lib/previewFilters.js";
import { metricExpression, metricExpressionOnModel } from "../lib/expr/metric.js";
import { resolveModelSql, MAX_FORMULA_TOKENS, isDatasetSpec } from "../lib/modelSql.js";
import { wrap, sendQueryError } from "./http.js";
import { cleanShowAs } from "../lib/showAs.js";

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

// Slice 1 - date/timestamp dimension bucketing units. Mirrors
// queryEngine.js's own BUCKETS map (kept as a plain Set here, same as
// ALLOWED_PAGE_SIZES appears in more than one place) - the route validates
// against this, the engine re-derives the actual date_trunc unit.
const QUERY_BUCKETS = new Set(["day", "week", "month", "quarter", "year"]);

const QUERY_SORT_DIRECTIONS = new Set(["asc", "desc"]);

// Phase 4.4b - calculated measures' arithmetic operator.
const QUERY_CALC_OPERATORS = new Set(["+", "-", "*", "/"]);

// A "measure" value token references another measure, resolved
// recursively (resolveMeasureAsTerm) - `depth` counts how many such
// reference-hops a resolution has gone through, capped here regardless of
// how long a chain of distinct real measures a payload references
// (bounded in practice by the visiting-set cycle check, but that alone
// doesn't stop a very long non-cyclic chain from recursing deep).
const MAX_EXPR_DEPTH = 6;

// Matching rows for the pager (cached like the rows), capped by the report's row limit.
async function totalOf(sourceId, connectionString, compiled, rowLimit, fresh = false) {
  const q = countQueryOf(compiled.sql, compiled.params);
  if (!q) return null;
  const key = cacheKey(sourceId, `count:${q.sql}`, q.params);
  let n = fresh ? null : getCachedQuery(key)?.rows;
  if (n == null) {
    const rows = await runQuery(connectionString, q.sql, q.params);
    n = Number(rows[0]?.n ?? 0);
    setCachedQuery(key, n);
  }
  return rowLimit != null ? Math.min(n, rowLimit) : n;
}

export const queryRouter = Router();



// Export (body.export = { format, name }): the same compiled query without its page
// window, streamed to a CSV / JSON / XLSX download (lib/exporter.js), up to a million rows.
const exportOf = (body) => {
  const ex = body?.export;
  return ex && EXPORT_FORMATS.includes(ex.format) ? { format: ex.format, name: typeof ex.name === "string" ? ex.name : "report" } : null;
};
async function sendExport(res, connectionString, sql, params, columns, ex) {
  try {
    await streamExport(res, {
      format: ex.format,
      name: ex.name,
      columns,
      run: (onBatch) => streamQuery(connectionString, sql, params, onBatch),
    });
  } catch (err) {
    if (!res.headersSent) sendQueryError(res, "export", err);
    else res.destroy(err);
  }
}
async function sendReportExport(res, connectionString, compiled, rowLimit, columns, ex) {
  const cap = Math.min(EXPORT_ROW_CAP, rowLimit ?? EXPORT_ROW_CAP);
  const q = withoutPageWindow(compiled.sql, compiled.params, cap);
  if (!q) {
    res.status(400).json({ error: "This report can't be exported." });
    return;
  }
  await sendExport(res, connectionString, q.sql, q.params, columns, ex);
}

// A dashboard filter on a linked table's column (f.via = { column }), through a link
// column `fkCol`: the linked table, its key and the column, all from stored nodes.
// Returns null when there's no `via`, false when it can't be resolved.
function resolveVia(fkCol, via, nodes, defaultSchema) {
  if (!via) return null;
  const ref = fkCol?.references;
  const t = ref && nodes.find((n) => n.id === ref.tableId && n.type === "tableNode");
  const key = t && (t.data?.columns || []).find((c) => c.id === ref.columnId);
  const col = t && typeof via.column === "string" && (t.data?.columns || []).find((c) => c.name === via.column);
  if (!t || !key || !col) return false;
  return { tableName: t.data.label, tableSchema: t.data.schema ?? defaultSchema, keyColumn: key.name, column: col.name };
}

// A custom measure written as a formula (lib/expr), e.g. SumIf([total], [status] = "paid").
const isFormulaMeasure = (m) =>
  m && m.aggregation === "expression" && typeof m.expression === "string" && m.expression.trim() !== "" && m.expression.length <= 4000;

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
export async function handleReportQuery(req, res) {
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
      // An inline dataset shaped in the report builder (joins / calculated
      // columns) but not yet persisted as an owned Model. Same
      // { baseTableId, joins, columns, filters } shape a saved report
      // carries; compiled and aggregated over exactly like a `modelId`.
      dataset: bodyDataset = null,
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
      withTotal = false,
      // Refresh: skip the 30s result cache and read the database again.
      fresh = false,
    } = req.body || {};
    if (!tableId && !modelId && !bodyDataset) {
      res.status(400).json({ error: "tableId, modelId, or a dataset is required." });
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

    // Nothing summarized: the rows themselves. A plain table reads as a model of all its columns.
    const rowsOnly = !modelDimensions.length && !modelMeasures.length && (direct || modelId || bodyDataset);
    let dataset = bodyDataset;
    if (rowsOnly && direct && !modelId && !dataset) {
      const t = (branch?.nodes || []).find((n) => n.id === tableId && n.type === "tableNode");
      if (!t) {
        res.status(404).json({ error: "Table not found." });
        return;
      }
      dataset = {
        kind: "builder",
        baseTableId: tableId,
        joins: [],
        columns: (t.data?.columns || []).filter((c) => c.reportVisibility !== "hidden").map((c) => ({ tableId, columnId: c.id, alias: "" })),
        filters: [],
      };
    }

    // Slice 5 - model-sourced report. The model compiles to a subquery;
    // dims/measures aggregate over its OUTPUT columns (validated against
    // the compiled column list for a builder model; a SQL model's columns
    // aren't known here, so Postgres reports an unknown column itself).
    // `dataset` (an inline, not-yet-saved report dataset) takes the exact
    // same path - it's just resolved from the request body instead of a
    // stored row.
    if (modelId || dataset) {
      let model;
      if (modelId) {
        model = await store.getModel(req.params.sourceId, modelId);
        if (!model) {
          res.status(404).json({ error: "Model not found." });
          return;
        }
      } else {
        if (!isDatasetSpec(dataset)) {
          res.status(400).json({ error: "A dataset needs a base table and a column, or some SQL." });
          return;
        }
        model =
          dataset.kind === "sql"
            ? {
                kind: "sql",
                sql: dataset.sql,
                sqlVars: Array.isArray(dataset.sqlVars) ? dataset.sqlVars : [],
              }
            : {
                kind: "builder",
                baseTableId: dataset.baseTableId,
                joins: Array.isArray(dataset.joins) ? dataset.joins : [],
                columns: dataset.columns,
                filters: Array.isArray(dataset.filters) ? dataset.filters : [],
              };
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
        // A saved metric of the Model's base table: its definition, in the Model's column names.
        if (m && m.aggregation === "metric") {
          const base = (branch?.nodes || []).find((n) => n.id === model.baseTableId);
          const metric = (base?.data?.semanticModel?.measures || []).find((x) => x.id === m.metricId);
          if (!metric) {
            res.status(400).json({ error: "This report uses a metric that no longer exists." });
            return;
          }
          try {
            m.expression = metricExpressionOnModel(metric, base, model);
          } catch (err) {
            res.status(400).json({ error: `${metric.label || "A metric"}: ${err.message}` });
            return;
          }
          m.aggregation = "expression";
          m.label = m.label || metric.label;
        }
        if (isFormulaMeasure(m)) {
          rMeasures.push({ id: m.id, label: m.label, aggregation: "expression", expression: m.expression, columns: known });
          continue;
        }
        if (!m || !QUERY_AGGREGATIONS.has(m.aggregation)) {
          res.status(400).json({ error: `Invalid aggregation "${m?.aggregation}".` });
          return;
        }
        if (m.aggregation !== "count" && (typeof m.column !== "string" || !checkCol(m.column))) {
          res.status(400).json({ error: `Unknown model column "${m?.column}".` });
          return;
        }
        // Optional per-measure "only where …" conditions - same column /
        // operator validation the report-level filters get, against the
        // model's own compiled output columns.
        const mFilters = [];
        for (const f of m.filters || []) {
          if (!f || !QUERY_OPERATORS.has(f.operator) || typeof f.column !== "string" || !checkCol(f.column)) {
            res.status(400).json({ error: "Invalid measure condition." });
            return;
          }
          mFilters.push({ column: f.column, operator: f.operator, value: f.value });
        }
        rMeasures.push({
          id: m.id,
          aggregation: m.aggregation,
          column: m.aggregation === "count" ? null : m.column,
          label: m.label,
          filters: mFilters,
        });
      }
      const rFilters = [];
      for (const f of filters) {
        if (!f || !QUERY_OPERATORS.has(f.operator) || typeof f.column !== "string" || !checkCol(f.column)) {
          res.status(400).json({ error: "Invalid filter." });
          return;
        }
        // Linked: the Model's column must be a table's link column, by the name it has here.
        let via = null;
        if (f.via) {
          const nodes = branch?.nodes || [];
          const spec = model.kind === "builder" ? (model.columns || []).find((c) => !c.kind && (c.alias?.trim() || nodes.find((n) => n.id === c.tableId)?.data?.columns?.find((x) => x.id === c.columnId)?.name) === f.column) : null;
          const fkCol = spec && nodes.find((n) => n.id === spec.tableId)?.data?.columns?.find((x) => x.id === spec.columnId);
          via = resolveVia(fkCol, f.via, nodes, secrets.schema ?? null);
          if (!via) {
            res.status(400).json({ error: "Invalid filter." });
            return;
          }
        }
        rFilters.push({ column: f.column, operator: f.operator, value: f.value, ...(via && { via }) });
      }
      let resolvedOrderBy = null;
      if (orderBy && orderBy.field) {
        const sortable = new Set([...rDims, ...rMeasures].map((c) => c.id));
        if (!(rowsOnly ? checkCol(orderBy.field) : sortable.has(orderBy.field))) {
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
          showAs: cleanShowAs(req.body.showAs, rMeasures.map((m) => m.id)),
        });
      } catch (err) {
        res.status(400).json({ error: err.message });
        return;
      }
      // Rows mode returns the model's own columns.
      const outCols = rowsOnly
        ? (compiledModel.columns || []).map((c) => ({ id: c, label: c }))
        : [...rDims, ...rMeasures].map((c) => ({ id: c.id, label: c.label || c.column || c.aggregation }));
      if (exportOf(req.body)) {
        const cols = outCols;
        await sendReportExport(res, secrets.connectionString, mCompiled, rowLimit, cols, exportOf(req.body));
        return;
      }
      try {
        const key = cacheKey(
          req.params.sourceId,
          `${modelId ? `model:${modelId}` : "dataset"}:${mCompiled.sql}`,
          mCompiled.params,
        );
        let rawRows = fresh ? null : getCachedQuery(key)?.rows;
        const cached = !!rawRows;
        if (!rawRows) {
          rawRows = await runQuery(secrets.connectionString, mCompiled.sql, mCompiled.params);
          setCachedQuery(key, rawRows);
        }
        const { rows, hasMore } = paginateRows(rawRows, mCompiled.windowSize);
        const total = withTotal ? await totalOf(req.params.sourceId, secrets.connectionString, mCompiled, rowLimit, fresh) : null;
        res.json({
          total,
          columns: outCols.length || !rows.length ? outCols : Object.keys(rows[0]).map((c) => ({ id: c, label: c })),
          rows,
          hasMore,
          sql: mCompiled.sql,
          params: mCompiled.params,
          cached,
        });
      } catch (err) {
        sendQueryError(res, "model query", err);
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
        // A saved metric of this table, used live: its definition as a formula.
        if (m && m.aggregation === "metric") {
          const metric = (node.data?.semanticModel?.measures || []).find((x) => x.id === m.metricId);
          if (!metric) {
            res.status(400).json({ error: "This report uses a metric that no longer exists." });
            return;
          }
          let expression;
          try {
            expression = metricExpression(metric, node);
          } catch (err) {
            res.status(400).json({ error: `${metric.label || "A metric"}: ${err.message}` });
            return;
          }
          m.aggregation = "expression";
          m.expression = expression;
          m.label = m.label || metric.label;
        }
        if (isFormulaMeasure(m)) {
          const resolve = (name) => {
            const col = colsByName.get(name);
            return col ? { sql: quoteQualified(node.data.label, col.name), kind: kindOfColumnType(col.type) } : null;
          };
          rMeasures.push({ id: m.id, label: m.label || "Custom", aggregation: "expression", expression: m.expression, resolve });
          continue;
        }
        if (!m || !QUERY_AGGREGATIONS.has(m.aggregation)) {
          res.status(400).json({ error: `Invalid aggregation "${m?.aggregation}".` });
          return;
        }
        // Optional per-measure "only where …" conditions, against this
        // table's own physical columns.
        const mFilters = [];
        for (const f of m.filters || []) {
          const fcol = f && typeof f.column === "string" ? colsByName.get(f.column) : null;
          if (!fcol || !QUERY_OPERATORS.has(f.operator)) {
            res.status(400).json({ error: "Invalid measure condition." });
            return;
          }
          mFilters.push({ columnName: fcol.name, operator: f.operator, value: f.value });
        }
        if (m.aggregation === "count") {
          rMeasures.push({ id: m.id, label: m.label || "Count", aggregation: "count", columnName: null, filters: mFilters });
          continue;
        }
        const col = typeof m.column === "string" ? colsByName.get(m.column) : null;
        if (!col) {
          res.status(400).json({ error: `Unknown column "${m?.column}".` });
          return;
        }
        rMeasures.push({
          id: m.id,
          label: m.label || `${m.aggregation} of ${col.name}`,
          aggregation: m.aggregation,
          columnName: col.name,
          filters: mFilters,
        });
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
        const via = resolveVia(col, f.via, branch?.nodes || [], directSchema);
        if (via === false) {
          res.status(400).json({ error: "Invalid filter." });
          return;
        }
        rFilters.push({ tableName: node.data.label, columnName: col.name, operator: f.operator, value: f.value, ...(via && { via }) });
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
          showAs: cleanShowAs(req.body.showAs, rMeasures.map((m) => m.id)),
        });
      } catch (err) {
        res.status(400).json({ error: err.message });
        return;
      }

      if (exportOf(req.body)) {
        const cols = [...rDims, ...rMeasures].map((c) => ({ id: c.id, label: c.label }));
        await sendReportExport(res, secrets.connectionString, directCompiled, rowLimit, cols, exportOf(req.body));
        return;
      }
      try {
        const key = cacheKey(req.params.sourceId, `direct:${tableId}:${directCompiled.sql}`, directCompiled.params);
        let rawRows = fresh ? null : getCachedQuery(key)?.rows;
        const cached = !!rawRows;
        if (!rawRows) {
          rawRows = await runQuery(secrets.connectionString, directCompiled.sql, directCompiled.params);
          setCachedQuery(key, rawRows);
        }
        const { rows, hasMore } = paginateRows(rawRows, directCompiled.windowSize);
        const total = withTotal ? await totalOf(req.params.sourceId, secrets.connectionString, directCompiled, rowLimit, fresh) : null;
        res.json({
          total,
          columns: [...rDims, ...rMeasures].map((c) => ({ id: c.id, label: c.label })),
          rows,
          hasMore,
          sql: directCompiled.sql,
          params: directCompiled.params,
          cached,
        });
      } catch (err) {
        sendQueryError(res, "direct query", err);
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
          // Convert-to functions (`fn`) are row-level - custom columns only.
          if ((t.value !== "(" && t.value !== ")") || t.fn) return null;
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

    // A measure entry is a bare id string, OR { id, filters:[{dimensionId,
    // operator, value}] } - a per-measure "only where …" condition,
    // compiled as an aggregate FILTER by queryEngine.js. Each condition
    // resolves against a real dimension the same way a report filter does
    // (findDimension), so a joined table's column is allowed and a raw
    // client string never reaches the SQL. Ignored for a calculated
    // measure (FILTER can't wrap an arbitrary two-aggregate expression).
    const resolveMeasureFilters = (rawList) => {
      const out = [];
      for (const f of rawList || []) {
        const dim = findDimension(f?.dimensionId);
        if (!dim || !QUERY_OPERATORS.has(f.operator)) return null;
        out.push({ columnName: dim.columnName, tableName: dim.tableName, operator: f.operator, value: f.value });
      }
      return out;
    };

    let badMeasureFilter = false;
    const measures = measureIds.map((entry) => {
      const id = typeof entry === "string" ? entry : entry?.id;
      const rawMFilters = entry && typeof entry === "object" && Array.isArray(entry.filters) ? entry.filters : [];
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
      const mFilters = resolveMeasureFilters(rawMFilters);
      if (mFilters === null) {
        badMeasureFilter = true;
        return null;
      }
      if (measure.aggregation === "count") {
        return { id: measure.id, label: measure.label || "Count", aggregation: "count", columnName: null, filters: mFilters };
      }
      const col = baseColumnsById.get(measure.columnId);
      if (!col) {
        unknown.push(id);
        return null;
      }
      return {
        id: measure.id,
        label: measure.label || col.name,
        aggregation: measure.aggregation,
        columnName: col.name,
        filters: mFilters,
      };
    });
    if (badMeasureFilter) {
      res.status(400).json({ error: "Invalid measure condition." });
      return;
    }

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
        showAs: cleanShowAs(req.body.showAs, measures.map((m) => m.id)),
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
      return;
    }

    if (exportOf(req.body)) {
      const cols = [...dimensions, ...measures].map((c) => ({ id: c.id, label: c.label }));
      await sendReportExport(res, secrets.connectionString, compiled, rowLimit, cols, exportOf(req.body));
      return;
    }
    try {
      // Phase 4.4c - keyed by the exact compiled SQL+params (already
      // deterministic per resolved spec, offset/pageSize included), scoped
      // by sourceId. A repeated Run/reopen of the same report within the
      // TTL window skips the live database entirely.
      const key = cacheKey(req.params.sourceId, compiled.sql, compiled.params);
      let rawRows = fresh ? null : getCachedQuery(key)?.rows;
      const cached = !!rawRows;
      if (!rawRows) {
        rawRows = await runQuery(secrets.connectionString, compiled.sql, compiled.params);
        setCachedQuery(key, rawRows);
      }
      const { rows, hasMore } = paginateRows(rawRows, compiled.windowSize);
      const total = withTotal ? await totalOf(req.params.sourceId, secrets.connectionString, compiled, rowLimit, fresh) : null;
      res.json({
        total,
        columns: [...dimensions, ...measures].map((c) => ({ id: c.id, label: c.label })),
        rows,
        hasMore,
        sql: compiled.sql,
        params: compiled.params,
        cached,
      });
    } catch (err) {
      sendQueryError(res, "query", err);
    }
}
queryRouter.post("/sources/:sourceId/query", wrap(handleReportQuery));

// Slice 4 - native SQL. No semantic-model resolution: the client sends raw
// SELECT text with {{vars}}, resolveNativeVars turns those into bound $N
// params, and runNativeQuery runs it inside a READ ONLY transaction
// wrapped in `SELECT * FROM (<sql>) LIMIT/OFFSET` (see its comment for the
// three safety layers). Same source-scoping and 30s result cache as the
// semantic route.
export async function handleNativeQuery(req, res) {
    const { sql, vars = {}, offset = 0, pageSize = DEFAULT_PAGE_SIZE, withTotal = false, fresh = false } = req.body || {};
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
    const ex = exportOf(req.body);
    if (ex) {
      // Column names come from a small first read; then every row streams.
      try {
        const probe = await runNativeQuery(secrets.connectionString, boundSql, params, { offset: 0, pageSize: 10 });
        const cols = probe.fields.map((f) => ({ id: f.name, label: f.name }));
        await sendExport(res, secrets.connectionString, `SELECT * FROM (${boundSql}) AS _tablespace_sub LIMIT ${EXPORT_ROW_CAP}`, params, cols, ex);
      } catch (err) {
        if (!res.headersSent) sendQueryError(res, "export", err);
      }
      return;
    }
    try {
      const key = cacheKey(req.params.sourceId, `native:${boundSql}:${offset}:${pageSize}`, params);
      let raw = fresh ? null : getCachedQuery(key);
      const cached = !!raw;
      if (!raw) {
        const out = await runNativeQuery(secrets.connectionString, boundSql, params, { offset, pageSize });
        raw = { rows: out.rows, fields: out.fields.map((f) => ({ name: f.name, type: typeOfField(f) })) };
        setCachedQuery(key, raw);
      }
      const { rows, hasMore } = paginateRows(raw.rows, pageSize);
      // Counted with the page window as runNativeQuery adds it, so countQueryOf can strip it.
      const total = withTotal
        ? await totalOf(
            req.params.sourceId,
            secrets.connectionString,
            { sql: `SELECT * FROM (${boundSql}) AS _tablespace_sub LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, params: [...params, 0, 0] },
            null,
            fresh,
          )
        : null;
      res.json({
        total,
        columns: (raw.fields || []).map((f) => ({ id: f.name, label: f.name, type: f.type })),
        rows,
        hasMore,
        sql: boundSql,
        params,
        cached,
      });
    } catch (err) {
      logger.error("[sources] native query failed", err);
      // A user SQL mistake (syntax, unknown column, write in a read-only
      // txn) is a 400 with the DB's own message - that's the feedback they
      // need; it never contains the connection string.
      res.status(400).json({ error: err.message || "Query failed." });
    }
}
queryRouter.post("/sources/:sourceId/query/native", wrap(handleNativeQuery));
