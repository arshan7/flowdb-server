import { pool, query } from "./db.js";
import { encrypt, decrypt } from "./crypto.js";

// Raw parameterized SQL, no ORM - consistent with this codebase's existing
// hand-rolled style (see pgIntrospect.js), and avoids a THIRD definition
// of these tables' shape when the flowdb-migrations SQLAlchemy models
// already define them once. Column aliasing in the SELECTs gets camelCase
// JSON with zero glue code; pg returns JSONB columns already parsed back
// into JS objects/arrays on the way OUT. On the way IN, pg does NOT
// auto-serialize a plain JS array/object into JSON for a JSONB column -
// passed as a bare query param, an array instead gets encoded as a
// Postgres ARRAY literal ("{...}"), which the server then rejects with
// "invalid input syntax for type json" (confirmed directly via curl while
// building this, not assumed) - toJson() below exists specifically to
// avoid that.
const toJson = (value) => JSON.stringify(value ?? []);

const PROJECT_COLUMNS = `
  id, name, status, is_favorite AS "isFavorite",
  created_at AS "createdAt", updated_at AS "modifiedAt"
`;

export async function listProjects() {
  const { rows } = await query(`SELECT ${PROJECT_COLUMNS} FROM tablespace_projects ORDER BY updated_at DESC`);
  return rows;
}

export async function getProject(id) {
  const { rows } = await query(`SELECT ${PROJECT_COLUMNS} FROM tablespace_projects WHERE id = $1`, [id]);
  return rows[0] || null;
}

// Wrapped in a real transaction (not independent pool.query() calls) - a
// failed source/branch insert must never leave an orphaned project row.
// Every project gets exactly one source ("Main", type 'postgres') with
// exactly one main branch (ROADMAP.md Phase 3 - a project can hold
// multiple sources, but it always starts with one, matching how every
// project has always behaved up to this point).
export async function createProject({ name, template, createdAt }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: projectRows } = await client.query(
      `INSERT INTO tablespace_projects (name, created_at, updated_at)
       VALUES ($1, COALESCE($2, now()), COALESCE($2, now()))
       RETURNING id, name, status, is_favorite AS "isFavorite", created_at AS "createdAt", updated_at AS "modifiedAt"`,
      [name, createdAt || null],
    );
    const project = projectRows[0];
    const { rows: sourceRows } = await client.query(
      `INSERT INTO tablespace_sources (project_id, name, type) VALUES ($1, 'Main', 'postgres') RETURNING id`,
      [project.id],
    );
    await client.query(
      `INSERT INTO tablespace_branches (source_id, name, is_main, nodes, edges, enums, pages)
       VALUES ($1, 'main', true, $2, $3, $4, $5)`,
      [sourceRows[0].id, toJson(template?.nodes), toJson(template?.edges), toJson(template?.enums), toJson(template?.pages)],
    );
    await client.query("COMMIT");
    return project;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function updateProject(id, changes) {
  const sets = [];
  const values = [];
  let i = 1;
  if (changes.name !== undefined) {
    sets.push(`name = $${i++}`);
    values.push(changes.name);
  }
  if (changes.status !== undefined) {
    sets.push(`status = $${i++}`);
    values.push(changes.status);
  }
  if (changes.isFavorite !== undefined) {
    sets.push(`is_favorite = $${i++}`);
    values.push(changes.isFavorite);
  }
  if (sets.length === 0) return getProject(id);
  sets.push(`updated_at = now()`);
  values.push(id);
  const { rows } = await query(
    `UPDATE tablespace_projects SET ${sets.join(", ")} WHERE id = $${i} RETURNING ${PROJECT_COLUMNS}`,
    values,
  );
  return rows[0] || null;
}

export async function deleteProject(id) {
  const { rowCount } = await query(`DELETE FROM tablespace_projects WHERE id = $1`, [id]);
  return rowCount > 0; // ON DELETE CASCADE takes every source (and their branches/checkpoints) with it
}

// One connected source inside a project (ROADMAP.md Phase 3) - a Neon
// database, a Supabase project, a MongoDB project, a Salesforce
// connection, etc. Each owns its own independent branch/checkpoint
// history (tablespace_branches/tablespace_checkpoints hang off source_id,
// not project_id).
//
// The list query joins the source's main branch for exactly what the
// Sources Overview screen needs (table count, current branch name, last
// schema edit) in one round trip - same "list is cheap, get is full"
// philosophy BRANCH_LIST_COLUMNS already follows, just one level up.
// isConnected/lastSyncedAt are safe to expose - connection_string_encrypted
// itself is NEVER selected in either of these two queries, only ever read
// back out (decrypted, in-process) by getSourceConnectionSecrets below,
// which no route calls directly - see syncSource.js.
const SOURCE_LIST_QUERY = `
  SELECT
    s.id, s.project_id AS "projectId", s.name, s.type,
    s.is_connected AS "isConnected", s.last_synced_at AS "lastSyncedAt",
    b.name AS "mainBranchName",
    COALESCE(jsonb_array_length(b.nodes), 0) AS "tableCount",
    s.created_at AS "createdAt", s.updated_at AS "updatedAt"
  FROM tablespace_sources s
  LEFT JOIN tablespace_branches b ON b.source_id = s.id AND b.is_main = true
  WHERE s.project_id = $1
  ORDER BY s.created_at ASC
`;
const SOURCE_COLUMNS = `
  id, project_id AS "projectId", name, type,
  is_connected AS "isConnected", last_synced_at AS "lastSyncedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

export async function listSources(projectId) {
  const { rows } = await query(SOURCE_LIST_QUERY, [projectId]);
  return rows;
}

export async function getSource(sourceId) {
  const { rows } = await query(`SELECT ${SOURCE_COLUMNS} FROM tablespace_sources WHERE id = $1`, [sourceId]);
  return rows[0] || null;
}

// Every source needs its own main branch to be openable at all (same
// invariant every project's own creation already guarantees) - created in
// the same transaction, not a separate follow-up call a failure could
// leave half-done.
export async function createSource(projectId, { name, type }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: sourceRows } = await client.query(
      `INSERT INTO tablespace_sources (project_id, name, type) VALUES ($1, $2, $3) RETURNING ${SOURCE_COLUMNS}`,
      [projectId, name, type || "custom"],
    );
    const source = sourceRows[0];
    await client.query(
      `INSERT INTO tablespace_branches (source_id, name, is_main, nodes, edges, enums, pages) VALUES ($1, 'main', true, '[]', '[]', '[]', '[]')`,
      [source.id],
    );
    await client.query("COMMIT");
    return source;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function renameSource(sourceId, name) {
  const { rows } = await query(
    `UPDATE tablespace_sources SET name = $2, updated_at = now() WHERE id = $1 RETURNING ${SOURCE_COLUMNS}`,
    [sourceId, name],
  );
  return rows[0] || null;
}

export async function deleteSource(sourceId) {
  // No "last source" guard, unlike deleteBranch's "can't delete main" -
  // a project with zero sources is a real, designed-for state (Sources
  // Overview's own empty state), not an invalid one.
  const { rowCount } = await query(`DELETE FROM tablespace_sources WHERE id = $1`, [sourceId]);
  return rowCount > 0; // ON DELETE CASCADE takes its branches/checkpoints with it
}

// Marks a source Connected and stores its connection string encrypted at
// rest (crypto.js) - called by the /connection route, which triggers an
// immediate full sync right after this resolves (see syncSource.js).
// last_synced_at is deliberately NOT touched here - it's set only once an
// actual sync has run, so "Connected, never synced" stays a real,
// visible state rather than looking identical to "just synced."
export async function setSourceConnection(sourceId, { connectionString, schema }) {
  const { rows } = await query(
    `UPDATE tablespace_sources
     SET is_connected = true, connection_string_encrypted = $2, connection_schema = $3, updated_at = now()
     WHERE id = $1
     RETURNING ${SOURCE_COLUMNS}`,
    [sourceId, encrypt(connectionString), schema || "public"],
  );
  return rows[0] || null;
}

// Reverts a source to fully manual - whatever schema it already has
// (synced or hand-added) stays exactly as-is, only future syncing stops.
export async function clearSourceConnection(sourceId) {
  const { rows } = await query(
    `UPDATE tablespace_sources
     SET is_connected = false, connection_string_encrypted = NULL, connection_schema = NULL, last_synced_at = NULL, updated_at = now()
     WHERE id = $1
     RETURNING ${SOURCE_COLUMNS}`,
    [sourceId],
  );
  return rows[0] || null;
}

// Internal-only - decrypts the stored connection string back out.
// Deliberately NOT exported through any route; the only two callers are
// syncSource.js's own on-demand and scheduled sync paths, both of which
// use the connection string in-process and then discard it, exactly like
// the old ConnectDatabaseDialog.jsx never persisted it client-side.
export async function getSourceConnectionSecrets(sourceId) {
  const { rows } = await query(
    `SELECT connection_string_encrypted AS "encrypted", connection_schema AS "schema"
     FROM tablespace_sources WHERE id = $1 AND is_connected = true`,
    [sourceId],
  );
  const row = rows[0];
  if (!row || !row.encrypted) return null;
  return { connectionString: decrypt(row.encrypted), schema: row.schema || "public" };
}

// { tables: [...names], edges: [...signatures] } - every table/relationship
// this source has EVER synced in, independent of the branch's current
// nodes/edges. Read once at the start of a sync, written back once at the
// end with whatever reconcileSchema (syncSource.js) added - see that
// file's own comment for why this has to live outside the branch's own
// JSONB (a deleted table/edge leaves no trace there to check against).
export async function getSourceSyncLedger(sourceId) {
  const { rows } = await query(`SELECT sync_ledger AS "syncLedger" FROM tablespace_sources WHERE id = $1`, [sourceId]);
  return rows[0]?.syncLedger || { tables: [], edges: [] };
}

export async function saveSourceSyncLedger(sourceId, ledger) {
  await query(`UPDATE tablespace_sources SET sync_ledger = $2 WHERE id = $1`, [sourceId, toJson(ledger)]);
}

// Wipes the ledger back to empty - the next sync treats every table/
// relationship the live database currently has as brand new again,
// including anything previously deleted and therefore ignored. Doesn't
// touch the branch's own nodes/edges at all by itself; nothing changes
// until the next actual sync runs.
export async function resetSourceSyncLedger(sourceId) {
  await query(`UPDATE tablespace_sources SET sync_ledger = '{"tables": [], "edges": []}' WHERE id = $1`, [sourceId]);
}

// Every Connected source, for the periodic scheduler (syncScheduler.js) to
// iterate - id and lastSyncedAt only, never the secret itself; each
// source's connection string is decrypted individually, right before use,
// via getSourceConnectionSecrets above.
export async function listConnectedSources() {
  const { rows } = await query(
    `SELECT id, last_synced_at AS "lastSyncedAt" FROM tablespace_sources WHERE is_connected = true`,
  );
  return rows;
}

export async function markSourceSynced(sourceId) {
  await query(`UPDATE tablespace_sources SET last_synced_at = now() WHERE id = $1`, [sourceId]);
}

// Phase 4.4 - saved/reusable reports. Source-scoped, not branch-scoped -
// see app/models/tablespace_report.py (flowdb-migrations) for the full
// reasoning. table_id/dimension_ids/measure_ids are soft references into
// a branch's own nodes JSONB (node/dimension/measure ids) - nothing here
// enforces they still exist; ReportBuilderScreen.jsx degrades gracefully
// client-side if a saved report's table/fields were since removed.
const REPORT_COLUMNS = `
  id, source_id AS "sourceId", name, table_id AS "tableId",
  join_table_ids AS "joinTableIds",
  dimension_ids AS "dimensionIds", measure_ids AS "measureIds", filters,
  chart_type AS "chartType", page_size AS "pageSize",
  dimension_buckets AS "dimensionBuckets", order_by AS "orderBy", row_limit AS "rowLimit",
  kind, sql, sql_vars AS "sqlVars",
  collection_id AS "collectionId", is_favorite AS "isFavorite", model_id AS "modelId",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

// Slice 1 - dimension_buckets is a map (default {}), order_by is a single
// nullable object, row_limit a nullable int - so none of the three fit
// toJson's "default to []" shape.
const toBuckets = (value) => JSON.stringify(value && typeof value === "object" ? value : {});
const toOrderBy = (value) => (value && value.field ? JSON.stringify(value) : null);

export async function listReports(sourceId) {
  const { rows } = await query(
    `SELECT ${REPORT_COLUMNS} FROM tablespace_reports WHERE source_id = $1 ORDER BY created_at ASC`,
    [sourceId],
  );
  return rows;
}

export async function getReport(sourceId, reportId) {
  const { rows } = await query(
    `SELECT ${REPORT_COLUMNS} FROM tablespace_reports WHERE id = $1 AND source_id = $2`,
    [reportId, sourceId],
  );
  return rows[0] || null;
}

export async function createReport(sourceId, r) {
  const { rows } = await query(
    `INSERT INTO tablespace_reports
       (source_id, name, table_id, join_table_ids, dimension_ids, measure_ids, filters, chart_type, page_size,
        dimension_buckets, order_by, row_limit, kind, sql, sql_vars, collection_id, model_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING ${REPORT_COLUMNS}`,
    [
      sourceId,
      r.name,
      r.tableId ?? null,
      toJson(r.joinTableIds || []),
      toJson(r.dimensionIds || []),
      toJson(r.measureIds || []),
      toJson(r.filters || []),
      r.chartType || "table",
      r.pageSize || 100,
      toBuckets(r.dimensionBuckets),
      toOrderBy(r.orderBy),
      r.rowLimit ?? null,
      r.kind === "sql" ? "sql" : "semantic",
      r.kind === "sql" ? (r.sql ?? "") : null,
      toJson(r.sqlVars || []),
      r.collectionId ?? null,
      r.modelId ?? null,
    ],
  );
  return rows[0];
}

export function renameReport(sourceId, reportId, name) {
  return updateReportMeta(sourceId, reportId, { name });
}

// IA redesign (post-4.4a) - the Report Builder now has a real edit
// context (opened from a gallery card), so "Save" on an already-saved
// report updates its query definition in place instead of always forcing
// a new row - the delete-and-resave v1 behavior stays available as
// "Save as new" (client-side: just calls createReport again). Name is
// deliberately NOT touched here - renaming stays the gallery's job
// (renameReport above), same separation of concerns Metabase draws
// between "Save" and "Rename."
export async function updateReport(sourceId, reportId, r) {
  const { rows } = await query(
    `UPDATE tablespace_reports
     SET table_id = $3, join_table_ids = $4, dimension_ids = $5, measure_ids = $6,
         filters = $7, chart_type = $8, page_size = $9,
         dimension_buckets = $10, order_by = $11, row_limit = $12,
         kind = $13, sql = $14, sql_vars = $15, model_id = $16, updated_at = now()
     WHERE id = $1 AND source_id = $2 RETURNING ${REPORT_COLUMNS}`,
    [
      reportId,
      sourceId,
      r.tableId ?? null,
      toJson(r.joinTableIds || []),
      toJson(r.dimensionIds || []),
      toJson(r.measureIds || []),
      toJson(r.filters || []),
      r.chartType || "table",
      r.pageSize || 100,
      toBuckets(r.dimensionBuckets),
      toOrderBy(r.orderBy),
      r.rowLimit ?? null,
      r.kind === "sql" ? "sql" : "semantic",
      r.kind === "sql" ? (r.sql ?? "") : null,
      toJson(r.sqlVars || []),
      r.modelId ?? null,
    ],
  );
  return rows[0] || null;
}

// Slice 4 - the organisation fields (rename / move to a collection / star),
// distinct from updateReport's full query-definition replace. Partial: a
// key left undefined is untouched.
export async function updateReportMeta(sourceId, reportId, { name, collectionId, isFavorite }) {
  const sets = [];
  const values = [reportId, sourceId];
  if (name !== undefined) values.push(name), sets.push(`name = $${values.length}`);
  if (collectionId !== undefined) values.push(collectionId), sets.push(`collection_id = $${values.length}`);
  if (isFavorite !== undefined) values.push(!!isFavorite), sets.push(`is_favorite = $${values.length}`);
  if (sets.length === 0) return getReport(sourceId, reportId);
  const { rows } = await query(
    `UPDATE tablespace_reports SET ${sets.join(", ")}, updated_at = now()
     WHERE id = $1 AND source_id = $2 RETURNING ${REPORT_COLUMNS}`,
    values,
  );
  return rows[0] || null;
}

export async function deleteReport(sourceId, reportId) {
  const { rowCount } = await query(
    `DELETE FROM tablespace_reports WHERE id = $1 AND source_id = $2`,
    [reportId, sourceId],
  );
  return rowCount > 0;
}

// Phase 4.5 - dashboards. A named, ordered list of report ids (array
// order IS the grid order - v1 has no per-tile x/y/w/h, just an
// auto-flowing grid, same "prove the narrow case first" scoping every
// other sub-phase here has used). No stored result data, same as
// reports - a dashboard just points at report ids; the client re-runs
// each report's query live via the existing /sources/:sourceId/query
// route per tile.
const DASHBOARD_COLUMNS = `
  id, source_id AS "sourceId", name, report_ids AS "reportIds",
  layout, text_tiles AS "textTiles", parameters,
  collection_id AS "collectionId", is_favorite AS "isFavorite",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

export async function listDashboards(sourceId) {
  const { rows } = await query(
    `SELECT ${DASHBOARD_COLUMNS} FROM tablespace_dashboards WHERE source_id = $1 ORDER BY created_at ASC`,
    [sourceId],
  );
  return rows;
}

export async function getDashboard(sourceId, dashboardId) {
  const { rows } = await query(
    `SELECT ${DASHBOARD_COLUMNS} FROM tablespace_dashboards WHERE id = $1 AND source_id = $2`,
    [dashboardId, sourceId],
  );
  return rows[0] || null;
}

export async function createDashboard(sourceId, { name, reportIds, layout, textTiles, parameters, collectionId }) {
  const { rows } = await query(
    `INSERT INTO tablespace_dashboards (source_id, name, report_ids, layout, text_tiles, parameters, collection_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${DASHBOARD_COLUMNS}`,
    [
      sourceId,
      name,
      toJson(reportIds || []),
      toJson(layout || []),
      toJson(textTiles || []),
      toJson(parameters || []),
      collectionId ?? null,
    ],
  );
  return rows[0];
}

// Slice 4 - rename / move to a collection / star, partial like
// updateReportMeta. Kept separate from updateDashboard (which owns the
// grid/membership JSONB fields).
export async function updateDashboardMeta(sourceId, dashboardId, { name, collectionId, isFavorite }) {
  const sets = [];
  const values = [dashboardId, sourceId];
  if (name !== undefined) values.push(name), sets.push(`name = $${values.length}`);
  if (collectionId !== undefined) values.push(collectionId), sets.push(`collection_id = $${values.length}`);
  if (isFavorite !== undefined) values.push(!!isFavorite), sets.push(`is_favorite = $${values.length}`);
  if (sets.length === 0) return getDashboard(sourceId, dashboardId);
  const { rows } = await query(
    `UPDATE tablespace_dashboards SET ${sets.join(", ")}, updated_at = now()
     WHERE id = $1 AND source_id = $2 RETURNING ${DASHBOARD_COLUMNS}`,
    values,
  );
  return rows[0] || null;
}

export function renameDashboard(sourceId, dashboardId, name) {
  return updateDashboardMeta(sourceId, dashboardId, { name });
}

// Reporting-parity slice 3 - a dashboard now has four mutable fields
// (membership + grid layout + text tiles + filter params). A partial
// update: only the keys actually passed are written, so "add a report"
// (client sends reportIds) and "drag a tile" (client sends layout) don't
// clobber each other. report_ids is still replaced wholesale when sent -
// add/remove/reorder are all one operation (the client sends the full
// next array), same as before.
export async function updateDashboard(sourceId, dashboardId, patch = {}) {
  const sets = [];
  const values = [dashboardId, sourceId];
  const col = (name, value) => {
    values.push(toJson(value || []));
    sets.push(`${name} = $${values.length}`);
  };
  if (patch.reportIds !== undefined) col("report_ids", patch.reportIds);
  if (patch.layout !== undefined) col("layout", patch.layout);
  if (patch.textTiles !== undefined) col("text_tiles", patch.textTiles);
  if (patch.parameters !== undefined) col("parameters", patch.parameters);
  if (sets.length === 0) return getDashboard(sourceId, dashboardId);
  const { rows } = await query(
    `UPDATE tablespace_dashboards SET ${sets.join(", ")}, updated_at = now()
     WHERE id = $1 AND source_id = $2 RETURNING ${DASHBOARD_COLUMNS}`,
    values,
  );
  return rows[0] || null;
}

// Back-compat wrapper - the "Add to dashboard" / remove / reorder paths
// only ever touch membership.
export async function updateDashboardReports(sourceId, dashboardId, reportIds) {
  return updateDashboard(sourceId, dashboardId, { reportIds });
}

export async function deleteDashboard(sourceId, dashboardId) {
  const { rowCount } = await query(
    `DELETE FROM tablespace_dashboards WHERE id = $1 AND source_id = $2`,
    [dashboardId, sourceId],
  );
  return rowCount > 0;
}

// Slice 4 - collections: source-scoped folders for reports + dashboards.
// parent_id self-ref (NULL = top level). Delete CASCADEs child folders and
// SET NULLs the collection_id on any report/dashboard that was filed here
// (contents survive, just unfiled - see the migration).
const COLLECTION_COLUMNS = `
  id, source_id AS "sourceId", parent_id AS "parentId", name,
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

export async function listCollections(sourceId) {
  const { rows } = await query(
    `SELECT ${COLLECTION_COLUMNS} FROM tablespace_collections WHERE source_id = $1 ORDER BY name ASC`,
    [sourceId],
  );
  return rows;
}

export async function createCollection(sourceId, { name, parentId }) {
  const { rows } = await query(
    `INSERT INTO tablespace_collections (source_id, name, parent_id)
     VALUES ($1, $2, $3) RETURNING ${COLLECTION_COLUMNS}`,
    [sourceId, name, parentId ?? null],
  );
  return rows[0];
}

export async function renameCollection(sourceId, collectionId, name) {
  const { rows } = await query(
    `UPDATE tablespace_collections SET name = $3, updated_at = now()
     WHERE id = $1 AND source_id = $2 RETURNING ${COLLECTION_COLUMNS}`,
    [collectionId, sourceId, name],
  );
  return rows[0] || null;
}

export async function deleteCollection(sourceId, collectionId) {
  const { rowCount } = await query(
    `DELETE FROM tablespace_collections WHERE id = $1 AND source_id = $2`,
    [collectionId, sourceId],
  );
  return rowCount > 0;
}

// Slice 5 - Models: saved curated datasets a report is built on. Mirrors
// the reports shape (source-scoped, soft refs into branch JSONB, same
// create / full-update / partial-meta-update split).
const MODEL_COLUMNS = `
  id, source_id AS "sourceId", name, kind,
  base_table_id AS "baseTableId", joins, columns, filters,
  sql, sql_vars AS "sqlVars",
  collection_id AS "collectionId", is_favorite AS "isFavorite",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

export async function listModels(sourceId) {
  const { rows } = await query(
    `SELECT ${MODEL_COLUMNS} FROM tablespace_models WHERE source_id = $1 ORDER BY created_at ASC`,
    [sourceId],
  );
  return rows;
}

export async function getModel(sourceId, modelId) {
  const { rows } = await query(
    `SELECT ${MODEL_COLUMNS} FROM tablespace_models WHERE id = $1 AND source_id = $2`,
    [modelId, sourceId],
  );
  return rows[0] || null;
}

const modelValues = (m) => [
  m.name,
  m.kind === "sql" ? "sql" : "builder",
  m.kind === "sql" ? null : (m.baseTableId ?? null),
  toJson(m.joins || []),
  toJson(m.columns || []),
  toJson(m.filters || []),
  m.kind === "sql" ? (m.sql ?? "") : null,
  toJson(m.sqlVars || []),
];

export async function createModel(sourceId, m) {
  const { rows } = await query(
    `INSERT INTO tablespace_models
       (source_id, name, kind, base_table_id, joins, columns, filters, sql, sql_vars, collection_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${MODEL_COLUMNS}`,
    [sourceId, ...modelValues(m), m.collectionId ?? null],
  );
  return rows[0];
}

export async function updateModel(sourceId, modelId, m) {
  const { rows } = await query(
    `UPDATE tablespace_models
     SET name = $3, kind = $4, base_table_id = $5, joins = $6, columns = $7, filters = $8,
         sql = $9, sql_vars = $10, updated_at = now()
     WHERE id = $1 AND source_id = $2 RETURNING ${MODEL_COLUMNS}`,
    [modelId, sourceId, ...modelValues(m)],
  );
  return rows[0] || null;
}

export async function updateModelMeta(sourceId, modelId, { name, collectionId, isFavorite }) {
  const sets = [];
  const values = [modelId, sourceId];
  if (name !== undefined) values.push(name), sets.push(`name = $${values.length}`);
  if (collectionId !== undefined) values.push(collectionId), sets.push(`collection_id = $${values.length}`);
  if (isFavorite !== undefined) values.push(!!isFavorite), sets.push(`is_favorite = $${values.length}`);
  if (sets.length === 0) return getModel(sourceId, modelId);
  const { rows } = await query(
    `UPDATE tablespace_models SET ${sets.join(", ")}, updated_at = now()
     WHERE id = $1 AND source_id = $2 RETURNING ${MODEL_COLUMNS}`,
    values,
  );
  return rows[0] || null;
}

export async function deleteModel(sourceId, modelId) {
  const { rowCount } = await query(
    `DELETE FROM tablespace_models WHERE id = $1 AND source_id = $2`,
    [modelId, sourceId],
  );
  return rowCount > 0;
}

// List rows are deliberately lightweight (a table-count derived from
// jsonb_array_length, not the full nodes/edges/enums payload) - matches
// this file's existing listProjects/listCheckpoints pattern of "list is
// cheap, get is full."
// canMerge: a branch can only ever be automatically merged into the exact
// parent it forked from (no common-ancestor computation for arbitrary
// pairs - see schemaMerge.js's own header comment), AND only if it has a
// recorded fork-point snapshot (base_nodes - NULL for main and for any
// branch created before automatic merge shipped). Computed here so the
// UI can enable/disable the merge action from this lightweight list alone,
// never fetching the JSONB base snapshot just to check eligibility.
const BRANCH_LIST_COLUMNS = `
  id, source_id AS "sourceId", name, parent_branch_id AS "parentBranchId",
  is_main AS "isMain", schema_version AS "schemaVersion",
  jsonb_array_length(nodes) AS "tableCount",
  (parent_branch_id IS NOT NULL AND base_nodes IS NOT NULL) AS "canMerge",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const BRANCH_FULL_COLUMNS = `
  id, source_id AS "sourceId", name, parent_branch_id AS "parentBranchId",
  is_main AS "isMain", nodes, edges, enums, pages, schema_version AS "schemaVersion",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
// Only selected when actually merging - the normal load/switch/save path
// (getBranch/getMainBranch) never pays for a JSONB payload it doesn't need.
const BRANCH_FULL_COLUMNS_WITH_BASE = `${BRANCH_FULL_COLUMNS},
  base_nodes AS "baseNodes", base_edges AS "baseEdges", base_enums AS "baseEnums"`;

export async function listBranches(sourceId) {
  const { rows } = await query(
    `SELECT ${BRANCH_LIST_COLUMNS} FROM tablespace_branches WHERE source_id = $1 ORDER BY is_main DESC, created_at ASC`,
    [sourceId],
  );
  return rows;
}

export async function getMainBranch(sourceId) {
  const { rows } = await query(
    `SELECT ${BRANCH_FULL_COLUMNS} FROM tablespace_branches WHERE source_id = $1 AND is_main = true`,
    [sourceId],
  );
  return rows[0] || null;
}

export async function getBranch(sourceId, branchId) {
  const { rows } = await query(
    `SELECT ${BRANCH_FULL_COLUMNS} FROM tablespace_branches WHERE id = $1 AND source_id = $2`,
    [branchId, sourceId],
  );
  return rows[0] || null;
}

// The only place base_nodes/base_edges/base_enums are ever read - used
// exclusively by the merge route.
export async function getBranchWithBase(sourceId, branchId) {
  const { rows } = await query(
    `SELECT ${BRANCH_FULL_COLUMNS_WITH_BASE} FROM tablespace_branches WHERE id = $1 AND source_id = $2`,
    [branchId, sourceId],
  );
  return rows[0] || null;
}

// A point-in-time copy of the source branch's current content - no live
// link back afterward. Editing the source later never retroactively
// changes a fork already taken from it; that drift is exactly what the
// diff viewer exists to surface. The SAME copy is also captured into
// base_nodes/base_edges/base_enums - the fork-point snapshot automatic
// merge needs (see schemaMerge.js) - captured ONCE, here, and never
// updated again, deliberately distinct from nodes/edges/enums which then
// diverge via normal edits on this new branch.
export async function createBranch(sourceId, { name, sourceBranchId }) {
  const sourceBranch = await getBranch(sourceId, sourceBranchId);
  if (!sourceBranch) return null;
  const nodesJson = toJson(sourceBranch.nodes);
  const edgesJson = toJson(sourceBranch.edges);
  const enumsJson = toJson(sourceBranch.enums);
  // Pages carry forward like any other starting content, but - unlike
  // nodes/edges/enums - are NOT captured into a base_* fork-point snapshot:
  // schemaMerge.js only ever reconciles nodes/edges/enums, so a page's
  // table-id list just rides along per-branch with no automatic merge
  // reconciliation of its own.
  const pagesJson = toJson(sourceBranch.pages);
  const { rows } = await query(
    `INSERT INTO tablespace_branches
       (source_id, name, parent_branch_id, is_main, nodes, edges, enums, pages, base_nodes, base_edges, base_enums, schema_version)
     VALUES ($1, $2, $3, false, $4, $5, $6, $7, $4, $5, $6, $8)
     RETURNING ${BRANCH_FULL_COLUMNS}`,
    [sourceId, name, sourceBranchId, nodesJson, edgesJson, enumsJson, pagesJson, sourceBranch.schemaVersion],
  );
  return rows[0];
}

export async function saveBranch(sourceId, branchId, { nodes, edges, enums, pages, schemaVersion }) {
  const { rows } = await query(
    `UPDATE tablespace_branches SET nodes = $3, edges = $4, enums = $5, pages = $6, schema_version = $7, updated_at = now()
     WHERE id = $1 AND source_id = $2
     RETURNING ${BRANCH_FULL_COLUMNS}`,
    [branchId, sourceId, toJson(nodes), toJson(edges), toJson(enums), toJson(pages), schemaVersion],
  );
  return rows[0] || null;
}

export async function renameBranch(sourceId, branchId, name) {
  const { rows } = await query(
    `UPDATE tablespace_branches SET name = $3, updated_at = now() WHERE id = $1 AND source_id = $2
     RETURNING ${BRANCH_LIST_COLUMNS}`,
    [branchId, sourceId, name],
  );
  return rows[0] || null;
}

// is_main = false in the SQL is defense-in-depth; the route pre-checks
// isMain separately first so it can return an accurate 400 ("can't delete
// main") instead of a misleading 404 for that specific case.
export async function deleteBranch(sourceId, branchId) {
  const { rows } = await query(
    `DELETE FROM tablespace_branches WHERE id = $1 AND source_id = $2 AND is_main = false RETURNING id`,
    [branchId, sourceId],
  );
  return rows.length > 0;
}

export async function listCheckpoints(sourceId) {
  const { rows } = await query(
    `SELECT id, source_id AS "sourceId", label, nodes, edges, enums, created_at AS "createdAt"
     FROM tablespace_checkpoints WHERE source_id = $1 ORDER BY created_at DESC`,
    [sourceId],
  );
  return rows;
}

export async function createCheckpoint(sourceId, { label, nodes, edges, enums }) {
  const { rows } = await query(
    `INSERT INTO tablespace_checkpoints (source_id, label, nodes, edges, enums)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, source_id AS "sourceId", label, nodes, edges, enums, created_at AS "createdAt"`,
    [sourceId, label, toJson(nodes), toJson(edges), toJson(enums)],
  );
  return rows[0];
}

export async function getCheckpoint(sourceId, checkpointId) {
  const { rows } = await query(
    `SELECT id, source_id AS "sourceId", label, nodes, edges, enums, created_at AS "createdAt"
     FROM tablespace_checkpoints WHERE id = $1 AND source_id = $2`,
    [checkpointId, sourceId],
  );
  return rows[0] || null;
}

export async function deleteCheckpoint(sourceId, checkpointId) {
  const { rowCount } = await query(
    `DELETE FROM tablespace_checkpoints WHERE id = $1 AND source_id = $2`,
    [checkpointId, sourceId],
  );
  return rowCount > 0;
}
