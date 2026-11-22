// @vitest-environment node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { describe, it } from "vite-plus/test";
import type { AuthenticatedConnection } from "@nteract/identity";
import { createServerAppSession, readServerAccountEmail } from "../src/app-session.ts";
import {
  conditionalSessionUpdate,
  cookieValue,
  deleteExpiredOidcRows,
  loadServerSession,
  oidcDatabase,
  openServerSecret,
  randomSecret,
  readServerAppSession,
  readServerAppSessionByIds,
  revokeServerSession,
  revokeServerSessionsFor,
  sealServerSecret,
  serverOidcEnabled,
  serverSessionContext,
  serverSessionCookie,
  serverSessionId,
  serverSessionIds,
  touchServerSession,
  SERVER_SESSION_ABSOLUTE_SECONDS,
  SERVER_SESSION_COOKIE,
  SERVER_SESSION_IDLE_SECONDS,
  type ServerSessionEnvironment,
  type ServerSessionRow,
} from "../src/oidc-session-store.ts";
import type {
  SessionDatabase,
  SessionDatabaseStatement,
  SessionDatabaseValue,
} from "../src/session-database.ts";

// node:sqlite through createRequire, so the test does not depend on the
// installed Node type definitions knowing the module. The adapter runs the
// store's SQL unchanged against an in-memory SQLite database, as D1 would.
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
  prepared = 0;
  prepare(sql: string): SessionDatabaseStatement {
    this.prepared += 1;
    return new SqliteSessionStatement(this.sqlite.prepare(sql), []);
  }
  row(id: string): ServerSessionRow | undefined {
    const row = this.sqlite.prepare("SELECT * FROM oidc_server_sessions WHERE id = ?").get(id);
    return row ? ({ ...row } as unknown as ServerSessionRow) : undefined;
  }
  set(id: string, assignments: string, ...values: SqliteValue[]): void {
    this.sqlite
      .prepare(`UPDATE oidc_server_sessions SET ${assignments} WHERE id = ?`)
      .run(...values, id);
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

const ORIGIN = "https://notebooks.example.test";
const NOW = 1_800_000_000;

/** A fresh 32-byte key, base64url so the keyring accepts it as written. */
const freshKey = () => randomBytes(32).toString("base64url");

function environment(
  db: SessionDatabase,
  keyring: { active: string; keys: Record<string, string> },
  overrides: Partial<ServerSessionEnvironment> = {},
): ServerSessionEnvironment & { DB: SessionDatabase } {
  return {
    DB: db,
    NOTEBOOK_CLOUD_OIDC_FLOW: "server",
    NOTEBOOK_CLOUD_APP_SESSION_KEYS: JSON.stringify(keyring),
    NOTEBOOK_CLOUD_OIDC_ISSUER: "https://issuer.example.test",
    NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "session-store-test-client",
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: ORIGIN,
    ...overrides,
  };
}

function setup() {
  const db = new SqliteSessionDatabase();
  const keys = { k1: freshKey() };
  return { db, keys, env: environment(db, { active: "k1", keys }) };
}

function identity(principal = "user-1", verifiedEmail?: string): AuthenticatedConnection {
  return {
    principal,
    operator: "browser",
    actorLabel: `${principal}/browser`,
    scope: "editor",
    metadata: {
      provider: "oidc",
      transport: "oidc-bearer",
      principalNamespace: "oidc:issuer.example.test",
      displayName: "Test User",
      ...(verifiedEmail ? { email: verifiedEmail, emailVerified: true } : {}),
    },
  };
}

function request(token: string | null, origin = ORIGIN): Request {
  return new Request(`${origin}/api/auth/session`, {
    headers: token === null ? {} : { cookie: `${SERVER_SESSION_COOKIE}=${token}` },
  });
}

/**
 * Inserts a session row the way the sign-in callback does, and returns its
 * cookie token and id. Access expiry defaults to an hour after `now`.
 * `accountEmail` signs in with that verified address on a host that retains
 * it for the account menu.
 */
async function insertSession(
  env: ServerSessionEnvironment,
  now: number,
  options: {
    principal?: string;
    accessExpiresAt?: number;
    bundle?: unknown;
    accountEmail?: string;
  } = {},
): Promise<{ token: string; id: string; context: string }> {
  const db = await oidcDatabase(env);
  const token = randomSecret();
  const id = await serverSessionId(env, token);
  const context = serverSessionContext(env, ORIGIN);
  const accessExpiresAt = options.accessExpiresAt ?? now + 60 * 60;
  const session = await createServerAppSession(
    env,
    identity(options.principal, options.accountEmail),
    id,
    accessExpiresAt,
    now,
    { retainAccountEmail: options.accountEmail !== undefined },
  );
  await db
    .prepare(
      `INSERT INTO oidc_server_sessions (id, context, session_json, sealed, access_expires_at, idle_expires_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      context,
      JSON.stringify(session),
      await sealServerSecret(
        env,
        options.bundle ?? { refreshToken: "refresh-1" },
        `session:${id}:${context}`,
      ),
      accessExpiresAt,
      now + SERVER_SESSION_IDLE_SECONDS,
      now + SERVER_SESSION_ABSOLUTE_SECONDS,
    )
    .run();
  return { token, id, context };
}

/** The claim a refresh makes before it spends the sealed credential. */
function claim(db: SqliteSessionDatabase, id: string, lease: string, leaseUntil: number): void {
  db.set(id, "lease = ?, lease_until = ?", lease, leaseUntil);
}

describe("server session store setup", () => {
  it("is enabled only by the server flow", () => {
    assert.equal(serverOidcEnabled({ NOTEBOOK_CLOUD_OIDC_FLOW: "server" }), true);
    assert.equal(serverOidcEnabled({ NOTEBOOK_CLOUD_OIDC_FLOW: "browser" }), false);
    assert.equal(serverOidcEnabled({}), false);
  });

  it("requires a database and runs the schema once per binding", async () => {
    await assert.rejects(oidcDatabase({}), /requires database storage/);
    const { db, env } = setup();
    assert.equal(await oidcDatabase(env), db);
    const afterSchema = db.prepared;
    assert.ok(afterSchema > 0);
    assert.equal(await oidcDatabase(env), db);
    assert.equal(db.prepared, afterSchema);
  });

  it("reads exactly one session cookie", () => {
    assert.equal(cookieValue(request("abc"), SERVER_SESSION_COOKIE), "abc");
    assert.equal(cookieValue(request(null), SERVER_SESSION_COOKIE), null);
    const twice = new Request(ORIGIN, {
      headers: { cookie: `${SERVER_SESSION_COOKIE}=a; ${SERVER_SESSION_COOKIE}=b` },
    });
    assert.equal(cookieValue(twice, SERVER_SESSION_COOKIE), null);
  });

  it("writes a host-only cookie that lasts the idle window by default", () => {
    assert.equal(
      serverSessionCookie("token"),
      `${SERVER_SESSION_COOKIE}=token; Path=/; Max-Age=${SERVER_SESSION_IDLE_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
    );
    assert.match(serverSessionCookie("", 0), /Max-Age=0;/);
  });
});

describe("server session rows", () => {
  it("creates a row that loads by its cookie and projects the app session", async () => {
    const { env } = setup();
    const { token, id, context } = await insertSession(env, NOW);

    const row = await loadServerSession(env, request(token), NOW);
    assert.ok(row);
    assert.equal(row.id, id);
    assert.equal(row.context, context);
    assert.equal(row.generation, 0);
    assert.equal(row.lease, null);
    assert.equal(row.lease_until, 0);
    assert.equal(row.retry_after, 0);
    assert.equal(row.idle_expires_at, NOW + SERVER_SESSION_IDLE_SECONDS);
    assert.equal(row.absolute_expires_at, NOW + SERVER_SESSION_ABSOLUTE_SECONDS);

    const session = await readServerAppSession(env, request(token), NOW);
    assert.equal(session?.principal, "user-1");
    assert.equal(session?.cacheKey, id);
    assert.equal(session?.provider, "oidc");
  });

  it("finds nothing for a missing, malformed or unknown token", async () => {
    const { env } = setup();
    await insertSession(env, NOW);
    assert.equal(await loadServerSession(env, request(null), NOW), null);
    assert.equal(await loadServerSession(env, request("not-a-token"), NOW), null);
    assert.equal(await loadServerSession(env, request(randomSecret()), NOW), null);
  });

  it("refuses a row created for another issuer, client or origin", async () => {
    const { db, keys, env } = setup();
    const { token } = await insertSession(env, NOW);
    const other = (overrides: Partial<ServerSessionEnvironment>) =>
      environment(db, { active: "k1", keys }, overrides);
    assert.equal(
      await loadServerSession(
        other({ NOTEBOOK_CLOUD_OIDC_ISSUER: "https://other.example.test" }),
        request(token),
        NOW,
      ),
      null,
    );
    assert.equal(
      await loadServerSession(
        other({ NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "other" }),
        request(token),
        NOW,
      ),
      null,
    );
    assert.equal(
      await loadServerSession(
        other({ NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://other.example.test" }),
        request(token),
        NOW,
      ),
      null,
    );
  });

  it("ends at the idle expiry: live one second before, gone at it", async () => {
    const { env } = setup();
    const { token } = await insertSession(env, NOW);
    const idle = NOW + SERVER_SESSION_IDLE_SECONDS;
    assert.ok(await loadServerSession(env, request(token), idle - 1));
    assert.equal(await loadServerSession(env, request(token), idle), null);
  });

  it("ends at the absolute expiry even when idle time remains", async () => {
    const { db, env } = setup();
    const { token, id } = await insertSession(env, NOW);
    const absolute = NOW + SERVER_SESSION_ABSOLUTE_SECONDS;
    db.set(id, "idle_expires_at = ?", absolute + SERVER_SESSION_IDLE_SECONDS);
    assert.ok(await loadServerSession(env, request(token), absolute - 1));
    assert.equal(await loadServerSession(env, request(token), absolute), null);
  });

  it("projects no app session once access proof expires, while the row stays", async () => {
    const { env } = setup();
    const { token } = await insertSession(env, NOW, { accessExpiresAt: NOW + 60 });
    assert.ok(await readServerAppSession(env, request(token), NOW + 59));
    assert.equal(await readServerAppSession(env, request(token), NOW + 60), null);
    assert.ok(await loadServerSession(env, request(token), NOW + 60));
  });

  it("revokes the caller's row and every row a principal holds here", async () => {
    const { db, env } = setup();
    const mine = await insertSession(env, NOW);
    await revokeServerSession(env, request(mine.token));
    assert.equal(db.row(mine.id), undefined);
    await revokeServerSession(env, request(null));

    const first = await insertSession(env, NOW, { principal: "user-2" });
    const second = await insertSession(env, NOW, { principal: "user-2" });
    const other = await insertSession(env, NOW, { principal: "user-3" });
    assert.equal(await revokeServerSessionsFor(env, "user-2", ORIGIN), 2);
    assert.equal(db.row(first.id), undefined);
    assert.equal(db.row(second.id), undefined);
    assert.ok(db.row(other.id));
    assert.equal(await revokeServerSessionsFor(env, "user-2", ORIGIN), 0);
    await assert.rejects(revokeServerSessionsFor(env, "", ORIGIN), /Invalid principal/);
  });
});

describe("idle renewal", () => {
  it("leaves a row alone while more than half its idle window remains", async () => {
    const { db, env } = setup();
    const { token, id } = await insertSession(env, NOW);
    const row = (await loadServerSession(env, request(token), NOW))!;
    const now = NOW + SERVER_SESSION_IDLE_SECONDS / 2 - 1;
    assert.equal(await touchServerSession(env, request(token), row, now), row);
    assert.equal(db.row(id)?.idle_expires_at, NOW + SERVER_SESSION_IDLE_SECONDS);
  });

  it("extends idle expiry from now, capped at the absolute expiry", async () => {
    const { db, env } = setup();
    const { token, id } = await insertSession(env, NOW, {
      accessExpiresAt: NOW + SERVER_SESSION_ABSOLUTE_SECONDS,
    });
    const now = NOW + SERVER_SESSION_IDLE_SECONDS - 10;
    const row = (await loadServerSession(env, request(token), now))!;
    const touched = await touchServerSession(env, request(token), row, now);
    assert.equal(touched?.idle_expires_at, now + SERVER_SESSION_IDLE_SECONDS);
    assert.equal(touched?.generation, row.generation);

    const absolute = NOW + SERVER_SESSION_ABSOLUTE_SECONDS;
    const late = absolute - 10;
    db.set(id, "idle_expires_at = ?", late + 1);
    const nearEnd = (await loadServerSession(env, request(token), late))!;
    const capped = await touchServerSession(env, request(token), nearEnd, late);
    assert.equal(capped?.idle_expires_at, absolute);
  });

  it("keeps the sealed account email when it rewrites the session", async () => {
    const { env } = setup();
    const email = "user@example.test";
    const { token } = await insertSession(env, NOW, {
      accessExpiresAt: NOW + SERVER_SESSION_ABSOLUTE_SECONDS,
      accountEmail: email,
    });
    const now = NOW + SERVER_SESSION_IDLE_SECONDS - 10;
    const row = (await loadServerSession(env, request(token), now))!;
    await touchServerSession(env, request(token), row, now);
    const session = (await readServerAppSession(env, request(token), now))!;
    // The touch wrote a new session_json: its expiry moved with the idle window.
    assert.equal(session.expiresAt, now + SERVER_SESSION_IDLE_SECONDS);
    assert.equal(await readServerAccountEmail(env, session), email);
  });

  it("does not renew from a row read before a refresh saved a new generation", async () => {
    const { db, env } = setup();
    const { token, id } = await insertSession(env, NOW, {
      accessExpiresAt: NOW + SERVER_SESSION_ABSOLUTE_SECONDS,
    });
    const now = NOW + SERVER_SESSION_IDLE_SECONDS - 10;
    const stale = (await loadServerSession(env, request(token), now))!;
    db.set(id, "generation = generation + 1");
    const fresh = await touchServerSession(env, request(token), stale, now);
    assert.equal(fresh?.generation, 1);
    assert.equal(fresh?.idle_expires_at, NOW + SERVER_SESSION_IDLE_SECONDS);
  });

  it("does not renew a row whose access proof has expired", async () => {
    const { db, env } = setup();
    const { token, id } = await insertSession(env, NOW, { accessExpiresAt: NOW + 60 });
    const now = NOW + SERVER_SESSION_IDLE_SECONDS - 10;
    const row = (await loadServerSession(env, request(token), now))!;
    assert.equal(await touchServerSession(env, request(token), row, now), row);
    assert.equal(db.row(id)?.idle_expires_at, NOW + SERVER_SESSION_IDLE_SECONDS);
  });
});

describe("generation and lease fence", () => {
  const SAVE =
    "session_json = session_json, generation = generation + 1, lease = NULL, lease_until = 0, retry_after = 0";
  const BACK_OFF = "lease = NULL, lease_until = 0, retry_after = ?";

  it("saves under the lease that claimed the row and moves to the next generation", async () => {
    const { db, env } = setup();
    const { token, id } = await insertSession(env, NOW);
    const row = (await loadServerSession(env, request(token), NOW))!;
    claim(db, id, "lease-a", NOW + 30);
    assert.equal(await conditionalSessionUpdate(db, row, "lease-a", SAVE, []), true);
    const saved = db.row(id)!;
    assert.equal(saved.generation, 1);
    assert.equal(saved.lease, null);
    assert.equal(saved.lease_until, 0);
  });

  it("refuses a write from a row read at an older generation", async () => {
    const { db, env } = setup();
    const { token, id } = await insertSession(env, NOW);
    const stale = (await loadServerSession(env, request(token), NOW))!;
    db.set(id, "generation = 1");
    claim(db, id, "lease-a", NOW + 30);
    assert.equal(await conditionalSessionUpdate(db, stale, "lease-a", SAVE, []), false);
    assert.equal(db.row(id)?.generation, 1);
    assert.equal(db.row(id)?.lease, "lease-a");
  });

  it("refuses a write while another lease holds the row", async () => {
    const { db, env } = setup();
    const { token, id } = await insertSession(env, NOW);
    const row = (await loadServerSession(env, request(token), NOW))!;
    claim(db, id, "lease-b", NOW + 30);
    assert.equal(await conditionalSessionUpdate(db, row, "lease-a", SAVE, []), false);
    assert.equal(db.row(id)?.lease, "lease-b");
    assert.equal(db.row(id)?.generation, 0);
  });

  it("refuses a write to an unclaimed row", async () => {
    const { db, env } = setup();
    const { token } = await insertSession(env, NOW);
    const row = (await loadServerSession(env, request(token), NOW))!;
    assert.equal(await conditionalSessionUpdate(db, row, "lease-a", SAVE, []), false);
  });

  it("fences on the lease value, not on lease_until", async () => {
    // An owner whose lease lapsed may still save while the row names it. Ending
    // an abandoned lease is the refresh flow's decision, made with a fenced
    // delete before any other request claims the row.
    const { db, env } = setup();
    const { token, id } = await insertSession(env, NOW);
    const row = (await loadServerSession(env, request(token), NOW))!;
    claim(db, id, "lease-a", NOW - 1);
    assert.equal(await conditionalSessionUpdate(db, row, "lease-a", SAVE, []), true);
    assert.equal(db.row(id)?.generation, 1);
  });

  it("releases the lease with a retry_after backoff and keeps the generation", async () => {
    const { db, env } = setup();
    const { token, id } = await insertSession(env, NOW);
    const row = (await loadServerSession(env, request(token), NOW))!;
    claim(db, id, "lease-a", NOW + 30);
    assert.equal(await conditionalSessionUpdate(db, row, "lease-a", BACK_OFF, [NOW + 15]), true);
    const released = (await loadServerSession(env, request(token), NOW))!;
    assert.equal(released.lease, null);
    assert.equal(released.lease_until, 0);
    assert.equal(released.retry_after, NOW + 15);
    assert.equal(released.generation, 0);
    // A second release from the same claim finds no lease to match.
    assert.equal(await conditionalSessionUpdate(db, row, "lease-a", BACK_OFF, [NOW + 30]), false);
  });
});

describe("expired row cleanup", () => {
  it("deletes rows at or past either expiry, up to the limit", async () => {
    const { db, env } = setup();
    const live = await insertSession(env, NOW);
    const idleNow = await insertSession(env, NOW);
    const absoluteNow = await insertSession(env, NOW);
    const idlePast = await insertSession(env, NOW);
    const cleanup = NOW + 100;
    db.set(live.id, "idle_expires_at = ?", cleanup + 1);
    db.set(idleNow.id, "idle_expires_at = ?", cleanup);
    db.set(absoluteNow.id, "absolute_expires_at = ?", cleanup);
    db.set(idlePast.id, "idle_expires_at = ?", cleanup - 1);

    assert.equal(await deleteExpiredOidcRows(env, "oidc_server_sessions", cleanup, 2), 2);
    assert.equal(await deleteExpiredOidcRows(env, "oidc_server_sessions", cleanup, 2), 1);
    assert.equal(await deleteExpiredOidcRows(env, "oidc_server_sessions", cleanup, 2), 0);
    assert.ok(db.row(live.id));
    assert.equal(await deleteExpiredOidcRows(env, "oidc_login_transactions", cleanup, 10), 0);
  });

  it("rejects an invalid time, limit or table", async () => {
    const { env } = setup();
    await assert.rejects(deleteExpiredOidcRows(env, "oidc_server_sessions", -1, 1), /time/);
    await assert.rejects(deleteExpiredOidcRows(env, "oidc_server_sessions", 1.5, 1), /time/);
    await assert.rejects(deleteExpiredOidcRows(env, "oidc_server_sessions", NOW, 0), /limit/);
    await assert.rejects(deleteExpiredOidcRows(env, "oidc_server_sessions", NOW, 1001), /limit/);
    await assert.rejects(
      deleteExpiredOidcRows(env, "notebooks" as "oidc_server_sessions", NOW, 1),
      /Unknown sign-in table/,
    );
  });
});

describe("keyring rotation", () => {
  it("reads a row sealed under the previous active key after rotation", async () => {
    const { db, keys, env } = setup();
    const bundle = { refreshToken: "refresh-before-rotation" };
    const { token, id, context } = await insertSession(env, NOW, { bundle });

    const rotated = environment(db, { active: "k2", keys: { ...keys, k2: freshKey() } });
    const [activeId, previousId] = await serverSessionIds(rotated, token);
    assert.notEqual(activeId, id);
    assert.equal(previousId, id);

    const row = await loadServerSession(rotated, request(token), NOW);
    assert.equal(row?.id, id);
    assert.match(row!.sealed, /^k1\./);
    assert.deepEqual(
      await openServerSecret(rotated, row!.sealed, `session:${id}:${context}`),
      bundle,
    );
    assert.match(await sealServerSecret(rotated, bundle, `session:${id}:${context}`), /^k2\./);
    assert.equal((await readServerAppSession(rotated, request(token), NOW))?.principal, "user-1");
  });

  it("loses a row once its key leaves the keyring", async () => {
    const { db, env } = setup();
    const { token, id, context } = await insertSession(env, NOW);
    const sealed = db.row(id)!.sealed;
    const retired = environment(db, { active: "k2", keys: { k2: freshKey() } });
    assert.equal(await loadServerSession(retired, request(token), NOW), null);
    await assert.rejects(
      openServerSecret(retired, sealed, `session:${id}:${context}`),
      /Invalid encrypted session/,
    );
  });

  it("refuses to open a seal under another row's binding", async () => {
    const { db, env } = setup();
    const { id, context } = await insertSession(env, NOW);
    const sealed = db.row(id)!.sealed;
    await assert.rejects(openServerSecret(env, sealed, `session:other:${context}`));
  });
});

describe("readServerAppSessionByIds", () => {
  it("reads an active session by derived IDs, enforces context and expiry boundaries, and drops revoked rows", async () => {
    const { db, env } = setup();
    const { token, id, context } = await insertSession(env, NOW, {
      accessExpiresAt: NOW + 600,
    });
    const ids = await serverSessionIds(env, token);
    const active = await readServerAppSessionByIds(env, ids, context, NOW);
    assert.equal(active?.principal, "user-1");

    // Wrong context or malformed IDs are refused.
    assert.equal(await readServerAppSessionByIds(env, ids, "wrong-context", NOW), null);
    assert.equal(await readServerAppSessionByIds(env, [], context, NOW), null);
    assert.equal(await readServerAppSessionByIds(env, [id, id, id], context, NOW), null);
    assert.equal(await readServerAppSessionByIds(env, [""], context, NOW), null);

    // Boundary seconds refuse expired access, idle, or absolute windows.
    assert.equal(await readServerAppSessionByIds(env, ids, context, NOW + 600), null);
    db.set(id, "access_expires_at = ?, idle_expires_at = ?", NOW + 9_999, NOW + 100);
    assert.equal(
      (await readServerAppSessionByIds(env, ids, context, NOW + 99))?.principal,
      "user-1",
    );
    assert.equal(await readServerAppSessionByIds(env, ids, context, NOW + 100), null);
    db.set(id, "idle_expires_at = ?, absolute_expires_at = ?", NOW + 9_999, NOW + 200);
    assert.equal(
      (await readServerAppSessionByIds(env, ids, context, NOW + 199))?.principal,
      "user-1",
    );
    assert.equal(await readServerAppSessionByIds(env, ids, context, NOW + 200), null);

    // Revoking the row causes immediate null.
    db.set(id, "absolute_expires_at = ?", NOW + 9_999);
    await revokeServerSession(env, request(token));
    assert.equal(await readServerAppSessionByIds(env, ids, context, NOW), null);
  });
});
