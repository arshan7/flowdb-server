// ALTER TABLE for a live (synced) table edited in the designer. Pure: diffs
// the table as the main branch has it against the columns the designer
// wants, then builds the statements. Same safety model as ddl.js - types and
// defaults come from allow-lists, identifiers go through quoteIdent.
// See docs/LIVE_TABLE_EDITS.md.
import { quoteIdent, quoteTable } from "./queryEngine.js";
import { checkName, typeSql, defaultSql } from "./ddl.js";

// The designer's type words -> Postgres (ddl.js COLUMN_TYPES).
const DESIGN_TYPES = {
  varchar: "varchar",
  text: "text",
  integer: "integer",
  bigint: "bigint",
  boolean: "boolean",
  date: "date",
  timestamp: "timestamp",
  decimal: "numeric",
  json: "jsonb",
  uuid: "uuid",
};

const MAX_IDENT = 63;

/** A designer column -> the column shape ddl.js understands. */
export function toPgColumn(col, { withDefault = true } = {}) {
  const type = DESIGN_TYPES[col.type];
  if (!type) return { error: `"${col.name}" has a type that can't be applied to the database (${col.type}).` };
  const p = col.typeParams || {};
  const out = { name: col.name, type };
  if (type === "varchar" && p.length != null && p.length !== "") out.length = Number(p.length);
  if (type === "numeric" && p.precision != null && p.precision !== "") {
    out.precision = Number(p.precision);
    if (p.scale != null && p.scale !== "") out.scale = Number(p.scale);
  }
  if (!withDefault) return { col: { ...out, default: { kind: "none" } } };
  const def = parseDefault(col.default);
  if (def.error) return { error: `"${col.name}": ${def.error}` };
  out.default = def;
  return { col: out };
}

// The designer's default is text: a preset (now(), CURRENT_DATE…), a
// number, true/false, or a plain value (quotes optional).
export function parseDefault(raw) {
  const v = raw == null ? "" : String(raw).trim();
  if (v === "" || /^null$/i.test(v)) return { kind: "none" };
  if (/^(now\(\)|current_timestamp)$/i.test(v)) return { kind: "now" };
  if (/^current_date$/i.test(v)) return { kind: "current_date" };
  if (/^gen_random_uuid\(\)$/i.test(v)) return { kind: "uuid" };
  if (/\(\)$/.test(v)) return { error: `the default ${v} can't be applied to the database; use a plain value or now().` };
  const quoted = v.match(/^'(.*)'$/s);
  const value = quoted ? quoted[1].replace(/''/g, "'") : v;
  if (value === "") return { error: "an empty-text default can't be applied; leave it empty instead." };
  return { kind: "value", value };
}

const sameTypeParams = (a, b) => {
  const x = a || {};
  const y = b || {};
  return (
    String(x.length ?? "") === String(y.length ?? "") &&
    String(x.precision ?? "") === String(y.precision ?? "") &&
    String(x.scale ?? "") === String(y.scale ?? "")
  );
};
const sameDefault = (a, b) => String(a ?? "").trim() === String(b ?? "").trim();
const sameRef = (a, b) =>
  (a?.tableId ?? null) === (b?.tableId ?? null) && (a?.columnId ?? null) === (b?.columnId ?? null);

/**
 * Diffs the stored table against the wanted columns (matched by column id).
 * @returns {{ changes: object[], blocked: string[] }}
 *   changes (by name, in the order they must run):
 *     { op: "drop", name } | { op: "rename", from, to } | { op: "dropDefault", name }
 *     { op: "type", name, col } | { op: "setDefault", name, col } | { op: "notNull", name, notNull }
 *     { op: "unique", name, unique } | { op: "add", id, col, notNull, unique }
 */
export function planAlter(node, wanted) {
  const blocked = [];
  const before = node?.data?.columns || [];
  const byId = new Map(before.map((c) => [c.id, c]));
  const wantedIds = new Set(wanted.map((c) => c.id));
  const names = new Set();
  for (const c of wanted) {
    const err = checkName(c?.name, "A column");
    if (err) {
      blocked.push(err);
      continue;
    }
    const key = c.name.toLowerCase();
    if (names.has(key)) blocked.push(`Two columns are named "${c.name}".`);
    names.add(key);
  }
  if (wanted.length === 0) blocked.push("A table needs at least one column.");

  const drops = [];
  const renames = [];
  const dropDefaults = [];
  const types = [];
  const setDefaults = [];
  const notNulls = [];
  const uniques = [];
  const adds = [];

  for (const old of before) {
    if (!wantedIds.has(old.id)) {
      if (old.isPrimaryKey) blocked.push(`"${old.name}" is the primary key; removing it isn't supported for a live table.`);
      else drops.push({ op: "drop", name: old.name });
    }
  }

  for (const col of wanted) {
    const old = byId.get(col.id);
    if (!old) {
      if (col.isPrimaryKey) blocked.push(`New column "${col.name}" can't be the primary key of a live table.`);
      if (col.isForeignKey || col.references) blocked.push(`Link "${col.name}" after it exists: adding a column with a link isn't supported yet.`);
      const pg = toPgColumn(col);
      if (pg.error) blocked.push(pg.error);
      else adds.push({ op: "add", id: col.id, col: pg.col, notNull: !!col.notNull, unique: !!col.isUnique });
      continue;
    }
    const name = col.name;
    if (old.name !== name) renames.push({ op: "rename", from: old.name, to: name });
    if (!!old.isPrimaryKey !== !!col.isPrimaryKey) {
      blocked.push(`Changing the primary key ("${name}") isn't supported for a live table.`);
    }
    if (!!old.isForeignKey !== !!col.isForeignKey || !sameRef(old.references, col.references)) {
      blocked.push(`Changing the link on "${name}" isn't supported for a live table yet.`);
    }
    const typeChanged = old.type !== col.type || !sameTypeParams(old.typeParams, col.typeParams);
    const defaultChanged = !sameDefault(old.default, col.default);
    if (typeChanged || defaultChanged) {
      const pg = toPgColumn(col, { withDefault: defaultChanged });
      if (pg.error) {
        blocked.push(pg.error);
        continue;
      }
      // Drop the old default first: it may not cast to the new type.
      if (defaultChanged && String(old.default ?? "").trim() !== "") dropDefaults.push({ op: "dropDefault", name });
      if (typeChanged) types.push({ op: "type", name, col: pg.col });
      if (defaultChanged && pg.col.default.kind !== "none") setDefaults.push({ op: "setDefault", name, col: pg.col });
    }
    if (!!old.notNull !== !!col.notNull && !col.isPrimaryKey) notNulls.push({ op: "notNull", name, notNull: !!col.notNull });
    if (!!old.isUnique !== !!col.isUnique && !col.isPrimaryKey) uniques.push({ op: "unique", name, unique: !!col.isUnique });
  }

  return {
    changes: [...drops, ...renames, ...dropDefaults, ...types, ...setDefaults, ...notNulls, ...uniques, ...adds],
    blocked,
  };
}

/**
 * @param {{ schema?: string, table: string, changes: object[], uniqueConstraints?: Record<string, string> }} p
 *   uniqueConstraints: column name -> the name of its single-column UNIQUE constraint (for dropping)
 * @returns {{ statements: string[] } | { error: string }}
 */
export function buildAlterStatements({ schema, table, changes, uniqueConstraints = {} }) {
  const t = `ALTER TABLE ${quoteTable(schema, table)}`;
  const out = [];
  for (const c of changes) {
    switch (c.op) {
      case "drop":
        out.push(`${t} DROP COLUMN ${quoteIdent(c.name)};`);
        break;
      case "rename":
        out.push(`${t} RENAME COLUMN ${quoteIdent(c.from)} TO ${quoteIdent(c.to)};`);
        break;
      case "dropDefault":
        out.push(`${t} ALTER COLUMN ${quoteIdent(c.name)} DROP DEFAULT;`);
        break;
      case "type": {
        const ty = typeSql(c.col);
        if (ty.error) return ty;
        out.push(`${t} ALTER COLUMN ${quoteIdent(c.name)} TYPE ${ty.sql} USING ${quoteIdent(c.name)}::${ty.sql};`);
        break;
      }
      case "setDefault": {
        const d = defaultSql(c.col);
        if (d.error) return d;
        out.push(`${t} ALTER COLUMN ${quoteIdent(c.name)} SET DEFAULT ${d.sql};`);
        break;
      }
      case "notNull":
        out.push(`${t} ALTER COLUMN ${quoteIdent(c.name)} ${c.notNull ? "SET" : "DROP"} NOT NULL;`);
        break;
      case "unique":
        if (c.unique) {
          const cname = `${table}_${c.name}_key`.slice(0, MAX_IDENT);
          out.push(`${t} ADD CONSTRAINT ${quoteIdent(cname)} UNIQUE (${quoteIdent(c.name)});`);
        } else {
          const cname = uniqueConstraints[c.name];
          if (!cname) return { error: `Couldn't find the unique rule on "${c.name}" in the database.` };
          out.push(`${t} DROP CONSTRAINT ${quoteIdent(cname)};`);
        }
        break;
      case "add": {
        const ty = typeSql(c.col);
        if (ty.error) return ty;
        const parts = [`${t} ADD COLUMN ${quoteIdent(c.col.name)} ${ty.sql}`];
        const d = defaultSql(c.col);
        if (d.error) return d;
        if (d.sql) parts.push(`DEFAULT ${d.sql}`);
        if (c.notNull) parts.push("NOT NULL");
        if (c.unique) parts.push("UNIQUE");
        out.push(`${parts.join(" ")};`);
        break;
      }
      default:
        return { error: "Unknown change." };
    }
  }
  return { statements: out };
}
