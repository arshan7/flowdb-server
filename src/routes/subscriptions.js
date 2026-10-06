import { Router } from "express";
import * as store from "../lib/tablespaceStore.js";
import { nextRun, ScheduleError } from "../lib/alerts/schedule.js";
import { ATTACHMENTS, runSubscription } from "../lib/subscriptions/runner.js";
import { wrap, uid } from "./http.js";

// Dashboard subscriptions: list / create / change / delete, and "send it now".
export const subscriptionsRouter = Router();

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_TILES = 30;

function validSubscription(b, { partial = false } = {}) {
  const out = {};
  if (b.recipients !== undefined || !partial) {
    const list = (Array.isArray(b.recipients) ? b.recipients : []).map((e) => String(e).trim()).filter(Boolean);
    if (!list.length || list.length > 20 || !list.every((e) => EMAIL.test(e))) return [null, "Add 1 to 20 valid email addresses."];
    out.recipients = list;
  }
  if (b.schedule !== undefined || !partial) out.schedule = b.schedule;
  if (b.timezone !== undefined || !partial) {
    const tz = typeof b.timezone === "string" && b.timezone ? b.timezone : "UTC";
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch {
      return [null, "That time zone isn't known."];
    }
    out.timezone = tz;
  }
  if (b.attachment !== undefined || !partial) {
    if (!ATTACHMENTS.includes(b.attachment ?? "none")) return [null, "Attach CSV, Excel, or nothing."];
    out.attachment = b.attachment ?? "none";
  }
  if (b.filterValues !== undefined) out.filterValues = b.filterValues && typeof b.filterValues === "object" ? b.filterValues : {};
  if (b.tiles !== undefined || !partial) {
    const tiles = Array.isArray(b.tiles) ? b.tiles : [];
    const ok = tiles.every(
      (t) => t && typeof t.name === "string" && t.request && (t.request.endpoint === "query" || t.request.endpoint === "native") && t.request.body && typeof t.request.body === "object",
    );
    if (!tiles.length || tiles.length > MAX_TILES || !ok) return [null, "The dashboard's reports are missing."];
    out.tiles = tiles.map((t) => ({ reportId: t.reportId ?? null, name: t.name.slice(0, 200), request: { endpoint: t.request.endpoint, body: t.request.body } }));
  }
  if (b.active !== undefined) out.active = !!b.active;
  return [out, null];
}

const scheduleError = (res, err) => {
  if (!(err instanceof ScheduleError)) throw err;
  res.status(400).json({ error: err.message });
};

subscriptionsRouter.get(
  "/sources/:sourceId/subscriptions",
  wrap(async (req, res) => {
    const dashboardId = req.query.dashboardId ? Number(req.query.dashboardId) : null;
    res.json(await store.listSubscriptions(req.params.sourceId, dashboardId));
  }),
);

subscriptionsRouter.post(
  "/sources/:sourceId/subscriptions",
  wrap(async (req, res) => {
    const [s, error] = validSubscription(req.body || {});
    if (error) {
      res.status(400).json({ error });
      return;
    }
    const dashboard = await store.getDashboard(req.params.sourceId, req.body.dashboardId);
    if (!dashboard) {
      res.status(404).json({ error: "Dashboard not found." });
      return;
    }
    let next;
    try {
      next = nextRun(s.schedule, new Date(), s.timezone);
    } catch (err) {
      scheduleError(res, err);
      return;
    }
    const sub = await store.createSubscription(req.params.sourceId, { ...s, dashboardId: dashboard.id, ownerUserId: uid(req), active: s.active ?? true, nextRunAt: next });
    res.status(201).json(sub);
  }),
);

subscriptionsRouter.put(
  "/sources/:sourceId/subscriptions/:id",
  wrap(async (req, res) => {
    const [patch, error] = validSubscription(req.body || {}, { partial: true });
    if (error) {
      res.status(400).json({ error });
      return;
    }
    const current = await store.getSubscription(req.params.sourceId, req.params.id);
    if (!current) {
      res.status(404).json({ error: "Subscription not found." });
      return;
    }
    if (patch.schedule || patch.timezone || patch.active) {
      try {
        patch.nextRunAt = nextRun(patch.schedule || current.schedule, new Date(), patch.timezone || current.timezone);
      } catch (err) {
        scheduleError(res, err);
        return;
      }
    }
    res.json(await store.updateSubscription(req.params.sourceId, req.params.id, patch));
  }),
);

subscriptionsRouter.delete(
  "/sources/:sourceId/subscriptions/:id",
  wrap(async (req, res) => {
    const ok = await store.deleteSubscription(req.params.sourceId, req.params.id);
    if (!ok) {
      res.status(404).json({ error: "Subscription not found." });
      return;
    }
    res.json({ success: true });
  }),
);

// Sends it now (a test); the schedule is unchanged.
subscriptionsRouter.post(
  "/sources/:sourceId/subscriptions/:id/test",
  wrap(async (req, res) => {
    const sub = await store.getSubscription(req.params.sourceId, req.params.id);
    if (!sub) {
      res.status(404).json({ error: "Subscription not found." });
      return;
    }
    try {
      res.json(await runSubscription(sub));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }),
);
