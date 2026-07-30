import pg from "pg";

// pg-connection-string (what `pg` uses to parse a connection string's own
// sslmode) treats "require"/"prefer"/"verify-ca" as aliases for
// "verify-full" - full certificate-chain + hostname verification - not the
// weaker "encrypt, don't verify" that real libpq gives those modes. That
// mismatch is silent: a connection string with sslmode=require still gets
// full verification, so a self-signed or private-CA server (AWS RDS, most
// self-hosted Postgres, Docker) fails identically whether sslmode is present
// or not. Parsing it ourselves restores the semantics a user coming from
// psql/DataGrip/pgAdmin actually expects.
function resolveSsl(connectionString) {
  const match = connectionString.match(/[?&]sslmode=([^&]+)/i);
  const sslmode = match ? decodeURIComponent(match[1]).toLowerCase() : null;

  if (sslmode === "disable") return false;
  if (sslmode === "verify-ca" || sslmode === "verify-full") return { rejectUnauthorized: true };

  // require/prefer/allow, or no sslmode at all - encrypt, but don't demand a
  // certificate chain Node's default CA bundle happens to trust. AWS RDS
  // (and most hosted-or-self-hosted Postgres outside a few providers like
  // Neon that use a publicly-trusted CA) uses a cert that isn't in that
  // bundle even though the connection is genuinely TLS-encrypted - exactly
  // why DataGrip/psql connect fine here with their own default settings
  // while strict verification alone doesn't. Whoever calls this endpoint
  // already holds real credentials for the target database, so the risk
  // this weakens (an attacker impersonating the DB server) is narrow
  // relative to failing every non-Neon-like host by default.
  return { rejectUnauthorized: false };
}

// One-shot, ephemeral connection - no pooling, no reuse across requests. This
// endpoint's whole job is "borrow a connection just long enough to read the
// catalog, then let it go" - holding a pool keyed by arbitrary user-supplied
// connection strings would mean silently caching other people's DB credentials
// in memory for the life of the process, which is exactly the kind of thing an
// introspection-only service shouldn't do.
async function withClient(connectionString, fn) {
  const client = new pg.Client({
    connectionString,
    ssl: resolveSsl(connectionString),
    connectionTimeoutMillis: 10_000,
    query_timeout: 20_000,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// Migration tools' own bookkeeping tables (Alembic, Django, Rails/
// golang-migrate, Knex, Flyway, Laravel) are real tables in the schema, but
// not domain tables a user importing their database wants to see on the
// canvas - confirmed live against a real Alembic-managed Neon database
// (alembic_version) and a real Django/RDS production database
// (django_migrations), both otherwise showing up as their own node.
//
// Deliberately narrow to migration-tracking tables specifically, not every
// framework-internal table (e.g. Django's auth_user or django_session) -
// those are real tables people often do want relationships drawn to/from,
// so hiding them would be guessing at intent this list has no business
// guessing at.
const MIGRATION_TOOL_TABLES = [
  "alembic_version",
  "django_migrations",
  "schema_migrations",
  "knex_migrations",
  "knex_migrations_lock",
  "flyway_schema_history",
  "migrations",
];

const TABLES_QUERY = `
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = $1 AND table_type = 'BASE TABLE'
    AND table_name NOT IN (${MIGRATION_TOOL_TABLES.map((_, i) => `$${i + 2}`).join(", ")})
  ORDER BY table_name;
`;

const COLUMNS_QUERY = `
  SELECT table_name, column_name, data_type, udt_name, character_maximum_length,
         numeric_precision, numeric_scale, is_nullable, column_default, ordinal_position
  FROM information_schema.columns
  WHERE table_schema = $1
  ORDER BY table_name, ordinal_position;
`;

const PRIMARY_KEYS_QUERY = `
  SELECT tc.table_name, kcu.column_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1
  ORDER BY tc.table_name, kcu.ordinal_position;
`;

const FOREIGN_KEYS_QUERY = `
  SELECT
    tc.constraint_name,
    tc.table_name AS from_table,
    kcu.column_name AS from_column,
    ccu.table_name AS to_table,
    ccu.column_name AS to_column
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  JOIN information_schema.constraint_column_usage ccu
    ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1;
`;

const UNIQUE_CONSTRAINTS_QUERY = `
  SELECT tc.table_name, tc.constraint_name, kcu.column_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'UNIQUE' AND tc.table_schema = $1
  ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position;
`;

const CHECK_CONSTRAINTS_QUERY = `
  SELECT tc.table_name, tc.constraint_name, cc.check_clause
  FROM information_schema.table_constraints tc
  JOIN information_schema.check_constraints cc
    ON tc.constraint_name = cc.constraint_name AND tc.constraint_schema = cc.constraint_schema
  WHERE tc.constraint_type = 'CHECK' AND tc.table_schema = $1
    AND tc.constraint_name NOT LIKE '%_not_null';
`;

// pg_catalog rather than information_schema for indexes - information_schema
// has no clean "list of columns per index" view, while pg_index/pg_class do.
// Excludes primary-key-backing indexes (already represented via
// constraints.primaryKey) - those aren't a separate user-defined index.
const INDEXES_QUERY = `
  SELECT
    t.relname AS table_name,
    i.relname AS index_name,
    ix.indisunique AS is_unique,
    array_agg(a.attname::text ORDER BY array_position(ix.indkey::int[], a.attnum::int)) AS column_names
  FROM pg_index ix
  JOIN pg_class i ON i.oid = ix.indexrelid
  JOIN pg_class t ON t.oid = ix.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
  WHERE n.nspname = $1 AND t.relkind = 'r' AND NOT ix.indisprimary
  GROUP BY t.relname, i.relname, ix.indisunique
  ORDER BY t.relname, i.relname;
`;

const ENUMS_QUERY = `
  SELECT t.typname AS enum_name, e.enumlabel AS value
  FROM pg_type t
  JOIN pg_enum e ON t.oid = e.enumtypid
  JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = $1
  ORDER BY t.typname, e.enumsortorder;
`;

// Runs every introspection query against one connection and hands back the
// raw rows - shaping this into the app's {nodes, edges, enums} schema is a
// separate concern, see toTablespaceSchema.js.
export async function introspectPostgres(connectionString, schema = "public") {
  return withClient(connectionString, async (client) => {
    const [tables, columns, primaryKeys, foreignKeys, uniqueConstraints, checkConstraints, indexes, enums] =
      await Promise.all([
        client.query(TABLES_QUERY, [schema, ...MIGRATION_TOOL_TABLES]),
        client.query(COLUMNS_QUERY, [schema]),
        client.query(PRIMARY_KEYS_QUERY, [schema]),
        client.query(FOREIGN_KEYS_QUERY, [schema]),
        client.query(UNIQUE_CONSTRAINTS_QUERY, [schema]),
        client.query(CHECK_CONSTRAINTS_QUERY, [schema]),
        client.query(INDEXES_QUERY, [schema]),
        client.query(ENUMS_QUERY, [schema]),
      ]);

    return {
      tables: tables.rows,
      columns: columns.rows,
      primaryKeys: primaryKeys.rows,
      foreignKeys: foreignKeys.rows,
      uniqueConstraints: uniqueConstraints.rows,
      checkConstraints: checkConstraints.rows,
      indexes: indexes.rows,
      enums: enums.rows,
    };
  });
}
