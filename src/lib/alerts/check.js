// Whether a run of an alert sends an email.
//   { kind: "rows" }                  - the report returned any rows
//   { kind: "goal", measureId, direction: "above" | "below", value, repeat: "first" | "every" }
//     - the measure's latest value (the last row: reports sort by their first group,
//       so a time series ends with the newest) is on that side of the goal. With
//       repeat "first" it sends once per crossing: not again until the value has
//       been back on the other side.

/**
 * @param {object} condition
 * @param {{rows: object[]}} result
 * @param {string|null} lastState - "met" | "unmet" | null, from the previous run
 * @param {{dimId: string, bucket: string}|null} [period] - the report's time grouping
 * @param {Date} [now]
 * @returns {{send: boolean, state: "met" | "unmet", value?: number|null}}
 */
export function checkAlert(condition, result, lastState, period = null, now = new Date()) {
  const rows = result?.rows || [];
  if (!condition || condition.kind === "rows") {
    const met = rows.length > 0;
    return { send: met, state: met ? "met" : "unmet" };
  }
  // The current week (month…) isn't over: judge the last finished one.
  let last = rows[rows.length - 1];
  if (period && last && new Date(last[period.dimId]) >= periodStart(period.bucket, now)) last = rows[rows.length - 2];
  const raw = last ? last[condition.measureId] : null;
  const value = raw == null || raw === "" ? null : Number(raw);
  const goal = Number(condition.value);
  const met = value != null && Number.isFinite(value) && Number.isFinite(goal) && (condition.direction === "below" ? value < goal : value >= goal);
  const state = met ? "met" : "unmet";
  const send = met && (condition.repeat === "every" || lastState !== "met");
  return { send, state, value };
}

/** "Revenue went above 1,000" - the email's subject line part. */
export function describeCondition(condition, measureLabel = "The value") {
  if (!condition || condition.kind === "rows") return "has results";
  const goal = Number(condition.value).toLocaleString("en-US");
  return `${measureLabel} is ${condition.direction === "below" ? "below" : "at or above"} ${goal}`;
}

/** When the period containing `now` began (UTC; weeks start on Monday, as Postgres's date_trunc). */
export function periodStart(bucket, now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (bucket === "week") d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  else if (bucket === "month") d.setUTCDate(1);
  else if (bucket === "quarter") d.setUTCMonth(Math.floor(d.getUTCMonth() / 3) * 3, 1);
  else if (bucket === "year") d.setUTCMonth(0, 1);
  else if (bucket !== "day") return new Date(8.64e15); // no time grouping: every row counts
  return d;
}
