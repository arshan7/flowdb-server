import { test } from "node:test";
import assert from "node:assert/strict";
import { legacyToTokens, parseFormula } from "./formulaExpr.js";

// Resolved leaves used by parseFormula tests - real resolution (resolveTerm
// in tablespace.js) turns a raw term into something queryEngine.js can
// compile; parseFormula doesn't care about that shape, only about kind/
// value/op/paren structure, so a plain marker object is enough here.
function val(label) {
  return { kind: "value", node: { label } };
}
function op(value) {
  return { kind: "op", value };
}
function paren(value) {
  return { kind: "paren", value };
}
// legacyToTokens produces UNRESOLVED tokens (`{kind:"value", term}`) -
// real usage resolves each `term` into a `node` (resolveTerm, in
// tablespace.js) before parseFormula ever sees it. This stub stands in
// for that resolution step so a legacyToTokens->parseFormula test can
// check tree SHAPE without needing a real column/table to resolve
// against - the term object itself becomes the "resolved" leaf.
function resolveStub(tokens) {
  return tokens.map((t) => (t.kind === "value" ? { kind: "value", node: t.term } : t));
}

test("parseFormula: A + B produces a single calculated node", () => {
  const tree = parseFormula([val("A"), op("+"), val("B")]);
  assert.deepEqual(tree, { kind: "calculated", operator: "+", termA: { label: "A" }, termB: { label: "B" } });
});

test("parseFormula: * binds tighter than + (standard precedence, no parens)", () => {
  // A + B * C  ->  A + (B * C)
  const tree = parseFormula([val("A"), op("+"), val("B"), op("*"), val("C")]);
  assert.deepEqual(tree, {
    kind: "calculated",
    operator: "+",
    termA: { label: "A" },
    termB: { kind: "calculated", operator: "*", termA: { label: "B" }, termB: { label: "C" } },
  });
});

test("parseFormula: explicit parens override precedence", () => {
  // (A + B) * C
  const tree = parseFormula([paren("("), val("A"), op("+"), val("B"), paren(")"), op("*"), val("C")]);
  assert.deepEqual(tree, {
    kind: "calculated",
    operator: "*",
    termA: { kind: "calculated", operator: "+", termA: { label: "A" }, termB: { label: "B" } },
    termB: { label: "C" },
  });
});

test("parseFormula: left-to-right chain of same-precedence operators is left-associative", () => {
  // A - B - C  ->  (A - B) - C, not A - (B - C)
  const tree = parseFormula([val("A"), op("-"), val("B"), op("-"), val("C")]);
  assert.deepEqual(tree, {
    kind: "calculated",
    operator: "-",
    termA: { kind: "calculated", operator: "-", termA: { label: "A" }, termB: { label: "B" } },
    termB: { label: "C" },
  });
});

test("parseFormula: nested parens compose correctly", () => {
  // (A - (B * C)) / D
  const tree = parseFormula([
    paren("("), val("A"), op("-"), paren("("), val("B"), op("*"), val("C"), paren(")"), paren(")"), op("/"), val("D"),
  ]);
  assert.deepEqual(tree, {
    kind: "calculated",
    operator: "/",
    termA: {
      kind: "calculated",
      operator: "-",
      termA: { label: "A" },
      termB: { kind: "calculated", operator: "*", termA: { label: "B" }, termB: { label: "C" } },
    },
    termB: { label: "D" },
  });
});

test("parseFormula: a bare single value (no operator) is rejected, not returned as a leaf", () => {
  assert.equal(parseFormula([val("A")]), null);
});

test("parseFormula: empty/non-array input is rejected", () => {
  assert.equal(parseFormula([]), null);
  assert.equal(parseFormula(null), null);
  assert.equal(parseFormula(undefined), null);
});

test("parseFormula: unbalanced parens are rejected", () => {
  assert.equal(parseFormula([paren("("), val("A"), op("+"), val("B")]), null);
  assert.equal(parseFormula([val("A"), op("+"), val("B"), paren(")")]), null);
});

test("parseFormula: two values in a row (missing operator) is rejected", () => {
  assert.equal(parseFormula([val("A"), val("B")]), null);
});

test("parseFormula: two operators in a row is rejected", () => {
  assert.equal(parseFormula([val("A"), op("+"), op("*"), val("B")]), null);
});

test("parseFormula: trailing operator with nothing after it is rejected", () => {
  assert.equal(parseFormula([val("A"), op("+"), val("B"), op("-")]), null);
});

test("parseFormula: empty parens are rejected", () => {
  assert.equal(parseFormula([val("A"), op("+"), paren("("), paren(")")]), null);
});

test("legacyToTokens: a single operator needs no defensive parens", () => {
  const tokens = legacyToTokens({ termA: { label: "A" }, operator: "-", termB: { label: "B" } });
  assert.deepEqual(tokens, [
    { kind: "value", term: { label: "A" } },
    { kind: "op", value: "-" },
    { kind: "value", term: { label: "B" } },
  ]);
});

test("legacyToTokens: 3+ terms fold left-associatively with defensive parens, preserving old left-to-right meaning", () => {
  // Old flat shape "A - B * C" meant strictly (A - B) * C, NOT standard
  // precedence's A - (B*C) - legacyToTokens must produce tokens that
  // parseFormula resolves back to exactly that original grouping.
  const legacy = { terms: [{ label: "A" }, { label: "B" }, { label: "C" }], operators: ["-", "*"] };
  const tokens = legacyToTokens(legacy);
  const tree = parseFormula(resolveStub(tokens));
  assert.deepEqual(tree, {
    kind: "calculated",
    operator: "*",
    termA: { kind: "calculated", operator: "-", termA: { label: "A" }, termB: { label: "B" } },
    termB: { label: "C" },
  });
});

test("legacyToTokens: 4 terms continue folding left-associatively", () => {
  const legacy = {
    terms: [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }],
    operators: ["+", "*", "-"],
  };
  const tree = parseFormula(resolveStub(legacyToTokens(legacy)));
  assert.deepEqual(tree, {
    kind: "calculated",
    operator: "-",
    termA: {
      kind: "calculated",
      operator: "*",
      termA: { kind: "calculated", operator: "+", termA: { label: "A" }, termB: { label: "B" } },
      termB: { label: "C" },
    },
    termB: { label: "D" },
  });
});
