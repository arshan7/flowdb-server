// "Show as" on a measure: its value as % of total, a running total, or the change
// from the previous group - Postgres window functions over the grouped rows.
// Windows run before LIMIT, so "top 10, as % of total" is a share of everything.

export const SHOW_AS = new Set(["percent", "running", "change", "percentChange"]);

/** Keeps only known modes for ids the report has: { [measureId]: mode }. */
export function cleanShowAs(showAs, measureIds) {
  const out = {};
  if (!showAs || typeof showAs !== "object") return out;
  const ids = new Set(measureIds);
  for (const [id, mode] of Object.entries(showAs)) if (ids.has(id) && SHOW_AS.has(mode)) out[id] = mode;
  return out;
}

/**
 * @param {string} expr - the measure's aggregate SQL
 * @param {string} mode - one of SHOW_AS
 * @param {{sql: string, time: boolean}[]} dims - the report's groups, in order
 * @returns {string}
 */
export function showAsExpr(expr, mode, dims) {
  if (mode === "percent") return `((${expr})::float8 / NULLIF(SUM(${expr}) OVER (), 0))`;
  // Down the first date group (else the first group), restarting for each value of the others.
  const along = dims.find((d) => d.time) || dims[0];
  if (!along) throw new Error("A running total or change needs the report grouped by something.");
  const rest = dims.filter((d) => d !== along).map((d) => d.sql);
  const over = `OVER (${rest.length ? `PARTITION BY ${rest.join(", ")} ` : ""}ORDER BY ${along.sql}`;
  if (mode === "running") return `SUM(${expr}) ${over} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`;
  const prev = `LAG(${expr}) ${over})`;
  if (mode === "change") return `((${expr}) - ${prev})`;
  if (mode === "percentChange") return `(((${expr}) - ${prev})::float8 / NULLIF(${prev}, 0))`;
  return expr;
}
