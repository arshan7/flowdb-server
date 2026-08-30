// Bigger formulas - pure token-stream parsing/legacy-migration for a
// calculated measure's formula, kept separate from tablespace.js's route-
// scoped resolution (which still needs `node`/`nodesById` etc. to resolve
// a VALUE token into a real column/table) so this part - real operator
// precedence over an already-resolved token array, and folding an older
// flat term list into that shape - can be unit tested on its own, the
// same way schemaDiff.js/schemaMerge.js already are.

// Folds an older flat term/operator list (`termA`/`operator`/`termB`, or
// the N-ary `terms`/`operators`) into a token stream, defensively
// re-parenthesizing every fold past the first pair. Both older shapes
// always meant strict left-to-right evaluation with no precedence concept
// - reinterpreting the same flat list under real +/- vs */÷ precedence
// could silently change an already-saved measure's computed value (e.g.
// "A - B * C" meant "(A-B)*C" under the old rule, but "A-(B*C)" under real
// precedence), so anything past a single operator gets wrapped in
// explicit parens that pin down the original meaning exactly. A single-
// operator measure (the overwhelming common case) needs no parens at all
// - there's no precedence ambiguity with only one operator. Mirrors
// measureExpr.js's client-side version exactly.
export function legacyToTokens(measure) {
  const rawTerms = measure.terms || [measure.termA, measure.termB];
  const rawOperators = measure.operators || [measure.operator];
  let tokens = [{ kind: "value", term: rawTerms[0] }];
  for (let i = 1; i < rawTerms.length; i++) {
    const valueToken = { kind: "value", term: rawTerms[i] };
    const opToken = { kind: "op", value: rawOperators[i - 1] };
    tokens =
      i === 1
        ? [...tokens, opToken, valueToken]
        : [{ kind: "paren", value: "(" }, ...tokens, { kind: "paren", value: ")" }, opToken, valueToken];
  }
  return tokens;
}

// Recursive-descent parser over an already-resolved token array (`{kind:
// "value", node}` | `{kind:"op", value}` | `{kind:"paren", value}`, where
// `node` is a queryEngine.js-compilable leaf - a raw client id never
// reaches here) - standard grammar, standard precedence:
//   expr    := sum (('&') sum)*        -- '&' = text concat, binds loosest
//   sum     := product (('+'|'-') product)*
//   product := factor (('*'|'/') factor)*
//   factor  := VALUE | '(' expr ')'
// '&' is the lowest-precedence level on purpose: `a + b & c + d` reads as
// `(a+b) & (c+d)` - you're almost always concatenating whole computed
// pieces, not weaving concat into the middle of an arithmetic chain.
// `pos` is a single-element array used as a cursor shared across the
// recursive calls - simplest way to thread "how far have we consumed"
// through mutual recursion without a class.
function parseExpr(tokens, pos) {
  let node = parseSum(tokens, pos);
  if (!node) return null;
  while (tokens[pos[0]]?.kind === "op" && tokens[pos[0]].value === "&") {
    pos[0]++;
    const rhs = parseSum(tokens, pos);
    if (!rhs) return null;
    node = { kind: "calculated", operator: "&", termA: node, termB: rhs };
  }
  return node;
}

function parseSum(tokens, pos) {
  let node = parseProduct(tokens, pos);
  if (!node) return null;
  while (tokens[pos[0]]?.kind === "op" && (tokens[pos[0]].value === "+" || tokens[pos[0]].value === "-")) {
    const operator = tokens[pos[0]++].value;
    const rhs = parseProduct(tokens, pos);
    if (!rhs) return null;
    node = { kind: "calculated", operator, termA: node, termB: rhs };
  }
  return node;
}

function parseProduct(tokens, pos) {
  let node = parseFactor(tokens, pos);
  if (!node) return null;
  while (tokens[pos[0]]?.kind === "op" && (tokens[pos[0]].value === "*" || tokens[pos[0]].value === "/")) {
    const operator = tokens[pos[0]++].value;
    const rhs = parseFactor(tokens, pos);
    if (!rhs) return null;
    node = { kind: "calculated", operator, termA: node, termB: rhs };
  }
  return node;
}

function parseFactor(tokens, pos) {
  const t = tokens[pos[0]];
  if (!t) return null;
  if (t.kind === "paren" && t.value === "(") {
    pos[0]++;
    const inner = parseExpr(tokens, pos);
    if (!inner) return null;
    if (tokens[pos[0]]?.kind !== "paren" || tokens[pos[0]]?.value !== ")") return null;
    pos[0]++;
    return inner;
  }
  if (t.kind === "value") {
    pos[0]++;
    return t.node;
  }
  return null;
}

// Parses a fully-resolved token array into the nested `{kind:"calculated",
// operator, termA, termB}` tree queryEngine.js compiles - null on any
// grammar violation (unbalanced parens, two values in a row, trailing
// garbage, etc.), or if the whole thing collapses to a bare leaf (a
// single-value token list, with no operator at all - a well-formed
// formula always combines 2+ values, so that's rejected here rather than
// letting a bare leaf reach queryEngine.js, which would misread it as a
// non-calculated measure against the wrong table).
export function parseFormula(resolvedTokens) {
  if (!Array.isArray(resolvedTokens) || resolvedTokens.length === 0) return null;
  const pos = [0];
  const tree = parseExpr(resolvedTokens, pos);
  if (!tree || pos[0] !== resolvedTokens.length) return null;
  return tree.kind === "calculated" ? tree : null;
}
