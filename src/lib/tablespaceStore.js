import { pool, query } from "./db.js";

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

// Wrapped in a real transaction (not two independent pool.query() calls) -
// a failed branch insert must never leave an orphaned project row.
// Unconditionally creates a main branch (previously only inserted a
// tablespace_diagrams row `if (template)`) - branches are saved via a plain
// UPDATE, not an upsert like the old diagram table was, so a project with
// no row to target would 404 on its very first edit.
export async function createProject({ name, template, createdAt }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO tablespace_projects (name, created_at, updated_at)
       VALUES ($1, COALESCE($2, now()), COALESCE($2, now()))
       RETURNING id, name, status, is_favorite AS "isFavorite", created_at AS "createdAt", updated_at AS "modifiedAt"`,
      [name, createdAt || null],
    );
    const project = rows[0];
    await client.query(
      `INSERT INTO tablespace_branches (project_id, name, is_main, nodes, edges, enums)
       VALUES ($1, 'main', true, $2, $3, $4)`,
      [project.id, toJson(template?.nodes), toJson(template?.edges), toJson(template?.enums)],
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
  return rowCount > 0; // ON DELETE CASCADE takes the diagram + checkpoints with it
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
  id, project_id AS "projectId", name, parent_branch_id AS "parentBranchId",
  is_main AS "isMain", schema_version AS "schemaVersion",
  jsonb_array_length(nodes) AS "tableCount",
  (parent_branch_id IS NOT NULL AND base_nodes IS NOT NULL) AS "canMerge",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const BRANCH_FULL_COLUMNS = `
  id, project_id AS "projectId", name, parent_branch_id AS "parentBranchId",
  is_main AS "isMain", nodes, edges, enums, schema_version AS "schemaVersion",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
// Only selected when actually merging - the normal load/switch/save path
// (getBranch/getMainBranch) never pays for a JSONB payload it doesn't need.
const BRANCH_FULL_COLUMNS_WITH_BASE = `${BRANCH_FULL_COLUMNS},
  base_nodes AS "baseNodes", base_edges AS "baseEdges", base_enums AS "baseEnums"`;

export async function listBranches(projectId) {
  const { rows } = await query(
    `SELECT ${BRANCH_LIST_COLUMNS} FROM tablespace_branches WHERE project_id = $1 ORDER BY is_main DESC, created_at ASC`,
    [projectId],
  );
  return rows;
}

export async function getMainBranch(projectId) {
  const { rows } = await query(
    `SELECT ${BRANCH_FULL_COLUMNS} FROM tablespace_branches WHERE project_id = $1 AND is_main = true`,
    [projectId],
  );
  return rows[0] || null;
}

export async function getBranch(projectId, branchId) {
  const { rows } = await query(
    `SELECT ${BRANCH_FULL_COLUMNS} FROM tablespace_branches WHERE id = $1 AND project_id = $2`,
    [branchId, projectId],
  );
  return rows[0] || null;
}

// The only place base_nodes/base_edges/base_enums are ever read - used
// exclusively by the merge route.
export async function getBranchWithBase(projectId, branchId) {
  const { rows } = await query(
    `SELECT ${BRANCH_FULL_COLUMNS_WITH_BASE} FROM tablespace_branches WHERE id = $1 AND project_id = $2`,
    [branchId, projectId],
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
export async function createBranch(projectId, { name, sourceBranchId }) {
  const source = await getBranch(projectId, sourceBranchId);
  if (!source) return null;
  const nodesJson = toJson(source.nodes);
  const edgesJson = toJson(source.edges);
  const enumsJson = toJson(source.enums);
  const { rows } = await query(
    `INSERT INTO tablespace_branches
       (project_id, name, parent_branch_id, is_main, nodes, edges, enums, base_nodes, base_edges, base_enums, schema_version)
     VALUES ($1, $2, $3, false, $4, $5, $6, $4, $5, $6, $7)
     RETURNING ${BRANCH_FULL_COLUMNS}`,
    [projectId, name, sourceBranchId, nodesJson, edgesJson, enumsJson, source.schemaVersion],
  );
  return rows[0];
}

export async function saveBranch(projectId, branchId, { nodes, edges, enums, schemaVersion }) {
  const { rows } = await query(
    `UPDATE tablespace_branches SET nodes = $3, edges = $4, enums = $5, schema_version = $6, updated_at = now()
     WHERE id = $1 AND project_id = $2
     RETURNING ${BRANCH_FULL_COLUMNS}`,
    [branchId, projectId, toJson(nodes), toJson(edges), toJson(enums), schemaVersion],
  );
  return rows[0] || null;
}

export async function renameBranch(projectId, branchId, name) {
  const { rows } = await query(
    `UPDATE tablespace_branches SET name = $3, updated_at = now() WHERE id = $1 AND project_id = $2
     RETURNING ${BRANCH_LIST_COLUMNS}`,
    [branchId, projectId, name],
  );
  return rows[0] || null;
}

// is_main = false in the SQL is defense-in-depth; the route pre-checks
// isMain separately first so it can return an accurate 400 ("can't delete
// main") instead of a misleading 404 for that specific case.
export async function deleteBranch(projectId, branchId) {
  const { rows } = await query(
    `DELETE FROM tablespace_branches WHERE id = $1 AND project_id = $2 AND is_main = false RETURNING id`,
    [branchId, projectId],
  );
  return rows.length > 0;
}

export async function listCheckpoints(projectId) {
  const { rows } = await query(
    `SELECT id, project_id AS "projectId", label, nodes, edges, enums, created_at AS "createdAt"
     FROM tablespace_checkpoints WHERE project_id = $1 ORDER BY created_at DESC`,
    [projectId],
  );
  return rows;
}

export async function createCheckpoint(projectId, { label, nodes, edges, enums }) {
  const { rows } = await query(
    `INSERT INTO tablespace_checkpoints (project_id, label, nodes, edges, enums)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, project_id AS "projectId", label, nodes, edges, enums, created_at AS "createdAt"`,
    [projectId, label, toJson(nodes), toJson(edges), toJson(enums)],
  );
  return rows[0];
}

export async function getCheckpoint(projectId, checkpointId) {
  const { rows } = await query(
    `SELECT id, project_id AS "projectId", label, nodes, edges, enums, created_at AS "createdAt"
     FROM tablespace_checkpoints WHERE id = $1 AND project_id = $2`,
    [checkpointId, projectId],
  );
  return rows[0] || null;
}

export async function deleteCheckpoint(projectId, checkpointId) {
  const { rowCount } = await query(
    `DELETE FROM tablespace_checkpoints WHERE id = $1 AND project_id = $2`,
    [checkpointId, projectId],
  );
  return rowCount > 0;
}
