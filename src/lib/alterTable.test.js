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
  assert.deepEqual(planAlter(node, cols()), { changes: [], blocked: [] });
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
  assert.match(blocked.join("\n"), /link on "status"/);
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
