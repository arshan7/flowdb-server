import { Router } from "express";
import * as store from "../lib/tablespaceStore.js";
import { wrap } from "./http.js";

export const dashboardsRouter = Router();

// --- Dashboards (ROADMAP.md Phase 4.5): a named, ordered list of report
// ids, rendered client-side as a grid. Same source-scoped/no-stored-
// result-data shape reports already use - see tablespaceStore.js's own
// comment. report_ids isn't validated against real report rows here
// (soft reference, same contract a report's own table_id/dimension_ids
// have) - the client fetches each report and skips ones that 404.

dashboardsRouter.get(
  "/sources/:sourceId/dashboards",
  wrap(async (req, res) => {
    res.json(await store.listDashboards(req.params.sourceId));
  }),
);

dashboardsRouter.get(
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

dashboardsRouter.post(
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
dashboardsRouter.patch(
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

dashboardsRouter.put(
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
    // Tabs and filter behaviour: an object.
    if (body.settings !== undefined) {
      if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) {
        res.status(400).json({ error: "settings must be an object." });
        return;
      }
      patch.settings = body.settings;
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "Nothing to update - send reportIds, layout, textTiles, parameters and/or settings." });
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

dashboardsRouter.delete(
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
