// Postgres information_schema.columns.data_type -> Tablespace's fixed internal
// vocabulary. Deliberately mirrors FlowDB's own sqlImport/astToSchema.js TYPE_MAP
// (reversed: DB type name -> internal type instead of parsed-SQL keyword -> internal
// type) so a table imported by pasting SQL and the same table imported by connecting
// live produce identical column types, not two subtly different type systems.
const POSTGRES_TYPE_MAP = {
  "character varying": "varchar",
  varchar: "varchar",
  character: "varchar",
  char: "varchar",
  bpchar: "varchar",
  text: "text",
  citext: "text",
  integer: "integer",
  int: "integer",
  int4: "integer",
  smallint: "integer",
  int2: "integer",
  serial: "integer",
  smallserial: "integer",
  bigint: "bigint",
  int8: "bigint",
  bigserial: "bigint",
  boolean: "boolean",
  bool: "boolean",
  date: "date",
  "timestamp without time zone": "timestamp",
  "timestamp with time zone": "timestamp",
  timestamp: "timestamp",
  timestamptz: "timestamp",
  "time without time zone": "timestamp",
  "time with time zone": "timestamp",
  time: "timestamp",
  numeric: "decimal",
  decimal: "decimal",
  real: "decimal",
  float4: "decimal",
  "double precision": "decimal",
  float8: "decimal",
  money: "decimal",
  json: "json",
  jsonb: "json",
  uuid: "uuid",
};

// Tablespace has no first-class "enum" column type yet (DATA_TYPES in
// TableEditSidebar.jsx is a fixed list, and no UI currently lets a column point
// at one of the schema's defined enums) - so a Postgres enum column falls back
// to "text" rather than a type value the rest of the app doesn't know how to
// render or let the user edit. The enum type itself is still captured in the
// `enums` array so the information isn't silently lost, just not wired to the
// column yet.
export function mapPostgresType(dataType) {
  if (!dataType) return "text";
  const normalized = String(dataType).toLowerCase().trim();
  if (normalized === "user-defined" || normalized === "array") return "text";
  return POSTGRES_TYPE_MAP[normalized] || "text";
}
