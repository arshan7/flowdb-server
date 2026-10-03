import { test } from "node:test";
import assert from "node:assert/strict";
import { cronOf, describeSchedule, nextRun, parseCron } from "./schedule.js";

const at = (iso) => new Date(iso);

test("friendly schedules become cron", () => {
  assert.equal(cronOf({ every: "minutes", minutes: 30 }), "*/30 * * * *");
  assert.equal(cronOf({ every: "day", hour: 9, minute: 5 }), "5 9 * * *");
  assert.equal(cronOf({ every: "week", weekday: 1, hour: 8, minute: 0 }), "0 8 * * 1");
  assert.equal(cronOf({ every: "month", day: 31, hour: 8 }), "0 8 1 * *"); // days past 28 fall back
  assert.throws(() => cronOf({ every: "cron", cron: "61 * * * *" }), /out of range/);
  assert.throws(() => cronOf({}), /how often/);
});

test("cron fields: steps, ranges, lists, Sunday as 7", () => {
  const c = parseCron("*/15 9-17 * * 1-5");
  assert.deepEqual([...c.minute], [0, 15, 30, 45]);
  assert.equal(c.hour.size, 9);
  assert.deepEqual([...parseCron("0 0 * * 7").weekday], [0]);
});

test("next run in UTC and in a half-hour time zone", () => {
  assert.equal(nextRun({ every: "day", hour: 9, minute: 0 }, at("2026-10-03T08:59:30Z"), "UTC").toISOString(), "2026-10-03T09:00:00.000Z");
  assert.equal(nextRun({ every: "day", hour: 9, minute: 0 }, at("2026-10-03T09:00:00Z"), "UTC").toISOString(), "2026-10-04T09:00:00.000Z");
  // 09:00 in Kolkata is 03:30 UTC
  assert.equal(nextRun({ every: "day", hour: 9, minute: 0 }, at("2026-10-03T00:00:00Z"), "Asia/Kolkata").toISOString(), "2026-10-03T03:30:00.000Z");
  assert.equal(nextRun({ every: "minutes", minutes: 15 }, at("2026-10-03T10:07:00Z"), "UTC").toISOString(), "2026-10-03T10:15:00.000Z");
  // Saturday 3 Oct 2026 -> the next Monday 08:00
  assert.equal(nextRun({ every: "week", weekday: 1, hour: 8 }, at("2026-10-03T12:00:00Z"), "UTC").toISOString(), "2026-10-05T08:00:00.000Z");
  assert.equal(nextRun({ every: "month", day: 1, hour: 6 }, at("2026-10-03T12:00:00Z"), "UTC").toISOString(), "2026-11-01T06:00:00.000Z");
});

test("schedules read in plain words", () => {
  assert.equal(describeSchedule({ every: "week", weekday: 1, hour: 8, minute: 30 }), "Every Monday at 08:30");
});
