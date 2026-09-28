// The database supplies this column when an INSERT leaves it out. Tables
// synced before `autoIncrement` existed lack it, so an integer primary key
// counts too; if it really has no default, Postgres's own error still says so.
export function dbFillsIn(col) {
  if (col.default || col.autoIncrement) return true;
  return !!col.isPrimaryKey && /int|serial/i.test(String(col.type || ""));
}
