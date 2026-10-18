import { createRequire } from "node:module";
import type {
  D1Database,
  D1PreparedStatement,
  D1Value,
  D1Result,
} from "../../notebook-cloud/src/cloudflare-types.ts";
type Value = string | number | null | Uint8Array;
interface Statement {
  get(...values: Value[]): Record<string, unknown> | undefined;
  all(...values: Value[]): Record<string, unknown>[];
  run(...values: Value[]): { changes: number | bigint };
}
interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => Database;
};
export class SqliteD1 implements D1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string): D1PreparedStatement {
    const statement = this.sqlite.prepare(sql);
    const prepared = (values: Value[]): D1PreparedStatement => ({
      bind: (...args: D1Value[]) =>
        prepared(
          args.map((v) =>
            typeof v === "boolean" ? Number(v) : v instanceof ArrayBuffer ? new Uint8Array(v) : v,
          ),
        ),
      first: async <T>(column?: string) => {
        const row = statement.get(...values);
        return ((column ? row?.[column] : row) ?? null) as T | null;
      },
      all: async <T>() => ({ success: true, meta: {}, results: statement.all(...values) as T[] }),
      run: async <T>() =>
        ({
          success: true,
          meta: { changes: Number(statement.run(...values).changes) },
        }) as D1Result<T>,
    });
    return prepared([]);
  }
  async exec(sql: string) {
    this.sqlite.exec(sql);
    return { success: true, meta: {} };
  }
  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const s of statements) results.push(await s.run<T>());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (e) {
      this.sqlite.exec("ROLLBACK");
      throw e;
    }
  }
}
