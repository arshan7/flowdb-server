import { Router } from "express";
import * as store from "../lib/tablespaceStore.js";

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
        res.status(409).json({ error: `A database named "${name.trim()}" already exists` });
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

tablespaceRouter.get(
  "/projects/:id/diagram",
  wrap(async (req, res) => {
    const diagram = await store.getDiagram(req.params.id);
    if (!diagram) {
      res.status(404).json({ error: "No diagram saved for this project yet." });
      return;
    }
    res.json(diagram);
  }),
);

tablespaceRouter.put(
  "/projects/:id/diagram",
  wrap(async (req, res) => {
    const { nodes, edges, enums, schemaVersion } = req.body || {};
    const diagram = await store.saveDiagram(req.params.id, {
      nodes: nodes || [],
      edges: edges || [],
      enums: enums || [],
      schemaVersion: schemaVersion || 1,
    });
    res.json(diagram);
  }),
);

tablespaceRouter.get(
  "/projects/:id/checkpoints",
  wrap(async (req, res) => {
    res.json(await store.listCheckpoints(req.params.id));
  }),
);

tablespaceRouter.post(
  "/projects/:id/checkpoints",
  wrap(async (req, res) => {
    const { label, nodes, edges, enums } = req.body || {};
    if (!label || typeof label !== "string") {
      res.status(400).json({ error: "label is required." });
      return;
    }
    const checkpoint = await store.createCheckpoint(req.params.id, {
      label,
      nodes: nodes || [],
      edges: edges || [],
      enums: enums || [],
    });
    res.status(201).json(checkpoint);
  }),
);

tablespaceRouter.get(
  "/projects/:id/checkpoints/:checkpointId",
  wrap(async (req, res) => {
    const checkpoint = await store.getCheckpoint(req.params.id, req.params.checkpointId);
    if (!checkpoint) {
      res.status(404).json({ error: "Checkpoint not found." });
      return;
    }
    res.json(checkpoint);
  }),
);

tablespaceRouter.delete(
  "/projects/:id/checkpoints/:checkpointId",
  wrap(async (req, res) => {
    const deleted = await store.deleteCheckpoint(req.params.id, req.params.checkpointId);
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
