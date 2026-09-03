// Shared by /api/introspect and the Connected-source connect/sync routes -
// both ultimately fail the same way (introspectPostgres throwing a raw pg
// driver error), and a user typing a connection string wrong hits the same
// handful of causes either way.
const CERT_ERROR_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
]);

// Never echoes the connection string back, even inside the message - it's
// the one thing in this whole request that must never be logged or
// reflected, since it carries the DB password.
export function describeIntrospectError(err) {
  if (err.code === "ENOTFOUND" || err.code === "ECONNREFUSED") {
    return "Could not reach that database host. Check the host/port and that it accepts connections from the internet.";
  }
  if (err.code === "28P01") return "Authentication failed - check the username and password.";
  if (err.code === "3D000") return "That database name doesn't exist on this server.";
  if (err.code === "ETIMEDOUT" || err.code === "CONNECTION_TIMEOUT") {
    return "Connection timed out - the host may be unreachable from this server (check security groups/firewall rules if this is a cloud database).";
  }
  if (CERT_ERROR_CODES.has(err.code)) {
    return "Couldn't verify the database's TLS certificate against a trusted CA. If it uses a private or self-signed certificate (Aiven, AWS RDS, self-hosted), use ?sslmode=require - that keeps the connection encrypted without requiring a publicly-trusted CA.";
  }
  if (/does not support SSL/i.test(err.message || "")) {
    return "That server doesn't support SSL connections - add ?sslmode=disable to the connection string if this is a local/trusted database.";
  }
  return "Failed to connect to that database.";
}

// For a query that RAN against an established connection but whose SQL
// failed - almost always the user's model / filter / join has a type
// mismatch, or names something that's since changed on the source. This
// is a different failure from describeIntrospectError's (the connection
// never opening), and must never report itself as "failed to connect".
//
// Postgres *execution* errors don't carry the connection string (that
// only appears in connect-time driver errors), so echoing a trimmed
// err.message is safe here and is usually the single most useful thing -
// it names the exact operator / column at fault.
export function describeQueryError(err) {
  const detail =
    typeof err.message === "string" ? err.message.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  switch (err.code) {
    case "42P01": // undefined_table
    case "42703": // undefined_column
      return {
        status: 409,
        error: `This query references a table or column that no longer exists on the source. Re-sync the source, then try again.${detail ? ` (${detail})` : ""}`,
      };
    case "42883": // undefined_function / "operator does not exist" - a type mismatch
    case "42804": // datatype_mismatch
    case "42P18": // indeterminate_datatype
      return {
        status: 400,
        error: `A comparison, join, or function in this query used incompatible column types.${detail ? ` (${detail})` : ""}`,
      };
    case "22P02": // invalid_text_representation
    case "22003": // numeric_value_out_of_range
    case "22007": // invalid_datetime_format
    case "22008": // datetime_field_overflow
      return {
        status: 400,
        error: `A filter value doesn't match its column's type.${detail ? ` (${detail})` : ""}`,
      };
    case "57014": // query_canceled (statement timeout)
      return { status: 504, error: "The query took too long and was cancelled by the database." };
    case "42601": // syntax_error - the compiler emitted bad SQL; a bug, but not a connection fault
      return { status: 500, error: `The generated SQL was invalid.${detail ? ` (${detail})` : ""}` };
    default:
      return { status: 502, error: "The query could not run against the source database." };
  }
}
