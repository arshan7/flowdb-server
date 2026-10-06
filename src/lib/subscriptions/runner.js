// Runs dashboard subscriptions: each tile's query (the same handlers the app
// calls), one email with every tile's first rows, and optionally each tile as a
// CSV or Excel file. Checked every minute next to alerts.
import * as store from "../tablespaceStore.js";
import { logger } from "../logger.js";
import { appBaseUrl, buildSubscriptionEmail, sendEmail } from "../email.js";
import { exportToBuffer, fileNameOf } from "../exporter.js";
import { runRequest } from "../alerts/runner.js";
import { nextRun } from "../alerts/schedule.js";

const CHECK_EVERY_MS = 60_000;
// Rows per tile in an attachment (the largest page the query route serves); the
// email itself shows the first few.
const ATTACHMENT_ROWS = 1000;
export const ATTACHMENTS = ["none", "csv", "xlsx"];

/**
 * Runs one subscription now and sends it.
 * @returns {Promise<{sent: boolean, error?: string, skipped?: string, failedTiles: number}>}
 */
export async function runSubscription(sub) {
  const dashboard = await store.getDashboard(sub.sourceId, sub.dashboardId);
  if (!dashboard) throw new Error("The dashboard this subscription sends no longer exists.");
  const attach = sub.attachment === "csv" || sub.attachment === "xlsx" ? sub.attachment : null;
  const tiles = [];
  for (const t of sub.tiles || []) {
    try {
      const result = await runRequest(sub.sourceId, t.request, attach ? ATTACHMENT_ROWS : 50);
      tiles.push({ name: t.name, columns: result.columns || [], rows: result.rows || [] });
    } catch (err) {
      tiles.push({ name: t.name, error: err.message });
    }
  }
  const attachments = attach
    ? await Promise.all(
        tiles
          .filter((t) => !t.error)
          .map(async (t) => ({
            filename: fileNameOf(t.name, attach),
            content: await exportToBuffer({ format: attach, name: t.name, columns: t.columns.map((c) => ({ id: c.id, label: c.label || c.id })), rows: t.rows }),
          })),
      )
    : [];
  const projectId = (await store.getSource(sub.sourceId))?.projectId;
  const dashboardUrl = projectId ? `${appBaseUrl()}/projects/${projectId}/sources/${sub.sourceId}/dashboards/${sub.dashboardId}` : `${appBaseUrl()}/`;
  const email = buildSubscriptionEmail({ dashboardName: dashboard.name, tiles, dashboardUrl, attached: !!attach });
  const sent = await sendEmail({ to: sub.recipients, ...email, attachments });
  return { sent: sent.sent, error: sent.error, skipped: sent.skipped, failedTiles: tiles.filter((t) => t.error).length };
}

async function runDue() {
  for (const sub of await store.claimDueSubscriptions()) {
    let next = null;
    try {
      next = nextRun(sub.schedule, new Date(), sub.timezone);
    } catch (err) {
      await store.finishSubscriptionRun(sub.id, { nextRunAt: null, error: err.message });
      continue;
    }
    try {
      const out = await runSubscription(sub);
      await store.finishSubscriptionRun(sub.id, { nextRunAt: next, sent: out.sent, error: out.error || null });
    } catch (err) {
      logger.error(`[subscriptions] subscription ${sub.id} failed`, err);
      await store.finishSubscriptionRun(sub.id, { nextRunAt: next, error: err.message });
    }
  }
}

export function startSubscriptionScheduler() {
  setInterval(() => {
    runDue().catch((err) => logger.error("[subscriptions] run failed", err));
  }, CHECK_EVERY_MS);
}
