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
    return "TLS certificate verification failed unexpectedly - this shouldn't happen with the current SSL handling. Please report this.";
  }
  if (/does not support SSL/i.test(err.message || "")) {
    return "That server doesn't support SSL connections - add ?sslmode=disable to the connection string if this is a local/trusted database.";
  }
  return "Failed to connect to that database.";
}
