import { Router } from "express";
import { introspectPostgres } from "../lib/pgIntrospect.js";
import { toTablespaceSchema } from "../lib/toTablespaceSchema.js";
import { describeIntrospectError } from "../lib/introspectErrors.js";

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
    // eslint-disable-next-line no-console
    console.error("[introspect] failed:", err.code || err.message);
    res.status(502).json({ error: describeIntrospectError(err) });
  }
});
