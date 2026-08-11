import pg from "pg";
import { resolveSsl } from "./pgIntrospect.js";

const AGGREGATIONS = { count: "COUNT", sum: "SUM", avg: "AVG", min: "MIN", max: "MAX" };
const OPERATORS = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", contains: "ILIKE" };
// Phase 4.4b - calculated measures. Only these four symbols ever reach the
// SQL string, and only by exact map lookup (never a client value passed
// through directly) - same discipline OPERATORS above already uses for
// filters.
const CALC_OPERATORS = { "+": "+", "-": "-", "*": "*", "/": "/" };

// Phase 4.3 follow-up - pagination. `pageSize` IS client-choosable now
// (per explicit request), but only from this fixed allow-list - never an
// arbitrary client-supplied number. MAX_ROWS is the real hard cap
// regardless of which page size is picked: offset + pageSize can never
// exceed it, so "how many rows can this endpoint ever return across a
// paging session" stays a single, easy-to-reason-about invariant no
// matter how it's sliced - a deliberate, considered relaxation of the
// old flat LIMIT 1000, not an accidental one.
export const ALLOWED_PAGE_SIZES = [10, 50, 100, 500, 1000];
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_ROWS = 5000;

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

// Table-qualified identifier - "table"."column". Always used now (even in
// the no-join, single-table case) rather than only once a join makes it
// necessary, so there's exactly one code path instead of two that could
// silently drift apart. Harmless for the single-table case, required the
// moment two tables in a join share a column name.
function quoteQualified(table, column) {
  return `${quoteIdent(table)}.${quoteIdent(column)}`;
}

// A single aggregate expression - COUNT(*) or AGG("table"."column"). The
// one building block both a simple measure and each side of a calculated
// measure (4.4b) reduce to.
function aggExpr(aggregation, columnName, tableName) {
  return aggregation === "count" ? "COUNT(*)" : `${AGGREGATIONS[aggregation]}(${quoteQualified(tableName, columnName)})`;
}

// Phase 4.2 (single table) / 4.4a (direct joins) - compiles an
// ALREADY-SERVER-VALIDATED query spec into parameterized SQL. Every
// table/column name passed in here was resolved by the
// /sources/:sourceId/query route against stored semanticModel data and
// real relationship edges - this function never sees a raw
// client-supplied string used as an identifier. Filter VALUES are the
// only untrusted input this ever touches, and those are always bound as
// query parameters ($1, $2, ...), never concatenated into the SQL string.
//
// `measures` always resolve against the base table (`tableName`) only -
// see 4.4a's plan for why: a JOIN can multiply rows before aggregation
// (order->order_items 1:many, then SUM an orders-level column double-
// counts it), and cardinality-aware rewriting to handle that safely is
// out of scope for v1. `dimensions`/`filters` may reference the base
// table OR a joined one (each entry carries its own `tableName`).
//
// Phase 4.4b - a measure with `kind: "calculated"` carries `operator` +
// `termA`/`termB` (each `{aggregation, columnName}`, same shape as a
// simple measure) instead of a single `aggregation`/`columnName` pair -
// two aggregate results combined with one arithmetic operator (e.g.
// SUM(revenue) - SUM(cost)). Division guards against a zero denominator
// with NULLIF rather than letting Postgres raise a division-by-zero error
// mid-query. v1 is deliberately two terms, not an arbitrary expression
// tree - same "prove the narrow case first" scoping every other
// sub-phase here has used.
export function compileQuery({
  tableName,
  measures = [],
  dimensions = [],
  filters = [],
  joins = [],
  offset = 0,
  pageSize = DEFAULT_PAGE_SIZE,
}) {
  if (measures.length === 0 && dimensions.length === 0) {
    throw new Error("Pick at least one dimension or measure.");
  }

  const selectParts = [
    ...dimensions.map((dim) => `${quoteQualified(dim.tableName, dim.columnName)} AS ${quoteIdent(dim.id)}`),
    ...measures.map((measure) => {
      let expr;
      if (measure.kind === "calculated") {
        const a = aggExpr(measure.termA.aggregation, measure.termA.columnName, tableName);
        const b = aggExpr(measure.termB.aggregation, measure.termB.columnName, tableName);
        const op = CALC_OPERATORS[measure.operator];
        expr = op === "/" ? `(${a} / NULLIF(${b}, 0))` : `(${a} ${op} ${b})`;
      } else {
        expr = aggExpr(measure.aggregation, measure.columnName, tableName);
      }
      return `${expr} AS ${quoteIdent(measure.id)}`;
    }),
  ];

  const params = [];
  const whereParts = filters.map((f) => {
    params.push(f.operator === "contains" ? `%${f.value}%` : f.value);
    return `${quoteQualified(f.tableName, f.columnName)} ${OPERATORS[f.operator]} $${params.length}`;
  });

  // Each join is resolved server-side (route) against a real FK
  // relationship before ever reaching here - baseColumn/joinColumn are
  // always real, verified column names, never client-supplied strings.
  const joinParts = joins.map(
    (j) =>
      `JOIN ${quoteIdent(j.tableName)} ON ${quoteQualified(tableName, j.baseColumn)} = ${quoteQualified(j.tableName, j.joinColumn)}`,
  );

  // Dimensions-only -> DISTINCT (no aggregation happening, so GROUP BY
  // would do the same dedup job in a more roundabout way). Both present ->
  // GROUP BY the dimensions. Measures-only -> neither, a single aggregate
  // row regardless of any WHERE filter.
  const distinct = dimensions.length > 0 && measures.length === 0 ? "DISTINCT " : "";
  let sql = `SELECT ${distinct}${selectParts.join(", ")} FROM ${quoteIdent(tableName)}`;
  if (joinParts.length) sql += ` ${joinParts.join(" ")}`;
  if (whereParts.length) sql += ` WHERE ${whereParts.join(" AND ")}`;
  if (dimensions.length > 0 && measures.length > 0) {
    sql += ` GROUP BY ${dimensions.map((dim) => quoteQualified(dim.tableName, dim.columnName)).join(", ")}`;
  }
  // Requests one extra row past pageSize so paginateRows() below can tell
  // "there's a next page" apart from "that was everything" without a
  // separate COUNT(*) (which can be its own expensive query on a large
  // table) - trimmed back down to pageSize before ever reaching a client.
  params.push(pageSize + 1);
  sql += ` LIMIT $${params.length}`;
  params.push(offset);
  sql += ` OFFSET $${params.length}`;

  return { sql, params };
}

// Trims the one lookahead row compileQuery's LIMIT (pageSize + 1) always
// requests, and reports whether it was actually there.
export function paginateRows(rows, pageSize = DEFAULT_PAGE_SIZE) {
  const hasMore = rows.length > pageSize;
  return { rows: hasMore ? rows.slice(0, pageSize) : rows, hasMore };
}

// Ephemeral, single-use connection - never pooled/reused across requests,
// same "scoped to one request's lifetime" principle pgIntrospect.js's own
// withClient already uses. max:1 (one query, not introspection's 8
// concurrent ones), a tighter query_timeout (interactive, not a
// background sync). Wrapped in an explicit READ ONLY transaction as a
// second, DB-enforced guarantee independent of compileQuery only ever
// emitting SELECT - defense in depth, not redundant with it.
export async function runQuery(connectionString, sql, params) {
  const pool = new pg.Pool({
    connectionString,
    ssl: resolveSsl(connectionString),
    connectionTimeoutMillis: 10_000,
    query_timeout: 15_000,
    max: 1,
  });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      try {
        const result = await client.query(sql, params);
        await client.query("COMMIT");
        return result.rows;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
