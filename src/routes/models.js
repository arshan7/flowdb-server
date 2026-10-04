import { Router } from "express";
import * as store from "../lib/tablespaceStore.js";
import { logger } from "../lib/logger.js";
import { runNativeQuery, paginateRows, ALLOWED_PAGE_SIZES, MAX_ROWS } from "../lib/queryEngine.js";
import { previewWhereClause } from "../lib/previewFilters.js";
import { loadJoinedModels, resolveModelSql } from "../lib/modelSql.js";
import { typeOfField } from "../lib/pgTypes.js";
import { wrap } from "./http.js";

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

export const modelsRouter = Router();

// Slice 5 - run a Model and return its rows: the Model builder's live
// preview (body carries the unsaved `model` shape) and the report
// builder's "what columns does this model expose" describe (body carries
// `modelId` + a small `limit`).
modelsRouter.post(
  "/sources/:sourceId/models/query",
  wrap(async (req, res) => {
    // `limit` is the report builder's tiny "describe columns" probe; the
    // Model builder's live preview sends `pageSize` + `offset` + `orderBy`
    // ({ ordinal, direction }) so it can page and sort like the Data grid.
    // `filterGroup` is the Model builder's new grouped AND/OR row filter
    // (same shape /preview's own filterGroup uses) - a live-preview-only
    // view filter over the model's OUTPUT columns, never part of the saved
    // model (that stays `model.filters`, resolved by resolveModelSql as
    // before, untouched here).
    const { model: bodyModel, modelId, limit, offset = 0, pageSize, orderBy = null, filterGroup = null, withTotal = false } = req.body || {};
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
    const joined = await loadJoinedModels(model, (id) => store.getModel(req.params.sourceId, id));
    const compiled = resolveModelSql(model, branch, secrets.schema ?? null, joined);
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
    const params = [...compiled.params];
    let wrapped = false;

    // The Model builder's grouped AND/OR row filter - same
    // filterGroup/compileFilterGroup pattern /preview uses, but filtering
    // the model's own OUTPUT columns (by alias) rather than a table's raw
    // ones, so it wraps the compiled model as a subquery. A builder
    // model's output aliases are known (`compiled.columns`); a SQL model's
    // aren't knowable without running it, so any column name is accepted
    // and Postgres rejects a bad one itself, same as the orderBy check
    // below already does for that case.
    if (filterGroup && typeof filterGroup === "object") {
      const columnNames = Array.isArray(compiled.columns) ? new Set(compiled.columns) : { has: () => true };
      const wc = previewWhereClause(filterGroup, null, columnNames, "_ms", params);
      if (wc.error) {
        res.status(400).json({ error: wc.error });
        return;
      }
      sql = `SELECT * FROM (${compiled.sql}) AS _ms${wc.clause}`;
      wrapped = true;
    }
    // Counted before ORDER BY is added; the pager's "of N".
    const countSql = `SELECT count(*)::bigint AS n FROM (${sql}) AS _mc`;
    const countParams = [...params];
    if (orderBy && typeof orderBy === "object" && Number.isInteger(orderBy.ordinal) && orderBy.ordinal >= 1) {
      const maxOrdinal = Array.isArray(compiled.columns) ? compiled.columns.length : null;
      if (maxOrdinal && orderBy.ordinal > maxOrdinal) {
        res.status(400).json({ error: "Can't sort by a column that isn't in this model." });
        return;
      }
      // `ORDER BY <ordinal>` binds to the CURRENT query's own SELECT list -
      // since both wraps are `SELECT *`, the model's output order survives
      // either way, so the filtered query can be ordered in place without
      // wrapping it a second time.
      const dir = orderBy.direction === "desc" ? "DESC" : "ASC";
      sql = wrapped
        ? `${sql} ORDER BY ${orderBy.ordinal} ${dir}`
        : `SELECT * FROM (${compiled.sql}) AS _ms ORDER BY ${orderBy.ordinal} ${dir}`;
    }

    try {
      const [out, counted] = await Promise.all([
        runNativeQuery(secrets.connectionString, sql, params, { offset, pageSize: size }),
        withTotal ? runNativeQuery(secrets.connectionString, countSql, countParams, { pageSize: 1 }) : null,
      ]);
      const { rows, hasMore } = paginateRows(out.rows, size);
      res.json({
        columns: (out.fields || []).map((f) => ({ id: f.name, label: f.name, type: typeOfField(f) })),
        rows,
        hasMore,
        total: counted ? Number(counted.rows[0]?.n ?? 0) : null,
        sql: compiled.sql,
        params: compiled.params,
      });
    } catch (err) {
      logger.error("[sources] model preview failed", err);
      res.status(400).json({ error: err.message || "Model query failed." });
    }
  }),
);

// --- Models (slice 5): saved curated datasets. Same source-scoped shape
// as reports (create / full PUT / partial PATCH-meta / delete).
modelsRouter.get(
  "/sources/:sourceId/models",
  wrap(async (req, res) => {
    res.json(await store.listModels(req.params.sourceId));
  }),
);

modelsRouter.get(
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

modelsRouter.post(
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

modelsRouter.put(
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

modelsRouter.patch(
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

modelsRouter.delete(
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
