import { Router } from "express";
import * as store from "../lib/tablespaceStore.js";
import { runNativeQuery, runWriteTransaction, paginateRows, quoteTable, quoteIdent, quoteQualified, compileRowIdentityWhere, compileConcurrencyWhere, ALLOWED_PAGE_SIZES, MAX_ROWS, MAX_BULK_WRITE_ROWS } from "../lib/queryEngine.js";
import { previewWhereClause } from "../lib/previewFilters.js";
import { groupOrderClause } from "../lib/groupOrder.js";
import { reverseEntry } from "../lib/auditUndo.js";
import { previewOrderClause } from "../lib/previewOrder.js";
import { wrap, sendQueryError, uid } from "./http.js";
import { dbFillsIn } from "../lib/dbFillsIn.js";

// Data-tab write path - resolves a client-supplied tableId (a branch node
// id, exactly like /preview's own inline lookup - never trusted as a
// literal table name) into everything a write route needs: the real
// schema/table name to target, the set of real column names a proposed
// write may touch, and the introspected primary-key column names (empty
// when the table has none, the ctid-fallback case). Five write routes
// share this rather than each repeating /preview's lookup inline.
const stripCtid = (row) => {
  if (!row) return null;
  const { ctid: _ctid, ...rest } = row;
  return rest;
};
async function resolveWritableTable(sourceId, tableId, secrets) {
  const branch = await store.getMainBranch(sourceId);
  const node = (branch?.nodes || []).find((n) => n.id === tableId && n.type === "tableNode");
  if (!node) return { error: "Table not found.", status: 404 };
  const columns = node.data?.columns || [];
  const columnByName = new Map(columns.map((c) => [c.name, c]));
  const columnById = new Map(columns.map((c) => [c.id, c]));
  const pkColumnIds = node.data?.constraints?.primaryKey || [];
  const pkColumns = pkColumnIds.map((id) => columnById.get(id)).filter(Boolean).map((c) => c.name);
  return {
    label: node.data.label,
    schema: node.data.schema ?? secrets.schema ?? null,
    columnNames: new Map(columns.map((c) => [c.name, c.type])),
    columnByName,
    pkColumns,
  };
}

// A row's identity for a write - the primary key (composite-safe) when the
// table has one, else a ctid the client must have just read from /preview
// or a prior write's response. Shared validation for insert/update/delete/
// duplicate so each route doesn't repeat the same 400 conditions.
function readIdentity(body) {
  if (body && body.ctid) return { ctid: body.ctid };
  if (body && body.pk && typeof body.pk === "object" && Object.keys(body.pk).length > 0) return { pk: body.pk };
  return null;
}

// Heuristic only (toTablespaceSchema's introspected column metadata has no
// "this is an auto-maintained last-modified timestamp" flag) - a naming
// convention, not a guarantee. Used purely to pick the cheaper of the two
// optimistic-concurrency strategies queryEngine's compileConcurrencyWhere
// offers; a wrong guess just means the client didn't send
// expectedUpdatedAt and the full-row expectedValues compare-and-swap is
// used instead, not a correctness problem either way.
const UPDATED_AT_NAMES = new Set(["updated_at", "updatedat", "modified_at", "modifiedat"]);

function detectUpdatedAtColumn(columnByName) {
  for (const [name, col] of columnByName) {
    if (UPDATED_AT_NAMES.has(name.toLowerCase()) && /timestamp|date/i.test(col.type || "")) return name;
  }
  return null;
}

// Data browse - the Σ summary row computed across the WHOLE filtered
// table, not just the loaded page ("Summarize all N matching rows"). Same
// table/column revalidation and filter handling as /column-summary; takes
// a list of { column, agg } and returns one value per column, all from a
// single aggregate query. `agg` is the grid's own vocabulary. A column
// whose agg doesn't fit its type (sum on text, say) comes back null
// rather than failing the whole request.
const TABLE_SUMMARY_AGGS = new Set(["count", "filled", "distinct", "sum", "avg", "min", "max"]);

const TABLE_SUMMARY_MAX_COLUMNS = 200;

// The SQL fragment for one { column, agg }, or null when the aggregate
// doesn't apply to the column's type (Postgres would raise on it). `col`
// is already quoteIdent'd.
function tableSummaryAggSql(agg, col, colType) {
  const t = String(colType || "").toLowerCase();
  const numeric = /int|numeric|decimal|real|double|float|money|serial/.test(t);
  const rangeable = numeric || /date|time/.test(t);
  switch (agg) {
    case "count":
      return "count(*)::bigint";
    case "filled":
      return `count(${col})::bigint`;
    case "distinct":
      return `count(DISTINCT ${col})::bigint`;
    case "sum":
      return numeric ? `sum(${col})::text` : null;
    case "avg":
      return numeric ? `avg(${col})::text` : null;
    case "min":
      return rangeable ? `min(${col})::text` : null;
    case "max":
      return rangeable ? `max(${col})::text` : null;
    default:
      return null;
  }
}

// Data browse - row grouping. One column's distinct values with a
// per-value COUNT(*) across the WHOLE filtered table, so the Data tab's
// group headers can show a real total even though only the loaded page's
// rows are clustered under them (DATA_TAB.md §19). Same table/column
// revalidation and filter handling as /column-summary. Ordered by count so
// the cap keeps the biggest groups; `capped` says whether it was hit.
const GROUP_BY_MAX_GROUPS = 2000;
const GROUP_BY_MAX_AGGREGATES = 10;
const GROUP_BY_AGG_FNS = new Set(["sum", "avg", "min", "max"]);

export const dataRouter = Router();

// Slice 5 - preview a physical table's rows (the "Data" browse layer).
// Read-only, hard row cap. The browse UI (DataBrowseScreen) drives paging
// (`offset`/`pageSize`), a single sort key (`orderBy: {column, direction}`),
// and plain-language row filters (`filters: [{column, operator, value}]`)
// from here. Every column name is re-validated against the modeled node's
// own columns before it reaches the SQL string; filter values bind as
// params via compileFilterCondition (shared with the report engine); and
// runNativeQuery still wraps the whole thing in a READ ONLY txn plus an
// un-removable LIMIT/OFFSET.
dataRouter.post(
  "/sources/:sourceId/preview",
  wrap(async (req, res) => {
    const {
      tableId,
      offset = 0,
      pageSize = 50,
      orderBy = null,
      // An optional second, always-ascending sort key appended after
      // `orderBy`. Purely for determinism: LIMIT/OFFSET paging over a sort
      // key with ties has no defined row order, so pages can repeat or skip
      // rows. The Data tab's grouped view sorts by the group column - where
      // every row inside a group ties - and passes the primary key here.
      orderTiebreak = null,
      filters = [],
      filterGroup = null,
      withCount = false,
    } = req.body || {};
    if (!tableId) {
      res.status(400).json({ error: "tableId is required." });
      return;
    }
    if (!ALLOWED_PAGE_SIZES.includes(pageSize)) {
      res.status(400).json({ error: `pageSize must be one of ${ALLOWED_PAGE_SIZES.join(", ")}.` });
      return;
    }
    if (!Number.isInteger(offset) || offset < 0 || offset + pageSize > MAX_ROWS) {
      res.status(400).json({ error: `offset must be a non-negative integer, and offset + pageSize can't exceed ${MAX_ROWS}.` });
      return;
    }
    if (!Array.isArray(filters)) {
      res.status(400).json({ error: "filters must be an array." });
      return;
    }
    const secrets = await store.getSourceConnectionSecrets(req.params.sourceId);
    if (!secrets) {
      res.status(400).json({ error: "This source isn't connected." });
      return;
    }
    const branch = await store.getMainBranch(req.params.sourceId);
    const node = (branch?.nodes || []).find((n) => n.id === tableId && n.type === "tableNode");
    if (!node) {
      res.status(404).json({ error: "Table not found." });
      return;
    }

    // A client-named column never reaches the SQL: only a column the
    // modeled table actually has can be sorted or filtered on. `label` is
    // the FROM range-table name - compileFilterCondition qualifies as
    // "label"."col", which binds to it whatever schema the FROM used.
    const columnNames = new Map((node.data?.columns || []).map((c) => [c.name, c.type]));
    const label = node.data.label;
    const params = [];
    const wc = previewWhereClause(filterGroup, filters, columnNames, label, params);
    if (wc.error) {
      res.status(400).json({ error: wc.error });
      return;
    }

    const order = previewOrderClause({
      orderBy,
      orderTiebreak,
      columnNames,
      pkNames: (node.data?.columns || []).filter((c) => c.isPrimaryKey).map((c) => c.name),
    });
    if (order.error) {
      res.status(400).json({ error: order.error });
      return;
    }
    const orderClause = order.clause;

    try {
      // node.data.schema is authoritative; fall back to the source's pinned
      // connection_schema for a single-schema source whose nodes predate
      // schema tagging (a resync back-fills them - see reconcile.js).
      const from = quoteTable(node.data.schema ?? secrets.schema ?? null, label);
      const whereClause = wc.clause;
      // Data-tab write path - `ctid` rides along on every preview fetch so
      // a row loaded here can be targeted for edit/delete even when the
      // table has no primary key (see queryEngine's compileRowIdentityWhere
      // and this file's resolveWritableTable). Filtered back out of the
      // `columns` list below so it never renders as a real grid column -
      // Postgres reserves the name, so no real column can collide with it.
      const inner = `SELECT *, ctid::text AS ctid FROM ${from}${whereClause}${orderClause}`;
      const out = await runNativeQuery(secrets.connectionString, inner, params, { offset, pageSize });
      const { rows, hasMore } = paginateRows(out.rows, pageSize);

      // Opt-in exact total for the "showing 1-50 of N" pager. A COUNT(*) can
      // be its own expensive query on a big table, so it's off by default
      // and its failure (statement timeout, etc.) is swallowed to null -
      // the UI just falls back to "of many".
      let total = null;
      if (withCount) {
        try {
          const countRes = await runNativeQuery(
            secrets.connectionString,
            `SELECT count(*)::bigint AS n FROM ${from}${whereClause}`,
            params,
            { offset: 0, pageSize: 1 },
          );
          const n = countRes.rows?.[0]?.n;
          total = n == null ? null : Number(n);
        } catch {
          total = null;
        }
      }

      res.json({
        columns: (out.fields || []).filter((f) => f.name !== "ctid").map((f) => ({ id: f.name, label: f.name })),
        rows,
        hasMore,
        total,
      });
    } catch (err) {
      sendQueryError(res, "preview", err);
    }
  }),
);

// ===========================================================================
// Data-tab write path (Phase 1). Every route below actually writes to the
// connected source's own database - the first such routes in this file,
// which until now was 100% read-only. Direct-write model: an edit commits
// as soon as the request lands (no separate review/approval step), guarded
// by: real column validation before the SQL is built, a real READ WRITE
// transaction with its own (shorter) timeout, letting Postgres's own
// constraint enforcement be the source of truth for CHECK/FK/UNIQUE
// (translated into a good error by describeQueryError rather than
// speculatively pre-checked), and an audit-log row in FlowDB's OWN
// database after every successful commit. See resolveWritableTable/
// readIdentity/detectUpdatedAtColumn above for the shared pieces.
// ===========================================================================

// Insert one row.
dataRouter.post(
  "/sources/:sourceId/rows",
  wrap(async (req, res) => {
    const { tableId, values } = req.body || {};
    if (!tableId) {
      res.status(400).json({ error: "tableId is required." });
      return;
    }
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      res.status(400).json({ error: "values must be an object." });
      return;
    }
    const secrets = await store.getSourceConnectionSecrets(req.params.sourceId);
    if (!secrets) {
      res.status(400).json({ error: "This source isn't connected." });
      return;
    }
    const table = await resolveWritableTable(req.params.sourceId, tableId, secrets);
    if (table.error) {
      res.status(table.status).json({ error: table.error });
      return;
    }
    const keys = Object.keys(values);
    for (const k of keys) {
      if (!table.columnNames.has(k)) {
        res.status(400).json({ error: `"${k}" isn't a column of this table.` });
        return;
      }
    }
    // Cheap, unambiguous pre-checks only (NOT NULL with no default) - type/
    // CHECK/FK/UNIQUE are left to Postgres itself, then translated (see the
    // block comment above).
    const missing = [...table.columnByName.values()]
      .filter((col) => col.notNull && !dbFillsIn(col) && !(Object.prototype.hasOwnProperty.call(values, col.name) && values[col.name] !== null))
      .map((col) => col.name);
    if (missing.length) {
      res.status(400).json({ error: `${missing.map((m) => `"${m}"`).join(", ")} can't be empty.` });
      return;
    }

    const from = quoteTable(table.schema, table.label);
    const params = [];
    const idents = keys.map((k) => quoteIdent(k));
    const placeholders = keys.map((k) => {
      params.push(values[k]);
      return `$${params.length}`;
    });
    const sql = keys.length
      ? `INSERT INTO ${from} (${idents.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *, ctid::text AS ctid`
      : `INSERT INTO ${from} DEFAULT VALUES RETURNING *, ctid::text AS ctid`;

    try {
      const result = await runWriteTransaction(secrets.connectionString, (client) => client.query(sql, params));
      const row = result.rows[0];
      const identity = table.pkColumns.length
        ? { pk: Object.fromEntries(table.pkColumns.map((c) => [c, row[c]])) }
        : { ctid: row.ctid };
      const audit = await store.insertAuditLog(req.params.sourceId, {
        ownerUserId: uid(req),
        tableId,
        tableSchema: table.schema,
        tableName: table.label,
        operation: "insert",
        rowIdentity: identity,
        before: null,
        after: row,
      });
      res.status(201).json({ row, auditIds: [Number(audit.id)] });
    } catch (err) {
      sendQueryError(res, "insert row", err);
    }
  }),
);

// Update one row (single- or multi-cell - just more keys in `values`).
// Optimistic concurrency: pass `expectedUpdatedAt` if the table has a
// last-modified column, else `expectedValues` (every column value the
// client last saw) for a full-row compare-and-swap. A 0-row result is the
// conflict signal - re-checked to tell "someone else changed it" (409, with
// the row's current state) apart from "it's gone" (404).
dataRouter.patch(
  "/sources/:sourceId/rows",
  wrap(async (req, res) => {
    const { tableId, values, expectedUpdatedAt, expectedValues } = req.body || {};
    const identity = readIdentity(req.body || {});
    if (!tableId) {
      res.status(400).json({ error: "tableId is required." });
      return;
    }
    if (!identity) {
      res.status(400).json({ error: "A row's primary key or ctid is required." });
      return;
    }
    if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).length === 0) {
      res.status(400).json({ error: "values must be a non-empty object." });
      return;
    }
    const secrets = await store.getSourceConnectionSecrets(req.params.sourceId);
    if (!secrets) {
      res.status(400).json({ error: "This source isn't connected." });
      return;
    }
    const table = await resolveWritableTable(req.params.sourceId, tableId, secrets);
    if (table.error) {
      res.status(table.status).json({ error: table.error });
      return;
    }
    for (const k of Object.keys(values)) {
      if (!table.columnNames.has(k)) {
        res.status(400).json({ error: `"${k}" isn't a column of this table.` });
        return;
      }
    }

    const from = quoteTable(table.schema, table.label);
    const updatedAtColumn = detectUpdatedAtColumn(table.columnByName);

    try {
      const outcome = await runWriteTransaction(secrets.connectionString, async (client) => {
        const beforeParams = [];
        const beforeWhere = compileRowIdentityWhere(table.label, identity, beforeParams);
        const beforeRes = await client.query(`SELECT *, ctid::text AS ctid FROM ${from} WHERE ${beforeWhere}`, beforeParams);
        const before = beforeRes.rows[0] || null;

        const params = [];
        const setParts = Object.entries(values).map(([k, v]) => {
          params.push(v);
          return `${quoteIdent(k)} = $${params.length}`;
        });
        const idWhere = compileRowIdentityWhere(table.label, identity, params);
        const concurrencyParts = compileConcurrencyWhere(table.label, { updatedAtColumn, expectedUpdatedAt, expectedValues }, params);
        const whereClause = [idWhere, ...concurrencyParts].join(" AND ");
        const updateRes = await client.query(
          `UPDATE ${from} SET ${setParts.join(", ")} WHERE ${whereClause} RETURNING *, ctid::text AS ctid`,
          params,
        );
        return { before, row: updateRes.rows[0] || null, matched: updateRes.rowCount > 0 };
      });

      if (!outcome.matched) {
        if (!outcome.before) {
          res.status(404).json({ error: "This row no longer exists." });
        } else {
          res.status(409).json({ error: "Someone else changed this row.", current: outcome.before });
        }
        return;
      }
      const audit = await store.insertAuditLog(req.params.sourceId, {
        ownerUserId: uid(req),
        tableId,
        tableSchema: table.schema,
        tableName: table.label,
        operation: "update",
        rowIdentity: identity,
        before: outcome.before,
        after: outcome.row,
      });
      res.json({ row: outcome.row, auditIds: [Number(audit.id)] });
    } catch (err) {
      sendQueryError(res, "update row", err);
    }
  }),
);

// Bulk update - same value(s) applied to every row matching a filter
// (distinct from PATCH /rows above, which targets one specific row by
// identity). Requires at least one filter (never the whole table) and a
// pre-check against MAX_BULK_WRITE_ROWS before the actual UPDATE runs.
// Doesn't capture a per-row "before" snapshot (a pre-read of a
// potentially-large matched set is real added cost for a bulk operation) -
// audit rows record the after-state only; single-row PATCH above is the
// path that gets full before/after.
dataRouter.patch(
  "/sources/:sourceId/rows/bulk",
  wrap(async (req, res) => {
    const { tableId, values, filters = [], filterGroup = null } = req.body || {};
    if (!tableId) {
      res.status(400).json({ error: "tableId is required." });
      return;
    }
    if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).length === 0) {
      res.status(400).json({ error: "values must be a non-empty object." });
      return;
    }
    if (!Array.isArray(filters)) {
      res.status(400).json({ error: "filters must be an array." });
      return;
    }
    const secrets = await store.getSourceConnectionSecrets(req.params.sourceId);
    if (!secrets) {
      res.status(400).json({ error: "This source isn't connected." });
      return;
    }
    const table = await resolveWritableTable(req.params.sourceId, tableId, secrets);
    if (table.error) {
      res.status(table.status).json({ error: table.error });
      return;
    }
    for (const k of Object.keys(values)) {
      if (!table.columnNames.has(k)) {
        res.status(400).json({ error: `"${k}" isn't a column of this table.` });
        return;
      }
    }

    const from = quoteTable(table.schema, table.label);
    const countParams = [];
    const countWc = previewWhereClause(filterGroup, filters, table.columnNames, table.label, countParams);
    if (countWc.error) {
      res.status(400).json({ error: countWc.error });
      return;
    }
    if (!countWc.clause) {
      res.status(400).json({ error: "A bulk update needs at least one filter - it can't target the whole table." });
      return;
    }

    try {
      const countRes = await runNativeQuery(
        secrets.connectionString,
        `SELECT count(*)::bigint AS n FROM ${from}${countWc.clause}`,
        countParams,
        { offset: 0, pageSize: 1 },
      );
      const affected = Number(countRes.rows?.[0]?.n ?? 0);
      if (affected > MAX_BULK_WRITE_ROWS) {
        res.status(400).json({
          error: `This would update ${affected} rows, which is more than the ${MAX_BULK_WRITE_ROWS}-row bulk-write limit. Narrow the filter first.`,
        });
        return;
      }
      if (affected === 0) {
        res.json({ updatedCount: 0 });
        return;
      }

      const updateParams = [];
      const setParts = Object.entries(values).map(([k, v]) => {
        updateParams.push(v);
        return `${quoteIdent(k)} = $${updateParams.length}`;
      });
      const updateWc = previewWhereClause(filterGroup, filters, table.columnNames, table.label, updateParams);
      if (updateWc.error) {
        res.status(400).json({ error: updateWc.error });
        return;
      }
      // Read the rows first (locked), so each audit entry keeps its before-state
      // and the change can be undone.
      const result = await runWriteTransaction(secrets.connectionString, async (client) => {
        const old = await client.query(
          `SELECT *, ctid::text AS ctid FROM ${from}${countWc.clause} FOR UPDATE`,
          countParams,
        );
        const updated = await client.query(
          `UPDATE ${from} SET ${setParts.join(", ")}${updateWc.clause} RETURNING *, ctid::text AS ctid`,
          updateParams,
        );
        return { old: old.rows, rows: updated.rows };
      });
      const keyOf = (row) =>
        table.pkColumns.length ? JSON.stringify(table.pkColumns.map((c) => row[c])) : row.ctid;
      const beforeByKey = new Map(result.old.map((r) => [keyOf(r), r]));
      const auditIds = await store.insertAuditLogs(
        req.params.sourceId,
        result.rows.map((row) => ({
          ownerUserId: uid(req),
          tableId,
          tableSchema: table.schema,
          tableName: table.label,
          operation: "update",
          rowIdentity: table.pkColumns.length
            ? { pk: Object.fromEntries(table.pkColumns.map((c) => [c, row[c]])) }
            : { ctid: row.ctid },
          before: stripCtid(beforeByKey.get(keyOf(row))),
          after: row,
        })),
      );
      res.json({ updatedCount: result.rows.length, auditIds });
    } catch (err) {
      sendQueryError(res, "bulk update rows", err);
    }
  }),
);

// Delete one or more rows - a single-row delete is just a 1-element array,
// no separate route needed.
dataRouter.delete(
  "/sources/:sourceId/rows",
  wrap(async (req, res) => {
    const { tableId, identities } = req.body || {};
    if (!tableId) {
      res.status(400).json({ error: "tableId is required." });
      return;
    }
    if (!Array.isArray(identities) || identities.length === 0) {
      res.status(400).json({ error: "identities must be a non-empty array." });
      return;
    }
    if (identities.length > MAX_BULK_WRITE_ROWS) {
      res.status(400).json({ error: `Can't delete more than ${MAX_BULK_WRITE_ROWS} rows in one request.` });
      return;
    }
    const secrets = await store.getSourceConnectionSecrets(req.params.sourceId);
    if (!secrets) {
      res.status(400).json({ error: "This source isn't connected." });
      return;
    }
    const table = await resolveWritableTable(req.params.sourceId, tableId, secrets);
    if (table.error) {
      res.status(table.status).json({ error: table.error });
      return;
    }

    const from = quoteTable(table.schema, table.label);
    const params = [];
    let clauses;
    try {
      clauses = identities.map((identity) => `(${compileRowIdentityWhere(table.label, identity, params)})`);
    } catch (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    const sql = `DELETE FROM ${from} WHERE ${clauses.join(" OR ")} RETURNING *, ctid::text AS ctid`;

    try {
      const result = await runWriteTransaction(secrets.connectionString, (client) => client.query(sql, params));
      const auditIds = await store.insertAuditLogs(
        req.params.sourceId,
        result.rows.map((row) => ({
          ownerUserId: uid(req),
          tableId,
          tableSchema: table.schema,
          tableName: table.label,
          operation: "delete",
          rowIdentity: table.pkColumns.length
            ? { pk: Object.fromEntries(table.pkColumns.map((c) => [c, row[c]])) }
            : { ctid: row.ctid },
          before: row,
          after: null,
        })),
      );
      res.json({ deletedCount: result.rows.length, auditIds });
    } catch (err) {
      sendQueryError(res, "delete rows", err);
    }
  }),
);

// Delete every row a filter matches ("select all N matching" -> Delete). Like
// the bulk update: a filter is required and the row count is capped; the
// count and the delete run in one transaction. Audit rows keep each deleted
// row, so undo can put them back.
dataRouter.post(
  "/sources/:sourceId/rows/bulk-delete",
  wrap(async (req, res) => {
    const { tableId, filters = [], filterGroup = null } = req.body || {};
    if (!tableId) {
      res.status(400).json({ error: "tableId is required." });
      return;
    }
    if (!Array.isArray(filters)) {
      res.status(400).json({ error: "filters must be an array." });
      return;
    }
    const secrets = await store.getSourceConnectionSecrets(req.params.sourceId);
    if (!secrets) {
      res.status(400).json({ error: "This source isn't connected." });
      return;
    }
    const table = await resolveWritableTable(req.params.sourceId, tableId, secrets);
    if (table.error) {
      res.status(table.status).json({ error: table.error });
      return;
    }
    const params = [];
    const wc = previewWhereClause(filterGroup, filters, table.columnNames, table.label, params);
    if (wc.error) {
      res.status(400).json({ error: wc.error });
      return;
    }
    if (!wc.clause) {
      res.status(400).json({ error: "A bulk delete needs at least one filter - it can't target the whole table." });
      return;
    }
    const from = quoteTable(table.schema, table.label);
    try {
      const result = await runWriteTransaction(secrets.connectionString, async (client) => {
        const counted = await client.query(`SELECT count(*)::bigint AS n FROM ${from}${wc.clause}`, params);
        const n = Number(counted.rows?.[0]?.n ?? 0);
        if (n > MAX_BULK_WRITE_ROWS) {
          const err = new Error(
            `This would delete ${n} rows, which is more than the ${MAX_BULK_WRITE_ROWS}-row bulk-write limit. Narrow the filter first.`,
          );
          err.isLimit = true;
          throw err;
        }
        return client.query(`DELETE FROM ${from}${wc.clause} RETURNING *, ctid::text AS ctid`, params);
      });
      const auditIds = await store.insertAuditLogs(
        req.params.sourceId,
        result.rows.map((row) => ({
          ownerUserId: uid(req),
          tableId,
          tableSchema: table.schema,
          tableName: table.label,
          operation: "delete",
          rowIdentity: table.pkColumns.length
            ? { pk: Object.fromEntries(table.pkColumns.map((c) => [c, row[c]])) }
            : { ctid: row.ctid },
          before: row,
          after: null,
        })),
      );
      res.json({ deletedCount: result.rows.length, auditIds });
    } catch (err) {
      if (err.isLimit) {
        res.status(400).json({ error: err.message });
        return;
      }
      sendQueryError(res, "bulk delete rows", err);
    }
  }),
);

// Duplicate one row. `overrides` supplies any column that must differ from
// the source row (e.g. a UNIQUE column, or a non-serial primary key -
// omitted PK columns are left out of the INSERT so Postgres can
// serial/identity-generate a fresh one; a non-auto PK with no override
// will surface a clean 23502/23505 translation rather than succeed).
dataRouter.post(
  "/sources/:sourceId/rows/duplicate",
  wrap(async (req, res) => {
    const { tableId, overrides = {} } = req.body || {};
    const identity = readIdentity(req.body || {});
    if (!tableId) {
      res.status(400).json({ error: "tableId is required." });
      return;
    }
    if (!identity) {
      res.status(400).json({ error: "A row's primary key or ctid is required." });
      return;
    }
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
      res.status(400).json({ error: "overrides must be an object." });
      return;
    }
    const secrets = await store.getSourceConnectionSecrets(req.params.sourceId);
    if (!secrets) {
      res.status(400).json({ error: "This source isn't connected." });
      return;
    }
    const table = await resolveWritableTable(req.params.sourceId, tableId, secrets);
    if (table.error) {
      res.status(table.status).json({ error: table.error });
      return;
    }
    for (const k of Object.keys(overrides)) {
      if (!table.columnNames.has(k)) {
        res.status(400).json({ error: `"${k}" isn't a column of this table.` });
        return;
      }
    }

    const pkSet = new Set(table.pkColumns);
    const cols = [...table.columnNames].filter((name) => !pkSet.has(name) || Object.prototype.hasOwnProperty.call(overrides, name));
    const from = quoteTable(table.schema, table.label);
    const params = [];
    const selectExprs = cols.map((c) => {
      if (Object.prototype.hasOwnProperty.call(overrides, c)) {
        params.push(overrides[c]);
        return `$${params.length}`;
      }
      return quoteQualified(table.label, c);
    });
    const whereClause = compileRowIdentityWhere(table.label, identity, params);
    const sql =
      `INSERT INTO ${from} (${cols.map((c) => quoteIdent(c)).join(", ")}) ` +
      `SELECT ${selectExprs.join(", ")} FROM ${from} WHERE ${whereClause} RETURNING *, ctid::text AS ctid`;

    try {
      const result = await runWriteTransaction(secrets.connectionString, (client) => client.query(sql, params));
      if (result.rowCount === 0) {
        res.status(404).json({ error: "The row to duplicate no longer exists." });
        return;
      }
      const row = result.rows[0];
      const audit = await store.insertAuditLog(req.params.sourceId, {
        ownerUserId: uid(req),
        tableId,
        tableSchema: table.schema,
        tableName: table.label,
        operation: "insert",
        rowIdentity: table.pkColumns.length
          ? { pk: Object.fromEntries(table.pkColumns.map((c) => [c, row[c]])) }
          : { ctid: row.ctid },
        before: null,
        after: row,
      });
      res.status(201).json({ row, auditIds: [Number(audit.id)] });
    } catch (err) {
      sendQueryError(res, "duplicate row", err);
    }
  }),
);

// Audit history for one table (HIST-01/02) - newest first, from FlowDB's
// own database (never the connected source).
dataRouter.get(
  "/sources/:sourceId/audit-log",
  wrap(async (req, res) => {
    const { tableId = null, limit = 200 } = req.query || {};
    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);
    const rows = await store.listAuditLog(req.params.sourceId, { tableId: tableId || null, limit: parsedLimit });
    res.json({ entries: rows });
  }),
);

// Undo audit-log entries (REC-07): each is replayed in reverse (lib/auditUndo.js)
// and the reverse write is logged too, so undoing an undo is a redo. The
// response carries the new entries' ids - what the client undoes next time.
async function undoEntries(req, res, ids) {
  const entries = await store.getAuditLogEntries(req.params.sourceId, ids);
  if (entries.length !== ids.length) {
    res.status(404).json({ error: "Some of those changes aren't in the history any more." });
    return;
  }
  const secrets = await store.getSourceConnectionSecrets(req.params.sourceId);
  if (!secrets) {
    res.status(400).json({ error: "This source isn't connected." });
    return;
  }
  const tables = new Map();
  for (const e of entries) {
    if (tables.has(e.tableId)) continue;
    const t = await resolveWritableTable(req.params.sourceId, e.tableId, secrets);
    if (t.error) {
      res.status(t.status).json({ error: t.error });
      return;
    }
    tables.set(e.tableId, { ...t, from: quoteTable(t.schema, t.label) });
  }
  try {
    // Newest first, all or nothing.
    const records = await runWriteTransaction(secrets.connectionString, async (client) => {
      const out = [];
      for (const e of entries) {
        const t = tables.get(e.tableId);
        out.push(await reverseEntry(client, e, t, t.from));
      }
      return out;
    });
    const auditIds = await store.insertAuditLogs(
      req.params.sourceId,
      records.map(({ row: _row, ...r }) => ({ ...r, ownerUserId: uid(req) })),
    );
    res.status(201).json({
      undone: records.length,
      auditIds,
      rows: records.map((r) => ({ operation: r.operation, rowIdentity: r.rowIdentity, row: r.row })),
    });
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    sendQueryError(res, "undo", err);
  }
}

dataRouter.post(
  "/sources/:sourceId/audit-log/:auditId/undo",
  wrap(async (req, res) => {
    const id = Number(req.params.auditId);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid audit entry id." });
      return;
    }
    await undoEntries(req, res, [id]);
  }),
);

dataRouter.post(
  "/sources/:sourceId/audit-log/undo",
  wrap(async (req, res) => {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BULK_WRITE_ROWS || !ids.every(Number.isInteger)) {
      res.status(400).json({ error: `ids must be 1 to ${MAX_BULK_WRITE_ROWS} audit entry ids.` });
      return;
    }
    await undoEntries(req, res, ids);
  }),
);

// Data browse - approximate row count for every table in a connected
// source, from one cheap system-catalog read (pg_class.reltuples is the
// planner's own estimate; no table scan). Keyed by modeled node id, for
// the "12k rows" hint on the table index. A never-analyzed table reads as
// a negative reltuples in pg_class; that comes back as null (unknown),
// never a misleading 0.
dataRouter.get(
  "/sources/:sourceId/table-counts",
  wrap(async (req, res) => {
    const secrets = await store.getSourceConnectionSecrets(req.params.sourceId);
    if (!secrets) {
      res.status(400).json({ error: "This source isn't connected." });
      return;
    }
    const branch = await store.getMainBranch(req.params.sourceId);
    const nodes = (branch?.nodes || []).filter((n) => n.type === "tableNode");
    if (nodes.length === 0) {
      res.json({ counts: {} });
      return;
    }
    try {
      const out = await runNativeQuery(
        secrets.connectionString,
        `SELECT n.nspname AS schema, c.relname AS name, c.reltuples::bigint AS est
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p', 'm', 'f')
            AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
        [],
        { offset: 0, pageSize: 20000 },
      );
      const byKey = new Map();
      for (const r of out.rows || []) byKey.set(`${r.schema}.${r.name}`, r.est == null ? null : Number(r.est));
      const fallbackSchema = secrets.schema ?? null;
      const counts = {};
      for (const nd of nodes) {
        const key = `${nd.data?.schema ?? fallbackSchema}.${nd.data?.label}`;
        const est = byKey.has(key) ? byKey.get(key) : null;
        counts[nd.id] = est != null && est >= 0 ? est : null;
      }
      res.json({ counts });
    } catch (err) {
      sendQueryError(res, "table-counts", err);
    }
  }),
);

// Data browse - one column's shape, for the "value summary" popover.
// Same column-name revalidation and plain-language filter set as /preview,
// and it honours the section's current filters so the summary matches
// what's on screen. Returns { total, filled, empty, distinct, low, high,
// top: [{ value, count }] } - `low`/`high` are the column min/max (only
// computed for number/date columns; the UI hides them otherwise), `top`
// the eight commonest non-null values.
dataRouter.post(
  "/sources/:sourceId/column-summary",
  wrap(async (req, res) => {
    const { tableId, column, filters = [], filterGroup = null } = req.body || {};
    if (!tableId || typeof column !== "string") {
      res.status(400).json({ error: "tableId and column are required." });
      return;
    }
    if (!Array.isArray(filters)) {
      res.status(400).json({ error: "filters must be an array." });
      return;
    }
    const secrets = await store.getSourceConnectionSecrets(req.params.sourceId);
    if (!secrets) {
      res.status(400).json({ error: "This source isn't connected." });
      return;
    }
    const branch = await store.getMainBranch(req.params.sourceId);
    const node = (branch?.nodes || []).find((n) => n.id === tableId && n.type === "tableNode");
    if (!node) {
      res.status(404).json({ error: "Table not found." });
      return;
    }
    const modeledCols = node.data?.columns || [];
    const columnNames = new Map(modeledCols.map((c) => [c.name, c.type]));
    if (!columnNames.has(column)) {
      res.status(400).json({ error: `"${column}" isn't a column of this table.` });
      return;
    }
    const label = node.data.label;
    const params = [];
    const wc = previewWhereClause(filterGroup, filters, columnNames, label, params);
    if (wc.error) {
      res.status(400).json({ error: wc.error });
      return;
    }
    const where = wc.clause;
    const col = quoteIdent(column);
    const colType = String(modeledCols.find((c) => c.name === column)?.type || "").toLowerCase();
    const rangeable = /int|numeric|decimal|real|double|float|money|serial|date|time/.test(colType);
    const minMax = rangeable
      ? `min(${col})::text AS low, max(${col})::text AS high`
      : `NULL::text AS low, NULL::text AS high`;

    try {
      const from = quoteTable(node.data.schema ?? secrets.schema ?? null, label);
      const [aggRes, topRes] = await Promise.all([
        runNativeQuery(
          secrets.connectionString,
          `SELECT count(*)::bigint AS total, count(${col})::bigint AS filled, ` +
            `count(DISTINCT ${col})::bigint AS distinct_count, ${minMax} FROM ${from}${where}`,
          params,
          { offset: 0, pageSize: 1 },
        ),
        runNativeQuery(
          secrets.connectionString,
          `SELECT ${col}::text AS value, count(*)::bigint AS count FROM ${from}` +
            `${where}${where ? " AND" : " WHERE"} ${col} IS NOT NULL ` +
            `GROUP BY ${col} ORDER BY count(*) DESC LIMIT 8`,
          params,
          { offset: 0, pageSize: 8 },
        ),
      ]);
      const a = aggRes.rows?.[0] || {};
      const total = Number(a.total || 0);
      const filled = Number(a.filled || 0);
      res.json({
        total,
        filled,
        empty: total - filled,
        distinct: Number(a.distinct_count || 0),
        low: a.low ?? null,
        high: a.high ?? null,
        top: (topRes.rows || []).map((r) => ({ value: r.value, count: Number(r.count) })),
      });
    } catch (err) {
      sendQueryError(res, "column-summary", err);
    }
  }),
);

dataRouter.post(
  "/sources/:sourceId/table-summary",
  wrap(async (req, res) => {
    const { tableId, columns = [], filters = [], filterGroup = null } = req.body || {};
    if (!tableId || !Array.isArray(columns) || columns.length === 0) {
      res.status(400).json({ error: "tableId and a non-empty columns array are required." });
      return;
    }
    if (columns.length > TABLE_SUMMARY_MAX_COLUMNS) {
      res.status(400).json({ error: `Too many columns (max ${TABLE_SUMMARY_MAX_COLUMNS}).` });
      return;
    }
    if (!Array.isArray(filters)) {
      res.status(400).json({ error: "filters must be an array." });
      return;
    }
    const secrets = await store.getSourceConnectionSecrets(req.params.sourceId);
    if (!secrets) {
      res.status(400).json({ error: "This source isn't connected." });
      return;
    }
    const branch = await store.getMainBranch(req.params.sourceId);
    const node = (branch?.nodes || []).find((n) => n.id === tableId && n.type === "tableNode");
    if (!node) {
      res.status(404).json({ error: "Table not found." });
      return;
    }
    const modeledCols = node.data?.columns || [];
    const typeByName = new Map(modeledCols.map((c) => [c.name, c.type]));
    const columnNames = new Map(modeledCols.map((c) => [c.name, c.type]));

    // One bad { column, agg } is a client bug - reject the request rather
    // than silently dropping it (a type mismatch, handled below, is not).
    for (const spec of columns) {
      if (!spec || typeof spec.column !== "string" || !columnNames.has(spec.column)) {
        res.status(400).json({ error: `"${spec?.column}" isn't a column of this table.` });
        return;
      }
      if (!TABLE_SUMMARY_AGGS.has(spec.agg)) {
        res.status(400).json({ error: `"${spec.agg}" isn't a summary this endpoint computes.` });
        return;
      }
    }

    const params = [];
    const wc = previewWhereClause(filterGroup, filters, columnNames, node.data.label, params);
    if (wc.error) {
      res.status(400).json({ error: wc.error });
      return;
    }

    // One SELECT, a positional alias per column (c0, c1, ...) so nothing
    // derived from a column name reaches the SQL beyond quoteIdent. A spec
    // whose agg doesn't fit its column type is recorded null and left out.
    const selectParts = [];
    const aliasToSpec = new Map();
    const values = {};
    columns.forEach((spec, i) => {
      const sql = tableSummaryAggSql(spec.agg, quoteIdent(spec.column), typeByName.get(spec.column));
      if (!sql) {
        values[spec.column] = null;
        return;
      }
      const alias = `c${i}`;
      selectParts.push(`${sql} AS ${alias}`);
      aliasToSpec.set(alias, spec);
    });

    if (selectParts.length === 0) {
      res.json({ values });
      return;
    }

    try {
      const from = quoteTable(node.data.schema ?? secrets.schema ?? null, node.data.label);
      const out = await runNativeQuery(
        secrets.connectionString,
        `SELECT ${selectParts.join(", ")} FROM ${from}${wc.clause}`,
        params,
        { offset: 0, pageSize: 1 },
      );
      const row = out.rows?.[0] || {};
      for (const [alias, spec] of aliasToSpec) {
        const raw = row[alias];
        if (raw == null) {
          values[spec.column] = null;
        } else if (spec.agg === "count" || spec.agg === "filled" || spec.agg === "distinct") {
          values[spec.column] = Number(raw);
        } else {
          // sum/avg/min/max come back as ::text to keep precision; numeric
          // columns parse to Number, dates stay strings for the client to
          // format.
          const t = String(typeByName.get(spec.column) || "").toLowerCase();
          const numeric = /int|numeric|decimal|real|double|float|money|serial/.test(t);
          values[spec.column] = numeric ? Number(raw) : raw;
        }
      }
      res.json({ values });
    } catch (err) {
      sendQueryError(res, "table-summary", err);
    }
  }),
);

dataRouter.post(
  "/sources/:sourceId/group-by",
  wrap(async (req, res) => {
    const { tableId, groupColumn, filters = [], filterGroup = null, aggregates = [], order = null } = req.body || {};
    if (!tableId || typeof groupColumn !== "string") {
      res.status(400).json({ error: "tableId and groupColumn are required." });
      return;
    }
    if (!Array.isArray(filters)) {
      res.status(400).json({ error: "filters must be an array." });
      return;
    }
    const secrets = await store.getSourceConnectionSecrets(req.params.sourceId);
    if (!secrets) {
      res.status(400).json({ error: "This source isn't connected." });
      return;
    }
    const branch = await store.getMainBranch(req.params.sourceId);
    const node = (branch?.nodes || []).find((n) => n.id === tableId && n.type === "tableNode");
    if (!node) {
      res.status(404).json({ error: "Table not found." });
      return;
    }
    const modeledCols = node.data?.columns || [];
    const columnNames = new Map(modeledCols.map((c) => [c.name, c.type]));
    if (!columnNames.has(groupColumn)) {
      res.status(400).json({ error: `"${groupColumn}" isn't a column of this table.` });
      return;
    }
    // Optional per-group totals: [{column, fn}] with fn sum|avg|min|max.
    if (!Array.isArray(aggregates) || aggregates.length > GROUP_BY_MAX_AGGREGATES) {
      res.status(400).json({ error: `aggregates must be an array of at most ${GROUP_BY_MAX_AGGREGATES}.` });
      return;
    }
    for (const a of aggregates) {
      if (!a || !columnNames.has(a.column) || !GROUP_BY_AGG_FNS.has(a.fn)) {
        res.status(400).json({ error: "Each aggregate needs a column of this table and fn sum, avg, min or max." });
        return;
      }
    }
    const label = node.data.label;
    const params = [];
    const wc = previewWhereClause(filterGroup, filters, columnNames, label, params);
    if (wc.error) {
      res.status(400).json({ error: wc.error });
      return;
    }
    const orderBy = groupOrderClause(order, groupColumn, columnNames);
    if (orderBy.error) {
      res.status(400).json({ error: orderBy.error });
      return;
    }
    const col = quoteIdent(groupColumn);
    try {
      const from = quoteTable(node.data.schema ?? secrets.schema ?? null, label);
      const out = await runNativeQuery(
        secrets.connectionString,
        `SELECT ${col}::text AS value, count(*)::bigint AS count` +
          aggregates.map((a, i) => `, ${a.fn}(${quoteIdent(a.column)})::text AS agg_${i}`).join("") +
          ` FROM ${from}${wc.clause} ` +
          `GROUP BY ${col} ORDER BY ${orderBy.clause}`,
        params,
        { offset: 0, pageSize: GROUP_BY_MAX_GROUPS },
      );
      const all = out.rows || [];
      const capped = all.length > GROUP_BY_MAX_GROUPS;
      res.json({
        groups: all
          .slice(0, GROUP_BY_MAX_GROUPS)
          .map((r) => ({
            value: r.value,
            count: Number(r.count),
            ...(aggregates.length
              ? { aggregates: aggregates.map((a, i) => ({ column: a.column, fn: a.fn, value: r[`agg_${i}`] })) }
              : null),
          })),
        capped,
      });
    } catch (err) {
      sendQueryError(res, "group-by", err);
    }
  }),
);
