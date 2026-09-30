import { Router } from "express";
import * as store from "../lib/tablespaceStore.js";
import { runWriteTransaction, runQuery } from "../lib/queryEngine.js";
import { buildCreateTable } from "../lib/ddl.js";
import { planAlter, buildAlterStatements } from "../lib/alterTable.js";
import { syncSource } from "../lib/syncSource.js";
import { tableKey } from "../lib/reconcile.js";
import { nanoid } from "nanoid";
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

// Postgres codes an ALTER TABLE commonly fails with, in the user's words.
const ALTER_ERRORS = {
  "22P02": [400, "Some existing values can't be converted to the new type."],
  "22007": [400, "Some existing values aren't valid dates or times."],
  "22003": [400, "Some existing values are too big for the new type."],
  "22001": [400, "Some existing values are longer than the new length."],
  "42804": [400, "Some existing values can't be converted to the new type."],
  "23502": [400, "A required column would have empty values: fill in the empty ones first, or give a new required column a default."],
  "23505": [400, "A column you made unique has duplicate values."],
  "2BP01": [409, "Something else in the database depends on that column (a link, view or index)."],
  "42701": [409, "A column with that name already exists in the database."],
  "42703": [409, "The table changed in the database since the last sync. Sync, then try again."],
  "42501": [403, "The database user this source connects as isn't allowed to change this table."],
  "23503": [400, "Some values have no matching row in the linked table, so a database link can't be added. Fix those values, or keep the link in the app only."],
  "42830": [400, "A link must point at a primary key or unique column."],
  "42P07": [409, "A table with that name already exists in the database."],
};

// Single-column FOREIGN KEY constraint names, for removing a database link.
async function fkConstraintNames(connectionString, schema, table) {
  const rows = await runQuery(
    connectionString,
    `SELECT a.attname AS column_name, con.conname AS name
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = rel.relnamespace
       JOIN pg_attribute a ON a.attrelid = rel.oid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1
        AND ns.nspname = $1 AND rel.relname = $2`,
    [schema || "public", table],
  );
  return Object.fromEntries(rows.map((r) => [r.column_name, r.name]));
}

// A relationship line from a link column to what it references (same shape sync makes).
function linkEdge(tableId, col) {
  const sourceHandle = `${col.references.tableId}-${col.references.columnId}-source`;
  const targetHandle = `${tableId}-${col.id}-target`;
  return {
    id: `e${col.references.tableId}-${tableId}-${nanoid(6)}`,
    source: col.references.tableId,
    target: tableId,
    sourceHandle,
    targetHandle,
    type: "relationship",
    animated: true,
    data: {
      sourceCardinality: "1",
      targetCardinality: "N",
      sourceTableId: col.references.tableId,
      targetTableId: tableId,
      sourceColumnHandle: sourceHandle,
      targetColumnHandle: targetHandle,
      isIdentifying: false,
      label: "",
      virtual: !!col.references.virtual,
    },
  };
}

const linkOf = (c) =>
  c?.isForeignKey && c.references?.tableId
    ? { tableId: c.references.tableId, columnId: c.references.columnId, ...(c.references.virtual && { virtual: true }) }
    : null;
const linkKey = (link) => (link ? `${link.tableId}|${link.columnId}|${!!link.virtual}` : "");

// The branch after an edit: new names, links and lines. The sync that
// follows puts the database's facts on top (matched by name, ids kept).
export function patchBranch(branch, node, columns, newName) {
  const byId = new Map((node.data.columns || []).map((c) => [c.id, c]));
  const nextCols = columns.map((c) => {
    const link = linkOf(c);
    return { ...(byId.get(c.id) || c), name: c.name, isForeignKey: !!link, references: link };
  });
  const keep = new Set(nextCols.filter((c) => linkKey(c.references) === linkKey(linkOf(byId.get(c.id)))).map((c) => c.id));
  const handleOf = (id) => `${node.id}-${id}-target`;
  const edges = (branch.edges || []).filter((e) => {
    if (e.target !== node.id) return true;
    const h = e.data?.targetColumnHandle || e.targetHandle;
    return nextCols.some((c) => keep.has(c.id) && handleOf(c.id) === h);
  });
  for (const c of nextCols) if (!keep.has(c.id) && c.references) edges.push(linkEdge(node.id, c));
  const patched = { ...node, data: { ...node.data, label: newName ?? node.data.label, columns: nextCols } };
  return { ...branch, nodes: branch.nodes.map((n) => (n.id === node.id ? patched : n)), edges };
}

// The sync ledger is keyed by table name; carry a rename across.
export function renameInLedger(ledger, oldKey, newKey) {
  const swap = (sig) =>
    sig
      .split("->")
      .map((side) => (side.startsWith(`${oldKey}.`) ? `${newKey}.${side.slice(oldKey.length + 1)}` : side))
      .join("->");
  return {
    tables: (ledger?.tables || []).map((t) => (t === oldKey ? newKey : t)),
    edges: (ledger?.edges || []).map(swap),
  };
}

// Single-column UNIQUE constraint names, for turning "unique" off.
async function uniqueConstraintNames(connectionString, schema, table) {
  const rows = await runQuery(
    connectionString,
    `SELECT a.attname AS column_name, con.conname AS name
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = rel.relnamespace
       JOIN pg_attribute a ON a.attrelid = rel.oid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'u' AND array_length(con.conkey, 1) = 1
        AND ns.nspname = $1 AND rel.relname = $2`,
    [schema || "public", table],
  );
  return Object.fromEntries(rows.map((r) => [r.column_name, r.name]));
}

// POST { columns, dryRun? } - edit a live (synced) table's columns: the
// designer sends the columns it wants (ids from the main branch); the diff
// runs here. See docs/LIVE_TABLE_EDITS.md.
//   dryRun -> { sql, changes }            (the review step)
//   else   -> { sql, sync | null, syncError? }
tablesRouter.post(
  "/sources/:sourceId/tables/:tableId/alter",
  wrap(async (req, res) => {
    const { columns, name, dryRun } = req.body || {};
    if (!Array.isArray(columns) || columns.some((c) => !c || typeof c.id !== "string")) {
      res.status(400).json({ error: "Send the table's columns." });
      return;
    }
    const secrets = await store.getSourceConnectionSecrets(req.params.sourceId);
    if (!secrets) {
      res.status(400).json({ error: "Connect this source to a database before changing tables." });
      return;
    }
    const branch = await store.getMainBranch(req.params.sourceId);
    const node = (branch?.nodes || []).find((n) => n.type === "tableNode" && n.id === req.params.tableId);
    if (!node) {
      res.status(404).json({ error: "That table wasn't found. Sync, then try again." });
      return;
    }
    if (node.data?.sourceOrigin !== "synced") {
      res.status(400).json({ error: "This table only exists in the design; there's nothing to change in the database." });
      return;
    }
    const schema = node.data.schema ?? secrets.schema ?? null;
    const table = node.data.label;

    const plan = planAlter(node, columns, { nodes: branch.nodes, name });
    if (plan.blocked.length) {
      res.status(400).json({ error: plan.blocked[0], blocked: plan.blocked });
      return;
    }
    if (plan.changes.length === 0 && plan.designOnly.length === 0) {
      res.json({ sql: "", changes: 0, designOnly: [] });
      return;
    }
    let fkConstraints = {};
    if (plan.changes.some((c) => c.op === "dropFk")) {
      try {
        fkConstraints = await fkConstraintNames(secrets.connectionString, schema, table);
      } catch (err) {
        sendQueryError(res, "read constraints", err);
        return;
      }
    }
    let uniqueConstraints = {};
    if (plan.changes.some((c) => c.op === "unique" && !c.unique)) {
      try {
        uniqueConstraints = await uniqueConstraintNames(secrets.connectionString, schema, table);
      } catch (err) {
        sendQueryError(res, "read constraints", err);
        return;
      }
    }
    const built = buildAlterStatements({ schema, table, changes: plan.changes, uniqueConstraints, fkConstraints });
    if (built.error) {
      res.status(400).json({ error: built.error });
      return;
    }
    const sql = built.statements.join("\n");
    if (dryRun) {
      res.json({ sql, changes: plan.changes.length, designOnly: plan.designOnly });
      return;
    }

    try {
      if (built.statements.length) {
        await runWriteTransaction(secrets.connectionString, async (client) => {
          for (const statement of built.statements) await client.query(statement);
        });
      }
    } catch (err) {
      const known = ALTER_ERRORS[err.code];
      if (known) {
        logger.warn(`[tables] alter failed (${err.code})`, err);
        res.status(known[0]).json({ error: known[1], detail: err.message });
        return;
      }
      sendQueryError(res, "change table", err);
      return;
    }

    // Names, links and lines into the design first, so the sync's
    // name-matched refresh keeps every id (and what hangs off it).
    const renamed = plan.changes.find((c) => c.op === "renameTable")?.to;
    try {
      const next = patchBranch(branch, node, columns, renamed);
      await store.saveBranch(req.params.sourceId, branch.id, {
        nodes: next.nodes,
        edges: next.edges,
        enums: branch.enums,
        pages: branch.pages,
        schemaVersion: branch.schemaVersion,
      });
      if (renamed) {
        const ledger = await store.getSourceSyncLedger(req.params.sourceId);
        await store.saveSourceSyncLedger(req.params.sourceId, renameInLedger(ledger, tableKey(schema, table), tableKey(schema, renamed)));
      }
      const sync = await syncSource(req.params.sourceId);
      res.json({ sql, sync });
    } catch (err) {
      logger.error("[tables] altered, but sync failed", err);
      res.json({ sql, sync: null, syncError: "The table was changed, but refreshing the schema failed. Use Sync now to pull it in." });
    }
  }),
);
