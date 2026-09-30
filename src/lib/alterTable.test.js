import { test } from "node:test";
import assert from "node:assert/strict";
import { planAlter, buildAlterStatements, parseDefault } from "./alterTable.js";

const col = (id, name, type, extra = {}) => ({ id, name, type, typeParams: null, notNull: false, isUnique: false, isPrimaryKey: false, isForeignKey: false, references: null, default: "", ...extra });
const node = {
  data: {
    label: "orders",
    columns: [
      col("c1", "id", "bigint", { isPrimaryKey: true, notNull: true }),
      col("c2", "status", "text", { default: "pending" }),
      col("c3", "amount", "integer"),
      col("c4", "note", "varchar", { typeParams: { length: 50 } }),
    ],
  },
};
const cols = () => node.data.columns.map((c) => ({ ...c }));
const sql = (changes, extra) => buildAlterStatements({ table: "orders", changes, ...extra }).statements;

test("no changes -> nothing to run", () => {
  assert.deepEqual(planAlter(node, cols()), { changes: [], blocked: [], designOnly: [] });
});

test("adds a column with type, default, required and unique", () => {
  const next = [...cols(), col("n1", "code", "varchar", { typeParams: { length: 12 }, default: "'A-1'", notNull: true, isUnique: true })];
  const { changes, blocked } = planAlter(node, next);
  assert.deepEqual(blocked, []);
  assert.deepEqual(sql(changes), [`ALTER TABLE "orders" ADD COLUMN "code" varchar(12) DEFAULT 'A-1'::varchar(12) NOT NULL UNIQUE;`]);
});

test("drops a column", () => {
  const { changes } = planAlter(node, cols().filter((c) => c.id !== "c4"));
  assert.deepEqual(sql(changes), [`ALTER TABLE "orders" DROP COLUMN "note";`]);
});

test("renames, then changes the type under the new name", () => {
  const next = cols().map((c) => (c.id === "c3" ? { ...c, name: "total", type: "decimal", typeParams: { precision: 10, scale: 2 } } : c));
  const { changes } = planAlter(node, next);
  assert.deepEqual(sql(changes), [
    `ALTER TABLE "orders" RENAME COLUMN "amount" TO "total";`,
    `ALTER TABLE "orders" ALTER COLUMN "total" TYPE numeric(10, 2) USING "total"::numeric(10, 2);`,
  ]);
});

test("type change with a new default drops the old default first", () => {
  const next = cols().map((c) => (c.id === "c2" ? { ...c, type: "integer", default: "0" } : c));
  const { changes } = planAlter(node, next);
  assert.deepEqual(sql(changes), [
    `ALTER TABLE "orders" ALTER COLUMN "status" DROP DEFAULT;`,
    `ALTER TABLE "orders" ALTER COLUMN "status" TYPE integer USING "status"::integer;`,
    `ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 0;`,
  ]);
});

test("required and unique on and off", () => {
  const next = cols().map((c) => (c.id === "c3" ? { ...c, notNull: true, isUnique: true } : c));
  assert.deepEqual(sql(planAlter(node, next).changes), [
    `ALTER TABLE "orders" ALTER COLUMN "amount" SET NOT NULL;`,
    `ALTER TABLE "orders" ADD CONSTRAINT "orders_amount_key" UNIQUE ("amount");`,
  ]);
  const uniqueNode = { data: { columns: node.data.columns.map((c) => (c.id === "c3" ? { ...c, isUnique: true } : c)) } };
  const off = planAlter(uniqueNode, cols());
  assert.deepEqual(sql(off.changes, { uniqueConstraints: { amount: "orders_amount_key" } }), [
    `ALTER TABLE "orders" DROP CONSTRAINT "orders_amount_key";`,
  ]);
  assert.match(buildAlterStatements({ table: "orders", changes: off.changes }).error, /unique rule/);
});

test("blocks what a live table can't take", () => {
  const next = cols()
    .filter((c) => c.id !== "c1")
    .map((c) => (c.id === "c2" ? { ...c, isForeignKey: true, references: { tableId: "t", columnId: "x" } } : c));
  next.push(col("n2", "1bad", "text"), col("n3", "note", "text"), col("n4", "weird", "money"));
  const { blocked } = planAlter(node, next);
  assert.equal(blocked.length, 5);
  assert.match(blocked.join("\n"), /primary key/);
  assert.match(blocked.join("\n"), /"status" links to a table that wasn't found/);
  assert.match(blocked.join("\n"), /letters, numbers/);
  assert.match(blocked.join("\n"), /Two columns are named "note"/);
  assert.match(blocked.join("\n"), /can't be applied to the database \(money\)/);
});

test("an unchanged odd default doesn't block a type change", () => {
  const odd = { data: { columns: [col("c1", "at", "timestamp", { default: "(now() + '1 day'::interval)" })] } };
  const { changes, blocked } = planAlter(odd, [col("c1", "at", "date", { default: "(now() + '1 day'::interval)" })]);
  assert.deepEqual(blocked, []);
  assert.deepEqual(sql(changes), [`ALTER TABLE "orders" ALTER COLUMN "at" TYPE date USING "at"::date;`]);
});

test("parses designer defaults", () => {
  assert.deepEqual(parseDefault(""), { kind: "none" });
  assert.deepEqual(parseDefault("NULL"), { kind: "none" });
  assert.deepEqual(parseDefault("now()"), { kind: "now" });
  assert.deepEqual(parseDefault("CURRENT_TIMESTAMP"), { kind: "now" });
  assert.deepEqual(parseDefault("'it''s'"), { kind: "value", value: "it's" });
  assert.deepEqual(parseDefault("pending"), { kind: "value", value: "pending" });
  assert.ok(parseDefault("random()").error);
});

const customers = { id: "tc", type: "tableNode", data: { label: "customers", sourceOrigin: "synced", columns: [col("k1", "id", "bigint", { isPrimaryKey: true })] } };
const sketch = { id: "ts", type: "tableNode", data: { label: "sketch", columns: [col("s1", "id", "bigint")] } };
const nodes = [{ id: "to", type: "tableNode", data: node.data }, customers, sketch];
const link = (extra = {}) => ({ isForeignKey: true, references: { tableId: "tc", columnId: "k1", ...extra } });
const withCol = (id, patch) => cols().map((c) => (c.id === id ? { ...c, ...patch } : c));

test("links: add a database link, keep one app-only, remove, and soften", () => {
  const add = planAlter(node, withCol("c3", link()), { nodes });
  assert.deepEqual(sql(add.changes), [
    `ALTER TABLE "orders" ADD CONSTRAINT "orders_amount_fkey" FOREIGN KEY ("amount") REFERENCES "customers" ("id");`,
  ]);
  const virt = planAlter(node, withCol("c3", link({ virtual: true })), { nodes });
  assert.deepEqual(virt.changes, []);
  assert.match(virt.designOnly[0], /App-only link: "amount" → customers.id/);

  const linked = { data: { columns: node.data.columns.map((c) => (c.id === "c3" ? { ...c, ...link() } : c)) } };
  const drop = planAlter(linked, cols(), { nodes });
  assert.deepEqual(sql(drop.changes, { fkConstraints: { amount: "orders_amount_fkey" } }), [
    `ALTER TABLE "orders" DROP CONSTRAINT "orders_amount_fkey";`,
  ]);
  const soften = planAlter(linked, withCol("c3", link({ virtual: true })), { nodes });
  assert.deepEqual(soften.changes.map((c) => c.op), ["dropFk"]);
  assert.equal(soften.designOnly.length, 1);
});

test("links: a new column can link; a design-only target gets an app-only link only", () => {
  const withNew = planAlter(node, [...cols(), col("n9", "customer_id", "bigint", link())], { nodes });
  assert.deepEqual(sql(withNew.changes), [
    `ALTER TABLE "orders" ADD COLUMN "customer_id" bigint;`,
    `ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers" ("id");`,
  ]);
  const toSketch = { isForeignKey: true, references: { tableId: "ts", columnId: "s1" } };
  assert.match(planAlter(node, withCol("c3", toSketch), { nodes }).blocked[0], /only exists in the design/);
  const sketchVirtual = { isForeignKey: true, references: { tableId: "ts", columnId: "s1", virtual: true } };
  assert.deepEqual(planAlter(node, withCol("c3", sketchVirtual), { nodes }).blocked, []);
});

test("renames the table last, after the column changes", () => {
  const { changes, blocked } = planAlter(node, withCol("c4", { name: "memo" }), { nodes, name: "purchases" });
  assert.deepEqual(blocked, []);
  assert.deepEqual(sql(changes), [
    `ALTER TABLE "orders" RENAME COLUMN "note" TO "memo";`,
    `ALTER TABLE "orders" RENAME TO "purchases";`,
  ]);
  assert.match(planAlter(node, cols(), { nodes, name: "customers" }).blocked[0], /already exists/);
});
