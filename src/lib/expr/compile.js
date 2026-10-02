// Formula tree (parser.js) -> Postgres SQL, typed. One catalog (FUNCTIONS) drives
// compiling, checking, the editor's autocomplete and its docs (GET /api/expr/functions).
// Columns resolve only through ctx.column(); text and patterns are bound parameters;
// date units and other keywords are checked against fixed lists before they reach SQL.
import { ExprError, parse } from "./parser.js";

// Value kinds: number, text, date, datetime, bool, unknown (an untyped column), null.
const v = (sql, kind) => ({ sql, kind });
const isDate = (x) => x.kind === "date" || x.kind === "datetime";
const NUMBER_TEXT = String.raw`^\s*[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?\s*$`;
const DATE_TEXT = String.raw`^\s*[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])`;
const UNITS = ["year", "quarter", "month", "week", "day", "hour", "minute", "second"];
const SECONDS = { week: 604800, day: 86400, hour: 3600, minute: 60, second: 1 };

function makeCtx(base) {
  const params = base.params ?? [];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  return { ...base, params, bind, inAgg: false };
}

// --- coercion: what an argument of a given kind becomes -------------------------
function asNumber(x, ctx, at) {
  if (x.kind === "number" || x.kind === "unknown" || x.kind === "null") return x.sql;
  if (x.kind === "text") {
    const p = ctx.bind(NUMBER_TEXT);
    return `(CASE WHEN (${x.sql}) ~ ${p} THEN btrim(${x.sql})::numeric END)`;
  }
  if (x.kind === "bool") return `(${x.sql})::integer`;
  throw new ExprError("A date can't be used as a number here. DatetimeDiff gives the time between two dates.", at);
}
const asText = (x) => (x.kind === "text" ? x.sql : `(${x.sql})::text`);
function asDate(x, ctx, at, { time = false } = {}) {
  if (isDate(x) || x.kind === "unknown" || x.kind === "null") return time ? `(${x.sql})::timestamp` : x.sql;
  if (x.kind === "text") {
    const p = ctx.bind(DATE_TEXT);
    return `(CASE WHEN (${x.sql}) ~ ${p} THEN btrim(${x.sql})::timestamp END)`;
  }
  throw new ExprError("Expected a date here.", at);
}
function asBool(x, at) {
  if (x.kind === "bool" || x.kind === "unknown" || x.kind === "null") return x.sql;
  throw new ExprError("Expected a condition here, like [status] = \"paid\".", at);
}

// A keyword argument ("day", "case-insensitive"): must be a text literal from a fixed list.
function keyword(node, allowed, what) {
  const s = node?.type === "str" ? node.value.toLowerCase().replace(/s$/, "") : null;
  if (!s || !allowed.includes(s)) {
    throw new ExprError(`${what} must be one of: ${allowed.map((a) => `"${a}"`).join(", ")}.`, node?.at ?? null);
  }
  return s;
}
function literalNumber(node, what) {
  const neg = node?.type === "neg" && node.e?.type === "num";
  if (node?.type !== "num" && !neg) throw new ExprError(`${what} must be a number written in the formula.`, node?.at ?? null);
  return neg ? -node.e.value : node.value;
}

// --- the catalog ----------------------------------------------------------------
// args: kinds the compiled arguments are coerced to ("number" | "text" | "date" | "bool" | "any");
// a trailing "...kind" repeats. `raw: true` gets the uncompiled nodes (for keywords).
const F = [];
const def = (name, category, signature, description, example, spec) => F.push({ name, category, signature, description, example, ...spec });

// Aggregations (measures only).
const agg = (name, sig, desc, ex, args, sql) => def(name, "Aggregate", sig, desc, ex, { agg: true, args, returns: "number", sql });
agg("Count", "Count()", "Number of rows.", "Count()", [], () => "COUNT(*)");
agg("CountIf", "CountIf(condition)", "Rows where the condition is true.", 'CountIf([status] = "paid")', ["bool"], ([c]) => `COUNT(*) FILTER (WHERE ${c})`);
agg("Sum", "Sum(column)", "Total of the values.", "Sum([total])", ["number"], ([x]) => `SUM(${x})`);
agg("SumIf", "SumIf(column, condition)", "Total of the values where the condition is true.", 'SumIf([total], [status] = "paid")', ["number", "bool"], ([x, c]) => `SUM(${x}) FILTER (WHERE ${c})`);
agg("Distinct", "Distinct(column)", "Number of different values.", "Distinct([customer_id])", ["any"], ([x]) => `COUNT(DISTINCT ${x})`);
agg("DistinctIf", "DistinctIf(column, condition)", "Different values where the condition is true.", 'DistinctIf([customer_id], [status] = "paid")', ["any", "bool"], ([x, c]) => `COUNT(DISTINCT ${x}) FILTER (WHERE ${c})`);
agg("Average", "Average(column)", "Mean of the values.", "Average([total])", ["number"], ([x]) => `AVG(${x})`);
agg("Avg", "Avg(column)", "Same as Average.", "Avg([total])", ["number"], ([x]) => `AVG(${x})`);
agg("Median", "Median(column)", "The middle value.", "Median([total])", ["number"], ([x]) => `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${x})`);
agg("StandardDeviation", "StandardDeviation(column)", "How spread out the values are.", "StandardDeviation([total])", ["number"], ([x]) => `STDDEV_SAMP(${x})`);
agg("StdDev", "StdDev(column)", "Same as StandardDeviation.", "StdDev([total])", ["number"], ([x]) => `STDDEV_SAMP(${x})`);
agg("Variance", "Variance(column)", "Square of the standard deviation.", "Variance([total])", ["number"], ([x]) => `VAR_SAMP(${x})`);
agg("Share", "Share(condition)", "Fraction of rows where the condition is true (0 to 1).", 'Share([status] = "paid")', ["bool"], ([c]) => `(COUNT(*) FILTER (WHERE ${c}))::float8 / NULLIF(COUNT(*), 0)`);
def("Min", "Aggregate", "Min(column)", "Smallest value.", "Min([ordered_on])", { agg: true, args: ["any"], returns: (a) => a[0].kind, sql: ([x]) => `MIN(${x})` });
def("Max", "Aggregate", "Max(column)", "Largest value.", "Max([ordered_on])", { agg: true, args: ["any"], returns: (a) => a[0].kind, sql: ([x]) => `MAX(${x})` });
def("Percentile", "Aggregate", "Percentile(column, fraction)", "The value below which that fraction of values fall.", "Percentile([total], 0.9)", {
  agg: true,
  raw: true,
  returns: "number",
  compileRaw: ([col, p], ctx, at) => {
    const frac = literalNumber(p, "The fraction");
    if (!(frac >= 0 && frac <= 1)) throw new ExprError("The fraction must be between 0 and 1.", p?.at ?? at);
    const x = asNumber(compileNode(col, ctx), ctx, col.at);
    return `PERCENTILE_CONT(${frac}) WITHIN GROUP (ORDER BY ${x})`;
  },
});
// Window functions over the report's groups, in group order.
const win = (ctx, at) => {
  if (!ctx.windowOrder?.length) throw new ExprError("This needs the report to be grouped by something.", at);
  return `OVER (ORDER BY ${ctx.windowOrder.join(", ")})`;
};
def("CumulativeSum", "Aggregate", "CumulativeSum(column)", "Running total down the groups.", "CumulativeSum([total])", {
  agg: true, args: ["number"], returns: "number", sql: ([x], ctx, at) => `SUM(SUM(${x})) ${win(ctx, at)}`,
});
def("CumulativeCount", "Aggregate", "CumulativeCount()", "Running count of rows down the groups.", "CumulativeCount()", {
  agg: true, args: [], returns: "number", sql: (_a, ctx, at) => `SUM(COUNT(*)) ${win(ctx, at)}`,
});
def("Offset", "Aggregate", "Offset(measure, rows)", "The measure from another group: -1 is the previous one, 1 the next.", "Sum([total]) - Offset(Sum([total]), -1)", {
  aggWrapper: true,
  raw: true,
  returns: "number",
  compileRaw: ([e, n], ctx, at) => {
    const k = literalNumber(n, "The number of rows");
    if (!Number.isInteger(k) || k === 0) throw new ExprError("The number of rows must be a whole number other than 0.", n?.at ?? at);
    const inner = compileNode(e, ctx).sql;
    return `${k < 0 ? "LAG" : "LEAD"}(${inner}, ${Math.abs(k)}) ${win(ctx, at)}`;
  },
});

// Logic.
def("Case", "Logic", "Case(condition, value, …, otherwise)", "The value for the first true condition; the last value when none is.", 'Case([total] > 100, "big", "small")', {
  raw: true,
  returns: (parts) => parts.kind,
  compileRaw: (args, ctx, at) => caseSql(args, ctx, at),
});
def("If", "Logic", "If(condition, value, …, otherwise)", "Same as Case.", 'If([vip], "VIP", "Regular")', {
  raw: true,
  returns: (parts) => parts.kind,
  compileRaw: (args, ctx, at) => caseSql(args, ctx, at),
});
def("Coalesce", "Logic", "Coalesce(value, …)", "The first value that isn't empty.", 'Coalesce([nickname], [name], "unknown")', {
  args: ["...any"], returns: (a) => sameKind(a), sql: (a) => `COALESCE(${a.join(", ")})`,
});
def("IsNull", "Logic", "IsNull(value)", "True when the value is empty (null).", "IsNull([email])", { args: ["any"], returns: "bool", sql: ([x]) => `(${x} IS NULL)` });
def("NotNull", "Logic", "NotNull(value)", "True when the value isn't null.", "NotNull([email])", { args: ["any"], returns: "bool", sql: ([x]) => `(${x} IS NOT NULL)` });
def("IsEmpty", "Logic", "IsEmpty(text)", "True when the text is null or blank.", "IsEmpty([email])", { args: ["text"], returns: "bool", sql: ([x]) => `(NULLIF(btrim(${x}), '') IS NULL)` });
def("NotEmpty", "Logic", "NotEmpty(text)", "True when the text has something in it.", "NotEmpty([email])", { args: ["text"], returns: "bool", sql: ([x]) => `(NULLIF(btrim(${x}), '') IS NOT NULL)` });
def("In", "Logic", "In(value, option, …)", "True when the value is any of the options.", 'In([status], "paid", "shipped")', {
  raw: true, returns: "bool", compileRaw: (args, ctx, at) => inSql(args, ctx, at, false),
});
def("NotIn", "Logic", "NotIn(value, option, …)", "True when the value is none of the options.", 'NotIn([status], "cancelled")', {
  raw: true, returns: "bool", compileRaw: (args, ctx, at) => inSql(args, ctx, at, true),
});
def("Between", "Logic", "Between(value, low, high)", "True when low ≤ value ≤ high.", "Between([total], 10, 100)", {
  raw: true,
  returns: "bool",
  compileRaw: ([x, lo, hi], ctx, at) => {
    if (!hi) throw new ExprError("Between needs a value, a low and a high.", at);
    const [a, b, c] = [x, lo, hi].map((n) => compileNode(n, ctx));
    if (isDate(a)) return `(${asDate(a, ctx, x.at)} BETWEEN ${asDate(b, ctx, lo.at)} AND ${asDate(c, ctx, hi.at)})`;
    return `(${asNumber(a, ctx, x.at)} BETWEEN ${asNumber(b, ctx, lo.at)} AND ${asNumber(c, ctx, hi.at)})`;
  },
});

// Math.
const math = (name, sig, desc, ex, args, sql) => def(name, "Math", sig, desc, ex, { args, returns: "number", sql });
math("Abs", "Abs(number)", "Distance from zero.", "Abs([balance])", ["number"], ([x]) => `ABS(${x})`);
math("Ceil", "Ceil(number)", "Rounded up.", "Ceil([price])", ["number"], ([x]) => `CEIL(${x})`);
math("Floor", "Floor(number)", "Rounded down.", "Floor([price])", ["number"], ([x]) => `FLOOR(${x})`);
def("Round", "Math", "Round(number, digits?)", "Rounded to the nearest whole number, or to that many decimals.", "Round([price], 2)", {
  raw: true,
  returns: "number",
  compileRaw: ([x, d], ctx, at) => {
    if (!x) throw new ExprError("Round needs a number.", at);
    const n = asNumber(compileNode(x, ctx), ctx, x.at);
    if (!d) return `ROUND((${n})::numeric)`;
    const digits = literalNumber(d, "The number of decimals");
    if (!Number.isInteger(digits) || digits < 0 || digits > 10) throw new ExprError("Decimals must be a whole number from 0 to 10.", d.at);
    return `ROUND((${n})::numeric, ${digits})`;
  },
});
math("Sqrt", "Sqrt(number)", "Square root.", "Sqrt([area])", ["number"], ([x]) => `SQRT(${x})`);
math("Power", "Power(number, exponent)", "The number raised to the exponent.", "Power([growth], 2)", ["number", "number"], ([x, y]) => `POWER(${x}, ${y})`);
math("Exp", "Exp(number)", "e raised to the number.", "Exp(1)", ["number"], ([x]) => `EXP(${x})`);
math("Log", "Log(number)", "Base-10 logarithm.", "Log([views])", ["number"], ([x]) => `LOG(${x})`);
math("Ln", "Ln(number)", "Natural logarithm.", "Ln([views])", ["number"], ([x]) => `LN(${x})`);

// Text.
const txt = (name, sig, desc, ex, args, sql, returns = "text") => def(name, "Text", sig, desc, ex, { args, returns, sql });
txt("Concat", "Concat(value, …)", "Values joined into one text (empty parts are skipped).", 'Concat([first_name], " ", [last_name])', ["...text"], (a) => `concat(${a.join(", ")})`);
def("Contains", "Text", "Contains(text, part, \"case-insensitive\"?)", "True when the text contains the part.", 'Contains([email], "@gmail")', {
  raw: true, returns: "bool", compileRaw: (args, ctx, at) => likeSql(args, ctx, at, "%", "%", false),
});
def("DoesNotContain", "Text", "DoesNotContain(text, part, \"case-insensitive\"?)", "True when the text doesn't contain the part.", 'DoesNotContain([email], "test")', {
  raw: true, returns: "bool", compileRaw: (args, ctx, at) => likeSql(args, ctx, at, "%", "%", true),
});
def("StartsWith", "Text", "StartsWith(text, start, \"case-insensitive\"?)", "True when the text begins with that.", 'StartsWith([sku], "AB-")', {
  raw: true, returns: "bool", compileRaw: (args, ctx, at) => likeSql(args, ctx, at, "", "%", false),
});
def("EndsWith", "Text", "EndsWith(text, end, \"case-insensitive\"?)", "True when the text ends with that.", 'EndsWith([email], ".edu")', {
  raw: true, returns: "bool", compileRaw: (args, ctx, at) => likeSql(args, ctx, at, "%", "", false),
});
txt("Lower", "Lower(text)", "Lower case.", "Lower([email])", ["text"], ([x]) => `LOWER(${x})`);
txt("Upper", "Upper(text)", "Upper case.", "Upper([code])", ["text"], ([x]) => `UPPER(${x})`);
txt("Trim", "Trim(text)", "Spaces removed from both ends.", "Trim([name])", ["text"], ([x]) => `btrim(${x})`);
txt("LTrim", "LTrim(text)", "Spaces removed from the start.", "LTrim([name])", ["text"], ([x]) => `ltrim(${x})`);
txt("RTrim", "RTrim(text)", "Spaces removed from the end.", "RTrim([name])", ["text"], ([x]) => `rtrim(${x})`);
txt("Length", "Length(text)", "Number of characters.", "Length([name])", ["text"], ([x]) => `LENGTH(${x})`, "number");
txt("Substring", "Substring(text, start, length)", "Part of the text; the first character is 1.", "Substring([sku], 1, 3)", ["text", "number", "number"], ([s, a, n]) => `SUBSTRING(${s} FROM (${a})::integer FOR (${n})::integer)`);
txt("Replace", "Replace(text, find, with)", "Every `find` replaced.", 'Replace([phone], "-", "")', ["text", "text", "text"], ([s, a, b]) => `REPLACE(${s}, ${a}, ${b})`);
txt("RegexExtract", "RegexExtract(text, pattern)", "The first part matching the pattern (its first ( ) group if it has one).", 'RegexExtract([url], "utm_source=([^&]+)")', ["text", "text"], ([s, p]) => `SUBSTRING(${s} FROM ${p})`);
txt("SplitPart", "SplitPart(text, delimiter, position)", "One piece of the text split by the delimiter; the first is 1.", 'SplitPart([full_name], " ", 1)', ["text", "text", "number"], ([s, d, n]) => `SPLIT_PART(${s}, ${d}, (${n})::integer)`);
def("Host", "Text", "Host(url)", "The site in a URL or email, without www.", 'Host([website])  → "example.com"', {
  args: ["text"], returns: "text", sql: ([u], ctx) => hostSql(u, ctx),
});
def("Domain", "Text", "Domain(url)", "The name part of the site.", 'Domain([website])  → "example"', {
  args: ["text"], returns: "text", sql: ([u], ctx) => `NULLIF(SPLIT_PART(REVERSE(${hostSql(u, ctx)}), '.', 2), '')`, post: (sql) => `REVERSE(${sql})`,
});
def("Subdomain", "Text", "Subdomain(url)", "What comes before the domain, if anything.", 'Subdomain([website])  → "shop"', {
  args: ["text"], returns: "text", sql: ([u], ctx) => `NULLIF(REGEXP_REPLACE(${hostSql(u, ctx)}, ${ctx.bind(String.raw`\.?[^.]+\.[^.]+$`)}, ''), '')`,
});
def("Path", "Text", "Path(url)", "The path part of a URL.", 'Path([url])  → "/pricing"', {
  args: ["text"], returns: "text", sql: ([u], ctx) => `SUBSTRING(${u} FROM ${ctx.bind(String.raw`^(?:[A-Za-z][A-Za-z0-9+.-]*://)?[^/?#]*(/[^?#]*)`)})`,
});

// Conversions.
def("Text", "Convert", "Text(value)", "The value as text.", "Text([id])", { args: ["any"], returns: "text", sql: ([x]) => `(${x})::text` });
def("Integer", "Convert", "Integer(value)", "A whole number (text that isn't a number becomes empty).", 'Integer([zip])', {
  raw: true, returns: "number", compileRaw: ([x], ctx, at) => `ROUND((${asNumber(need(x, at, ctx), ctx, x.at)})::numeric)::bigint`,
});
def("Float", "Convert", "Float(value)", "A decimal number (text that isn't a number becomes empty).", 'Float([price_text])', {
  raw: true, returns: "number", compileRaw: ([x], ctx, at) => `(${asNumber(need(x, at, ctx), ctx, x.at)})::float8`,
});
def("Date", "Convert", "Date(value)", "A date (text like 2026-05-06, or a date and time's day).", 'Date([created_at])', {
  raw: true, returns: "date", compileRaw: ([x], ctx, at) => `(${asDate(need(x, at, ctx), ctx, x.at)})::date`,
});
def("Datetime", "Convert", "Datetime(value)", "A date and time.", 'Datetime([ordered_on])', {
  raw: true, returns: "datetime", compileRaw: ([x], ctx, at) => asDate(need(x, at, ctx), ctx, x.at, { time: true }),
});

// Dates.
def("Now", "Date", "Now()", "The current date and time.", "Now()", { args: [], returns: "datetime", sql: () => "NOW()" });
def("Today", "Date", "Today()", "Today's date.", "Today()", { args: [], returns: "date", sql: () => "CURRENT_DATE" });
// Time parts read a date as midnight (Postgres refuses EXTRACT(HOUR FROM date)).
const part = (name, field, desc) =>
  def(name, "Date", `${name}(date)`, desc, `${name}([ordered_on])`, {
    args: ["date"],
    returns: "number",
    sql: ([d]) => `EXTRACT(${field} FROM ${["HOUR", "MINUTE", "SECOND"].includes(field) ? `(${d})::timestamp` : d})::integer`,
  });
part("Year", "YEAR", "The year.");
part("Quarter", "QUARTER", "The quarter, 1-4.");
part("Month", "MONTH", "The month, 1-12.");
part("Week", "WEEK", "The ISO week of the year, 1-53.");
part("Day", "DAY", "The day of the month, 1-31.");
part("Weekday", "ISODOW", "The day of the week, 1 (Monday) to 7 (Sunday).");
part("Hour", "HOUR", "The hour, 0-23.");
part("Minute", "MINUTE", "The minute, 0-59.");
part("Second", "SECOND", "The second, 0-59.");
def("MonthName", "Date", "MonthName(date)", "The month's name.", "MonthName([ordered_on])", { args: ["date"], returns: "text", sql: ([d]) => `TRIM(TO_CHAR(${d}, 'FMMonth'))` });
def("DayName", "Date", "DayName(date)", "The weekday's name.", "DayName([ordered_on])", { args: ["date"], returns: "text", sql: ([d]) => `TRIM(TO_CHAR(${d}, 'FMDay'))` });
def("QuarterName", "Date", "QuarterName(date)", 'The quarter as "Q1"-"Q4".', "QuarterName([ordered_on])", { args: ["date"], returns: "text", sql: ([d]) => `('Q' || EXTRACT(QUARTER FROM ${d})::integer)` });
const shift = (sign) => ([d, n, u], ctx, at) => {
  if (!u) throw new ExprError("Give a date, an amount and a unit like \"day\".", at);
  const unit = keyword(u, UNITS, "The unit");
  const dd = compileNode(d, ctx);
  const amount = asNumber(compileNode(n, ctx), ctx, n.at);
  const step = unit === "quarter" ? `(${amount}) * interval '3 month'` : `(${amount}) * interval '1 ${unit}'`;
  return `(${asDate(dd, ctx, d.at, { time: true })} ${sign} ${step})`;
};
def("DatetimeAdd", "Date", 'DatetimeAdd(date, amount, "unit")', "The date moved forward.", 'DatetimeAdd([ordered_on], 7, "day")', { raw: true, returns: "datetime", compileRaw: shift("+") });
def("DatetimeSubtract", "Date", 'DatetimeSubtract(date, amount, "unit")', "The date moved back.", 'DatetimeSubtract(Now(), 1, "month")', { raw: true, returns: "datetime", compileRaw: shift("-") });
def("DatetimeDiff", "Date", 'DatetimeDiff(start, end, "unit")', "Whole units from start to end.", 'DatetimeDiff([ordered_on], [shipped_on], "day")', {
  raw: true,
  returns: "number",
  compileRaw: ([a, b, u], ctx, at) => {
    if (!u) throw new ExprError("Give a start, an end and a unit like \"day\".", at);
    const unit = keyword(u, UNITS, "The unit");
    const s = asDate(compileNode(a, ctx), ctx, a.at, { time: true });
    const e = asDate(compileNode(b, ctx), ctx, b.at, { time: true });
    if (SECONDS[unit]) return `TRUNC(EXTRACT(EPOCH FROM (${e} - ${s})) / ${SECONDS[unit]})::bigint`;
    const months = `(EXTRACT(YEAR FROM AGE(${e}, ${s})) * 12 + EXTRACT(MONTH FROM AGE(${e}, ${s})))`;
    return `TRUNC(${months} / ${unit === "year" ? 12 : unit === "quarter" ? 3 : 1})::bigint`;
  },
});
def("ConvertTimezone", "Date", 'ConvertTimezone(datetime, "to zone", "from zone"?)', "The time shown in another time zone.", 'ConvertTimezone([created_at], "Asia/Kolkata")', {
  raw: true,
  returns: "datetime",
  compileRaw: ([d, to, from], ctx, at) => {
    const zone = (n, what) => {
      if (n?.type !== "str" || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$|^UTC$/.test(n.value)) throw new ExprError(`${what} must be a zone name like "Europe/Paris".`, n?.at ?? at);
      return ctx.bind(n.value);
    };
    const dd = asDate(compileNode(d, ctx), ctx, d.at, { time: true });
    const src = from ? zone(from, "The from zone") : "'UTC'";
    return `((${dd} AT TIME ZONE ${src}) AT TIME ZONE ${zone(to, "The zone")})`;
  },
});
def("RelativeDatetime", "Date", 'RelativeDatetime(amount, "unit")', "Now moved by the amount (negative is the past).", 'RelativeDatetime(-30, "day")', {
  raw: true,
  returns: "datetime",
  compileRaw: ([n, u], ctx, at) => {
    if (!u) throw new ExprError("Give an amount and a unit like \"day\".", at);
    const unit = keyword(u, UNITS, "The unit");
    const amount = asNumber(compileNode(n, ctx), ctx, n.at);
    return `(NOW() + (${amount}) * interval '${unit === "quarter" ? "3 month" : `1 ${unit}`}')`;
  },
});

export const FUNCTIONS = F;
const BY_NAME = new Map(F.map((f) => [f.name.toLowerCase(), f]));

// --- helpers used by the catalog -----------------------------------------------
function need(node, at, ctx) {
  if (!node) throw new ExprError("This needs a value.", at);
  return compileNode(node, ctx);
}
function sameKind(args) {
  const kinds = [...new Set(args.map((a) => a.kind).filter((k) => k !== "null"))];
  return kinds.length === 1 ? kinds[0] : kinds.includes("text") ? "text" : kinds[0] ?? "unknown";
}
function caseSql(args, ctx, at) {
  if (args.length < 2) throw new ExprError("Case needs a condition and a value.", at);
  const parts = [];
  const values = [];
  let i = 0;
  for (; i + 1 < args.length; i += 2) {
    parts.push(`WHEN ${asBool(compileNode(args[i], ctx), args[i].at)} THEN `);
    values.push(compileNode(args[i + 1], ctx));
  }
  const otherwise = i < args.length ? compileNode(args[i], ctx) : null;
  const all = otherwise ? [...values, otherwise] : values;
  const kind = sameKind(all);
  const cast = (x) => (kind === "text" ? asText(x) : kind === "number" ? asNumber(x, ctx, at) : x.sql);
  const body = parts.map((w, k) => w + cast(values[k])).join(" ");
  return { sql: `(CASE ${body}${otherwise ? ` ELSE ${cast(otherwise)}` : ""} END)`, kind };
}
function inSql([x, ...opts], ctx, at, negate) {
  if (!x || !opts.length) throw new ExprError("Give a value and at least one option.", at);
  const val = compileNode(x, ctx);
  const items = opts.map((o) => compileNode(o, ctx));
  const textual = val.kind === "text" || items.some((o) => o.kind === "text");
  const list = items.map((o) => (textual ? asText(o) : asNumber(o, ctx, at))).join(", ");
  return `(${textual ? asText(val) : asNumber(val, ctx, x.at)} ${negate ? "NOT IN" : "IN"} (${list}))`;
}
function likeSql([s, part, mode], ctx, at, pre, post, negate) {
  if (!part) throw new ExprError("Give the text and the part to look for.", at);
  const ci = mode ? keyword(mode, ["case-insensitive"], "The last option") === "case-insensitive" : false;
  const text = asText(compileNode(s, ctx));
  const p = asText(compileNode(part, ctx));
  // Escape % and _ in the part so they match literally.
  const pattern = `${pre ? "'%' || " : ""}REPLACE(REPLACE(REPLACE(${p}, '\\', '\\\\'), '%', '\\%'), '_', '\\_')${post ? " || '%'" : ""}`;
  return `(${text} ${negate ? "NOT " : ""}${ci ? "ILIKE" : "LIKE"} ${pattern})`;
}
function hostSql(u, ctx) {
  const p = ctx.bind(String.raw`^(?:[A-Za-z][A-Za-z0-9+.-]*://)?(?:[^@/]*@)?(?:www\.)?([^/:?#]+)`);
  return `LOWER(SUBSTRING(${u} FROM ${p}))`;
}

// --- the walk ---------------------------------------------------------------------
const ARITH = { "+": "+", "-": "-", "*": "*", "/": "/" };
const CMP = { "=": "=", "!=": "<>", "<": "<", "<=": "<=", ">": ">", ">=": ">=" };

function compileNode(node, ctx) {
  switch (node.type) {
    case "num":
      return v(`${ctx.bind(node.value)}::numeric`, "number");
    case "str":
      return v(`${ctx.bind(node.value)}::text`, "text");
    case "bool":
      return v(node.value ? "TRUE" : "FALSE", "bool");
    case "null":
      return v("NULL", "null");
    case "col": {
      if (ctx.mode === "agg" && !ctx.inAgg) {
        throw new ExprError(`[${node.name}] must be inside an aggregation, like Sum([${node.name}]).`, node.at);
      }
      const c = ctx.column(node.name);
      if (!c) throw new ExprError(`There's no column called [${node.name}].`, node.at);
      return c;
    }
    case "neg":
      return v(`(-${asNumber(compileNode(node.e, ctx), ctx, node.at)})`, "number");
    case "not":
      return v(`(NOT ${asBool(compileNode(node.e, ctx), node.at)})`, "bool");
    case "bin": {
      const l = compileNode(node.l, ctx);
      const r = compileNode(node.r, ctx);
      if (node.op === "&") return v(`concat(${l.sql}, ${r.sql})`, "text");
      if (node.op === "and" || node.op === "or") return v(`(${asBool(l, node.l.at)} ${node.op.toUpperCase()} ${asBool(r, node.r.at)})`, "bool");
      if (CMP[node.op]) {
        const [a, b] =
          isDate(l) || isDate(r)
            ? [asDate(l, ctx, node.l.at), asDate(r, ctx, node.r.at)]
            : l.kind === "text" && r.kind === "text"
              ? [l.sql, r.sql]
              : l.kind === "text" || r.kind === "text"
                ? [asText(l), asText(r)]
                : l.kind === "bool" || r.kind === "bool"
                  ? [l.sql, r.sql]
                  : [asNumber(l, ctx, node.l.at), asNumber(r, ctx, node.r.at)];
        return v(`(${a} ${CMP[node.op]} ${b})`, "bool");
      }
      if (isDate(l) || isDate(r)) {
        if (node.op === "-" && isDate(l) && isDate(r)) {
          return v(`(EXTRACT(EPOCH FROM ((${l.sql})::timestamp - (${r.sql})::timestamp)) / 86400)`, "number");
        }
        throw new ExprError("For dates use DatetimeAdd, DatetimeSubtract or DatetimeDiff.", node.at);
      }
      const a = asNumber(l, ctx, node.l.at);
      const b = asNumber(r, ctx, node.r.at);
      return v(node.op === "/" ? `(${a}::float8 / NULLIF(${b}, 0))` : `(${a} ${ARITH[node.op]} ${b})`, "number");
    }
    case "call":
      return compileCall(node, ctx);
    default:
      throw new ExprError("This formula has something it can't read.", node.at ?? null);
  }
}

function compileCall(node, ctx) {
  const f = BY_NAME.get(node.name.toLowerCase());
  if (!f) throw new ExprError(`There's no function called ${node.name}.`, node.at);
  if (f.agg && ctx.mode !== "agg") throw new ExprError(`${f.name} works in a measure, not a row formula.`, node.at);
  if (f.agg && ctx.inAgg) throw new ExprError(`${f.name} can't go inside another aggregation.`, node.at);
  if (f.aggWrapper && ctx.mode !== "agg") throw new ExprError(`${f.name} works in a measure, not a row formula.`, node.at);
  const wasInAgg = ctx.inAgg;
  if (f.agg) ctx.inAgg = true;
  try {
    if (f.raw) {
      const out = f.compileRaw(node.args, ctx, node.at);
      if (typeof out === "object") return out;
      return v(out, typeof f.returns === "string" ? f.returns : "unknown");
    }
    const fixed = f.args.filter((a) => !a.startsWith("..."));
    const rest = f.args.find((a) => a.startsWith("..."))?.slice(3);
    if (node.args.length < fixed.length || (!rest && node.args.length > fixed.length) || (rest && node.args.length < 1)) {
      throw new ExprError(`${f.signature} - ${node.args.length} given.`, node.at);
    }
    const compiled = node.args.map((a) => compileNode(a, ctx));
    const sqlArgs = compiled.map((c, i) => {
      const want = fixed[i] ?? rest;
      const at = node.args[i].at;
      if (want === "number") return asNumber(c, ctx, at);
      if (want === "text") return asText(c);
      if (want === "date") return asDate(c, ctx, at);
      if (want === "bool") return asBool(c, at);
      return c.sql;
    });
    let sql = f.sql(sqlArgs, ctx, node.at);
    if (f.post) sql = f.post(sql);
    const kind = typeof f.returns === "function" ? f.returns(compiled) : f.returns;
    return v(sql, kind);
  } finally {
    ctx.inAgg = wasInAgg;
  }
}
/**
 * Compile formula text.
 * @param {string} text
 * @param {{mode: "row"|"agg", column: (name: string) => ({sql: string, kind: string}|null), params?: unknown[], windowOrder?: string[]}} options
 * @returns {{sql: string, kind: string, params: unknown[]}}
 */
export function compileExpression(text, options) {
  const ctx = makeCtx(options);
  const tree = parse(text);
  const out = compileNode(tree, ctx);
  if (ctx.mode === "agg" && !/\b(COUNT|SUM|AVG|MIN|MAX|PERCENTILE_CONT|STDDEV_SAMP|VAR_SAMP|LAG|LEAD)\b/.test(out.sql)) {
    throw new ExprError("A measure needs an aggregation, like Sum([total]) or Count().", 0);
  }
  return { sql: out.sql, kind: out.kind, params: ctx.params };
}

/** The catalog for the editor: no SQL, just what a person reads. */
export function functionDocs() {
  return FUNCTIONS.map((f) => ({
    name: f.name,
    category: f.category,
    signature: f.signature,
    description: f.description,
    example: f.example,
    measureOnly: !!(f.agg || f.aggWrapper),
  }));
}
