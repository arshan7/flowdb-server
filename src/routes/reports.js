import { Router } from "express";
import * as store from "../lib/tablespaceStore.js";
import { isDatasetSpec } from "../lib/modelSql.js";
import { wrap } from "./http.js";

async function syncOwnedDataset(sourceId, reportId, dataset, reportName) {
  if (isDatasetSpec(dataset)) {
    const spec =
      dataset.kind === "sql"
        ? { kind: "sql", sql: dataset.sql, sqlVars: Array.isArray(dataset.sqlVars) ? dataset.sqlVars : [] }
        : {
            baseTableId: dataset.baseTableId,
            joins: Array.isArray(dataset.joins) ? dataset.joins : [],
            columns: dataset.columns,
            filters: Array.isArray(dataset.filters) ? dataset.filters : [],
          };
    return store.upsertOwnedModel(sourceId, reportId, spec, reportName);
  }
  await store.releaseOwnedModel(sourceId, reportId);
  return null;
}

export const reportsRouter = Router();

// --- Reports (ROADMAP.md Phase 4.4): saved, reusable query definitions
// against a source's semantic model. Scoped by sourceId alone, same
// reasoning as /sources/:sourceId/query above - a report's fields only
// ever resolve against that source's main branch regardless of which
// branch is currently checked out client-side.

reportsRouter.get(
  "/sources/:sourceId/reports",
  wrap(async (req, res) => {
    res.json(await store.listReports(req.params.sourceId));
  }),
);

reportsRouter.get(
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

reportsRouter.post(
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
        // Opaque chart-customization blob - passed straight through, never
        // parsed or used to build SQL. See tablespaceStore.toViz.
        viz: b.viz,
        // Opaque too - reusable named condition sets. The client expands
        // each { segmentId } reference into real conditions before a query
        // ever reaches the server; this is just persistence.
        segments: b.segments,
      });
      // The owned dataset model needs the new report's id, so it's linked
      // in a second step. It's named after the report.
      if (hasDataset) {
        const ownedId = await syncOwnedDataset(req.params.sourceId, report.id, b.dataset, report.name);
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
reportsRouter.patch(
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
reportsRouter.put(
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
    // owned model FK-references a real report id, and names itself after it.
    const existingReport = await store.getReport(req.params.sourceId, req.params.reportId);
    if (!existingReport) {
      res.status(404).json({ error: "Report not found." });
      return;
    }
    // Resolve the inline dataset first so the report can point straight at
    // the owned model (or have any stale owned model cleaned up).
    const ownedModelId = await syncOwnedDataset(
      req.params.sourceId,
      req.params.reportId,
      b.dataset,
      existingReport.name,
    );
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
      viz: b.viz,
      segments: b.segments,
    });
    if (!report) {
      res.status(404).json({ error: "Report not found." });
      return;
    }
    res.json(report);
  }),
);

reportsRouter.delete(
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
