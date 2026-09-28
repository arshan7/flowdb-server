import { Router } from "express";
import * as store from "../lib/tablespaceStore.js";
import { wrap } from "./http.js";

export const checkpointsRouter = Router();

checkpointsRouter.get(
  "/sources/:sourceId/checkpoints",
  wrap(async (req, res) => {
    res.json(await store.listCheckpoints(req.params.sourceId));
  }),
);

checkpointsRouter.post(
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

checkpointsRouter.get(
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

checkpointsRouter.delete(
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
