import { Router } from "express";
import * as store from "../lib/tablespaceStore.js";
import { nextRun, ScheduleError } from "../lib/alerts/schedule.js";
import { runAlert } from "../lib/alerts/runner.js";
import { wrap, uid } from "./http.js";

// Report alerts: list / create / change / delete, and "send a test now".
export const alertsRouter = Router();

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DIRECTIONS = ["above", "below"];

// The parts of a body an alert can be saved from; null + a message when it isn't valid.
function validAlert(b, { partial = false } = {}) {
  const out = {};
  if (b.condition !== undefined || !partial) {
    const c = b.condition || {};
    if (c.kind === "rows") out.condition = { kind: "rows" };
    else if (c.kind === "goal" && typeof c.measureId === "string" && DIRECTIONS.includes(c.direction) && Number.isFinite(Number(c.value))) {
      out.condition = { kind: "goal", measureId: c.measureId, direction: c.direction, value: Number(c.value), repeat: c.repeat === "every" ? "every" : "first" };
    } else return [null, "The condition is incomplete."];
  }
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
  if (b.request !== undefined || !partial) {
    const r = b.request;
    if (!r || (r.endpoint !== "query" && r.endpoint !== "native") || !r.body || typeof r.body !== "object") return [null, "The report's query is missing."];
    out.request = { endpoint: r.endpoint, body: r.body };
  }
  if (b.active !== undefined) out.active = !!b.active;
  return [out, null];
}

alertsRouter.get(
  "/sources/:sourceId/alerts",
  wrap(async (req, res) => {
    const reportId = req.query.reportId ? Number(req.query.reportId) : null;
    res.json(await store.listAlerts(req.params.sourceId, reportId));
  }),
);

alertsRouter.post(
  "/sources/:sourceId/alerts",
  wrap(async (req, res) => {
    const [a, error] = validAlert(req.body || {});
    if (error) {
      res.status(400).json({ error });
      return;
    }
    const report = await store.getReport(req.params.sourceId, req.body.reportId);
    if (!report) {
      res.status(404).json({ error: "Report not found." });
      return;
    }
    let next;
    try {
      next = nextRun(a.schedule, new Date(), a.timezone);
    } catch (err) {
      if (!(err instanceof ScheduleError)) throw err;
      res.status(400).json({ error: err.message });
      return;
    }
    const alert = await store.createAlert(req.params.sourceId, { ...a, reportId: report.id, ownerUserId: uid(req), active: a.active ?? true, nextRunAt: next });
    res.status(201).json(alert);
  }),
);

alertsRouter.put(
  "/sources/:sourceId/alerts/:alertId",
  wrap(async (req, res) => {
    const [patch, error] = validAlert(req.body || {}, { partial: true });
    if (error) {
      res.status(400).json({ error });
      return;
    }
    const current = await store.getAlert(req.params.sourceId, req.params.alertId);
    if (!current) {
      res.status(404).json({ error: "Alert not found." });
      return;
    }
    if (patch.schedule || patch.timezone || patch.active) {
      try {
        patch.nextRunAt = nextRun(patch.schedule || current.schedule, new Date(), patch.timezone || current.timezone);
      } catch (err) {
        if (!(err instanceof ScheduleError)) throw err;
        res.status(400).json({ error: err.message });
        return;
      }
    }
    // A changed condition starts fresh: "first time" counts from now.
    if (patch.condition) patch.lastState = null;
    res.json(await store.updateAlert(req.params.sourceId, req.params.alertId, patch));
  }),
);

alertsRouter.delete(
  "/sources/:sourceId/alerts/:alertId",
  wrap(async (req, res) => {
    const ok = await store.deleteAlert(req.params.sourceId, req.params.alertId);
    if (!ok) {
      res.status(404).json({ error: "Alert not found." });
      return;
    }
    res.json({ success: true });
  }),
);

// Runs it now and sends the email whatever the condition says (marked as a test).
alertsRouter.post(
  "/sources/:sourceId/alerts/:alertId/test",
  wrap(async (req, res) => {
    const alert = await store.getAlert(req.params.sourceId, req.params.alertId);
    if (!alert) {
      res.status(404).json({ error: "Alert not found." });
      return;
    }
    try {
      res.json(await runAlert(alert, { force: true }));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }),
);
