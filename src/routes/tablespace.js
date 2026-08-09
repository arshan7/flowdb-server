import { Router } from "express";
import * as store from "../lib/tablespaceStore.js";
import { diffSchemas } from "../lib/schemaDiff.js";
import { mergeSchemas } from "../lib/schemaMerge.js";
import { syncSource } from "../lib/syncSource.js";
import { describeIntrospectError } from "../lib/introspectErrors.js";

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
    const { name, type } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required." });
      return;
    }
    try {
      const source = await store.createSource(req.params.id, { name: name.trim(), type });
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
