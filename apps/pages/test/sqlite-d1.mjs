import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** D1 refuses a `LIKE` or `GLOB` pattern longer than this many UTF-8 bytes
 * (https://developers.cloudflare.com/d1/platform/limits/). Plain SQLite allows
 * 50,000. Kept here apart from the Worker's own constant, so loosening that
 * one can't loosen the test database. */
export const D1_LIKE_PATTERN_MAX_BYTES = 50;

const utf8 = new TextEncoder();
const asciiLower = (text) => text.replace(/[A-Z]+/g, (run) => run.toLowerCase());
const literal = (char) => char.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

/** SQLite's `LIKE`: `%` matches any run of characters, `_` one character,
 * the escape character makes the next one literal, and ASCII letters match
 * either case. Throws D1's error for a pattern over D1's limit. */
function like(pattern, text, escape) {
  if (pattern === null || text === null || escape === null) return null;
  pattern = String(pattern);
  if (utf8.encode(pattern).length > D1_LIKE_PATTERN_MAX_BYTES)
    throw new Error("LIKE or GLOB pattern too complex: SQLITE_ERROR");
  if (escape !== undefined && [...String(escape)].length !== 1)
    throw new Error("ESCAPE expression must be a single character");
  let source = "";
  const chars = [...asciiLower(pattern)];
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index];
    if (escape !== undefined && char === String(escape)) {
      index++;
      if (index === chars.length) return 0;
      source += literal(chars[index]);
    } else if (char === "%") source += "[^]*";
    else if (char === "_") source += "[^]";
    else source += literal(char);
  }
  return new RegExp(`^${source}$`, "u").test(asciiLower(String(text))) ? 1 : 0;
}

/** Real SQLite behind the subset of the D1 binding Pages uses. A batch runs as
 * one transaction, like D1, and answers one result per statement.`LIKE` refuses patterns over D1's limit. `mode`
 * injects an outage: "fail" rejects every call, "hang" never settles. `delay`
 * adds latency to every call. */
export class SqliteD1 {
  mode = "ok";
  calls = 0;
  /** `Date.now()` at the start of each call, for deadline assertions. */
  callStarts = [];
  delay = 0;
  constructor(path) {
    this.sqlite = new DatabaseSync(path);
    // An application-defined like() replaces SQLite's, in both arities.
    this.sqlite.function("like", { deterministic: true }, (pattern, text) => like(pattern, text));
    this.sqlite.function("like", { deterministic: true }, like);
  }
  async #gate() {
    this.calls++;
    this.callStarts.push(Date.now());
    if (this.delay) await new Promise((resolve) => setTimeout(resolve, this.delay));
    if (this.mode === "fail") throw new Error("injected D1 outage");
    if (this.mode === "hang") await new Promise(() => {});
  }
  prepare(sql) {
    const connection = this.sqlite;
    const build = (values = []) => ({
      bind: (...next) => build(next),
      first: async () => {
        await this.#gate();
        return connection.prepare(sql).get(...values) ?? null;
      },
      all: async () => {
        await this.#gate();
        return { success: true, results: connection.prepare(sql).all(...values) };
      },
      run: async () => {
        await this.#gate();
        return this.#run(sql, values);
      },
      execute: () => this.#run(sql, values),
    });
    return build();
  }
  /** A statement's D1 result: the rows it returns, and in `meta.changes` the
   * rows it inserted, updated or deleted, as each result of a D1 batch has. */
  #run(sql, values) {
    const statement = this.sqlite.prepare(sql);
    if (!statement.columns().length) {
      const result = statement.run(...values);
      return { success: true, results: [], meta: { changes: Number(result.changes) } };
    }
    const before = this.#totalChanges();
    const results = statement.all(...values);
    return { success: true, results, meta: { changes: this.#totalChanges() - before } };
  }
  #totalChanges() {
    return Number(this.sqlite.prepare("SELECT total_changes() AS n").get().n);
  }
  /** `holdNext` delays only the next batch until the given promise settles;
   * its statements were already bound, like a D1 request still in flight.
   * `holdAnswer` lets the next batch commit and delays only its answer, like
   * a D1 response still in flight. */
  async batch(statements) {
    const hold = this.holdNext;
    this.holdNext = undefined;
    if (hold) await hold;
    await this.#gate();
    this.sqlite.exec("BEGIN");
    let results;
    try {
      results = statements.map((statement, index) => {
        if (this.failAt === index) {
          this.failAt = undefined;
          throw new Error("injected database failure");
        }
        return statement.execute();
      });
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    const answer = this.holdAnswer;
    this.holdAnswer = undefined;
    if (answer) await answer;
    return results;
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
