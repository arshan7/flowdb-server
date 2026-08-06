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
// a failed diagram insert must never leave an orphaned project row.
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
    if (template) {
      await client.query(
        `INSERT INTO tablespace_diagrams (project_id, nodes, edges, enums) VALUES ($1, $2, $3, $4)`,
        [project.id, toJson(template.nodes), toJson(template.edges), toJson(template.enums)],
      );
    }
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

export async function getDiagram(projectId) {
  const { rows } = await query(
    `SELECT project_id AS "projectId", nodes, edges, enums, schema_version AS "schemaVersion", updated_at AS "updatedAt"
     FROM tablespace_diagrams WHERE project_id = $1`,
    [projectId],
  );
  return rows[0] || null;
}

export async function saveDiagram(projectId, { nodes, edges, enums, schemaVersion }) {
  const { rows } = await query(
    `INSERT INTO tablespace_diagrams (project_id, nodes, edges, enums, schema_version, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (project_id) DO UPDATE SET
       nodes = EXCLUDED.nodes, edges = EXCLUDED.edges, enums = EXCLUDED.enums,
       schema_version = EXCLUDED.schema_version, updated_at = now()
     RETURNING project_id AS "projectId", nodes, edges, enums, schema_version AS "schemaVersion", updated_at AS "updatedAt"`,
    [projectId, toJson(nodes), toJson(edges), toJson(enums), schemaVersion],
  );
  return rows[0];
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
