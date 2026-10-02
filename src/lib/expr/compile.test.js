import { test } from "node:test";
import assert from "node:assert/strict";
import { compileExpression, FUNCTIONS, functionDocs } from "./compile.js";
import { parse, ExprError } from "./parser.js";

// The columns every catalog example uses, with their kinds.
export const EXAMPLE_COLUMNS = {
  status: "text", total: "number", customer_id: "number", ordered_on: "date", shipped_on: "date",
  email: "text", nickname: "text", name: "text", first_name: "text", last_name: "text", sku: "text",
  phone: "text", url: "text", website: "text", full_name: "text", zip: "text", price_text: "text",
  created_at: "datetime", vip: "bool", balance: "number", price: "number", area: "number",
  growth: "number", views: "number", code: "text", id: "number",
};
const column = (name) => (EXAMPLE_COLUMNS[name] ? { sql: `"t"."${name}"`, kind: EXAMPLE_COLUMNS[name] } : null);
const row = (text) => compileExpression(text, { mode: "row", column });
const measure = (text) => compileExpression(text, { mode: "agg", column, windowOrder: ['"t"."ordered_on"'] });

test("every catalog function compiles from its own example", () => {
  for (const f of FUNCTIONS) {
    const text = f.example.split("  →")[0];
    const out = f.agg || f.aggWrapper ? measure(text) : row(text);
    assert.ok(out.sql.length > 0, f.name);
  }
  assert.ok(FUNCTIONS.length >= 70, `catalog has ${FUNCTIONS.length} functions`);
  assert.equal(functionDocs().length, FUNCTIONS.length);
});

test("parse: precedence, comparison and logic", () => {
  const t = parse('[a] + [b] * 2 > 10 and not [c] = "x"');
  assert.equal(t.op, "and");
  assert.equal(t.l.op, ">");
  assert.equal(t.l.l.r.op, "*");
  assert.equal(t.r.type, "not");
});

test("errors point at the problem", () => {
  const at = (fn) => {
    try {
      fn();
    } catch (e) {
      assert.ok(e instanceof ExprError);
      return [e.message, e.at];
    }
    assert.fail("expected an error");
  };
  assert.deepEqual(at(() => parse("Sum([x]")), ["Expected a closing ) for Sum.", 7]);
  assert.match(at(() => row("[nope] + 1"))[0], /no column called \[nope\]/);
  assert.match(at(() => row("Sum([total])"))[0], /works in a measure/);
  assert.match(at(() => measure("[total] + 1"))[0], /inside an aggregation/);
  assert.match(at(() => measure("Sum(Sum([total]))"))[0], /can't go inside another aggregation/);
  assert.match(at(() => row("Frobnicate(1)"))[0], /no function called Frobnicate/);
  assert.match(at(() => row('DatetimeAdd([ordered_on], 1, "fortnight")'))[0], /unit must be one of/);
  assert.match(at(() => row("[ordered_on] * 2"))[0], /DatetimeAdd/);
});

test("text and numbers are bound, never pasted into the SQL", () => {
  const out = row(`Concat([name], "'; DROP TABLE t; --")`);
  assert.ok(!out.sql.includes("DROP"));
  assert.deepEqual(out.params, ["'; DROP TABLE t; --"]);
});

test("division is decimal, text in math converts only when it looks like a number", () => {
  assert.match(row("[total] / 2").sql, /::float8 \/ NULLIF/);
  const t = row("[price_text] * 2");
  assert.match(t.sql, /CASE WHEN .* ~ \$2 THEN btrim\("t"\."price_text"\)::numeric END/);
});

test("measures: conditional aggregates and window functions", () => {
  assert.match(measure('SumIf([total], [status] = "paid")').sql, /SUM\("t"\."total"\) FILTER \(WHERE/);
  assert.match(measure("CumulativeSum([total])").sql, /SUM\(SUM\("t"\."total"\)\) OVER \(ORDER BY "t"\."ordered_on"\)/);
  assert.match(measure("Offset(Sum([total]), -1)").sql, /LAG\(SUM\("t"\."total"\), 1\) OVER/);
  assert.throws(() => compileExpression("CumulativeCount()", { mode: "agg", column }), /grouped by something/);
  assert.throws(() => measure("1 + 2"), /needs an aggregation/);
});

test("Case picks one result type", () => {
  const out = row('Case([total] > 100, "big", [total] > 10, "mid", "small")');
  assert.equal(out.kind, "text");
  assert.match(out.sql, /^\(CASE WHEN .* THEN .* WHEN .* ELSE .* END\)$/);
});
