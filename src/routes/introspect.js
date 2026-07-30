import { Router } from "express";
import { introspectPostgres } from "../lib/pgIntrospect.js";
import { toTablespaceSchema } from "../lib/toTablespaceSchema.js";

export const introspectRouter = Router();

introspectRouter.post("/introspect", async (req, res) => {
  const { connectionString, schema } = req.body || {};

  if (!connectionString || typeof connectionString !== "string") {
    res.status(400).json({ error: "connectionString is required." });
    return;
  }

  try {
    const raw = await introspectPostgres(connectionString, schema || "public");
    if (raw.tables.length === 0) {
      res.status(404).json({
        error: `No tables found in schema "${schema || "public"}". Check the schema name and that the database isn't empty.`,
      });
      return;
    }
    res.json(toTablespaceSchema(raw));
  } catch (err) {
    // Never echo the connection string back, even inside an error message -
    // it's the one thing in this whole request that must never be logged or
    // reflected, since it carries the DB password.
    const CERT_ERROR_CODES = new Set([
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "CERT_HAS_EXPIRED",
    ]);
    const message =
      err.code === "ENOTFOUND" || err.code === "ECONNREFUSED"
        ? "Could not reach that database host. Check the host/port and that it accepts connections from the internet."
        : err.code === "28P01"
          ? "Authentication failed - check the username and password."
          : err.code === "3D000"
            ? "That database name doesn't exist on this server."
            : err.code === "ETIMEDOUT" || err.code === "CONNECTION_TIMEOUT"
              ? "Connection timed out - the host may be unreachable from this server (check security groups/firewall rules if this is a cloud database)."
              : CERT_ERROR_CODES.has(err.code)
                ? "TLS certificate verification failed unexpectedly - this shouldn't happen with the current SSL handling. Please report this."
                : "Failed to introspect the database.";
    // eslint-disable-next-line no-console
    console.error("[introspect] failed:", err.code || err.message);
    res.status(502).json({ error: message });
  }
});
