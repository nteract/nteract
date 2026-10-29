import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Real SQLite behind the subset of the D1 binding Pages uses. A batch runs as
 * one transaction, like D1. `mode` injects an outage: "fail" rejects every
 * call, "hang" never settles. */
export class SqliteD1 {
  mode = "ok";
  calls = 0;
  constructor(path) {
    this.sqlite = new DatabaseSync(path);
  }
  #outage() {
    this.calls++;
    if (this.mode === "fail") return Promise.reject(new Error("injected D1 outage"));
    if (this.mode === "hang") return new Promise(() => {});
    return null;
  }
  prepare(sql) {
    const connection = this.sqlite;
    const build = (values = []) => ({
      bind: (...next) => build(next),
      first: async () => this.#outage() ?? connection.prepare(sql).get(...values) ?? null,
      all: async () =>
        this.#outage() ?? { success: true, results: connection.prepare(sql).all(...values) },
      run: async () => this.#outage() ?? this.#run(sql, values),
      execute: () => this.#run(sql, values),
    });
    return build();
  }
  #run(sql, values) {
    const result = this.sqlite.prepare(sql).run(...values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
  /** `holdNext` delays only the next batch until the given promise settles;
   * its statements were already bound, like a D1 request still in flight. */
  async batch(statements) {
    const hold = this.holdNext;
    this.holdNext = undefined;
    if (hold) await hold;
    const outage = this.#outage();
    if (outage) return outage;
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement, index) => {
        if (this.failAt === index) {
          this.failAt = undefined;
          throw new Error("injected database failure");
        }
        return statement.execute();
      });
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  /** Direct read for assertions, outside any injected outage. */
  rows(sql, ...values) {
    return this.sqlite
      .prepare(sql)
      .all(...values)
      .map((row) => ({ ...row }));
  }
}

export function sqliteD1(t, name = "pages-d1-") {
  const directory = mkdtempSync(join(tmpdir(), name));
  const path = join(directory, "d1.sqlite");
  const databases = [];
  const open = () => {
    const db = new SqliteD1(path);
    databases.push(db);
    return db;
  };
  t.after(() => {
    for (const db of databases) db.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { path, open };
}
