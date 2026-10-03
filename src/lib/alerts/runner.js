// Runs alerts: the report's own query (through the same handlers the app calls),
// the condition, the email. The scheduler checks for due alerts every minute.
import * as store from "../tablespaceStore.js";
import { logger } from "../logger.js";
import { appBaseUrl, buildAlertEmail, sendEmail } from "../email.js";
import { checkAlert, describeCondition } from "./check.js";
import { nextRun } from "./schedule.js";

const CHECK_EVERY_MS = 60_000;
const PAGE = 500;

// The query handlers export; imported lazily so this module loads without the
// whole route tree (and its database pool) in unit tests.
async function runRequest(sourceId, request) {
  const { handleReportQuery, handleNativeQuery } = await import("../../routes/query.js");
  const handler = request.endpoint === "native" ? handleNativeQuery : handleReportQuery;
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        if (this.statusCode >= 400) reject(new Error(body?.error || `The report failed (${this.statusCode}).`));
        else resolve(body);
      },
      set() {},
      setHeader() {},
    };
    handler({ params: { sourceId: String(sourceId) }, body: { ...request.body, offset: 0, pageSize: PAGE, withTotal: false, fresh: true } }, res).catch(reject);
  });
}

/**
 * Runs one alert now.
 * @param {object} alert - a stored alert
 * @param {{force?: boolean}} [opts] - force: send even if the condition doesn't hold (a test)
 * @returns {Promise<{sent: boolean, met: boolean, error?: string, skipped?: string}>}
 */
export async function runAlert(alert, { force = false } = {}) {
  const report = await store.getReport(alert.sourceId, alert.reportId);
  if (!report) throw new Error("The report this alert watches no longer exists.");
  const result = await runRequest(alert.sourceId, alert.request);
  const outcome = checkAlert(alert.condition, result, alert.lastState);
  if (!outcome.send && !force) return { sent: false, met: outcome.state === "met", state: outcome.state };
  const measureLabel = (result.columns || []).find((c) => c.id === alert.condition?.measureId)?.label;
  const what = force && !outcome.send ? "(test)" : describeCondition(alert.condition, measureLabel);
  const projectId = (await store.getSource(alert.sourceId))?.projectId;
  const reportUrl = projectId
    ? `${appBaseUrl()}/projects/${projectId}/sources/${alert.sourceId}/reports/${alert.reportId}`
    : `${appBaseUrl()}/`;
  const email = buildAlertEmail({ reportName: report.name, what, columns: result.columns || [], rows: result.rows || [], reportUrl });
  const sent = await sendEmail({ to: alert.recipients, ...email });
  return { sent: sent.sent, met: outcome.state === "met", state: outcome.state, error: sent.error, skipped: sent.skipped };
}

async function runDue() {
  const due = await store.claimDueAlerts();
  for (const alert of due) {
    let next = null;
    try {
      next = nextRun(alert.schedule, new Date(), alert.timezone);
    } catch (err) {
      await store.finishAlertRun(alert.id, { nextRunAt: null, error: err.message });
      continue;
    }
    try {
      const out = await runAlert(alert);
      await store.finishAlertRun(alert.id, { nextRunAt: next, lastState: out.state, sent: out.sent, error: out.error || null });
    } catch (err) {
      logger.error(`[alerts] alert ${alert.id} failed`, err);
      await store.finishAlertRun(alert.id, { nextRunAt: next, error: err.message });
    }
  }
}

export function startAlertScheduler() {
  setInterval(() => {
    runDue().catch((err) => logger.error("[alerts] run failed", err));
  }, CHECK_EVERY_MS);
}
