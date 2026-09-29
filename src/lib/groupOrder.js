import { quoteIdent } from "./queryEngine.js";

const FNS = new Set(["sum", "avg", "min", "max"]);
const DIRS = { asc: "ASC", desc: "DESC" };

// ORDER BY for /group-by. `order`: { by: "count" | "value" | "agg", direction,
// column?, fn? } - "agg" sorts groups by a column's total. Default: biggest
// groups first. Returns { clause } or { error }.
export function groupOrderClause(order, groupColumn, columnNames) {
  const col = quoteIdent(groupColumn);
  if (!order) return { clause: `count(*) DESC, ${col} ASC` };
  const dir = DIRS[order.direction];
  if (!dir) return { error: "Group order direction must be asc or desc." };
  if (order.by === "count") return { clause: `count(*) ${dir}, ${col} ASC` };
  if (order.by === "value") return { clause: `${col} ${dir} NULLS LAST` };
  if (order.by === "agg") {
    if (!columnNames.has(order.column) || !FNS.has(order.fn))
      return { error: "Group order needs a column of this table and fn sum, avg, min or max." };
    return {
      clause: `${order.fn}(${quoteIdent(order.column)}) ${dir} NULLS LAST, count(*) DESC, ${col} ASC`,
    };
  }
  return { error: "Group order must be by count, value or agg." };
}
