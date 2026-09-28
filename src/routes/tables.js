import { Router } from "express";
import * as store from "../lib/tablespaceStore.js";
import { runWriteTransaction } from "../lib/queryEngine.js";
import { buildCreateTable } from "../lib/ddl.js";
import { syncSource } from "../lib/syncSource.js";
import { logger } from "../lib/logger.js";
import { wrap, sendQueryError } from "./http.js";

// Schema changes on a Connected source's own database (Data tab → New table).
// The live database stays the source of truth: the DDL runs there first, then
// the normal sync pulls the result into the source's main branch.
export const tablesRouter = Router();

// Postgres codes a CREATE TABLE commonly fails with, in the user's words.
const DDL_ERRORS = {
  "42P07": [409, "A table with this name already exists in the database."],
  "42501": [403, "The database user this source connects as isn't allowed to create tables."],
  "3F000": [400, "That schema doesn't exist in the database."],
  "42830": [400, "A link must point at a primary key or unique column."],
  "42804": [400, "A link's column type doesn't match the column it points at."],
};

// Foreign keys arrive as ids from the client's schema (never raw names) and are
// resolved against the main branch here, same trust model as the row routes.
function resolveForeignKeys(foreignKeys, nodes, defaultSchema) {
  const out = [];
  for (const fk of Array.isArray(foreignKeys) ? foreignKeys : []) {
    const node = nodes.find((n) => n.type === "tableNode" && n.id === fk?.targetTableId);
    const col = node?.data?.columns?.find((c) => c.id === fk?.targetColumnId);
    if (!node || !col) return { error: `The table linked from "${fk?.column}" wasn't found. Re-sync, then try again.` };
    out.push({
      column: fk.column,
      refSchema: node.data.schema ?? defaultSchema,
      refTable: node.data.label,
      refColumn: col.name,
      onDelete: fk.onDelete,
    });
  }
  return { foreignKeys: out };
}

// POST { table: { schema?, name, columns, foreignKeys }, dryRun? }
//   dryRun -> { sql }                    (the review step: exactly what will run)
//   else   -> { sql, sync: {added, conflicts} | null, syncError? }
tablesRouter.post(
  "/sources/:sourceId/tables",
  wrap(async (req, res) => {
    const { table, dryRun } = req.body || {};
    const secrets = await store.getSourceConnectionSecrets(req.params.sourceId);
    if (!secrets) {
      res.status(400).json({ error: "Connect this source to a database before creating tables." });
      return;
    }
    const branch = await store.getMainBranch(req.params.sourceId);
    const nodes = branch?.nodes || [];
    const schema = table?.schema || secrets.schema || null;

    const fks = resolveForeignKeys(table?.foreignKeys, nodes, schema);
    if (fks.error) {
      res.status(400).json({ error: fks.error });
      return;
    }
    const built = buildCreateTable({ ...table, schema, foreignKeys: fks.foreignKeys });
    if (built.error) {
      res.status(400).json({ error: built.error });
      return;
    }
    const clash = nodes.some(
      (n) =>
        n.type === "tableNode" &&
        String(n.data?.label).toLowerCase() === String(table.name).toLowerCase() &&
        (n.data?.schema ?? secrets.schema ?? null) === schema,
    );
    if (clash) {
      res.status(409).json({ error: `A table named "${table.name}" already exists.` });
      return;
    }
    if (dryRun) {
      res.json({ sql: built.sql });
      return;
    }

    try {
      await runWriteTransaction(secrets.connectionString, (client) => client.query(built.sql));
    } catch (err) {
      const known = DDL_ERRORS[err.code];
      if (known) {
        logger.warn(`[tables] create failed (${err.code})`, err);
        res.status(known[0]).json({ error: known[1] });
        return;
      }
      sendQueryError(res, "create table", err);
      return;
    }

    // The table exists now whatever happens next; a failed sync is reported,
    // not treated as a failed create (the next sync will pick it up).
    try {
      const sync = await syncSource(req.params.sourceId);
      res.status(201).json({ sql: built.sql, sync });
    } catch (err) {
      logger.error("[tables] created, but sync failed", err);
      res.status(201).json({
        sql: built.sql,
        sync: null,
        syncError: "The table was created, but refreshing the schema failed. Use Sync now to pull it in.",
      });
    }
  }),
);
