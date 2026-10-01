// Postgres type names for a result column, from the driver's type OID.
// Only the built-in types a report cares about; anything else is "unknown".
const BY_OID = {
  16: "boolean",
  20: "bigint",
  21: "smallint",
  23: "integer",
  26: "oid",
  700: "real",
  701: "double precision",
  790: "money",
  1700: "numeric",
  18: "char",
  19: "name",
  25: "text",
  1042: "character",
  1043: "character varying",
  2950: "uuid",
  1082: "date",
  1083: "time",
  1114: "timestamp",
  1184: "timestamptz",
  1186: "interval",
  114: "json",
  3802: "jsonb",
};

/** @param {{dataTypeID?: number}} field - a `pg` result field */
export function typeOfField(field) {
  return BY_OID[field?.dataTypeID] ?? "unknown";
}
