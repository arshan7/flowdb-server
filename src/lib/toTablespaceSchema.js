import { nanoid } from "nanoid";
import { mapPostgresType } from "./typeMap.js";

// Postgres reports a column default with a trailing ::type cast almost
// always ("'pending'::character varying", "now()" stays bare) and wraps
// SERIAL/IDENTITY columns in a nextval(...) call - neither is a "default
// value" in the sense the Default value field means (a real value the user
// typed), so nextval() is dropped entirely and the cast/quoting is stripped
// back to the plain value astToSchema.js's own extractDefault would have
// produced from parsing the same DEFAULT clause out of hand-written SQL.
function cleanDefault(raw) {
  if (raw == null) return "";
  const value = String(raw).trim();
  if (/^nextval\(/i.test(value)) return "";
  const withoutCast = value.replace(/::"?[a-zA-Z_ ]+"?(\[\])?$/, "");
  const unquoted = withoutCast.match(/^'(.*)'$/);
  return unquoted ? unquoted[1] : withoutCast;
}

function emptyConstraints() {
  return { primaryKey: [], uniqueConstraints: [], checkConstraints: [], indexes: [] };
}

// Two schemas in one database may each hold a table (or column) of the same
// name, so every internal lookup below is keyed by schema + name, not name
// alone. The NUL separator can't collide with any real identifier. A
// missing schema (older single-schema introspection, hand-drawn nodes)
// folds to "public" so those keep resolving unchanged.
const SEP = "\u0000";
const nodeKey = (schema, table) => `${schema || "public"}${SEP}${table}`;
const colKey = (schema, table, column) => `${schema || "public"}${SEP}${table}${SEP}${column}`;

// Mirrors astToSchema.js's output shape exactly (id/type/position/data with
// columns+constraints, edges with source/target/handles/data, enums with
// id/name/values) so the frontend's existing import handling - and every
// exporter downstream of it - can consume a live-DB introspection with zero
// special-casing versus a pasted-SQL one.
//
// Every table node carries data.schema (the Postgres schema it came from);
// the canvas shows one schema at a time and the reporting data pickers
// group by it. data.label stays the bare table name.
export function toTablespaceSchema(raw) {
  const nodesByKey = new Map();

  raw.tables.forEach((t) => {
    nodesByKey.set(nodeKey(t.table_schema, t.table_name), {
      id: nanoid(),
      type: "tableNode",
      position: { x: 0, y: 0 },
      data: {
        label: t.table_name,
        schema: t.table_schema ?? null,
        description: "",
        color: null,
        isExpanded: true,
        columns: [],
        constraints: emptyConstraints(),
      },
    });
  });

  // Column id lookup keyed by schema+table+column - needed repeatedly below
  // to resolve PK/FK/unique/index rows (which only carry names) back to the
  // actual column objects.
  const columnsByKey = new Map();

  raw.columns.forEach((c) => {
    const node = nodesByKey.get(nodeKey(c.table_schema, c.table_name));
    if (!node) return;

    const type = mapPostgresType(c.data_type);
    let typeParams = null;
    if (type === "varchar" && c.character_maximum_length) {
      typeParams = { length: c.character_maximum_length };
    } else if (type === "decimal" && c.numeric_precision) {
      typeParams = { precision: c.numeric_precision, scale: c.numeric_scale ?? null };
    }

    const column = {
      id: nanoid(),
      name: c.column_name,
      type,
      typeParams,
      default: cleanDefault(c.column_default),
      comment: "",
      isPrimaryKey: false,
      isForeignKey: false,
      references: null,
      notNull: c.is_nullable === "NO",
      isUnique: false,
      isIndex: false,
    };
    node.data.columns.push(column);
    columnsByKey.set(colKey(c.table_schema, c.table_name, c.column_name), { node, column });
  });

  raw.primaryKeys.forEach((pk) => {
    const entry = columnsByKey.get(colKey(pk.table_schema, pk.table_name, pk.column_name));
    if (!entry) return;
    entry.column.isPrimaryKey = true;
    entry.node.data.constraints.primaryKey.push(entry.column.id);
  });

  // Single-column UNIQUE constraints become column.isUnique (matching how a
  // hand-written "column_name TYPE UNIQUE" parses via astToSchema.js);
  // multi-column ones become a named entry in constraints.uniqueConstraints,
  // same split the frontend already makes.
  const uniqueByConstraint = new Map();
  raw.uniqueConstraints.forEach((row) => {
    const key = colKey(row.table_schema, row.table_name, row.constraint_name);
    if (!uniqueByConstraint.has(key)) {
      uniqueByConstraint.set(key, {
        schema: row.table_schema,
        tableName: row.table_name,
        name: row.constraint_name,
        columnNames: [],
      });
    }
    uniqueByConstraint.get(key).columnNames.push(row.column_name);
  });
  uniqueByConstraint.forEach(({ schema, tableName, name, columnNames }) => {
    const node = nodesByKey.get(nodeKey(schema, tableName));
    if (!node) return;
    if (columnNames.length === 1) {
      const entry = columnsByKey.get(colKey(schema, tableName, columnNames[0]));
      if (entry) entry.column.isUnique = true;
      return;
    }
    const columnIds = columnNames
      .map((n) => columnsByKey.get(colKey(schema, tableName, n))?.column.id)
      .filter(Boolean);
    if (columnIds.length) {
      node.data.constraints.uniqueConstraints.push({ id: nanoid(), name, columnIds });
    }
  });

  raw.checkConstraints.forEach((row) => {
    const node = nodesByKey.get(nodeKey(row.table_schema, row.table_name));
    if (!node) return;
    node.data.constraints.checkConstraints.push({
      id: nanoid(),
      name: row.constraint_name,
      expression: row.check_clause,
    });
  });

  // An index whose name matches a unique constraint we already recorded is
  // that constraint's own backing index (Postgres names them identically) -
  // skip it so the same thing doesn't show up twice, once as a constraint
  // and again as an index.
  const uniqueConstraintNames = new Set([...uniqueByConstraint.values()].map((u) => u.name));
  raw.indexes.forEach((row) => {
    if (uniqueConstraintNames.has(row.index_name)) return;
    const node = nodesByKey.get(nodeKey(row.table_schema, row.table_name));
    if (!node) return;
    node.data.constraints.indexes.push({
      id: nanoid(),
      name: row.index_name,
      columnNames: row.column_names.join(", "),
      isUnique: row.is_unique,
    });
  });

  const enums = [];
  const enumsByName = new Map();
  raw.enums.forEach((row) => {
    if (!enumsByName.has(row.enum_name)) {
      const e = { id: nanoid(), name: row.enum_name, values: [] };
      enumsByName.set(row.enum_name, e);
      enums.push(e);
    }
    enumsByName.get(row.enum_name).values.push(row.value);
  });

  // FKs last, once every column on both sides is guaranteed to exist -
  // same two-pass reasoning astToSchema.js uses, just never needing a
  // "pending, not yet resolvable" list since introspection (unlike parsing
  // hand-written SQL) can't reference a table that turns out not to exist.
  // A cross-schema FK resolves here whenever both schemas were part of the
  // introspection set (always true for an all-schemas source).
  const edges = [];
  raw.foreignKeys.forEach((fk) => {
    const child = columnsByKey.get(colKey(fk.from_schema, fk.from_table, fk.from_column));
    const parent = columnsByKey.get(colKey(fk.to_schema, fk.to_table, fk.to_column));
    if (!child || !parent) return;

    child.column.isForeignKey = true;
    child.column.references = { tableId: parent.node.id, columnId: parent.column.id };

    const sourceHandle = `${parent.node.id}-${parent.column.id}-source`;
    const targetHandle = `${child.node.id}-${child.column.id}-target`;

    edges.push({
      id: `e${parent.node.id}-${child.node.id}-${nanoid(6)}`,
      source: parent.node.id,
      target: child.node.id,
      sourceHandle,
      targetHandle,
      type: "relationship",
      animated: true,
      data: {
        sourceCardinality: "1",
        targetCardinality: "N",
        sourceTableId: parent.node.id,
        targetTableId: child.node.id,
        sourceColumnHandle: sourceHandle,
        targetColumnHandle: targetHandle,
        isIdentifying: false,
        label: "",
      },
    });
  });

  return { nodes: Array.from(nodesByKey.values()), edges, enums };
}
