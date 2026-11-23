// @vitest-environment node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "vite-plus/test";
import type { AuthenticatedConnection } from "@nteract/identity";
import { readServerAppSession, SERVER_SESSION_COOKIE } from "../src/oidc-session-store.ts";
import type { ServerSessionRow } from "../src/oidc-session-store.ts";
import {
  checkedProviderGrant,
  createServerSession,
  ServerSessionGrantRejected,
  type ServerSessionGrant,
} from "../src/provider-session.ts";
import type {
  SessionDatabase,
  SessionDatabaseStatement,
  SessionDatabaseValue,
} from "../src/session-database.ts";

// The same in-memory adapter the store tests use: node:sqlite through
// createRequire, running the SQL unchanged.
type SqliteValue = string | number | null | Uint8Array;
interface SqliteStatement {
  get(...values: SqliteValue[]): Record<string, unknown> | undefined;
  run(...values: SqliteValue[]): { changes: number | bigint };
}
interface SqliteConnection {
  prepare(sql: string): SqliteStatement;
}
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteConnection;
};
class SqliteSessionDatabase implements SessionDatabase {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string): SessionDatabaseStatement {
    return new SqliteSessionStatement(this.sqlite.prepare(sql), []);
  }
  firstSession(): Record<string, unknown> | undefined {
    return this.sqlite.prepare("SELECT * FROM oidc_server_sessions").get();
  }
}
class SqliteSessionStatement implements SessionDatabaseStatement {
  constructor(
    private readonly statement: SqliteStatement,
    private readonly values: SqliteValue[],
  ) {}
  bind(...values: SessionDatabaseValue[]): SessionDatabaseStatement {
    return new SqliteSessionStatement(
      this.statement,
      values.map((value) =>
        typeof value === "boolean"
          ? Number(value)
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : value,
      ),
    );
  }
  async first<T>(): Promise<T | null> {
    const row = this.statement.get(...this.values);
    return row ? ({ ...row } as T) : null;
  }
  async run(): Promise<{ meta: Record<string, unknown> }> {
    return { meta: { changes: Number(this.statement.run(...this.values).changes) } };
  }
}

const ORIGIN = "https://pages.example.test";
const PRINCIPAL = "user:pair:alice";
const now = () => Math.floor(Date.now() / 1000);

function environment(overrides: Record<string, unknown> = {}) {
  return {
    DB: new SqliteSessionDatabase(),
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: ORIGIN,
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: "provider-session-test-secret-".repeat(2),
    ...overrides,
  } as { DB: SqliteSessionDatabase } & Record<string, unknown>;
}
const identity = (principal = PRINCIPAL): AuthenticatedConnection => ({
  principal,
  operator: "browser",
  actorLabel: `${principal}/browser`,
  scope: "owner",
  metadata: {
    provider: "oidc",
    transport: "host-session-cookie",
    principalNamespace: "user:pair",
    displayName: "Alice",
  },
});
const grant = (overrides: Partial<ServerSessionGrant> = {}): ServerSessionGrant => ({
  identity: identity(),
  expiresAt: now() + 600,
  bundle: { ticket: "provider-ticket" },
  ...overrides,
});
const request = (cookie?: string) =>
  new Request(`${ORIGIN}/`, { headers: cookie ? { cookie } : {} });

describe("provider sessions", () => {
  it("stores a session the app session reads, with the bundle only sealed", async () => {
    const env = environment();
    const events: unknown[] = [];
    const setCookie = await createServerSession(request(), env, grant(), {
      onAuthEvent: (event) => events.push(event),
    });
    assert.match(setCookie, new RegExp(`^${SERVER_SESSION_COOKIE}=`));
    assert.match(setCookie, /; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
    const cookie = setCookie.split(";", 1)[0]!;
    const session = await readServerAppSession(env, request(cookie), now());
    assert.equal(session?.principal, PRINCIPAL);
    assert.equal(session?.displayName, "Alice");
    assert.deepEqual(events, [{ type: "sign_in", principal: PRINCIPAL }]);
    const row = env.DB.firstSession();
    assert.equal(JSON.stringify(row).includes("provider-ticket"), false);
    assert.equal(JSON.stringify(row).includes(cookie.split("=")[1]!), false);
  });

  it("signs in even when the audit listener throws", async () => {
    const env = environment();
    const setCookie = await createServerSession(request(), env, grant(), {
      onAuthEvent: () => {
        throw new Error("audit down");
      },
    });
    assert.match(setCookie, new RegExp(`^${SERVER_SESSION_COOKIE}=`));
  });

  it("refuses a deployment without storage or keys before storing anything", async () => {
    await assert.rejects(
      createServerSession(
        request(),
        environment({ NOTEBOOK_CLOUD_APP_SESSION_SECRET: undefined }),
        grant(),
      ),
      /not configured/,
    );
    const noDb = environment({ DB: undefined });
    await assert.rejects(createServerSession(request(), noDb, grant()), /not configured/);
  });

  it("never overwrites a stored session when a new one draws the same id", async () => {
    const env = environment();
    const first = (await createServerSession(request(), env, grant())).split(";", 1)[0]!;
    const held = env.DB.firstSession()!;
    // Force the next insert onto the stored row's id, as a collision would.
    const prepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql: string) => {
      const statement = prepare(sql);
      if (!sql.startsWith("INSERT INTO oidc_server_sessions")) return statement;
      return {
        ...statement,
        bind: (...values: SessionDatabaseValue[]) =>
          statement.bind(held.id as string, ...values.slice(1)),
      } as SessionDatabaseStatement;
    };
    const other = grant({ identity: identity("user:pair:mallory") });
    await assert.rejects(createServerSession(request(), env, other), /UNIQUE|constraint/i);
    assert.deepEqual(env.DB.firstSession(), held);
    const session = await readServerAppSession(env, request(first), now());
    assert.equal(session?.principal, PRINCIPAL);
  });

  it("accepts a grant until the second it expires", () => {
    const at = 1_800_000_000;
    assert.equal(checkedProviderGrant(grant({ expiresAt: at + 1 }), at).expiresAt, at + 1);
    for (const expiresAt of [at, at - 1, Number.NaN, at + 0.5])
      assert.throws(() => checkedProviderGrant(grant({ expiresAt }), at), /already expired/);
  });

  it("refuses an unusable principal or bundle, and ends a renewal for another person", () => {
    const at = now();
    assert.throws(
      () => checkedProviderGrant(grant({ identity: identity("") }), at),
      /no usable principal/,
    );
    assert.throws(
      () => checkedProviderGrant(grant({ identity: identity("x".repeat(513)) }), at),
      /no usable principal/,
    );
    assert.throws(
      () => checkedProviderGrant(grant({ bundle: [] as unknown as Record<string, unknown> }), at),
      /not a JSON record/,
    );
    const held = {
      session_json: JSON.stringify({ principal: PRINCIPAL, principalNamespace: "user:pair" }),
    } as ServerSessionRow;
    assert.equal(checkedProviderGrant(grant(), at, held).identity.principal, PRINCIPAL);
    assert.throws(
      () => checkedProviderGrant(grant({ identity: identity("user:pair:mallory") }), at, held),
      ServerSessionGrantRejected,
    );
  });
});
