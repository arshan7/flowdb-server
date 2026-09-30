import { quoteIdent, compileRowIdentityWhere } from "./queryEngine.js";

// Reverses one audit-log entry inside an open transaction (`client`): a
// delete is undone by re-inserting `before`, an insert by deleting the row it
// created, an update by writing `before` back. Returns the audit record for
// that reverse write (undoing is just another write, so it's logged too).
// Throws an Error with `status` when the entry can't be reversed.
export async function reverseEntry(client, entry, table, from) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const identityOf = (row) =>
    table.pkColumns.length
      ? { pk: Object.fromEntries(table.pkColumns.map((c) => [c, row[c]])) }
      : { ctid: row.ctid };
  const base = { tableId: entry.tableId, tableSchema: table.schema, tableName: table.label };

  if (entry.operation === "delete") {
    if (!entry.before) throw fail(400, "Nothing to restore.");
    const cols = Object.keys(entry.before).filter((c) => table.columnNames.has(c));
    const params = cols.map((c) => entry.before[c]);
    const result = await client.query(
      `INSERT INTO ${from} (${cols.map(quoteIdent).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *, ctid::text AS ctid`,
      params,
    );
    const row = result.rows[0];
    return { ...base, operation: "insert", rowIdentity: identityOf(row), before: null, after: row, row };
  }

  if (entry.operation === "insert") {
    const params = [];
    const where = compileRowIdentityWhere(table.label, entry.rowIdentity, params);
    const result = await client.query(`DELETE FROM ${from} WHERE ${where} RETURNING *, ctid::text AS ctid`, params);
    if (result.rowCount === 0) throw fail(404, "This row no longer exists.");
    const row = result.rows[0];
    return { ...base, operation: "delete", rowIdentity: entry.rowIdentity, before: row, after: null, row };
  }

  if (!entry.before) throw fail(400, "Nothing to restore.");
  const cols = Object.keys(entry.before).filter((c) => table.columnNames.has(c));
  const params = [];
  const setParts = cols.map((c) => {
    params.push(entry.before[c]);
    return `${quoteIdent(c)} = $${params.length}`;
  });
  const where = compileRowIdentityWhere(table.label, entry.rowIdentity, params);
  const result = await client.query(
    `UPDATE ${from} SET ${setParts.join(", ")} WHERE ${where} RETURNING *, ctid::text AS ctid`,
    params,
  );
  if (result.rowCount === 0) throw fail(409, "This row has since changed or no longer exists.");
  const row = result.rows[0];
  return { ...base, operation: "update", rowIdentity: entry.rowIdentity, before: entry.after, after: row, row };
}
