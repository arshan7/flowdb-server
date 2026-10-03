// A saved metric (semantic measure) as formula text, so any report on its table can
// use it live: SumIf([total], [status] = "paid") / Count(). Simple metrics, their
// conditions, calculated metrics and metrics built from other metrics on the same
// table convert; a term on another table doesn't (open those as a Metrics report).
import { kindOfColumnType } from "../modelEngine.js";

const AGG_FN = { sum: "Sum", avg: "Average", min: "Min", max: "Max", distinct: "Distinct", median: "Median" };
const IF_FN = { sum: "SumIf", distinct: "DistinctIf" };
const OPS = { eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" };
const MAX_DEPTH = 8;

export class MetricError extends Error {}

const ref = (name) => `[${name}]`;
const quote = (v) => `"${String(v ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const literal = (v, kind) => (kind === "number" && v !== "" && Number.isFinite(Number(v)) ? String(Number(v)) : quote(v));

function conditionText(f, colById, colByName) {
  const col = colById.get(f.columnId) || colByName.get(f.column);
  if (!col) throw new MetricError("This metric has a condition on a column that no longer exists.");
  const kind = kindOfColumnType(col.type);
  if (f.operator === "in") {
    const list = Array.isArray(f.value) ? f.value : String(f.value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return `In(${ref(col.name)}, ${list.map((v) => literal(v, kind)).join(", ")})`;
  }
  if (f.operator === "contains") return `Contains(${ref(col.name)}, ${quote(f.value)})`;
  const op = OPS[f.operator];
  if (!op) throw new MetricError("This metric has a condition this report can't use.");
  return `${ref(col.name)} ${op} ${literal(f.value, kind)}`;
}

/**
 * @param {object} measure - a semantic measure on `node`
 * @param {object} node - the table it belongs to
 * @returns {string} formula text
 */
export function metricExpression(measure, node, depth = 0) {
  if (depth > MAX_DEPTH) throw new MetricError("This metric refers to itself.");
  const cols = node.data?.columns || [];
  const colById = new Map(cols.map((c) => [c.id, c]));
  const colByName = new Map(cols.map((c) => [c.name, c]));
  const measures = node.data?.semanticModel?.measures || [];

  const term = (t) => {
    if (t.measureId) {
      const m = measures.find((x) => x.id === t.measureId);
      if (!m) throw new MetricError("This metric uses another metric that no longer exists.");
      return `(${metricExpression(m, node, depth + 1)})`;
    }
    if (t.tableId && t.tableId !== node.id) throw new MetricError("This metric reads another table; open it as a Metrics report.");
    const conds = (t.filters || []).map((f) => conditionText(f, colById, colByName));
    const cond = conds.join(" and ");
    if (t.aggregation === "count") return conds.length ? `CountIf(${cond})` : "Count()";
    const col = colById.get(t.columnId);
    if (!col) throw new MetricError("This metric uses a column that no longer exists.");
    if (t.aggregation === "value") throw new MetricError("This metric reads a single value; open it as a Metrics report.");
    if (conds.length) {
      if (IF_FN[t.aggregation]) return `${IF_FN[t.aggregation]}(${ref(col.name)}, ${cond})`;
      // No ...If function for this one: aggregate only the matching values.
      return `${AGG_FN[t.aggregation]}(If(${cond}, ${ref(col.name)}, Null))`;
    }
    const fn = AGG_FN[t.aggregation];
    if (!fn) throw new MetricError("This metric uses an aggregation this report can't use.");
    return `${fn}(${ref(col.name)})`;
  };

  if (measure.kind === "calculated") {
    const tokens = measure.tokens || [];
    if (!tokens.length) throw new MetricError("This metric has no formula.");
    return tokens
      .map((tk) => {
        if (tk.kind === "op") return ` ${tk.value} `;
        if (tk.kind === "paren") return tk.value;
        const tm = tk.term || {};
        if (tm.type === "constant") return String(Number(tm.value) || 0);
        return term(tm);
      })
      .join("")
      .trim();
  }
  return term(measure);
}
