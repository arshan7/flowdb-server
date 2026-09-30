import { Router } from "express";
import * as store from "../lib/tablespaceStore.js";
import { wrap, uid } from "./http.js";

// Saved views on the Data screen: a named snapshot of how a table is looked
// at (filters, sort, columns, grouping...). The `view` object is the
// client's; the server only checks it's a small plain object.
export const viewsRouter = Router();

const MAX_VIEW_BYTES = 64 * 1024;
const cleanName = (name) => (typeof name === "string" ? name.trim().slice(0, 120) : "");
const validId = (id) => /^\d{1,18}$/.test(String(id));
const badView = (view) =>
  !view || typeof view !== "object" || Array.isArray(view) || JSON.stringify(view).length > MAX_VIEW_BYTES;

viewsRouter.get(
  "/sources/:sourceId/views",
  wrap(async (req, res) => {
    const { tableId } = req.query || {};
    if (!tableId) {
      res.status(400).json({ error: "tableId is required." });
      return;
    }
    res.json({ views: await store.listSavedViews(req.params.sourceId, uid(req), String(tableId)) });
  }),
);

viewsRouter.post(
  "/sources/:sourceId/views",
  wrap(async (req, res) => {
    const { tableId, view } = req.body || {};
    const name = cleanName(req.body?.name);
    if (!tableId || !name) {
      res.status(400).json({ error: "A view needs a table and a name." });
      return;
    }
    if (badView(view)) {
      res.status(400).json({ error: "That view can't be saved." });
      return;
    }
    const saved = await store.createSavedView(req.params.sourceId, uid(req), { tableId: String(tableId), name, view });
    res.status(201).json({ view: saved });
  }),
);

viewsRouter.patch(
  "/sources/:sourceId/views/:viewId",
  wrap(async (req, res) => {
    if (!validId(req.params.viewId)) {
      res.status(404).json({ error: "View not found." });
      return;
    }
    const { view } = req.body || {};
    const name = req.body?.name === undefined ? undefined : cleanName(req.body.name);
    if (name === "") {
      res.status(400).json({ error: "A view needs a name." });
      return;
    }
    if (view !== undefined && badView(view)) {
      res.status(400).json({ error: "That view can't be saved." });
      return;
    }
    const saved = await store.updateSavedView(req.params.sourceId, uid(req), req.params.viewId, { name, view });
    if (!saved) {
      res.status(404).json({ error: "View not found." });
      return;
    }
    res.json({ view: saved });
  }),
);

viewsRouter.delete(
  "/sources/:sourceId/views/:viewId",
  wrap(async (req, res) => {
    if (!validId(req.params.viewId)) {
      res.status(404).json({ error: "View not found." });
      return;
    }
    const ok = await store.deleteSavedView(req.params.sourceId, uid(req), req.params.viewId);
    if (!ok) {
      res.status(404).json({ error: "View not found." });
      return;
    }
    res.json({ success: true });
  }),
);
