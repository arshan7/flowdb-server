// Formula text -> syntax tree. Metabase-style: [column] references, Function(args),
// "text" literals, numbers, True/False/Null, + - * /, = != < <= > >=, and/or/not.
// Errors carry the character position so the editor can point at them.
// The tree is compiled to SQL by compile.js; nothing here touches SQL.

export class ExprError extends Error {
  constructor(message, at = null) {
    super(message);
    this.at = at;
  }
}

const MAX_LENGTH = 4000;
const MAX_DEPTH = 40;

/** @returns {{type: string, value?: unknown, at: number, end: number}[]} */
export function tokenize(text) {
  if (typeof text !== "string") throw new ExprError("A formula must be text.");
  if (text.length > MAX_LENGTH) throw new ExprError(`A formula can be at most ${MAX_LENGTH} characters.`);
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    if (c === "[") {
      const close = text.indexOf("]", i + 1);
      if (close < 0) throw new ExprError("A column name is missing its closing ].", i);
      const name = text.slice(i + 1, close).trim();
      if (!name) throw new ExprError("Empty column name [ ].", i);
      out.push({ type: "col", value: name, at: start, end: close + 1 });
      i = close + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = "";
      while (j < text.length && text[j] !== c) {
        if (text[j] === "\\" && j + 1 < text.length) {
          s += text[j + 1];
          j += 2;
        } else s += text[j++];
      }
      if (j >= text.length) throw new ExprError("Text is missing its closing quote.", i);
      out.push({ type: "str", value: s, at: start, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(text.slice(i));
      if (!m) throw new ExprError(`Unexpected "${c}".`, i);
      out.push({ type: "num", value: Number(m[0]), at: start, end: i + m[0].length });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
      out.push({ type: "ident", value: m[0], at: start, end: i + m[0].length });
      i += m[0].length;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (["<=", ">=", "!=", "<>"].includes(two)) {
      out.push({ type: "op", value: two === "<>" ? "!=" : two, at: start, end: i + 2 });
      i += 2;
      continue;
    }
    if ("+-*/=<>(),&".includes(c)) {
      out.push({ type: c === "(" || c === ")" || c === "," ? c : "op", value: c, at: start, end: i + 1 });
      i++;
      continue;
    }
    throw new ExprError(`Unexpected "${c}".`, i);
  }
  return out;
}

// Precedence, loosest first: or, and, not, comparison, & (join text), + -, * /, unary -.
const COMPARE = new Set(["=", "!=", "<", "<=", ">", ">="]);

/**
 * @returns {object} the tree: {type:"num"|"str"|"bool"|"null"|"col"|"call"|"bin"|"not"|"neg", ...}
 */
export function parse(text) {
  const tokens = tokenize(text);
  if (!tokens.length) throw new ExprError("Write a formula.", 0);
  let pos = 0;
  let depth = 0;
  const peek = () => tokens[pos];
  const isWord = (t, w) => t?.type === "ident" && t.value.toLowerCase() === w;
  const expect = (type, what) => {
    const t = tokens[pos];
    if (t?.type !== type) throw new ExprError(`Expected ${what}.`, t ? t.at : text.length);
    pos++;
    return t;
  };
  const enter = () => {
    if (++depth > MAX_DEPTH) throw new ExprError("This formula is nested too deeply.", peek()?.at ?? 0);
  };

  function orExpr() {
    let l = andExpr();
    while (isWord(peek(), "or")) {
      const at = tokens[pos++].at;
      l = { type: "bin", op: "or", l, r: andExpr(), at };
    }
    return l;
  }
  function andExpr() {
    let l = notExpr();
    while (isWord(peek(), "and")) {
      const at = tokens[pos++].at;
      l = { type: "bin", op: "and", l, r: notExpr(), at };
    }
    return l;
  }
  function notExpr() {
    if (isWord(peek(), "not")) {
      const at = tokens[pos++].at;
      enter();
      const e = { type: "not", e: notExpr(), at };
      depth--;
      return e;
    }
    return compare();
  }
  function compare() {
    let l = concat();
    while (peek()?.type === "op" && COMPARE.has(peek().value)) {
      const t = tokens[pos++];
      l = { type: "bin", op: t.value, l, r: concat(), at: t.at };
    }
    return l;
  }
  function concat() {
    let l = additive();
    while (peek()?.type === "op" && peek().value === "&") {
      const t = tokens[pos++];
      l = { type: "bin", op: "&", l, r: additive(), at: t.at };
    }
    return l;
  }
  function additive() {
    let l = multiplicative();
    while (peek()?.type === "op" && (peek().value === "+" || peek().value === "-")) {
      const t = tokens[pos++];
      l = { type: "bin", op: t.value, l, r: multiplicative(), at: t.at };
    }
    return l;
  }
  function multiplicative() {
    let l = unary();
    while (peek()?.type === "op" && (peek().value === "*" || peek().value === "/")) {
      const t = tokens[pos++];
      l = { type: "bin", op: t.value, l, r: unary(), at: t.at };
    }
    return l;
  }
  function unary() {
    if (peek()?.type === "op" && peek().value === "-") {
      const at = tokens[pos++].at;
      enter();
      const e = { type: "neg", e: unary(), at };
      depth--;
      return e;
    }
    return primary();
  }
  function primary() {
    const t = peek();
    if (!t) throw new ExprError("The formula ends too early.", text.length);
    if (t.type === "num") return pos++, { type: "num", value: t.value, at: t.at };
    if (t.type === "str") return pos++, { type: "str", value: t.value, at: t.at };
    if (t.type === "col") return pos++, { type: "col", name: t.value, at: t.at };
    if (t.type === "(") {
      pos++;
      enter();
      const e = orExpr();
      depth--;
      expect(")", "a closing )");
      return e;
    }
    if (t.type === "ident") {
      const w = t.value.toLowerCase();
      if (w === "true" || w === "false") return pos++, { type: "bool", value: w === "true", at: t.at };
      if (w === "null") return pos++, { type: "null", at: t.at };
      pos++;
      if (peek()?.type !== "(") throw new ExprError(`"${t.value}" needs ( ) after it. Columns go in [brackets].`, t.at);
      pos++;
      enter();
      const args = [];
      if (peek()?.type !== ")") {
        args.push(orExpr());
        while (peek()?.type === ",") {
          pos++;
          args.push(orExpr());
        }
      }
      depth--;
      expect(")", `a closing ) for ${t.value}`);
      return { type: "call", name: t.value, args, at: t.at };
    }
    throw new ExprError(`Unexpected "${t.value ?? t.type}".`, t.at);
  }

  const tree = orExpr();
  if (pos < tokens.length) throw new ExprError(`Unexpected "${tokens[pos].value ?? tokens[pos].type}".`, tokens[pos].at);
  return tree;
}
