import { test } from "node:test";
import assert from "node:assert/strict";
import { metricExpression } from "./metric.js";
import { compileExpression } from "./compile.js";

const node = {
  id: "t_o",
  data: {
    columns: [
      { id: "c_total", name: "total", type: "numeric(10,2)" },
      { id: "c_status", name: "status", type: "text" },
      { id: "c_qty", name: "qty", type: "integer" },
    ],
    semanticModel: {
      measures: [
        { id: "m_rev", label: "Revenue", aggregation: "sum", columnId: "c_total" },
        { id: "m_paid", label: "Paid revenue", aggregation: "sum", columnId: "c_total", filters: [{ columnId: "c_status", operator: "eq", value: "paid" }] },
        { id: "m_big", label: "Big orders", aggregation: "count", filters: [{ columnId: "c_qty", operator: "gte", value: "10" }] },
        {
          id: "m_share",
          kind: "calculated",
          tokens: [
            { kind: "value", term: { measureId: "m_paid" } },
            { kind: "op", value: "/" },
            { kind: "value", term: { measureId: "m_rev" } },
          ],
        },
        { id: "m_x", aggregation: "sum", columnId: "c_total", tableId: "t_other" },
      ],
    },
  },
};
const m = (id) => node.data.semanticModel.measures.find((x) => x.id === id);
const column = (name) => {
  const c = node.data.columns.find((x) => x.name === name);
  return c ? { sql: `"t"."${name}"`, kind: c.type.startsWith("text") ? "text" : "number" } : null;
};

test("metrics become formulas that compile as measures", () => {
  assert.equal(metricExpression(m("m_rev"), node), "Sum([total])");
  assert.equal(metricExpression(m("m_paid"), node), 'SumIf([total], [status] = "paid")');
  assert.equal(metricExpression(m("m_big"), node), "CountIf([qty] >= 10)");
  assert.equal(metricExpression(m("m_share"), node), '(SumIf([total], [status] = "paid")) / (Sum([total]))');
  for (const id of ["m_rev", "m_paid", "m_big", "m_share"]) {
    assert.ok(compileExpression(metricExpression(m(id), node), { mode: "agg", column }).sql);
  }
});

test("a metric on another table is refused with a pointer", () => {
  assert.throws(() => metricExpression(m("m_x"), node), /open it as a Metrics report/);
});
