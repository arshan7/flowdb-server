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
export function resolveSsl(connectionString) {
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

// resolveSsl decides the ssl config, but handing pg a connection string
// that STILL carries `sslmode=` undoes that: pg-connection-string parses the
// string's own sslmode into an ssl object and Object.assigns it OVER the
// `ssl` option (pg's ConnectionParameters), and it reads require/verify-ca
// as full verify-full - so `?sslmode=require` against a private-CA host
// (Aiven, AWS RDS) throws SELF_SIGNED_CERT_IN_CHAIN even though resolveSsl
// asked for {rejectUnauthorized:false}. Strip sslmode from the string and
// pass the ssl config separately so the one resolveSsl chose is the one that
// takes effect. Keyword-form strings ("host=... sslmode=...") aren't URLs
// and aren't subject to that override, so leave them untouched.
export function splitSsl(connectionString) {
  const ssl = resolveSsl(connectionString);
  try {
    const u = new URL(connectionString);
    u.searchParams.delete("sslmode");
    return { connectionString: u.toString(), ssl };
  } catch {
    return { connectionString, ssl };
  }
}

// node-postgres has no equivalent of libpq's default sslmode=prefer - try
// SSL, then quietly fall back to a plaintext connection if the server
// refuses it. It just errors instead. This is the one pg error that means
// exactly "server refused SSL outright" (a bare Error with no .code, unlike
// the SQLSTATE-carrying auth/permission errors or the tagged cert errors),
// so it's the one case where retrying without SSL is the right move rather
// than a surprise. Public/LAN Postgres (the EBI RNAcentral demo DB, plain
// `postgres` containers, dev boxes) commonly has SSL off entirely.
export function isSslRefusedError(err) {
  return !err?.code && /does not support SSL/i.test(err?.message || "");
}

// ...but only fall back when the connection string didn't explicitly demand
// encryption. Mirrors libpq: no sslmode (the default) and prefer/allow fall
// back to plaintext; require/verify-ca/verify-full mean "encryption is
// mandatory", so a refusal there has to stay a hard error rather than be
// silently downgraded.
export function sslFallbackAllowed(connectionString) {
  const m = connectionString.match(/[?&]sslmode=([^&]+)/i);
  const mode = m ? decodeURIComponent(m[1]).toLowerCase() : null;
  return mode === null || mode === "prefer" || mode === "allow";
}

// Scoped to the lifetime of one request, then torn down - never reused
// across requests, so this isn't the kind of persistent credential-holding
// pool the "no pooling" principle is actually about. A single pg.Client
// serializes every query sent to it even when they're all fired off inside
// one Promise.all (each .query() call queues on the client, one at a time) -
// so introspectPostgres's 8 concurrent-looking queries were really running
// back to back, and a real ~250-table schema turned that into several
// real seconds. A pool sized to the number of introspection queries lets
// them actually run in parallel instead - measured ~6.2s -> ~4.6s on a real
// 267-table AWS RDS database (opening several concurrent connections to the
// same host has its own overhead, so this isn't the full 8x it might look
// like on paper - see COLUMNS/FOREIGN_KEYS below for the bigger remaining
// win).
async function withClient(connectionString, fn) {
  const { connectionString: cleanUrl, ssl } = splitSsl(connectionString);
  const open = (sslConfig) =>
    new pg.Pool({
      connectionString: cleanUrl,
      ssl: sslConfig,
      connectionTimeoutMillis: 10_000,
      query_timeout: 20_000,
      max: 8,
    });
  const run = async (pool) => {
    try {
      return await fn(pool);
    } finally {
      await pool.end();
    }
  };

  try {
    return await run(open(ssl));
  } catch (err) {
    // sslFallbackAllowed reads the ORIGINAL string - cleanUrl no longer has
    // sslmode to check.
    if (!isSslRefusedError(err) || !sslFallbackAllowed(connectionString)) throw err;
    return run(open(false));
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

// pg_catalog rather than information_schema for columns/PK/FK/unique/check -
// information_schema.columns and the table_constraints/key_column_usage/
// constraint_column_usage views do a privilege check per row, which is cheap
// on a handful of tables but measured at 1.1s-1.6s per query on a real
// ~250-table database, vs ~230-290ms querying the underlying catalog tables
// directly for the same data (confirmed byte-for-byte identical output,
// aside from FOREIGN_KEYS - see below).
//
// This isn't just a speed win: on that same real database, the
// information_schema-based FOREIGN_KEYS query silently omitted 14 real,
// valid, enforced foreign keys that pg_constraint has - confirmed by
// checking pg_constraint directly for one of them (a normal, deferrable FK
// to a table with several other FKs, no different from the ones that WERE
// returned). information_schema's constraint views are known to drop rows
// in some privilege/ownership edge cases; querying pg_constraint directly
// sidesteps that class of bug entirely, not just the slowness.
const COLUMNS_QUERY = `
  SELECT
    c.relname AS table_name,
    a.attname AS column_name,
    t.typname AS data_type,
    t.typname AS udt_name,
    information_schema._pg_char_max_length(a.atttypid, a.atttypmod) AS character_maximum_length,
    information_schema._pg_numeric_precision(a.atttypid, a.atttypmod) AS numeric_precision,
    information_schema._pg_numeric_scale(a.atttypid, a.atttypmod) AS numeric_scale,
    CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
    pg_get_expr(ad.adbin, ad.adrelid) AS column_default,
    a.attnum AS ordinal_position
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_type t ON t.oid = a.atttypid
  LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
  WHERE n.nspname = $1 AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY c.relname, a.attnum;
`;

const PRIMARY_KEYS_QUERY = `
  SELECT tc.relname AS table_name, col.attname AS column_name
  FROM pg_constraint con
  JOIN pg_class tc ON tc.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = con.connamespace
  CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
  JOIN pg_attribute col ON col.attrelid = tc.oid AND col.attnum = k.attnum
  WHERE con.contype = 'p' AND n.nspname = $1
  ORDER BY tc.relname, k.ord;
`;

// unnest(conkey, confkey) zips the two arrays together column-by-column, so
// this - unlike the information_schema equivalent it replaced - is also
// correct for composite (multi-column) foreign keys.
const FOREIGN_KEYS_QUERY = `
  SELECT
    con.conname AS constraint_name,
    tc.relname AS from_table,
    fc.relname AS to_table,
    fromcol.attname AS from_column,
    tocol.attname AS to_column
  FROM pg_constraint con
  JOIN pg_class tc ON tc.oid = con.conrelid
  JOIN pg_class fc ON fc.oid = con.confrelid
  JOIN pg_namespace n ON n.oid = con.connamespace
  CROSS JOIN LATERAL unnest(con.conkey, con.confkey) AS cols(from_attnum, to_attnum)
  JOIN pg_attribute fromcol ON fromcol.attrelid = tc.oid AND fromcol.attnum = cols.from_attnum
  JOIN pg_attribute tocol ON tocol.attrelid = fc.oid AND tocol.attnum = cols.to_attnum
  WHERE con.contype = 'f' AND n.nspname = $1;
`;

const UNIQUE_CONSTRAINTS_QUERY = `
  SELECT tc.relname AS table_name, con.conname AS constraint_name, col.attname AS column_name
  FROM pg_constraint con
  JOIN pg_class tc ON tc.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = con.connamespace
  CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
  JOIN pg_attribute col ON col.attrelid = tc.oid AND col.attnum = k.attnum
  WHERE con.contype = 'u' AND n.nspname = $1
  ORDER BY tc.relname, con.conname, k.ord;
`;

// pg_get_constraintdef always returns "CHECK " followed by the expression
// exactly as Postgres's own deparser formatted it (which may or may not add
// its own parens depending on the expression) - stripping just that literal
// prefix reproduces information_schema.check_constraints.check_clause
// exactly (verified against a real database: 0 diffs across every check
// constraint), without the privilege-check overhead of going through the
// view.
const CHECK_CONSTRAINTS_QUERY = `
  SELECT
    tc.relname AS table_name,
    con.conname AS constraint_name,
    regexp_replace(pg_get_constraintdef(con.oid), '^CHECK\\s+', '') AS check_clause
  FROM pg_constraint con
  JOIN pg_class tc ON tc.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = con.connamespace
  WHERE con.contype = 'c' AND n.nspname = $1 AND con.conname NOT LIKE '%_not_null';
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
    // pg_catalog is world-readable on a stock Postgres, but some hardened
    // shared/public instances (e.g. EBI's RNAcentral) revoke SELECT on
    // pg_enum from unprivileged roles. Enums are the most skippable part of
    // a schema import, so a permission wall on this one query shouldn't sink
    // the whole introspection - treat it as "no enums" and carry on. Only
    // 42501 (insufficient_privilege); anything else still means the
    // connection is compromised and must propagate.
    const enums = client.query(ENUMS_QUERY, [schema]).catch((err) => {
      if (err.code === "42501") return { rows: [] };
      throw err;
    });
    const [tables, columns, primaryKeys, foreignKeys, uniqueConstraints, checkConstraints, indexes, enumsResult] =
      await Promise.all([
        client.query(TABLES_QUERY, [schema, ...MIGRATION_TOOL_TABLES]),
        client.query(COLUMNS_QUERY, [schema]),
        client.query(PRIMARY_KEYS_QUERY, [schema]),
        client.query(FOREIGN_KEYS_QUERY, [schema]),
        client.query(UNIQUE_CONSTRAINTS_QUERY, [schema]),
        client.query(CHECK_CONSTRAINTS_QUERY, [schema]),
        client.query(INDEXES_QUERY, [schema]),
        enums,
      ]);

    return {
      tables: tables.rows,
      columns: columns.rows,
      primaryKeys: primaryKeys.rows,
      foreignKeys: foreignKeys.rows,
      uniqueConstraints: uniqueConstraints.rows,
      checkConstraints: checkConstraints.rows,
      indexes: indexes.rows,
      enums: enumsResult.rows,
    };
  });
}
