import pg from "pg";
import { resolveSsl } from "./pgIntrospect.js";

const AGGREGATIONS = { count: "COUNT", sum: "SUM", avg: "AVG", min: "MIN", max: "MAX" };
const OPERATORS = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", contains: "ILIKE" };
// Phase 4.4b - calculated measures. Only these four symbols ever reach the
// SQL string, and only by exact map lookup (never a client value passed
// through directly) - same discipline OPERATORS above already uses for
// filters.
const CALC_OPERATORS = { "+": "+", "-": "-", "*": "*", "/": "/" };

// Cross-table calculated measures (post-4.4b) - the aggregation used to
// COMBINE a joined table's already-per-base-row value across whatever the
// outer query is actually grouped at. Not always the same as the inner
// aggregation: "count of items per flow" needs SUM to total across a
// group of flows (re-COUNTing would count how many flows had items, not
// how many items) - SUM composes additively, so both count and sum wrap
// in SUM. min/max compose with themselves (the min of per-flow minimums
// IS the global minimum), so they wrap in themselves. avg wraps in avg
// too, as a documented approximation - the average of each entity's own
// average, not a single true weighted average, which would need extra
// machinery out of scope for v1.
const OUTER_WRAP = { count: "sum", sum: "sum", avg: "avg", min: "min", max: "max" };

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

// Cross-table calculated measure terms - a term whose `tableName` differs
// from the measure's own base table. Naively joining the two tables and
// aggregating both in one flat query re-introduces exactly the fan-out
// bug 4.4a's base-table-only rule exists to avoid (an order joined to 3
// order_items appears 3 times, so COUNT(*)/SUM on either side inflates).
//
// The fix: pre-aggregate the joined table BY ITS OWN FK column first (one
// row per base entity, never more), LEFT JOIN that already-deduplicated
// result onto the base table, and only THEN let the outer query's actual
// GROUP BY (or lack of one) combine values - by that point every row in
// the FROM clause maps to at most one base row, so no aggregate - base-
// column or joined-value alike - can be inflated by it. `crossSubqueries`
// collects one such LEFT JOIN per cross-table term used across the whole
// query (mutated in place - a plain array, not a Map, since a few
// redundant identical subqueries cost nothing Postgres can't handle and
// aren't worth the bookkeeping to dedupe).
function compileTermExpr(term, baseTableName, crossSubqueries) {
  if (!term.tableName || term.tableName === baseTableName) {
    return aggExpr(term.aggregation, term.columnName, baseTableName);
  }
  const alias = `_cx${crossSubqueries.length}`;
  const innerExpr = aggExpr(term.aggregation, term.columnName, term.tableName);
  const fkCol = quoteQualified(term.tableName, term.joinInfo.joinColumn);
  crossSubqueries.push(
    `LEFT JOIN (SELECT ${fkCol} AS ${quoteIdent("_jk")}, ${innerExpr} AS ${quoteIdent("_v")} ` +
      `FROM ${quoteIdent(term.tableName)} GROUP BY ${fkCol}) AS ${quoteIdent(alias)} ` +
      `ON ${quoteQualified(baseTableName, term.joinInfo.baseColumn)} = ${quoteQualified(alias, "_jk")}`,
  );
  const outerAgg = OUTER_WRAP[term.aggregation];
  return `${AGGREGATIONS[outerAgg]}(${quoteQualified(alias, "_v")})`;
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
// `termA`/`termB` (each `{aggregation, columnName, tableName, joinInfo}`)
// instead of a single `aggregation`/`columnName` pair - two aggregate
// results combined with one arithmetic operator (e.g. SUM(revenue) -
// SUM(cost)). Division guards against a zero denominator with NULLIF
// rather than letting Postgres raise a division-by-zero error mid-query.
// v1 is deliberately two terms, not an arbitrary expression tree - same
// "prove the narrow case first" scoping every other sub-phase here has
// used.
//
// Cross-table calculated measures (post-4.4b) - a term's `tableName` can
// now be a table directly joined to the base one (`joinInfo` carries the
// real FK relationship columns, same shape `joins` entries already use);
// see compileTermExpr()'s own comment for how that's compiled safely
// (pre-aggregate-then-LEFT-JOIN, never a flat join across both
// aggregates) and OUTER_WRAP for why the combining aggregation isn't
// always the term's own chosen one.
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

  // Populated by compileTermExpr() below as a side effect, for any
  // calculated measure term whose table isn't the base table - see that
  // function's own comment for why this has to be a LEFT JOIN onto a
  // pre-aggregated subquery rather than a flat join.
  const crossSubqueries = [];

  const selectParts = [
    ...dimensions.map((dim) => `${quoteQualified(dim.tableName, dim.columnName)} AS ${quoteIdent(dim.id)}`),
    ...measures.map((measure) => {
      let expr;
      if (measure.kind === "calculated") {
        const a = compileTermExpr(measure.termA, tableName, crossSubqueries);
        const b = compileTermExpr(measure.termB, tableName, crossSubqueries);
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
  if (crossSubqueries.length) sql += ` ${crossSubqueries.join(" ")}`;
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
