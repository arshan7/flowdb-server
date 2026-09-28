import { Router } from "express";
import * as store from "../lib/tablespaceStore.js";
import { wrap } from "./http.js";

export const collectionsRouter = Router();

// --- Collections (slice 4): source-scoped folders for reports + dashboards.
collectionsRouter.get(
  "/sources/:sourceId/collections",
  wrap(async (req, res) => {
    res.json(await store.listCollections(req.params.sourceId));
  }),
);

collectionsRouter.post(
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

collectionsRouter.patch(
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

collectionsRouter.delete(
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
