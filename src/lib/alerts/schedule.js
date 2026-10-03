// When an alert runs next. Every schedule is a 5-field cron expression (minute hour
// day-of-month month weekday) read in the alert's time zone; the friendly shapes
// ("every day at 9:00") are turned into one. No library: Intl gives the local time.

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "weekday", min: 0, max: 6 },
];

export class ScheduleError extends Error {}

function parseField(text, { name, min, max }) {
  const out = new Set();
  for (const part of String(text).split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new ScheduleError(`The ${name} part "${part}" isn't understood.`);
    let lo = min;
    let hi = max;
    if (m[2] !== undefined) {
      lo = Number(m[2]);
      hi = m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? max : lo;
    }
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (name === "weekday") {
      if (lo === 7) lo = 0;
      if (hi === 7) hi = name === "weekday" && lo === 0 && m[3] === undefined ? 0 : 6;
    }
    if (lo < min || hi > max || lo > hi || step < 1) throw new ScheduleError(`The ${name} part "${part}" is out of range.`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** @returns {{minute: Set, hour: Set, day: Set, month: Set, weekday: Set, dayAny: boolean, weekdayAny: boolean}} */
export function parseCron(cron) {
  const parts = String(cron || "").trim().split(/\s+/);
  if (parts.length !== 5) throw new ScheduleError("A schedule needs 5 parts: minute hour day month weekday.");
  const sets = Object.fromEntries(FIELDS.map((f, i) => [f.name, parseField(parts[i], f)]));
  return { ...sets, dayAny: parts[2] === "*", weekdayAny: parts[4] === "*" };
}

const clamp = (n, lo, hi, dflt) => (Number.isInteger(Number(n)) && Number(n) >= lo && Number(n) <= hi ? Number(n) : dflt);

/** A friendly schedule as cron. */
export function cronOf(schedule) {
  const s = schedule || {};
  const minute = clamp(s.minute, 0, 59, 0);
  const hour = clamp(s.hour, 0, 23, 9);
  switch (s.every) {
    case "minutes":
      return `*/${[5, 10, 15, 30].includes(Number(s.minutes)) ? Number(s.minutes) : 15} * * * *`;
    case "hour":
      return `${minute} * * * *`;
    case "day":
      return `${minute} ${hour} * * *`;
    case "week":
      return `${minute} ${hour} * * ${clamp(s.weekday, 0, 6, 1)}`;
    case "month":
      return `${minute} ${hour} ${clamp(s.day, 1, 28, 1)} * *`;
    case "cron":
      parseCron(s.cron);
      return String(s.cron).trim();
    default:
      throw new ScheduleError("Pick how often the alert checks.");
  }
}

const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function localParts(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: WEEKDAY[get("weekday")],
  };
}

/**
 * The first minute after `after` that the schedule fires, in `tz`.
 * @returns {Date}
 */
export function nextRun(schedule, after = new Date(), tz = "UTC") {
  const c = parseCron(cronOf(schedule));
  let t = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  const limit = after.getTime() + 400 * 86_400_000;
  while (t.getTime() < limit) {
    const p = localParts(t, tz);
    const dayOk = c.dayAny && c.weekdayAny ? true : c.dayAny ? c.weekday.has(p.weekday) : c.weekdayAny ? c.day.has(p.day) : c.day.has(p.day) || c.weekday.has(p.weekday);
    if (!c.month.has(p.month) || !dayOk) {
      t = new Date(t.getTime() + ((23 - p.hour) * 60 + (60 - p.minute)) * 60_000); // next local midnight
      continue;
    }
    if (!c.hour.has(p.hour)) {
      t = new Date(t.getTime() + (60 - p.minute) * 60_000); // next local hour
      continue;
    }
    if (c.minute.has(p.minute)) return t;
    t = new Date(t.getTime() + 60_000);
  }
  throw new ScheduleError("This schedule never runs.");
}

/** "Every day at 09:00" - how a schedule reads. */
export function describeSchedule(schedule) {
  const s = schedule || {};
  const at = `${String(clamp(s.hour, 0, 23, 9)).padStart(2, "0")}:${String(clamp(s.minute, 0, 59, 0)).padStart(2, "0")}`;
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  switch (s.every) {
    case "minutes":
      return `Every ${s.minutes || 15} minutes`;
    case "hour":
      return `Every hour at :${String(clamp(s.minute, 0, 59, 0)).padStart(2, "0")}`;
    case "day":
      return `Every day at ${at}`;
    case "week":
      return `Every ${days[clamp(s.weekday, 0, 6, 1)]} at ${at}`;
    case "month":
      return `On day ${clamp(s.day, 1, 28, 1)} of every month at ${at}`;
    case "cron":
      return `On the schedule ${s.cron}`;
    default:
      return "";
  }
}
