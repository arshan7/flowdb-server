import * as store from "./tablespaceStore.js";
import { syncSource } from "./syncSource.js";

// True background sync - runs for the lifetime of this process, no
// browser needed, which is the whole point of storing a Connected
// source's connection string server-side at all (see crypto.js). A plain
// setInterval is enough here: flowdb-server is already a single
// long-running Node process (not serverless), so there's no separate job
// queue/cron infra to stand up for this.
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // how often to check what's due
const SYNC_INTERVAL_MS = 60 * 60 * 1000; // how stale a source has to be to count as due

function isDue(source) {
  if (!source.lastSyncedAt) return true;
  return Date.now() - new Date(source.lastSyncedAt).getTime() >= SYNC_INTERVAL_MS;
}

// Sequential, not Promise.all - several Connected sources syncing at once
// would otherwise open that many simultaneous connections to that many
// different live databases in one burst. One misbehaving/unreachable
// source is caught and logged per-source so it can never block the rest
// from syncing.
async function runDueSyncs() {
  const sources = await store.listConnectedSources();
  for (const source of sources) {
    if (!isDue(source)) continue;
    try {
      await syncSource(source.id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[syncScheduler] source ${source.id} failed:`, err.message);
    }
  }
}

export function startSyncScheduler() {
  setInterval(() => {
    runDueSyncs().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[syncScheduler] run failed:", err.message);
    });
  }, CHECK_INTERVAL_MS);
}
