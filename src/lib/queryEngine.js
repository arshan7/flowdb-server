import pg from "pg";
import { resolveSsl } from "./pgIntrospect.js";

const AGGREGATIONS = { count: "COUNT", sum: "SUM", avg: "AVG", min: "MIN", max: "MAX" };
// "in" has no fixed symbol - it's special-cased in compileFilterCondition
// as `= ANY($n)` (a single parameterized array, not string-built
// `IN ($1,$2,$3)` for variable arity).
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
// machinery out of scope for v1. "value" (a joined-table column read
// directly, not really aggregated - see compileTermExpr) wraps in "max"
// for the same reason it's compiled as MAX inside the subquery: there's
// only ever one distinct value per base entity, so MAX just returns it,
// at any outer grouping level.
const OUTER_WRAP = { count: "sum", sum: "sum", avg: "avg", min: "min", max: "max", value: "max" };

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
// one building block both a simple measure and each leaf term of a
// calculated measure (4.4b) reduce to. "value" (post-4.4b) compiles to
// MAX - see compileTermExpr's own comment for why that's correct, not
// just convenient.
function aggExpr(aggregation, columnName, tableName) {
  if (aggregation === "count") return "COUNT(*)";
  const fn = aggregation === "value" ? "max" : aggregation;
  return `${AGGREGATIONS[fn]}(${quoteQualified(tableName, columnName)})`;
}

// Shared by the main WHERE clause and a cross-table term's own subquery
// WHERE clause - one place that decides how a filter condition becomes
// SQL, so the two can't silently drift into different behavior for the
// same operator.
function compileFilterCondition(tableName, columnName, operator, value, params) {
  const colExpr = quoteQualified(tableName, columnName);
  if (operator === "in") {
    params.push(value);
    return `${colExpr} = ANY($${params.length})`;
  }
  params.push(operator === "contains" ? `%${value}%` : value);
  return `${colExpr} ${OPERATORS[operator]} $${params.length}`;
}

// Compiles one calculated-measure term - RECURSIVE, since post-4.4b a
// term can itself be another calculated expression (a measure referencing
// another measure, inlined here rather than as a separate query layer -
// see tablespace.js's resolveMeasureAsTerm for why inlining an
// already-resolved expression is simpler than restructuring this query
// into dependency-ordered CTEs, and just as correct: substituting a
// verified-correct sub-expression can never make the outer one wrong).
//
// Leaf terms whose `tableName` differs from the base table are the
// original cross-table case: naively joining the two tables and
// aggregating both in one flat query reintroduces exactly the fan-out bug
// 4.4a's base-table-only rule exists to avoid (an order joined to 3
// order_items appears 3 times, so COUNT(*)/SUM on either side inflates).
// The fix: pre-aggregate the joined table BY ITS OWN FK column first (one
// row per base entity, never more, optionally narrowed by the term's own
// `filters` - post-4.4b, e.g. "only completed bookings"), LEFT JOIN that
// already-deduplicated result onto the base table, and only THEN let the
// outer query's actual GROUP BY (or lack of one) combine values - by that
// point every row in the FROM clause maps to at most one base row, so no
// aggregate - base-column or joined-value alike - can be inflated by it.
//
// "value" terms (post-4.4b - read a related table's column with no real
// aggregation, e.g. a purchase's club's tax rate) reuse this exact same
// machinery with MAX as the inner function: the route only ever resolves
// a "value" term when the relationship guarantees at most one matching
// joined row per base row (see resolveTerm's own comment), so MAX simply
// returns that one value - and composes safely with any outer GROUP BY
// the same way a true aggregate does, without needing to add it to that
// GROUP BY itself.
//
// Further post-4.4b: `term.chain` can have MORE than one hop - a "value"
// term reached through a multi-hop all-many-to-one path (e.g. purchase ->
// club -> region), not just a direct neighbor. Compiled as a SEQUENCE of
// plain LEFT JOINs, each hop uniquely aliased so it can never collide
// with another term's (or this same term's) joins elsewhere in the query
// - a few redundant identical joins cost nothing Postgres can't handle,
// same reasoning `crossSubqueries` not deduping already relied on. Every
// OTHER cross-table aggregation (count/sum/avg/min/max) still only ever
// gets a single-hop chain (`chain.length === 1`, resolved via the
// original 1-hop findJoinPath) - multi-hop AGGREGATION is a harder,
// separate, still-unbuilt problem.
//
// `crossSubqueries` collects one such LEFT JOIN (or LEFT JOIN chain) per
// cross-table leaf term used across the whole query (mutated in place).
function compileTermExpr(term, baseTableName, crossSubqueries, params) {
  if (term.kind === "calculated") {
    const a = compileTermExpr(term.termA, baseTableName, crossSubqueries, params);
    const b = compileTermExpr(term.termB, baseTableName, crossSubqueries, params);
    const op = CALC_OPERATORS[term.operator];
    return op === "/" ? `(${a} / NULLIF(${b}, 0))` : `(${a} ${op} ${b})`;
  }

  if (!term.tableName || term.tableName === baseTableName) {
    return aggExpr(term.aggregation, term.columnName, baseTableName);
  }

  const alias = `_cx${crossSubqueries.length}`;

  if (term.aggregation === "value") {
    let fromIdent = baseTableName; // raw, unquoted - only ever passed through quoteQualified/quoteIdent below
    term.chain.forEach((hop, i) => {
      const hopAlias = `${alias}_${i}`;
      crossSubqueries.push(
        `LEFT JOIN ${quoteIdent(hop.tableName)} AS ${quoteIdent(hopAlias)} ` +
          `ON ${quoteQualified(fromIdent, hop.baseColumn)} = ${quoteQualified(hopAlias, hop.joinColumn)}`,
      );
      fromIdent = hopAlias;
    });
    return `MAX(${quoteQualified(fromIdent, term.columnName)})`;
  }

  const hop = term.chain[0];
  const innerExpr = aggExpr(term.aggregation, term.columnName, term.tableName);
  const fkCol = quoteQualified(term.tableName, hop.joinColumn);
  const filterParts = (term.filters || []).map((f) =>
    compileFilterCondition(term.tableName, f.columnName, f.operator, f.value, params),
  );
  const whereClause = filterParts.length ? ` WHERE ${filterParts.join(" AND ")}` : "";
  crossSubqueries.push(
    `LEFT JOIN (SELECT ${fkCol} AS ${quoteIdent("_jk")}, ${innerExpr} AS ${quoteIdent("_v")} ` +
      `FROM ${quoteIdent(term.tableName)}${whereClause} GROUP BY ${fkCol}) AS ${quoteIdent(alias)} ` +
      `ON ${quoteQualified(baseTableName, hop.baseColumn)} = ${quoteQualified(alias, "_jk")}`,
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
//
// Further post-4.4b: a term can carry its own `filters` (only meaningful
// for a cross-table term - e.g. "only completed bookings" before
// counting them), applied inside that term's own pre-aggregation
// subquery. A term can also itself be `{kind: "calculated", operator,
// termA, termB}` - a measure referencing another measure, already fully
// resolved and inlined by the route (tablespace.js's
// resolveMeasureAsTerm) before it ever reaches here, so compileTermExpr
// just recurses.
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
  // pre-aggregated subquery rather than a flat join. params is declared
  // here (not down by the main WHERE clause, as it used to be) since a
  // cross-table term's own filters (post-4.4b) can now push parameters
  // while selectParts is still being built - order only matters in that
  // every push happens before its own $N is computed, which both sections
  // already do independently.
  const crossSubqueries = [];
  const params = [];

  const selectParts = [
    ...dimensions.map((dim) => `${quoteQualified(dim.tableName, dim.columnName)} AS ${quoteIdent(dim.id)}`),
    ...measures.map((measure) => {
      let expr;
      if (measure.kind === "calculated") {
        const a = compileTermExpr(measure.termA, tableName, crossSubqueries, params);
        const b = compileTermExpr(measure.termB, tableName, crossSubqueries, params);
        const op = CALC_OPERATORS[measure.operator];
        expr = op === "/" ? `(${a} / NULLIF(${b}, 0))` : `(${a} ${op} ${b})`;
      } else {
        expr = aggExpr(measure.aggregation, measure.columnName, tableName);
      }
      return `${expr} AS ${quoteIdent(measure.id)}`;
    }),
  ];

  const whereParts = filters.map((f) => compileFilterCondition(f.tableName, f.columnName, f.operator, f.value, params));

  // Each join is resolved server-side (route) against a real relationship
  // before ever reaching here - baseColumn/joinColumn are always real,
  // verified column names, never client-supplied strings. Post-4.4b, a
  // join's `fromTableName` isn't always the query's own base table - a
  // multi-hop chain's later hops join FROM the previous hop's table, not
  // the original one (route: buildForwardJoinGraph/chainTo). Defaults to
  // `tableName` for every join built before that existed.
  const joinParts = joins.map(
    (j) =>
      `JOIN ${quoteIdent(j.tableName)} ON ${quoteQualified(j.fromTableName || tableName, j.baseColumn)} = ${quoteQualified(j.tableName, j.joinColumn)}`,
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
