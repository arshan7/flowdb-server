import { Router } from "express";
import * as store from "../lib/tablespaceStore.js";
import { wrap, uid } from "./http.js";

export const projectsRouter = Router();

projectsRouter.get(
  "/projects",
  wrap(async (req, res) => {
    res.json(await store.listProjects(uid(req)));
  }),
);

projectsRouter.post(
  "/projects",
  wrap(async (req, res) => {
    const { name, createdAt } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required." });
      return;
    }
    try {
      await store.ensureUser({ clerkUserId: uid(req) });
      const project = await store.createProject({ name: name.trim(), createdAt, ownerUserId: uid(req) });
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

projectsRouter.get(
  "/projects/:id",
  wrap(async (req, res) => {
    const project = await store.getProject(req.params.id, uid(req));
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    res.json(project);
  }),
);

projectsRouter.patch(
  "/projects/:id",
  wrap(async (req, res) => {
    const project = await store.updateProject(req.params.id, req.body || {}, uid(req));
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    res.json(project);
  }),
);

projectsRouter.delete(
  "/projects/:id",
  wrap(async (req, res) => {
    const deleted = await store.deleteProject(req.params.id, uid(req));
    if (!deleted) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    res.json({ success: true });
  }),
);
