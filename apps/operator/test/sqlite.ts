import { createRequire } from "node:module";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  D1Value,
} from "../../notebook-cloud/src/cloudflare-types.ts";

type Value = string | number | null | Uint8Array;
interface Statement {
  all(...values: Value[]): Record<string, unknown>[];
  get(...values: Value[]): Record<string, unknown> | undefined;
  run(...values: Value[]): { changes: number | bigint };
}
interface Connection {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => Connection;
};
export class SqliteD1 implements D1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string): D1PreparedStatement {
    return new BoundStatement(this.sqlite.prepare(sql));
  }
  async exec(sql: string): Promise<D1Result> {
    this.sqlite.exec(sql);
    return { success: true, meta: {} };
  }
  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.sqlite.exec("BEGIN");
    try {
      const result: D1Result<T>[] = [];
      for (const statement of statements) result.push(await statement.run<T>());
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}
class BoundStatement implements D1PreparedStatement {
  constructor(
    private statement: Statement,
    private values: Value[] = [],
  ) {}
  bind(...values: D1Value[]) {
    return new BoundStatement(
      this.statement,
      values.map((v) =>
        typeof v === "boolean" ? Number(v) : v instanceof ArrayBuffer ? new Uint8Array(v) : v,
      ),
    );
  }
  async first<T>(column?: string): Promise<T | null> {
    const row = this.statement.get(...this.values);
    return ((column ? row?.[column] : row) as T | undefined) ?? null;
  }
  async run<T>(): Promise<D1Result<T>> {
    return { success: true, meta: { changes: Number(this.statement.run(...this.values).changes) } };
  }
  async all<T>(): Promise<D1Result<T>> {
    return { success: true, meta: {}, results: this.statement.all(...this.values) as T[] };
  }
}
