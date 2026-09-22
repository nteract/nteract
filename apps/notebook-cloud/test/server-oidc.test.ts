import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it, type TestContext } from "node:test";
import { createLocalOidcIssuer } from "@nteract/local-oidc";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  D1Value,
  Env,
} from "../src/cloudflare-types.ts";
import { readCloudAppSession } from "../src/app-session.ts";
import {
  beginServerOidcLogin,
  completeServerOidcLogin,
  deleteServerOidcSession,
  serverOidcSessionStatus,
} from "../src/server-oidc.ts";
import { SERVER_SESSION_COOKIE } from "../src/oidc-session-store.ts";

// The repository's Node 20 type definitions predate node:sqlite, while the
// Node 22 test runtime provides it. This adapter executes actual SQLite SQL;
// it deliberately does not interpret the application's query strings.
type SqliteValue = string | number | null | Uint8Array;
interface SqliteStatement {
  all(...values: SqliteValue[]): Record<string, unknown>[];
  get(...values: SqliteValue[]): Record<string, unknown> | undefined;
  run(...values: SqliteValue[]): { changes: number | bigint };
}
interface SqliteConnection {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteConnection;
};

class SqliteD1 implements D1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  afterNextRead?: () => Promise<void>;
  prepare(sql: string): D1PreparedStatement {
    return new SqliteD1Statement(this.sqlite.prepare(sql), [], async () => {
      const afterRead = this.afterNextRead;
      this.afterNextRead = undefined;
      await afterRead?.();
    });
  }
  async exec(sql: string): Promise<D1Result> {
    this.sqlite.exec(sql);
    return { success: true, meta: {} };
  }
  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.sqlite.exec("BEGIN");
    try {
      const results: D1Result<T>[] = [];
      for (const statement of statements) results.push(await statement.run<T>());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

class SqliteD1Statement implements D1PreparedStatement {
  constructor(
    private readonly statement: SqliteStatement,
    private readonly values: SqliteValue[] = [],
    private readonly afterRead?: () => Promise<void>,
  ) {}
  bind(...values: D1Value[]): D1PreparedStatement {
    return new SqliteD1Statement(
      this.statement,
      values.map((value) =>
        typeof value === "boolean"
          ? Number(value)
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : value,
      ),
      this.afterRead,
    );
  }
  async first<T>(column?: string): Promise<T | null> {
    const row = this.statement.get(...this.values);
    await this.afterRead?.();
    return ((column ? row?.[column] : row) as T | undefined) ?? null;
  }
  async run<T>(): Promise<D1Result<T>> {
    const result = this.statement.run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
  async all<T>(): Promise<D1Result<T>> {
    return { success: true, results: this.statement.all(...this.values) as T[], meta: {} };
  }
}

const ORIGIN = "https://pr-9000.preview.example";
const CLIENT_ID = "server-oidc-test-client";
const CLIENT_SECRET = "server-only-test-client-secret";
const LOGIN_COOKIE = "__Host-nteract_cloud_oidc_login";
const nowSeconds = () => Math.floor(Date.now() / 1000);
const noopProfile = async () => {};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function cookieFrom(response: Response, name: string): string {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  assert.ok(cookie, `response must set ${name}`);
  return cookie.split(";", 1)[0]!;
}

function hasSessionCookie(response: Response): boolean {
  return response.headers
    .getSetCookie()
    .some(
      (cookie) => cookie.startsWith(`${SERVER_SESSION_COOKIE}=`) && !cookie.includes("Max-Age=0"),
    );
}

async function fixture(
  t: TestContext,
  options: { publicClient?: boolean; tokenTtlSeconds?: number } = {},
) {
  const db = new SqliteD1();
  const issuerUrl = `https://issuer-${crypto.randomUUID()}.example/auth`;
  const issuer = createLocalOidcIssuer({
    issuerUrl,
    clientId: CLIENT_ID,
    audience: "notebook-resource",
    users: { sub: "alice", email: "alice@example.com", name: "Alice" },
    allowRedirectUri: (uri) => uri === `${ORIGIN}/oidc`,
    defaultTokenTtlSeconds: options.tokenTtlSeconds ?? 300,
  });
  const env: Env = {
    NOTEBOOK_ROOMS: {
      idFromName: () => {
        throw new Error("auth must not access notebook rooms");
      },
      get: () => {
        throw new Error("auth must not access notebook rooms");
      },
    },
    DB: db,
    NOTEBOOK_CLOUD_OIDC_FLOW: "server",
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: ORIGIN,
    NOTEBOOK_CLOUD_OIDC_ISSUER: issuerUrl,
    NOTEBOOK_CLOUD_OIDC_CLIENT_ID: CLIENT_ID,
    NOTEBOOK_CLOUD_OIDC_AUDIENCE: "notebook-resource",
    NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "user:test",
    NOTEBOOK_CLOUD_OIDC_JWKS_JSON: JSON.stringify(await issuer.jwks()),
    ...(options.publicClient ? {} : { NOTEBOOK_CLOUD_OIDC_CLIENT_SECRET: CLIENT_SECRET }),
    NOTEBOOK_CLOUD_OIDC_TOKEN_AUTH_METHOD: options.publicClient ? "none" : "client_secret_basic",
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: "test-session-encryption-key-with-at-least-32-bytes",
  };
  const originalFetch = globalThis.fetch;
  const calls: { grant: string; form: URLSearchParams; authorization: string | null }[] = [];
  const secrets: string[] = [CLIENT_SECRET, env.NOTEBOOK_CLOUD_APP_SESSION_SECRET!];
  const refreshTokens = new Map<string, string>();
  let refreshFailure: "unavailable" | "invalid_grant" | "auth_required" | undefined;
  let refreshGate:
    | { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }
    | undefined;
  let tamperVerifier = false;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(
      new URL(request.url).origin,
      new URL(issuerUrl).origin,
      "unexpected network request",
    );
    assert.equal(init?.redirect, "error", "provider requests must refuse redirects");
    if (new URL(request.url).pathname.endsWith("/token")) {
      const form = new URLSearchParams(await request.text());
      const grant = form.get("grant_type") ?? "";
      calls.push({
        grant,
        form: new URLSearchParams(form),
        authorization: request.headers.get("Authorization"),
      });
      assert.equal(
        request.headers.get("Authorization"),
        options.publicClient ? null : `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
      );
      assert.equal(form.get("client_secret"), null);
      if (grant === "refresh_token") {
        if (refreshGate) {
          refreshGate.entered.resolve();
          await refreshGate.release.promise;
        }
        if (refreshFailure === "unavailable")
          return new Response("provider unavailable", { status: 503 });
        if (refreshFailure === "auth_required")
          return Response.json({ error: { code: "auth_required" } }, { status: 403 });
        const opaque = form.get("refresh_token") ?? "";
        const providerToken = refreshTokens.get(opaque);
        if (refreshFailure === "invalid_grant" || !providerToken) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        // Consume the old grant before responding, as a rotating provider does.
        refreshTokens.delete(opaque);
        form.set("refresh_token", providerToken);
      }
      if (tamperVerifier) form.set("code_verifier", "a-different-verifier");
      const response = await issuer.handle(
        new Request(request.url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form,
        }),
      );
      assert.ok(response);
      if (!response.ok) return response;
      const tokens = (await response.json()) as Record<string, string | number>;
      const opaque = `provider-refresh-${crypto.randomUUID()}`;
      refreshTokens.set(opaque, String(tokens.refresh_token));
      tokens.refresh_token = opaque;
      secrets.push(String(tokens.access_token), String(tokens.id_token), opaque);
      return Response.json(tokens);
    }
    const response = await issuer.handle(request);
    assert.ok(response);
    return response;
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    db.sqlite.close();
  });

  const request = (path = "/api/auth/session", cookie?: string) =>
    new Request(`${ORIGIN}${path}`, {
      headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: ORIGIN },
    });
  const start = async (returnTo = "/n/test?mode=edit") => {
    const response = await beginServerOidcLogin(
      request(`/api/auth/login?return_to=${encodeURIComponent(returnTo)}`),
      env,
    );
    assert.equal(response.status, 302);
    const authorizationUrl = new URL(response.headers.get("Location")!);
    const cookie = cookieFrom(response, LOGIN_COOKIE);
    return { response, authorizationUrl, cookie };
  };
  const authorize = async (url: URL) => {
    const response = await issuer.handle(new Request(url));
    assert.ok(response);
    assert.equal(response.status, 302);
    return new URL(response.headers.get("Location")!);
  };
  const finish = (url: URL, cookie?: string, targetEnv = env) =>
    completeServerOidcLogin(
      new Request(url, {
        headers: cookie ? { Cookie: cookie } : {},
      }),
      targetEnv,
      noopProfile,
    );
  const login = async () => {
    const started = await start();
    const callback = await authorize(started.authorizationUrl);
    const response = await finish(callback, started.cookie);
    assert.equal(response.status, 303);
    return {
      ...started,
      callback,
      completed: response,
      sessionCookie: cookieFrom(response, SERVER_SESSION_COOKIE),
    };
  };
  const countRows = () =>
    Number(db.sqlite.prepare("SELECT count(*) AS n FROM oidc_server_sessions").get()!.n);
  const expireAccess = (remainingSeconds = 30) => {
    const expiry = nowSeconds() + remainingSeconds;
    db.sqlite
      .prepare(
        "UPDATE oidc_server_sessions SET access_expires_at = ?, session_json = json_set(session_json, '$.expiresAt', ?)",
      )
      .run(expiry, expiry);
  };
  return {
    env,
    db,
    calls,
    secrets,
    request,
    start,
    authorize,
    finish,
    login,
    countRows,
    expireAccess,
    setRefreshFailure(value: typeof refreshFailure) {
      refreshFailure = value;
    },
    setTamperVerifier() {
      tamperVerifier = true;
    },
    gateRefresh() {
      refreshGate = { entered: deferred(), release: deferred() };
      return refreshGate;
    },
  };
}

describe("server OIDC with SQLite persistence", { concurrency: false }, () => {
  it("completes PKCE login and reads the same identity through the app session gate", async (t) => {
    const f = await fixture(t);
    const login = await f.login();
    assert.equal(login.authorizationUrl.searchParams.get("code_challenge_method"), "S256");
    assert.equal(login.authorizationUrl.searchParams.get("redirect_uri"), `${ORIGIN}/oidc`);
    assert.ok(login.authorizationUrl.searchParams.get("nonce"));
    assert.equal(login.completed.headers.get("Location"), "/n/test?mode=edit");
    assert.equal(login.completed.headers.get("Cache-Control"), "no-store");
    assert.equal(login.completed.headers.get("Referrer-Policy"), "no-referrer");
    const tokenRequest = f.calls.find((call) => call.grant === "authorization_code")!;
    const verifier = tokenRequest.form.get("code_verifier")!;
    const challenge = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ).toString("base64url");
    assert.equal(login.authorizationUrl.searchParams.get("code_challenge"), challenge);
    assert.equal(
      f.db.sqlite.prepare("SELECT count(*) AS n FROM oidc_login_transactions").get()!.n,
      0,
    );
    const request = f.request(undefined, login.sessionCookie);
    const identity = await readCloudAppSession(f.env, request);
    assert.equal(identity?.principal, "user:test:alice");
    assert.equal(identity?.displayName, "Alice");
    const status = await serverOidcSessionStatus(request, f.env, noopProfile);
    assert.equal(status.status, 200);
    const body = await status.json();
    assert.equal(body.session.cache_key, identity?.cacheKey);
    assert.equal(f.calls.length, 1, "reading a fresh session never exchanges tokens again");

    const visible =
      [login.completed.headers, status.headers]
        .map((headers) => JSON.stringify([...headers]))
        .join("\n") + JSON.stringify(body);
    for (const secret of [...f.secrets, verifier]) assert.equal(visible.includes(secret), false);
    const row = f.db.sqlite.prepare("SELECT * FROM oidc_server_sessions").get()!;
    for (const secret of f.secrets) assert.equal(JSON.stringify(row).includes(secret), false);
    assert.match(login.completed.headers.get("Set-Cookie")!, /HttpOnly; Secure; SameSite=Lax/);
    assert.doesNotMatch(login.completed.headers.get("Set-Cookie")!, /Domain=/i);
  });

  it("rejects wrong state, missing or wrong browser cookies and callback replay", async (t) => {
    const f = await fixture(t);
    const started = await f.start();
    const callback = await f.authorize(started.authorizationUrl);
    const wrongState = new URL(callback);
    wrongState.searchParams.set("state", "a".repeat(43));
    for (const [url, cookie] of [
      [wrongState, started.cookie],
      [callback, undefined],
      [callback, `${LOGIN_COOKIE}=wrong-browser`],
    ] as const) {
      const response = await f.finish(url, cookie);
      assert.equal(response.status, 400);
      assert.equal(hasSessionCookie(response), false);
    }
    assert.equal(f.calls.length, 0, "unbound callbacks never reach token exchange");
    assert.equal((await f.finish(callback, started.cookie)).status, 303);
    assert.equal((await f.finish(callback, started.cookie)).status, 400);
    assert.equal(f.calls.length, 1);
    assert.equal(f.countRows(), 1);
  });

  it("rejects expired transactions, duplicate state and callbacks on another preview", async (t) => {
    const f = await fixture(t);
    const started = await f.start();
    const callback = await f.authorize(started.authorizationUrl);
    const duplicate = new URL(callback);
    duplicate.searchParams.append("state", callback.searchParams.get("state")!);
    assert.equal((await f.finish(duplicate, started.cookie)).status, 400);
    assert.equal(
      (
        await f.finish(callback, started.cookie, {
          ...f.env,
          NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://another.preview.example",
        })
      ).status,
      400,
    );
    f.db.sqlite.prepare("UPDATE oidc_login_transactions SET expires_at = ?").run(nowSeconds() - 1);
    assert.equal((await f.finish(callback, started.cookie)).status, 400);
    assert.equal(f.calls.length, 0);
    assert.equal(f.countRows(), 0);
  });

  it("enforces provider PKCE and signed ID-token nonce rather than trusting the callback", async (t) => {
    const f = await fixture(t);
    const nonceAttempt = await f.start();
    nonceAttempt.authorizationUrl.searchParams.set("nonce", "attacker-nonce");
    const nonceResponse = await f.finish(
      await f.authorize(nonceAttempt.authorizationUrl),
      nonceAttempt.cookie,
    );
    assert.equal(nonceResponse.status, 400);
    assert.equal(f.countRows(), 0);
    const pkceAttempt = await f.start();
    const callback = await f.authorize(pkceAttempt.authorizationUrl);
    f.setTamperVerifier();
    assert.equal((await f.finish(callback, pkceAttempt.cookie)).status, 400);
    assert.equal(f.countRows(), 0);
    assert.equal(
      (await f.finish(callback, pkceAttempt.cookie)).status,
      400,
      "failed exchange consumes the transaction",
    );
  });

  it("rejects foreign login origins and refuses external or auth-loop return URLs", async (t) => {
    const f = await fixture(t);
    for (const headers of [
      new Headers({ Origin: "https://attacker.example" }),
      new Headers({ "Sec-Fetch-Site": "cross-site" }),
    ]) {
      const response = await beginServerOidcLogin(
        new Request(`${ORIGIN}/api/auth/login`, { headers }),
        f.env,
      );
      assert.equal(response.status, 403);
    }
    for (const returnTo of [
      "https://attacker.example",
      "//attacker.example",
      "/\\attacker.example",
      "/oidc",
      "/api/auth/login",
    ]) {
      const started = await f.start(returnTo);
      const response = await f.finish(await f.authorize(started.authorizationUrl), started.cookie);
      assert.equal(response.status, 303);
      assert.equal(response.headers.get("Location"), "/");
    }
  });

  it("serializes concurrent refresh and stores the provider's rotated refresh token", async (t) => {
    const f = await fixture(t);
    const { sessionCookie } = await f.login();
    const request = f.request(undefined, sessionCookie);
    const original = await readCloudAppSession(f.env, request);
    f.expireAccess();
    const gate = f.gateRefresh();
    const first = serverOidcSessionStatus(request, f.env, noopProfile);
    await gate.entered.promise;
    const second = serverOidcSessionStatus(request, f.env, noopProfile);
    gate.release.resolve();
    const responses = await Promise.all([first, second]);
    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.equal((await response.json()).session.cache_key, original?.cacheKey);
    }
    assert.equal(f.calls.filter((call) => call.grant === "refresh_token").length, 1);
    f.expireAccess();
    assert.equal((await serverOidcSessionStatus(request, f.env, noopProfile)).status, 200);
    const refreshes = f.calls.filter((call) => call.grant === "refresh_token");
    assert.equal(refreshes.length, 2);
    assert.notEqual(
      refreshes[0]!.form.get("refresh_token"),
      refreshes[1]!.form.get("refresh_token"),
    );
    assert.equal(
      f.db.sqlite.prepare("SELECT generation FROM oidc_server_sessions").get()!.generation,
      2,
    );
  });

  it("logout during an in-flight refresh cannot recreate the revoked session", async (t) => {
    const f = await fixture(t);
    const { sessionCookie } = await f.login();
    const request = f.request(undefined, sessionCookie);
    f.expireAccess();
    const gate = f.gateRefresh();
    const pending = serverOidcSessionStatus(request, f.env, noopProfile);
    await gate.entered.promise;
    const logout = await deleteServerOidcSession(request, f.env);
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("Set-Cookie")!, /Max-Age=0/);
    assert.equal(await readCloudAppSession(f.env, request), null);
    gate.release.resolve();
    const completed = await pending;
    assert.equal(completed.status, 200);
    assert.equal((await completed.json()).session, null);
    assert.equal(hasSessionCookie(completed), false);
    assert.equal(f.countRows(), 0);
    assert.equal(await readCloudAppSession(f.env, request), null);
  });

  it("requires sign-in after an expired refresh lease and discards a late owner's response", async (t) => {
    const f = await fixture(t);
    const { sessionCookie } = await f.login();
    const request = f.request(undefined, sessionCookie);
    f.expireAccess();
    const gate = f.gateRefresh();
    const stalledOwner = serverOidcSessionStatus(request, f.env, noopProfile);
    await gate.entered.promise;
    f.db.sqlite.prepare("UPDATE oidc_server_sessions SET lease_until = ?").run(nowSeconds() - 1);
    const afterCrash = await serverOidcSessionStatus(request, f.env, noopProfile);
    assert.equal(afterCrash.status, 200);
    assert.equal((await afterCrash.json()).session, null);
    assert.equal(f.countRows(), 0);
    gate.release.resolve();
    const lateResponse = await stalledOwner;
    assert.equal(lateResponse.status, 200);
    assert.equal((await lateResponse.json()).session, null);
    assert.equal(f.countRows(), 0);
    assert.equal(
      f.calls.filter((call) => call.grant === "refresh_token").length,
      1,
      "an expired lease must never retry the possibly consumed refresh token",
    );
  });

  it("rejects ciphertext swapped between login transactions or session records", async (t) => {
    const f = await fixture(t);
    const first = await f.start();
    await f.start();
    const transactions = f.db.sqlite
      .prepare("SELECT state_hash, sealed FROM oidc_login_transactions ORDER BY rowid")
      .all();
    f.db.sqlite
      .prepare("UPDATE oidc_login_transactions SET sealed = ? WHERE state_hash = ?")
      .run(String(transactions[1]!.sealed), String(transactions[0]!.state_hash));
    const callback = await f.authorize(first.authorizationUrl);
    assert.equal((await f.finish(callback, first.cookie)).status, 400);
    assert.equal(f.calls.length, 0, "bad ciphertext is rejected before any code exchange");
    assert.equal(f.countRows(), 0);

    const login = await f.login();
    await f.login();
    const sessions = f.db.sqlite
      .prepare("SELECT id, sealed FROM oidc_server_sessions ORDER BY rowid")
      .all();
    f.db.sqlite
      .prepare("UPDATE oidc_server_sessions SET sealed = ? WHERE id = ?")
      .run(String(sessions[1]!.sealed), String(sessions[0]!.id));
    f.expireAccess(-1);
    const request = f.request(undefined, login.sessionCookie);
    assert.equal((await serverOidcSessionStatus(request, f.env, noopProfile)).status, 503);
    assert.equal(await readCloudAppSession(f.env, request), null);
    assert.equal(f.calls.filter((call) => call.grant === "refresh_token").length, 0);
  });

  it("rejects encrypted login and refresh credentials with a different deployment key", async (t) => {
    const f = await fixture(t);
    const wrongKey = {
      ...f.env,
      NOTEBOOK_CLOUD_APP_SESSION_SECRET: "different-deployment-key-with-at-least-32-bytes",
    };
    const started = await f.start();
    const callback = await f.authorize(started.authorizationUrl);
    assert.equal((await f.finish(callback, started.cookie, wrongKey)).status, 400);
    assert.equal(f.calls.length, 0);
    const { sessionCookie } = await f.login();
    const request = f.request(undefined, sessionCookie);
    assert.ok(await readCloudAppSession(f.env, request));
    assert.equal(await readCloudAppSession(wrongKey, request), null);
    const signedOut = await serverOidcSessionStatus(request, wrongKey, noopProfile);
    assert.equal(signedOut.status, 200);
    assert.equal((await signedOut.json()).session, null);
    assert.match(signedOut.headers.get("Set-Cookie")!, /Max-Age=0/);
    assert.equal(f.calls.filter((call) => call.grant === "refresh_token").length, 0);
    assert.equal(f.countRows(), 1, "key mismatch does not destroy the recoverable session record");
  });

  it("supports public PKCE clients without transmitting a client secret", async (t) => {
    const f = await fixture(t, { publicClient: true });
    const { sessionCookie } = await f.login();
    assert.equal(f.env.NOTEBOOK_CLOUD_OIDC_CLIENT_SECRET, undefined);
    const request = f.request(undefined, sessionCookie);
    assert.equal((await readCloudAppSession(f.env, request))?.principal, "user:test:alice");
    f.expireAccess();
    assert.equal((await serverOidcSessionStatus(request, f.env, noopProfile)).status, 200);
    assert.equal(f.calls.length, 2);
    for (const call of f.calls) {
      assert.equal(call.authorization, null);
      assert.equal(call.form.get("client_secret"), null);
      assert.equal(call.form.get("client_id"), CLIENT_ID);
    }
    assert.ok(f.calls[0]!.form.get("code_verifier"));
  });

  it("preserves the row on provider 503 but never authorizes an expired access proof", async (t) => {
    const f = await fixture(t);
    const { sessionCookie } = await f.login();
    const request = f.request(undefined, sessionCookie);
    f.expireAccess();
    f.setRefreshFailure("unavailable");
    const unavailable = await serverOidcSessionStatus(request, f.env, noopProfile);
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get("Set-Cookie"), null);
    assert.equal(f.countRows(), 1);
    assert.ok(
      await readCloudAppSession(f.env, request),
      "still-valid proof survives a temporary outage",
    );
    f.expireAccess(-1);
    assert.equal(await readCloudAppSession(f.env, request), null);
    assert.equal((await serverOidcSessionStatus(request, f.env, noopProfile)).status, 503);
    assert.equal(
      f.calls.filter((call) => call.grant === "refresh_token").length,
      1,
      "retry backoff prevents another provider call",
    );
    f.setRefreshFailure(undefined);
    f.db.sqlite.prepare("UPDATE oidc_server_sessions SET retry_after = 0").run();
    const recovered = await serverOidcSessionStatus(request, f.env, noopProfile);
    assert.equal(recovered.status, 200);
    assert.ok((await recovered.json()).session);
    assert.ok(await readCloudAppSession(f.env, request));
  });

  it("extends active idle sessions with long access tokens without refreshing their identity proof", async (t) => {
    const f = await fixture(t, { tokenTtlSeconds: 12 * 60 * 60 });
    const { sessionCookie } = await f.login();
    const request = f.request(undefined, sessionCookie);
    const original = await readCloudAppSession(f.env, request);
    assert.ok(original);
    assert.ok(original.identityVerifiedAt);
    const originalRow = f.db.sqlite.prepare("SELECT * FROM oidc_server_sessions").get()!;
    const nearIdleExpiry = Number(originalRow.idle_expires_at) - 30;
    t.mock.method(Date, "now", () => nearIdleExpiry * 1000);

    assert.ok(await readCloudAppSession(f.env, request));
    assert.equal(
      f.db.sqlite.prepare("SELECT idle_expires_at FROM oidc_server_sessions").get()!
        .idle_expires_at,
      originalRow.idle_expires_at,
      "the common authorization read must not slide idle expiry",
    );
    const response = await serverOidcSessionStatus(request, f.env, noopProfile);
    assert.equal(response.status, 200);
    const body = await response.json();
    const updated = await readCloudAppSession(f.env, request);
    assert.ok(updated);
    assert.equal(updated.expiresAt, nearIdleExpiry + 6 * 60 * 60);
    assert.equal(body.session.expires_at, updated.expiresAt);
    assert.equal(updated.cacheKey, original.cacheKey);
    assert.equal(updated.issuedAt, original.issuedAt);
    assert.equal(updated.identityVerifiedAt, original.identityVerifiedAt);
    assert.equal(updated.verifiedEmailBinding, original.verifiedEmailBinding);
    assert.equal(
      f.calls.length,
      1,
      "an unexpired long-lived access token needs no provider exchange",
    );
    assert.equal(
      f.db.sqlite.prepare("SELECT idle_expires_at FROM oidc_server_sessions").get()!
        .idle_expires_at,
      nearIdleExpiry + 6 * 60 * 60,
    );
  });

  it("bounds idle extension by absolute expiry and cannot resurrect an already idle-expired session", async (t) => {
    const f = await fixture(t, { tokenTtlSeconds: 12 * 60 * 60 });
    const { sessionCookie } = await f.login();
    const request = f.request(undefined, sessionCookie);
    const originalRow = f.db.sqlite.prepare("SELECT * FROM oidc_server_sessions").get()!;
    let current = Number(originalRow.idle_expires_at) - 30;
    t.mock.method(Date, "now", () => current * 1000);
    const absoluteExpiry = current + 300;
    f.db.sqlite
      .prepare("UPDATE oidc_server_sessions SET absolute_expires_at = ?")
      .run(absoluteExpiry);
    const renewed = await serverOidcSessionStatus(request, f.env, noopProfile);
    assert.equal(renewed.status, 200);
    assert.equal((await renewed.json()).session.expires_at, absoluteExpiry);
    assert.equal(
      f.db.sqlite.prepare("SELECT idle_expires_at FROM oidc_server_sessions").get()!
        .idle_expires_at,
      absoluteExpiry,
    );

    // Restore a later absolute bound to distinguish idle expiry from absolute expiry.
    f.db.sqlite
      .prepare("UPDATE oidc_server_sessions SET absolute_expires_at = ?")
      .run(absoluteExpiry + 3600);
    current = absoluteExpiry + 1;
    assert.equal(await readCloudAppSession(f.env, request), null);
    const expired = await serverOidcSessionStatus(request, f.env, noopProfile);
    assert.equal(expired.status, 200);
    assert.equal((await expired.json()).session, null);
    assert.equal(hasSessionCookie(expired), false);
    assert.equal(
      f.db.sqlite.prepare("SELECT idle_expires_at FROM oidc_server_sessions").get()!
        .idle_expires_at,
      absoluteExpiry,
    );
    assert.equal(f.calls.length, 1);
  });

  it("does not renew or restore a session when logout races an idle extension", async (t) => {
    const f = await fixture(t, { tokenTtlSeconds: 12 * 60 * 60 });
    const { sessionCookie } = await f.login();
    const request = f.request(undefined, sessionCookie);
    const row = f.db.sqlite.prepare("SELECT idle_expires_at FROM oidc_server_sessions").get()!;
    t.mock.method(Date, "now", () => (Number(row.idle_expires_at) - 30) * 1000);
    const read = deferred();
    const resume = deferred();
    f.db.afterNextRead = async () => {
      read.resolve();
      await resume.promise;
    };
    const pending = serverOidcSessionStatus(request, f.env, noopProfile);
    await read.promise;
    assert.equal((await deleteServerOidcSession(request, f.env)).status, 200);
    assert.equal(f.countRows(), 0);
    resume.resolve();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).session, null);
    assert.equal(hasSessionCookie(response), false);
    assert.equal(await readCloudAppSession(f.env, request), null);
    assert.equal(f.countRows(), 0);
    assert.equal(f.calls.length, 1);
  });

  it("treats Anaconda auth_required as rejected refresh authority rather than a temporary outage", async (t) => {
    const f = await fixture(t);
    const { sessionCookie } = await f.login();
    const request = f.request(undefined, sessionCookie);
    f.expireAccess();
    f.setRefreshFailure("auth_required");
    const response = await serverOidcSessionStatus(request, f.env, noopProfile);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).session, null);
    assert.equal(f.countRows(), 0);
    assert.equal(await readCloudAppSession(f.env, request), null);
    assert.equal(hasSessionCookie(response), false);
    assert.equal(f.calls.filter((call) => call.grant === "refresh_token").length, 1);
  });

  it("revokes rejected refresh grants and rejects origin/client/issuer session transplantation", async (t) => {
    const f = await fixture(t);
    const { sessionCookie } = await f.login();
    const request = f.request(undefined, sessionCookie);
    for (const difference of [
      { NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pr-9001.preview.example" },
      { NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "another-client" },
      { NOTEBOOK_CLOUD_OIDC_ISSUER: "https://different-issuer.example" },
    ])
      assert.equal(await readCloudAppSession({ ...f.env, ...difference }, request), null);
    f.expireAccess();
    f.setRefreshFailure("invalid_grant");
    const response = await serverOidcSessionStatus(request, f.env, noopProfile);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).session, null);
    assert.equal(f.countRows(), 0);
    assert.equal(await readCloudAppSession(f.env, request), null);
  });

  it("refuses duplicate session cookies and expired absolute or idle sessions", async (t) => {
    const f = await fixture(t);
    const { sessionCookie } = await f.login();
    assert.equal(
      await readCloudAppSession(f.env, f.request(undefined, `${sessionCookie}; ${sessionCookie}`)),
      null,
    );
    const request = f.request(undefined, sessionCookie);
    const now = nowSeconds();
    f.db.sqlite.prepare("UPDATE oidc_server_sessions SET idle_expires_at = ?").run(now - 1);
    assert.equal(await readCloudAppSession(f.env, request), null);
    f.db.sqlite
      .prepare("UPDATE oidc_server_sessions SET idle_expires_at = ?, absolute_expires_at = ?")
      .run(now + 300, now - 1);
    assert.equal(await readCloudAppSession(f.env, request), null);
    const status = await serverOidcSessionStatus(request, f.env, noopProfile);
    assert.equal((await status.json()).session, null);
    assert.equal(f.calls.length, 1);
  });
});
