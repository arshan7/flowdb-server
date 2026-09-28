import { Router } from "express";
import * as store from "../lib/tablespaceStore.js";
import { syncSource } from "../lib/syncSource.js";
import { describeIntrospectError } from "../lib/introspectErrors.js";
import { logger } from "../lib/logger.js";
import { wrap } from "./http.js";

export const sourcesRouter = Router();

// --- Sources: the connected systems living inside one project (ROADMAP.md
// Phase 3 - a Neon database, a Supabase project, a Mongo project, etc, each
// its own full canvas). Nested under /projects/:id since a source only ever
// makes sense in the context of the project that owns it, but branches and
// checkpoints below are scoped by source ALONE (not project+source) since
// source_id is already the sufficient, unambiguous key for those.

sourcesRouter.get(
  "/projects/:id/sources",
  wrap(async (req, res) => {
    res.json(await store.listSources(req.params.id));
  }),
);

sourcesRouter.post(
  "/projects/:id/sources",
  wrap(async (req, res) => {
    const { name, type, template } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required." });
      return;
    }
    try {
      const source = await store.createSource(req.params.id, {
        name: name.trim(),
        type,
        // Optional starter-schema seed (validated client-side, same as it
        // was for project creation before templates moved here).
        template: template && typeof template === "object" ? template : undefined,
      });
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

sourcesRouter.get(
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

sourcesRouter.patch(
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

sourcesRouter.delete(
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

sourcesRouter.post(
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
      logger.error("[sources] connect failed", err);
      res.status(502).json({ error: err.isFriendly ? err.message : describeIntrospectError(err) });
    }
  }),
);

sourcesRouter.delete(
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

sourcesRouter.post(
  "/sources/:sourceId/sync",
  wrap(async (req, res) => {
    try {
      const result = await syncSource(req.params.sourceId);
      res.json(result);
    } catch (err) {
      logger.error("[sources] sync failed", err);
      res
        .status(err.isFriendly ? 400 : 502)
        .json({ error: err.isFriendly ? err.message : describeIntrospectError(err) });
    }
  }),
);

// Clears the sync ledger only - doesn't touch the branch's own nodes/edges
// or run a sync itself. A previously-removed table/relationship stays
// exactly as removed until the next actual "Sync now" (or the periodic
// one) re-pulls it.
sourcesRouter.post(
  "/sources/:sourceId/sync/reset",
  wrap(async (req, res) => {
    await store.resetSourceSyncLedger(req.params.sourceId);
    res.json({ success: true });
  }),
);
