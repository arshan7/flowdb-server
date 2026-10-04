// Reporting-parity slice 5 - the Model compiler. A Model is a saved
// curated dataset; compileModel turns it into ONE SQL query, and
// compileModelReport wraps that query as a subquery for a report built on
// the model to aggregate over. Both reuse queryEngine's primitives so a
// model-sourced report and a table-sourced one emit the same shapes for
// buckets / sort / filters / paging.
import { joinKeyword } from "./joinResolve.js";
import { compileExpression } from "./expr/compile.js";
import { showAsExpr } from "./showAs.js";
import {
  quoteIdent,
  quoteQualified,
  quoteTable,
  aggExpr,
  dimExpr,
  compileFilterCondition,
  compileAnyFilter,
  SORT_DIRECTIONS,
  DEFAULT_PAGE_SIZE,
} from "./queryEngine.js";

const MODEL_ALIAS = "_tsm";

// Custom column operators - only these symbols ever reach the SQL string,
// and only by exact map lookup (same discipline queryEngine.js's
// CALC_OPERATORS uses for calculated measures). `&` is text concatenation,
// handled specially below (compiled to concat(), not an infix operator).
const SCALAR_OPERATORS = { "+": "+", "-": "-", "*": "*", "/": "/" };

// Compile a model's custom column - a row-level expression over its other
// columns. Walks the `{ kind:"calculated", operator, termA, termB }` tree
// formulaExpr.parseFormula produces (plus `{ kind:"cast", to, arg }` for a
// convert-to); leaves are a qualified column (with its declared `type`) or a
// bound constant, never an aggregate. Every column ref was validated by
// resolveModelSql - nothing here comes from a raw client string.
// Typed so the SQL is right whatever the columns hold:
// - `/` divides as a decimal (7 / 2 = 3.5, no 20-digit numeric scale) and a zero divisor yields NULL;
// - a text column in math converts when it looks like a number, else NULL;
// - date − date is days; date ± number moves by days; other date math is refused;
// - `&` compiles to concat() (NULL-tolerant) so a missing part still joins the rest.
function compileScalarExpr(node, params) {
  return compileTyped(node, params).sql;
}

export const CAST_TARGETS = ["number", "integer", "text", "date", "datetime"];

const NUMBER_TEXT = String.raw`'^[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?$'`;
const DATE_TEXT = String.raw`'^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])'`;
const DATETIME_TEXT = String.raw`'^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])([ T][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?)?'`;

/** "number" | "text" | "date" | "datetime" | "bool" | "unknown" from a declared column type. */
export function kindOfColumnType(type) {
  const t = String(type || "").toLowerCase();
  // No declared type: leave the value as it is rather than guess.
  if (!t) return "unknown";
  if (t.endsWith("[]")) return "text";
  if (/^((small|big)?int(eger)?|int[248])\b|serial|numeric|decimal|real|double|float|money/.test(t)) return "number";
  if (/^timestamp|^datetime/.test(t)) return "datetime";
  if (/^date/.test(t)) return "date";
  if (/^bool/.test(t)) return "bool";
  return "text";
}

const bad = (msg) => {
  throw new Error(msg);
};

// A text value as a number when it looks like one, else NULL (never a query error).
const textToNumber = (sql) => `(CASE WHEN btrim(${sql}) ~ ${NUMBER_TEXT} THEN btrim(${sql})::numeric END)`;

function asNumber(v) {
  if (v.kind === "number" || v.kind === "unknown") return v.sql;
  if (v.kind === "text") return textToNumber(v.sql);
  if (v.kind === "bool") return `(${v.sql})::integer`;
  return bad("A date can't be used as a number. Subtract two dates to get the days between them.");
}

function compileCast(to, v) {
  switch (to) {
    case "number":
      return { sql: `(${asNumber(v)})::numeric`, kind: "number" };
    case "integer":
      return { sql: `ROUND((${asNumber(v)})::numeric)::bigint`, kind: "number" };
    case "text":
      return { sql: `(${v.sql})::text`, kind: "text" };
    case "date":
      if (v.kind === "date" || v.kind === "datetime") return { sql: `(${v.sql})::date`, kind: "date" };
      if (v.kind === "text") return { sql: `(CASE WHEN btrim(${v.sql}) ~ ${DATE_TEXT} THEN substr(btrim(${v.sql}), 1, 10)::date END)`, kind: "date" };
      return bad("Only text or a date and time can be converted to a date.");
    case "datetime":
      if (v.kind === "date" || v.kind === "datetime") return { sql: `(${v.sql})::timestamp`, kind: "datetime" };
      if (v.kind === "text") return { sql: `(CASE WHEN btrim(${v.sql}) ~ ${DATETIME_TEXT} THEN btrim(${v.sql})::timestamp END)`, kind: "datetime" };
      return bad("Only text or a date can be converted to a date and time.");
    default:
      return bad("This model has an invalid custom column.");
  }
}

const isDate = (v) => v.kind === "date" || v.kind === "datetime";

function compileDateMath(op, a, b) {
  if (op === "-" && isDate(a) && isDate(b)) {
    // Whole days for two dates; fractional days once a time is involved.
    if (a.kind === "date" && b.kind === "date") return { sql: `(${a.sql} - ${b.sql})`, kind: "number" };
    return { sql: `(EXTRACT(EPOCH FROM ((${a.sql})::timestamp - (${b.sql})::timestamp)) / 86400)`, kind: "number" };
  }
  const [d, n] = isDate(a) ? [a, b] : [b, a];
  if ((op === "+" || (op === "-" && isDate(a))) && !isDate(n)) {
    const days = asNumber(n);
    if (d.kind === "date") return { sql: `(${d.sql} ${op} ROUND((${days})::numeric)::integer)`, kind: "date" };
    return { sql: `((${d.sql})::timestamp ${op} (${days}) * interval '1 day')`, kind: "datetime" };
  }
  return bad("Dates can only be subtracted from each other, or have a number of days added or taken away.");
}

function compileTyped(node, params) {
  if (!node || typeof node !== "object") bad("This model has an invalid custom column.");
  if (node.kind === "cast") return compileCast(node.to, compileTyped(node.arg, params));
  if (node.kind === "calculated") {
    const a = compileTyped(node.termA, params);
    const b = compileTyped(node.termB, params);
    if (node.operator === "&") return { sql: `concat(${a.sql}, ${b.sql})`, kind: "text" };
    const op = SCALAR_OPERATORS[node.operator];
    if (!op) bad("This model has an invalid custom column.");
    if (isDate(a) || isDate(b)) return compileDateMath(op, a, b);
    const [x, y] = [asNumber(a), asNumber(b)];
    return { sql: op === "/" ? `(${x}::float8 / NULLIF(${y}, 0))` : `(${x} ${op} ${y})`, kind: "number" };
  }
  if (node.column) {
    return { sql: quoteQualified(node.column.tableName, node.column.columnName), kind: kindOfColumnType(node.column.type) };
  }
  if (node.text !== undefined) {
    if (typeof node.text !== "string") bad("This model has an invalid custom column.");
    params.push(node.text);
    return { sql: `$${params.length}::text`, kind: "text" };
  }
  if (node.constant !== undefined) {
    if (!Number.isFinite(node.constant)) bad("This model has an invalid custom column.");
    params.push(node.constant);
    return { sql: `$${params.length}::numeric`, kind: "number" };
  }
  return bad("This model has an invalid custom column.");
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
const ROW_ALIAS = "_tsr";

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
  // shapes before they reach here. Expression constants / text literals
  // push onto `params` in column order, ahead of the WHERE clause's own
  // params.
  const selectParts = spec.columns.map((c) => {
    if (c.kind === "exprText") {
      try {
        return `${compileExpression(c.text, { mode: "row", column: c.resolve, params }).sql} AS ${quoteIdent(c.alias)}`;
      } catch (e) {
        throw new Error(`The custom column "${c.alias}": ${e.message}`);
      }
    }
    return c.kind === "exprTree"
      ? `${compileScalarExpr(c.tree, params)} AS ${quoteIdent(c.alias)}`
      : `${quoteQualified(c.tableName, c.columnName)} AS ${quoteIdent(c.alias)}`;
  });
  const joinParts = (spec.joinClauses || []).map((j) => {
    const from = j.fromTableName || spec.baseTableName;
    // `pairs` (a composite/multi-key join) AND-s several column equalities;
    // a plain FK join carries a single baseColumn/joinColumn instead.
    const onPairs = Array.isArray(j.pairs) && j.pairs.length ? j.pairs : [{ baseColumn: j.baseColumn, joinColumn: j.joinColumn }];
    const on = onPairs
      .map((p) => `${quoteQualified(from, p.baseColumn)} = ${quoteQualified(j.tableName, p.joinColumn)}`)
      .join(" AND ");
    return `${joinKeyword(j.type)} ${quoteTable(j.tableSchema, j.tableName)} ON ${on}`;
  });
  const whereParts = (spec.filters || []).map((f) =>
    compileFilterCondition(f.tableName, f.columnName, f.operator, f.value, params),
  );

  let sql = `SELECT ${selectParts.join(", ")} FROM ${quoteTable(spec.baseTableSchema, spec.baseTableName)}`;
  if (joinParts.length) sql += ` ${joinParts.join(" ")}`;
  if (whereParts.length) sql += ` WHERE ${whereParts.join(" AND ")}`;
  // Row filters name output columns (a formula column too), so they read the finished rows.
  if (spec.rowFilters?.length) {
    const outer = spec.rowFilters.map((f) => compileAnyFilter(ROW_ALIAS, f, params));
    sql = `SELECT * FROM (${sql}) AS ${quoteIdent(ROW_ALIAS)} WHERE ${outer.join(" AND ")}`;
  }

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
  showAs = {},
}) {
  if (measures.length === 0 && dimensions.length === 0) {
    throw new Error("Pick at least one column or measure.");
  }
  // modelParams occupy $1..$N; everything pushed below continues from there.
  const params = [...modelParams];

  const dimSql = (d) => dimExpr({ tableName: MODEL_ALIAS, columnName: d.column, bucket: d.bucket });
  const selectParts = [
    ...dimensions.map((d) => `${dimSql(d)} AS ${quoteIdent(d.id)}`),
    ...measures.map((m) => {
      // A formula measure: [column] reads the model's output columns.
      const shown = (expr) => (showAs[m.id] ? showAsExpr(expr, showAs[m.id], dimensions.map((d) => ({ sql: dimSql(d), time: !!d.bucket }))) : expr);
      if (m.aggregation === "expression") {
        const column = (name) => (m.columns?.has(name) ?? true ? { sql: quoteQualified(MODEL_ALIAS, name), kind: m.kinds?.[name] ?? "unknown" } : null);
        const out = compileFormulaMeasure(m, { column, params, windowOrder: dimensions.map(dimSql) });
        return `${shown(out)} AS ${quoteIdent(m.id)}`;
      }
      let expr = aggExpr(m.aggregation, m.column, MODEL_ALIAS);
      // Post-parity - an "only where …" condition on a single measure,
      // compiled as an aggregate FILTER over the model's own output
      // columns. Params push here, ahead of the WHERE clause's - order
      // stays internally consistent (every $N computed right after its
      // push), same as compileQuery's own measure filters.
      const mfParts = (m.filters || []).map((f) =>
        compileFilterCondition(MODEL_ALIAS, f.column, f.operator, f.value, params),
      );
      if (mfParts.length) expr += ` FILTER (WHERE ${mfParts.join(" AND ")})`;
      return `${shown(expr)} AS ${quoteIdent(m.id)}`;
    }),
  ];
  const whereParts = filters.map((f) => compileAnyFilter(MODEL_ALIAS, f, params));

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

/** A formula measure's SQL, with the measure named in any error. */
export function compileFormulaMeasure(m, { column, params, windowOrder }) {
  try {
    return compileExpression(m.expression, { mode: "agg", column, params, windowOrder }).sql;
  } catch (e) {
    throw new Error(`${m.label || "The custom measure"}: ${e.message}`);
  }
}
