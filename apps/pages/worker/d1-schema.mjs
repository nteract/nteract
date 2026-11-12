/** Versioned D1 schemas. Each schema keeps its own version table and lists
 * its migrations in order; this module imports nothing, so any module may
 * migrate its own table without joining another module's import graph. */

/** Apply `migrations` in order, recording each version in `table`. Each
 * schema keeps its own version table, so its migrations number from 1. */
export async function migrateSchema(
  db,
  { table, migrations, now = () => new Date().toISOString() },
) {
  if (!/^[a-z_]+$/.test(table)) throw new TypeError("Invalid schema table name");
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS ${table} (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )`,
    )
    .run();
  const current = async () =>
    (await db.prepare(`SELECT max(version) AS version FROM ${table}`).first())?.version ?? 0;
  let version = await current();
  for (const migration of migrations) {
    if (migration.version <= version) continue;
    try {
      await db.batch([
        ...migration.statements.map((sql) => db.prepare(sql)),
        db
          .prepare(`INSERT INTO ${table} (version, name, applied_at) VALUES (?, ?, ?)`)
          .bind(migration.version, migration.name, now()),
      ]);
    } catch (error) {
      if ((await current()) < migration.version) throw error;
    }
    version = migration.version;
  }
  return version;
}
