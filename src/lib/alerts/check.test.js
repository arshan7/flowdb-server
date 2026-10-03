import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAlert, describeCondition } from "./check.js";

const rows = (...vals) => ({ rows: vals.map((v, i) => ({ month: i, rev: String(v) })) });

test("a rows alert sends whenever there are rows", () => {
  assert.deepEqual(checkAlert({ kind: "rows" }, rows(1), null), { send: true, state: "met" });
  assert.deepEqual(checkAlert({ kind: "rows" }, rows(), "met"), { send: false, state: "unmet" });
});

test("a goal alert reads the latest value and sends once per crossing", () => {
  const goal = { kind: "goal", measureId: "rev", direction: "above", value: 100, repeat: "first" };
  assert.equal(checkAlert(goal, rows(500, 90), null).send, false); // latest is 90
  const crossed = checkAlert(goal, rows(90, 150), "unmet");
  assert.deepEqual(crossed, { send: true, state: "met", value: 150 });
  assert.equal(checkAlert(goal, rows(150, 160), "met").send, false); // still above: no repeat
  assert.equal(checkAlert({ ...goal, repeat: "every" }, rows(150, 160), "met").send, true);
  assert.equal(checkAlert({ ...goal, direction: "below" }, rows(50), null).send, true);
  assert.equal(checkAlert(goal, rows(), null).send, false);
});

test("conditions read in plain words", () => {
  assert.equal(describeCondition({ kind: "goal", direction: "below", value: 1000 }, "Revenue"), "Revenue is below 1,000");
});
