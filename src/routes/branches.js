import { Router } from "express";
import * as store from "../lib/tablespaceStore.js";
import { diffSchemas } from "../lib/schemaDiff.js";
import { mergeSchemas } from "../lib/schemaMerge.js";
import { wrap } from "./http.js";

export const branchesRouter = Router();

// --- Branches: one source's schema-definition lines. Scoped by sourceId
// alone below /sources/:sourceId, not nested under /projects, since a
// source_id is already the unambiguous owner.

branchesRouter.get(
  "/sources/:sourceId/branches",
  wrap(async (req, res) => {
    res.json(await store.listBranches(req.params.sourceId));
  }),
);

// Literal-path routes below (/branches/main, /branches/diff) MUST be
// registered before the generic /branches/:branchId route further down -
// Express matches routes in registration order, and :branchId would
// otherwise bind to the literal string "main"/"diff" first.
branchesRouter.get(
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

branchesRouter.get(
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

branchesRouter.post(
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

branchesRouter.get(
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

branchesRouter.put(
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

branchesRouter.patch(
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
branchesRouter.post(
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

branchesRouter.delete(
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
