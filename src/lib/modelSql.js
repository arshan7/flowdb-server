import { resolveNativeVars } from "./queryEngine.js";
import { parseFormula } from "./formulaExpr.js";
import { resolveJoins } from "./joinResolve.js";
import { compileModel } from "./modelEngine.js";
import { QUERY_OPERATORS } from "./previewFilters.js";

// Slice 5 - resolve a stored Model row into { sql, params, columns } using
// the branch's canvas nodes (same node/join/column resolution the /query
// route does for a table report). `columns` is the model's output column
// names for a builder model, null for a SQL model (not knowable without
// running it). Returns { error } on any dangling reference. Pure - no I/O.
// `defaultSchema` (the source's pinned connection_schema, or null for an
// all-schemas source) is the FROM/JOIN schema fallback for any base/join
// node that predates schema tagging - node.data.schema always wins.
export function resolveModelSql(model, branch, defaultSchema = null) {
  if (model.kind === "sql") {
    if (!model.sql || !model.sql.trim()) return { error: "This model has no SQL." };
    const defaults = {};
    for (const v of model.sqlVars || []) defaults[v.name] = v.defaultValue ?? "";
    const { sql, params } = resolveNativeVars(model.sql, defaults);
    return compileModel({ kind: "sql", sql, params });
  }
  const allTableNodes = (branch?.nodes || []).filter((n) => n.type === "tableNode");
  const nodesById = new Map(allTableNodes.map((n) => [n.id, n]));
  const base = nodesById.get(model.baseTableId);
  if (!base) return { error: "This model's base table no longer exists." };

  // `joins` entries are either a plain tableId string (FK-resolved, the
  // common case) or an explicit spec { tableId, baseColumnId, joinColumnId }
  // for a table with no defined relationship - the user picked the join
  // keys themselves in the Model builder.
  const rawJoins = Array.isArray(model.joins) ? model.joins : [];
  const fkJoinIds = rawJoins.filter((j) => typeof j === "string");
  const manualJoins = rawJoins.filter((j) => j && typeof j === "object");
  const jr = resolveJoins(base, fkJoinIds, allTableNodes, nodesById, defaultSchema);
  if (jr.error) return { error: jr.error };
  const joinClauses = [...jr.joinClauses];
  const joinNodes = [...jr.joinNodes];
  for (const mj of manualJoins) {
    const jn = nodesById.get(mj.tableId);
    if (!jn || jn.type !== "tableNode") return { error: "This model joins a table that no longer exists." };
    // A multi-key join carries `pairs`; an older single-key save has a
    // flat baseColumnId/joinColumnId - resolve either into a `pairs` list
    // of real column names, AND-ed together in compileModel.
    const rawPairs =
      Array.isArray(mj.pairs) && mj.pairs.length ? mj.pairs : [{ baseColumnId: mj.baseColumnId, joinColumnId: mj.joinColumnId }];
    const pairs = [];
    for (const p of rawPairs) {
      const bCol = (base.data?.columns || []).find((c) => c.id === p.baseColumnId);
      const jCol = (jn.data?.columns || []).find((c) => c.id === p.joinColumnId);
      if (!bCol || !jCol) return { error: "This model's join references a column that no longer exists." };
      pairs.push({ baseColumn: bCol.name, joinColumn: jCol.name });
    }
    if (!pairs.length) return { error: "This model's join has no matching columns." };
    if (!joinNodes.some((n) => n.id === jn.id)) joinNodes.push(jn);
    joinClauses.push({
      tableName: jn.data.label,
      tableSchema: jn.data.schema ?? defaultSchema,
      fromTableName: base.data.label,
      pairs,
    });
  }
  const nodeFor = (tid) => (tid === base.id ? base : joinNodes.find((n) => n.id === tid));

  const columns = [];
  for (const c of model.columns || []) {
    // A custom column - a row-level arithmetic formula over the model's
    // other columns. Its token stream is resolved + parsed here (every
    // column ref validated against a real node/column) into the tree
    // modelEngine.compileScalarExpr walks; a raw client string never
    // reaches the SQL.
    if (c && c.kind === "expr") {
      const alias = (c.alias || "").trim();
      if (!alias) return { error: "A custom column needs a name." };
      const tree = resolveColumnFormula(c.tokens, nodeFor);
      if (!tree) return { error: `The custom column "${alias}" has an incomplete or invalid formula.` };
      columns.push({ kind: "exprTree", tree, alias });
      continue;
    }
    const n = nodeFor(c.tableId);
    const col = (n?.data?.columns || []).find((x) => x.id === c.columnId);
    if (!n || !col) return { error: "This model references a column that no longer exists." };
    // Only FROM/JOIN positions need a schema prefix; a column ref like
    // "table"."col" binds to the range-table entry regardless of schema.
    columns.push({ tableName: n.data.label, columnName: col.name, alias: (c.alias || "").trim() || col.name });
  }
  if (columns.length === 0) return { error: "This model exposes no columns." };

  const filters = [];
  for (const f of model.filters || []) {
    const n = nodeFor(f.tableId);
    const col = (n?.data?.columns || []).find((x) => x.id === f.columnId);
    if (!n || !col || !QUERY_OPERATORS.has(f.operator)) return { error: "This model has an invalid filter." };
    filters.push({ tableName: n.data.label, columnName: col.name, operator: f.operator, value: f.value });
  }

  try {
    return compileModel({
      kind: "builder",
      baseTableName: base.data.label,
      baseTableSchema: base.data.schema ?? defaultSchema,
      joinClauses,
      columns,
      filters,
    });
  } catch (err) {
    return { error: err.message };
  }
}

// Operators a model custom column may use: the four arithmetic ones a
// calculated measure allows, plus `&` for text concatenation (row-level
// only - a measure combining two aggregates with `&` is nonsense, so that
// path keeps QUERY_CALC_OPERATORS).
export const MODEL_COLUMN_OPERATORS = new Set(["+", "-", "*", "/", "&"]);

// Resolve a model custom column's flat token stream (value / op / paren,
// the same shape a calculated measure's formula uses) into the nested tree
// formulaExpr.parseFormula returns. Row-level: a "value" token is either a
// constant number or a plain column reference - no aggregation. Every
// column ref is checked against a real node/column via `nodeFor`; returns
// null on any dangling ref, unknown operator, or grammar violation, so the
// caller can reject the model rather than emit half a formula.
export function resolveColumnFormula(tokens, nodeFor) {
  if (!Array.isArray(tokens) || tokens.length === 0 || tokens.length > MAX_FORMULA_TOKENS) return null;
  const resolved = [];
  for (const t of tokens) {
    if (!t || typeof t !== "object") return null;
    if (t.kind === "op") {
      if (!MODEL_COLUMN_OPERATORS.has(t.value)) return null;
      resolved.push(t);
    } else if (t.kind === "paren") {
      if (t.value !== "(" && t.value !== ")") return null;
      resolved.push(t);
    } else if (t.kind === "value") {
      const term = t.term || {};
      if (term.type === "constant") {
        const n = Number(term.value);
        if (!Number.isFinite(n)) return null;
        resolved.push({ kind: "value", node: { constant: n } });
      } else if (term.type === "text") {
        // A fixed text literal (e.g. a space in a "first & last" name).
        // Bound as a parameter by compileScalarExpr, never interpolated.
        if (typeof term.value !== "string") return null;
        resolved.push({ kind: "value", node: { text: term.value } });
      } else {
        const node = nodeFor(term.tableId);
        const col = (node?.data?.columns || []).find((x) => x.id === term.columnId);
        if (!node || !col) return null;
        resolved.push({ kind: "value", node: { column: { tableName: node.data.label, columnName: col.name } } });
      }
    } else {
      return null;
    }
  }
  return parseFormula(resolved);
}

// Bigger formulas - a calculated measure's formula is a flat token stream
// (value/op/paren, read left to right like a real formula bar), bounded -
// a sane defensive cap, not a client-configurable one, same spirit as
// MAX_ROWS/ALLOWED_PAGE_SIZES. Mirrors MetricFieldDrawer.jsx/measureExpr.js's
// own MAX_FORMULA_TOKENS so the UI self-limits before a formula could ever
// reach this, but this is the real, server-enforced bound - independent
// of what the UI offers, since these routes never trust client-shaped
// structure.
export const MAX_FORMULA_TOKENS = 61;

// A report can carry a `dataset` = { baseTableId, joins, columns, filters }
// - joins / calculated columns / cross-table filters shaped inline in the
// report builder rather than in a separate Model. It's persisted as a
// real builder Model: it shows in the Models gallery, named after the
// report, and outlives it. Its columns/joins are soft references validated
// at query time by resolveModelSql, same as any Model's.
export function isDatasetSpec(d) {
  if (!d || typeof d !== "object") return false;
  if (d.kind === "sql") return typeof d.sql === "string" && d.sql.trim().length > 0;
  return !!d.baseTableId && Array.isArray(d.columns) && d.columns.length > 0;
}
