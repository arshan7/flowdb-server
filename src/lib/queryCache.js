// Phase 4.4c - a simple time-boxed result cache, deliberately NOT
// pre-aggregation (Cube.dev's real core differentiator - materialized
// rollups, partitioned refresh - is a multi-year build on its own, out of
// scope here). Keyed by the exact compiled SQL + params (already
// deterministic per resolved query spec, offset/pageSize included), so a
// repeated Run/reopen of the same report within the TTL window skips the
// live database entirely.
//
// Security note for when Auth + Teams lands: this cache is currently
// process-wide with no per-tenant scoping, which is fine ONLY because the
// whole app is still gated by one shared API key today - every caller
// already has access to every source. Once real per-user/per-org identity
// exists, this cache MUST be scoped by org/team too, or one tenant could
// read another's cached rows for a source they don't have access to.
const TTL_MS = 30_000;
const store = new Map();

export function cacheKey(sourceId, sql, params) {
  return `${sourceId}:${sql}:${JSON.stringify(params)}`;
}

export function getCachedQuery(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > TTL_MS) {
    store.delete(key);
    return null;
  }
  return entry;
}

export function setCachedQuery(key, rows) {
  store.set(key, { rows, cachedAt: Date.now() });
}

// Same plain-setInterval reasoning syncScheduler.js already uses -
// flowdb-server is one long-running process, no separate job infra needed.
// Bounds memory for keys nobody looks up again within the TTL window.
const SWEEP_INTERVAL_MS = 60_000;

export function startQueryCacheSweeper() {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now - entry.cachedAt > TTL_MS) store.delete(key);
    }
  }, SWEEP_INTERVAL_MS);
}
