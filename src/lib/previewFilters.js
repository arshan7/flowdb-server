import { compileFilterCondition, compileFilterGroup } from "./queryEngine.js";

export const QUERY_OPERATORS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "in"]);

// Data-browse /preview row filters - plain-language operators ("is", "is
// not", "contains", "greater than"..., "is empty", "is not empty", "is any
// of") map to these keys, then through the shared compileFilterCondition.
// "isnull"/"notnull" bind no value; "in" binds one array (its value must
// be a non-empty array - the route checks that before compiling).
export const PREVIEW_OPERATORS = new Set(["eq", "neq", "contains", "gt", "gte", "lt", "lte", "isnull", "notnull", "in", "notin"]);

// Shared by /preview and /column-summary: validate ONE plain-language row
// filter (a leaf) against a table's real column names, then compile it to
// a parameterized WHERE fragment. Returns `{ sql }` or `{ error }`.
export function compilePreviewLeaf(f, columnNames, label, params) {
  if (!f || typeof f.column !== "string" || !columnNames.has(f.column) || !PREVIEW_OPERATORS.has(f.operator)) {
    return { error: "Invalid filter." };
  }
  if ((f.operator === "in" || f.operator === "notin") && (!Array.isArray(f.value) || f.value.length === 0)) {
    return { error: 'An "is any of" filter needs a non-empty list of values.' };
  }
  return { sql: compileFilterCondition(label, f.column, f.operator, f.value, params) };
}

// Thin wrapper for the flat `filters: []` callers (implicit AND). Returns
// an error string, or null on success (having pushed onto whereParts).
export function pushPreviewFilter(f, columnNames, label, whereParts, params) {
  const r = compilePreviewLeaf(f, columnNames, label, params);
  if (r.error) return r.error;
  whereParts.push(r.sql);
  return null;
}

// Build the ` WHERE ...` clause for /preview and /column-summary from
// EITHER a `filterGroup` AND/OR tree or the legacy flat `filters` array
// (implicit AND). Returns `{ clause }` (may be "") or `{ error }`.
export function previewWhereClause(filterGroup, filters, columnNames, label, params) {
  if (filterGroup && typeof filterGroup === "object") {
    try {
      const frag = compileFilterGroup(
        filterGroup,
        (leaf, p) => {
          const r = compilePreviewLeaf(leaf, columnNames, label, p);
          if (r.error) throw new Error(r.error);
          return r.sql;
        },
        params,
      );
      return { clause: frag ? ` WHERE ${frag}` : "" };
    } catch (e) {
      return { error: e.message || "Invalid filter." };
    }
  }
  const whereParts = [];
  for (const f of filters || []) {
    const err = pushPreviewFilter(f, columnNames, label, whereParts, params);
    if (err) return { error: err };
  }
  return { clause: whereParts.length ? ` WHERE ${whereParts.join(" AND ")}` : "" };
}
