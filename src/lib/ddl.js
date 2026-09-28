// CREATE TABLE builder for the Data tab's "New table" panel. Pure: takes a
// validated-shape spec, returns SQL or a user-facing error. DDL can't use
// bind parameters, so safety comes from allow-lists: types and default
// expressions come from fixed sets, every identifier goes through quoteIdent,
// and the only free-form values (text defaults) are emitted as escaped string
// literals.
import { quoteIdent, quoteTable } from "./queryEngine.js";

const INTEGER_TYPES = new Set(["smallint", "integer", "bigint"]);

// type -> which size options it takes
export const COLUMN_TYPES = {
  text: {},
  varchar: { length: true },
  smallint: {},
  integer: {},
  bigint: {},
  numeric: { precision: true },
  real: {},
  "double precision": {},
  boolean: {},
  date: {},
  time: {},
  timestamp: {},
  timestamptz: {},
  uuid: {},
  json: {},
  jsonb: {},
  bytea: {},
};

export const DEFAULT_KINDS = new Set(["none", "value", "now", "current_date", "uuid"]);
export const ON_DELETE = { "no action": "NO ACTION", restrict: "RESTRICT", cascade: "CASCADE", "set null": "SET NULL" };

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_IDENT = 63; // Postgres truncates longer identifiers silently
const MAX_COLUMNS = 200;

function checkName(name, what) {
  if (typeof name !== "string" || !name) return `${what} needs a name.`;
  if (name.length > MAX_IDENT) return `${what} "${name.slice(0, 20)}…" is longer than ${MAX_IDENT} characters.`;
  if (!NAME_RE.test(name)) return `${what} "${name}" can only use letters, numbers and _, and can't start with a number.`;
  return null;
}

function typeSql(col) {
  const def = COLUMN_TYPES[col.type];
  if (!def) return { error: `"${col.name}" has an unsupported type.` };
  if (def.length && col.length != null) {
    const n = Number(col.length);
    if (!Number.isInteger(n) || n < 1 || n > 10485760) return { error: `"${col.name}" needs a length between 1 and 10485760.` };
    return { sql: `varchar(${n})` };
  }
  if (def.precision && col.precision != null) {
    const p = Number(col.precision);
    const s = col.scale == null ? 0 : Number(col.scale);
    if (!Number.isInteger(p) || p < 1 || p > 1000 || !Number.isInteger(s) || s < 0 || s > p) {
      return { error: `"${col.name}" needs a precision 1-1000 and a scale between 0 and the precision.` };
    }
    return { sql: `numeric(${p}, ${s})` };
  }
  return { sql: col.type };
}

const quoteLiteral = (v) => `'${String(v).replace(/'/g, "''")}'`;

function defaultSql(col) {
  const d = col.default ?? { kind: "none" };
  if (!DEFAULT_KINDS.has(d.kind)) return { error: `"${col.name}" has an unsupported default.` };
  switch (d.kind) {
    case "none":
      return { sql: null };
    case "now":
      return /^(timestamp|timestamptz|date|time)$/.test(col.type) ? { sql: "now()" } : { error: `"${col.name}": "now" only fits a date or time column.` };
    case "current_date":
      return col.type === "date" ? { sql: "CURRENT_DATE" } : { error: `"${col.name}": "today" only fits a date column.` };
    case "uuid":
      return col.type === "uuid" ? { sql: "gen_random_uuid()" } : { error: `"${col.name}": a random UUID only fits a uuid column.` };
    case "value": {
      const v = d.value;
      if (v == null || v === "") return { error: `"${col.name}" has an empty default value.` };
      if (INTEGER_TYPES.has(col.type)) {
        return /^-?\d+$/.test(String(v)) ? { sql: String(v) } : { error: `"${col.name}" default must be a whole number.` };
      }
      if (/^(numeric|real|double precision)$/.test(col.type)) {
        return /^-?\d+(\.\d+)?$/.test(String(v)) ? { sql: String(v) } : { error: `"${col.name}" default must be a number.` };
      }
      if (col.type === "boolean") {
        const b = String(v).toLowerCase();
        return b === "true" || b === "false" ? { sql: b } : { error: `"${col.name}" default must be true or false.` };
      }
      if (/^(json|jsonb)$/.test(col.type)) {
        try {
          JSON.parse(String(v));
        } catch {
          return { error: `"${col.name}" default isn't valid JSON.` };
        }
      }
      return { sql: `${quoteLiteral(v)}::${typeSql(col).sql}` };
    }
    default:
      return { error: `"${col.name}" has an unsupported default.` };
  }
}

/**
 * @param {object} spec
 * @param {string} [spec.schema]
 * @param {string} spec.name
 * @param {Array<{name, type, length?, precision?, scale?, nullable?, unique?, primaryKey?, identity?, default?}>} spec.columns
 * @param {Array<{column, refSchema, refTable, refColumn, onDelete?}>} [spec.foreignKeys] - already resolved to names
 * @returns {{ sql: string } | { error: string }}
 */
export function buildCreateTable(spec) {
  if (!spec || typeof spec !== "object") return { error: "Missing table definition." };
  const nameErr = checkName(spec.name, "The table");
  if (nameErr) return { error: nameErr };
  if (spec.schema != null) {
    const schemaErr = checkName(spec.schema, "The schema");
    if (schemaErr) return { error: schemaErr };
  }
  const columns = Array.isArray(spec.columns) ? spec.columns : [];
  if (columns.length === 0) return { error: "Add at least one column." };
  if (columns.length > MAX_COLUMNS) return { error: `A table can have at most ${MAX_COLUMNS} columns here.` };

  const seen = new Set();
  const lines = [];
  const pk = [];
  for (const col of columns) {
    const err = checkName(col?.name, "A column");
    if (err) return { error: err };
    const key = col.name.toLowerCase();
    if (seen.has(key)) return { error: `Two columns are named "${col.name}".` };
    seen.add(key);

    const type = typeSql(col);
    if (type.error) return type;
    const parts = [quoteIdent(col.name), type.sql];
    if (col.identity) {
      if (!INTEGER_TYPES.has(col.type)) return { error: `"${col.name}": auto-increment only fits a whole-number column.` };
      if (col.default && col.default.kind !== "none") return { error: `"${col.name}" can't have both auto-increment and a default.` };
      parts.push("GENERATED BY DEFAULT AS IDENTITY");
    } else {
      const def = defaultSql(col);
      if (def.error) return def;
      if (def.sql) parts.push(`DEFAULT ${def.sql}`);
    }
    if (col.primaryKey) pk.push(col.name);
    if (!col.primaryKey && col.nullable === false) parts.push("NOT NULL");
    if (col.unique && !col.primaryKey) parts.push("UNIQUE");
    lines.push(parts.join(" "));
  }

  if (pk.length) {
    lines.push(`CONSTRAINT ${quoteIdent(`${spec.name}_pkey`.slice(0, MAX_IDENT))} PRIMARY KEY (${pk.map(quoteIdent).join(", ")})`);
  }

  for (const fk of spec.foreignKeys || []) {
    if (!seen.has(String(fk?.column || "").toLowerCase())) return { error: `A link uses "${fk?.column}", which isn't a column of this table.` };
    for (const [v, what] of [
      [fk.refTable, "The linked table"],
      [fk.refColumn, "The linked column"],
    ]) {
      if (typeof v !== "string" || !v || v.length > MAX_IDENT) return { error: `${what} is invalid.` };
    }
    const onDelete = ON_DELETE[(fk.onDelete || "no action").toLowerCase()];
    if (!onDelete) return { error: `"${fk.column}" has an unsupported delete rule.` };
    const cname = `${spec.name}_${fk.column}_fkey`.slice(0, MAX_IDENT);
    lines.push(
      `CONSTRAINT ${quoteIdent(cname)} FOREIGN KEY (${quoteIdent(fk.column)}) REFERENCES ${quoteTable(fk.refSchema, fk.refTable)} (${quoteIdent(fk.refColumn)}) ON DELETE ${onDelete}`,
    );
  }

  return { sql: `CREATE TABLE ${quoteTable(spec.schema, spec.name)} (\n  ${lines.join(",\n  ")}\n);` };
}
