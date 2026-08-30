import { introspectPostgres } from "./pgIntrospect.js";
import { toTablespaceSchema } from "./toTablespaceSchema.js";
import { reconcileSchema } from "./reconcile.js";
import * as store from "./tablespaceStore.js";

// Tagged so callers (the connect/sync routes) can tell "syncSource's own,
// already-user-facing message" apart from a raw pg driver error, which
// needs describeIntrospectError.js's mapping instead - a raw pg error
// generally lacks a `.code` a route could reliably switch on instead (the
// "does not support SSL" failure is a plain Error with no code at all).
function friendlyError(message) {
  const err = new Error(message);
  err.isFriendly = true;
  return err;
}

// Orchestrates one full sync for a single Connected source: decrypt ->
// introspect the live database -> reconcile against the source's MAIN
// branch only (forks are for experimentation, never sync targets - a
// fork's whole point is diverging from main on purpose) -> save -> stamp
// last_synced_at. Shared by both the on-demand "Sync now" route and the
// periodic scheduler (syncScheduler.js), so the two can never drift into
// different reconciliation behavior.
//
// secrets.schema is null for a multi-schema source (introspect every
// schema) or a schema name for a single-schema import - see
// pgIntrospect.introspectPostgres and reconcile.tableKey.
export async function syncSource(sourceId) {
  const secrets = await store.getSourceConnectionSecrets(sourceId);
  if (!secrets) {
    throw friendlyError("This source isn't connected.");
  }

  const raw = await introspectPostgres(secrets.connectionString, secrets.schema);
  const introspected = toTablespaceSchema(raw);

  const branch = await store.getMainBranch(sourceId);
  if (!branch) {
    throw friendlyError("This source has no main branch to sync into.");
  }

  const ledger = await store.getSourceSyncLedger(sourceId);
  const result = reconcileSchema(branch, introspected, ledger);
  await store.saveBranch(sourceId, branch.id, {
    nodes: result.nodes,
    edges: result.edges,
    enums: result.enums,
    pages: branch.pages,
    schemaVersion: branch.schemaVersion,
  });
  await store.saveSourceSyncLedger(sourceId, result.ledger);
  await store.markSourceSynced(sourceId);

  return { added: result.added, conflicts: result.conflicts };
}
