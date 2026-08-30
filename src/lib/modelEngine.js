// Reporting-parity slice 5 - the Model compiler. A Model is a saved
// curated dataset; compileModel turns it into ONE SQL query, and
// compileModelReport wraps that query as a subquery for a report built on
// the model to aggregate over. Both reuse queryEngine's primitives so a
// model-sourced report and a table-sourced one emit the same shapes for
// buckets / sort / filters / paging.
import {
  quoteIdent,
  quoteQualified,
  quoteTable,
  aggExpr,
  dimExpr,
  compileFilterCondition,
  SORT_DIRECTIONS,
  DEFAULT_PAGE_SIZE,
} from "./queryEngine.js";

const MODEL_ALIAS = "_tsm";

// Custom column arithmetic - only these four symbols ever reach the SQL
// string, and only by exact map lookup (same discipline queryEngine.js's
// CALC_OPERATORS uses for calculated measures).
const SCALAR_OPERATORS = { "+": "+", "-": "-", "*": "*", "/": "/" };

// Compile a model's custom column - a row-level arithmetic expression over
// its other columns. Walks the same `{ kind:"calculated", operator, termA,
// termB }` tree formulaExpr.parseFormula produces for calculated measures,
// but the leaves here are plain scalars: a qualified column or a bound
// constant, never an aggregate. The route (resolveModelSql) resolves the
// client's token stream into this tree and validates every column ref
// first - nothing here comes from a raw client string. `/` is guarded
// with NULLIF so a zero divisor yields NULL, not a query error.
function compileScalarExpr(node, params) {
  if (!node || typeof node !== "object") throw new Error("This model has an invalid custom column.");
  if (node.kind === "calculated") {
    const a = compileScalarExpr(node.termA, params);
    const b = compileScalarExpr(node.termB, params);
    const op = SCALAR_OPERATORS[node.operator];
    if (!op) throw new Error("This model has an invalid custom column.");
    return op === "/" ? `(${a} / NULLIF(${b}, 0))` : `(${a} ${op} ${b})`;
  }
  if (node.column) return quoteQualified(node.column.tableName, node.column.columnName);
  if (node.constant !== undefined) {
    if (!Number.isFinite(node.constant)) throw new Error("This model has an invalid custom column.");
    params.push(node.constant);
    return `$${params.length}`;
  }
  throw new Error("This model has an invalid custom column.");
}

// Compile a model to its own SELECT.
//
// kind "sql": `spec.sql` is raw user SELECT text with its `{{vars}}`
//   ALREADY resolved to positional `$N` by the caller (resolveNativeVars),
//   `spec.params` the bound values. Output columns aren't knowable without
//   running it, so `columns` is null - callers that need them run a
//   `LIMIT 0` describe.
// kind "builder": `spec` carries fully-resolved names (the route did the
//   node lookup + join resolution via resolveJoins):
//   { baseTableName, baseTableSchema,
//     joinClauses:[{tableName,tableSchema,fromTableName,baseColumn,joinColumn}],
//     columns:[{tableName,columnName,alias}], filters:[{tableName,columnName,operator,value}] }
//   baseTableSchema / joinClause.tableSchema drive the FROM/JOIN schema
//   prefix for a multi-schema source; null/"public" => bare name.
//
// Returns { sql, params, columns }. `sql` is NOT parenthesised - the
// caller wraps it.
export function compileModel(spec) {
  if (spec.kind === "sql") {
    return { sql: String(spec.sql || ""), params: spec.params || [], columns: null };
  }

  if (!spec.baseTableName) throw new Error("A builder model needs a base table.");
  if (!Array.isArray(spec.columns) || spec.columns.length === 0) {
    throw new Error("A builder model needs at least one column to expose.");
  }

  const params = [];
  // A column is either a direct reference { tableName, columnName } or a
  // custom expression { kind:"exprTree", tree } - the route resolves both
  // shapes before they reach here. Expression constants push onto `params`
  // in column order, ahead of the WHERE clause's own params.
  const selectParts = spec.columns.map((c) =>
    c.kind === "exprTree"
      ? `${compileScalarExpr(c.tree, params)} AS ${quoteIdent(c.alias)}`
      : `${quoteQualified(c.tableName, c.columnName)} AS ${quoteIdent(c.alias)}`,
  );
  const joinParts = (spec.joinClauses || []).map(
    (j) =>
      `JOIN ${quoteTable(j.tableSchema, j.tableName)} ON ` +
      `${quoteQualified(j.fromTableName || spec.baseTableName, j.baseColumn)} = ${quoteQualified(j.tableName, j.joinColumn)}`,
  );
  const whereParts = (spec.filters || []).map((f) =>
    compileFilterCondition(f.tableName, f.columnName, f.operator, f.value, params),
  );

  let sql = `SELECT ${selectParts.join(", ")} FROM ${quoteTable(spec.baseTableSchema, spec.baseTableName)}`;
  if (joinParts.length) sql += ` ${joinParts.join(" ")}`;
  if (whereParts.length) sql += ` WHERE ${whereParts.join(" AND ")}`;

  return { sql, params, columns: spec.columns.map((c) => c.alias) };
}

// Wrap a compiled model as `FROM (<modelSql>) AS _tsm` and aggregate over
// it. Mirrors compileQuery's tail (SELECT dims+measures, GROUP BY, ORDER
// BY, LIMIT/OFFSET) but every reference is `_tsm."<output column>"` by
// name - there's no semantic model here, just the model's own columns.
//
// `dimensions`: [{ id, column, bucket? }]  `measures`: [{ id, aggregation, column }]
// `filters`:    [{ column, operator, value }]
// `orderBy`:    { field: <dimension|measure id>, direction }  `rowLimit`: int|null
export function compileModelReport({
  modelSql,
  modelParams = [],
  dimensions = [],
  measures = [],
  filters = [],
  orderBy = null,
  rowLimit = null,
  offset = 0,
  pageSize = DEFAULT_PAGE_SIZE,
}) {
  if (measures.length === 0 && dimensions.length === 0) {
    throw new Error("Pick at least one column or measure.");
  }
  // modelParams occupy $1..$N; everything pushed below continues from there.
  const params = [...modelParams];

  const dimSql = (d) => dimExpr({ tableName: MODEL_ALIAS, columnName: d.column, bucket: d.bucket });
  const selectParts = [
    ...dimensions.map((d) => `${dimSql(d)} AS ${quoteIdent(d.id)}`),
    ...measures.map((m) => `${aggExpr(m.aggregation, m.column, MODEL_ALIAS)} AS ${quoteIdent(m.id)}`),
  ];
  const whereParts = filters.map((f) => compileFilterCondition(MODEL_ALIAS, f.column, f.operator, f.value, params));

  const distinct = dimensions.length > 0 && measures.length === 0 ? "DISTINCT " : "";
  let sql = `SELECT ${distinct}${selectParts.join(", ")} FROM (${modelSql}) AS ${quoteIdent(MODEL_ALIAS)}`;
  if (whereParts.length) sql += ` WHERE ${whereParts.join(" AND ")}`;
  if (dimensions.length > 0 && measures.length > 0) {
    sql += ` GROUP BY ${dimensions.map(dimSql).join(", ")}`;
  }
  if (orderBy && orderBy.field) {
    const dir = SORT_DIRECTIONS[orderBy.direction] || "ASC";
    sql += ` ORDER BY ${quoteIdent(orderBy.field)} ${dir}`;
  }

  const windowSize = rowLimit != null ? Math.max(0, Math.min(pageSize, rowLimit - offset)) : pageSize;
  params.push(windowSize + 1);
  sql += ` LIMIT $${params.length}`;
  params.push(offset);
  sql += ` OFFSET $${params.length}`;

  return { sql, params, windowSize };
}
