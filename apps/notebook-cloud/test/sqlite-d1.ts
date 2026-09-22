import { createRequire } from "node:module";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  D1Value,
} from "../src/cloudflare-types.ts";

interface SqliteStatement {
  run(...values: unknown[]): { changes: number | bigint };
  all(...values: unknown[]): Record<string, unknown>[];
  get(...values: unknown[]): Record<string, unknown> | undefined;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}
// Node 22 is the CI runtime; keep its experimental SQLite typing local to tests.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (filename: string) => SqliteDatabase;
};

export class SqliteD1 implements D1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  statements = 0;
  prepare(query: string): D1PreparedStatement {
    return new SqliteD1Statement(this, query);
  }
  async exec(query: string): Promise<D1Result> {
    this.sqlite.exec(query);
    return { success: true, meta: {} };
  }
  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.sqlite.exec("SAVEPOINT d1_batch");
    try {
      const results: D1Result<T>[] = [];
      for (const statement of statements) results.push(await statement.all<T>());
      this.sqlite.exec("RELEASE d1_batch");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK TO d1_batch; RELEASE d1_batch");
      throw error;
    }
  }
}

class SqliteD1Statement implements D1PreparedStatement {
  constructor(
    private db: SqliteD1,
    private query: string,
    private values: unknown[] = [],
  ) {}
  bind(...values: D1Value[]): D1PreparedStatement {
    return new SqliteD1Statement(
      this.db,
      this.query,
      values.map((value) =>
        typeof value === "boolean"
          ? Number(value)
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : value,
      ),
    );
  }
  async first<T>(columnName?: string): Promise<T | null> {
    this.db.statements++;
    const row = this.db.sqlite.prepare(this.query).get(...this.values);
    return (columnName ? row?.[columnName] : row ? { ...row } : null) as T | null;
  }
  async run<T>(): Promise<D1Result<T>> {
    this.db.statements++;
    const result = this.db.sqlite.prepare(this.query).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
  async all<T>(): Promise<D1Result<T>> {
    this.db.statements++;
    const rows = this.db.sqlite.prepare(this.query).all(...this.values);
    return { success: true, results: rows.map((row) => ({ ...row })) as T[], meta: {} };
  }
}
