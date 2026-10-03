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
 * @returns {{send: boolean, state: "met" | "unmet", value?: number|null}}
 */
export function checkAlert(condition, result, lastState) {
  const rows = result?.rows || [];
  if (!condition || condition.kind === "rows") {
    const met = rows.length > 0;
    return { send: met, state: met ? "met" : "unmet" };
  }
  const last = rows[rows.length - 1];
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
