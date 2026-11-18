/**
 * The part of a D1-style SQL binding the session store calls. A Cloudflare
 * Workers `D1Database`, notebook-cloud's `cloudflare-types.ts` declaration and
 * a SQLite adapter in tests all satisfy it structurally.
 */
export type SessionDatabaseValue = string | number | boolean | null | ArrayBuffer;

export interface SessionDatabaseStatement {
  bind(...values: SessionDatabaseValue[]): SessionDatabaseStatement;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<{ meta: Record<string, unknown> }>;
}

export interface SessionDatabase {
  prepare(query: string): SessionDatabaseStatement;
}
