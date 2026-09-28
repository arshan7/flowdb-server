import { quoteIdent } from "./queryEngine.js";

export const MAX_SORT_KEYS = 3;

// ORDER BY for /preview. `orderBy` is one {column, direction} or a list of up
// to MAX_SORT_KEYS (multi-column sort). Every column must be a real column of
// the table. Ties are broken by `orderTiebreak` if given, else by the primary
// key, so LIMIT/OFFSET pages never repeat or skip rows.
// Returns { clause } (may be "") or { error }.
export function previewOrderClause({ orderBy, orderTiebreak = null, columnNames, pkNames = [] }) {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).filter(
    (k) => k && typeof k === "object" && typeof k.column === "string" && k.column,
  );
  if (!keys.length) return { clause: "" };
  if (keys.length > MAX_SORT_KEYS) return { error: `Sort by at most ${MAX_SORT_KEYS} columns.` };
  const used = new Set();
  const parts = [];
  for (const k of keys) {
    if (!columnNames.has(k.column)) return { error: `Can't sort by "${k.column}" - it isn't a column of this table.` };
    if (used.has(k.column)) continue;
    used.add(k.column);
    parts.push(`${quoteIdent(k.column)} ${k.direction === "desc" ? "DESC" : "ASC"}`);
  }
  if (typeof orderTiebreak === "string" && orderTiebreak) {
    if (!columnNames.has(orderTiebreak)) return { error: `Can't sort by "${orderTiebreak}" - it isn't a column of this table.` };
    if (!used.has(orderTiebreak)) parts.push(`${quoteIdent(orderTiebreak)} ASC`);
  } else {
    for (const pk of pkNames) if (!used.has(pk)) parts.push(`${quoteIdent(pk)} ASC`);
  }
  return { clause: ` ORDER BY ${parts.join(", ")}` };
}
