import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createServerAppSession } from "@cloud/app-session.ts";
import {
  oidcDatabase,
  randomSecret,
  sealServerSecret,
  serverSessionContext,
  serverSessionId,
  SERVER_SESSION_COOKIE,
} from "@cloud/oidc-session-store.ts";
import worker from "./index.mjs";

const origin = "https://page10.example";
const LOGIN_COOKIE = "__Host-nteract_cloud_oidc_login";

class SqliteD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
  }
  prepare(sql) {
    const build = (values = []) => ({
      bind: (...next) => build(next),
      first: async () => this.sqlite.prepare(sql).get(...values) ?? null,
      all: async () => ({ success: true, results: this.sqlite.prepare(sql).all(...values) }),
      run: async () => ({
        success: true,
        meta: { changes: Number(this.sqlite.prepare(sql).run(...values).changes) },
      }),
    });
    return build();
  }
}

function fixture(t) {
  const env = {
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
    NOTEBOOK_CLOUD_OIDC_FLOW: "server",
    NOTEBOOK_CLOUD_OIDC_ISSUER: "https://issuer.example",
    NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "oidc-client",
    NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "user:anaconda",
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: "sign-in-failure-fixture-".repeat(3),
    DB: new SqliteD1(),
  };
  t.after(() => env.DB.sqlite.close());
  return env;
}

async function signedIn(env) {
  await oidcDatabase(env);
  const now = Math.floor(Date.now() / 1000);
  const token = randomSecret(),
    id = await serverSessionId(env, token);
  const context = serverSessionContext(env, origin);
  const app = await createServerAppSession(
    env,
    {
      principal: "user:anaconda:person",
      metadata: { provider: "oidc", principalNamespace: "user:anaconda" },
    },
    id,
    now + 3600,
    now,
  );
  await env.DB.prepare(
    "INSERT INTO oidc_server_sessions (id,context,session_json,sealed,access_expires_at,idle_expires_at,absolute_expires_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      context,
      JSON.stringify(app),
      await sealServerSecret(env, {}, `session:${id}:${context}`),
      now + 3600,
      now + 7200,
      now + 86400,
    )
    .run();
  return `${SERVER_SESSION_COOKIE}=${token}`;
}

// The shape of the callback Kyle hit on iOS Safari: a provider redirect that
// arrives in a browser context holding no login cookie for this sign-in.
const state = "s".repeat(43);
const callback = (cookie) =>
  new Request(`${origin}/oidc?state=${state}&code=provider-code`, {
    headers: {
      "Sec-Fetch-Site": "cross-site",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
      ...(cookie ? { cookie } : {}),
    },
  });

test("a refused sign-in callback is a Pages HTML page with same-origin ways back, not a download", async (t) => {
  const env = fixture(t);
  const records = [];
  t.mock.method(console, "warn", (_prefix, record) => records.push(record));
  for (const cookie of [undefined, `${LOGIN_COOKIE}=${"b".repeat(43)}`]) {
    const response = await worker.fetch(callback(cookie), env);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(response.headers.get("content-disposition"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
    assert.match(
      response.headers.getSetCookie().join("\n"),
      new RegExp(`${LOGIN_COOKIE}=;.*Max-Age=0`),
    );
    const body = await response.text();
    assert.match(body, /^<!doctype html>/);
    assert.match(body, /<title>Sign-in didn&#39;t finish · Pages<\/title>/);
    assert.match(
      body,
      /<a class="primary setup-action" href="\/api\/auth\/login\?return_to=%2Fpages">Sign in again<\/a>/,
    );
    assert.match(body, /<a href="\/pages">Back to Pages<\/a>/);
    assert.doesNotMatch(body, /notebook site/);
    for (const detail of [state, "provider-code", "login_", "callback_"])
      assert.equal(body.includes(detail), false, `the page must not reveal ${detail}`);
  }
  assert.deepEqual(
    records
      .filter((record) => record.event === "auth.server_callback.failed")
      .map(({ phase, kind, reason }) => ({ phase, kind, reason })),
    [
      { phase: "callback_transaction", kind: "callback_rejected", reason: "login_binding_missing" },
      {
        phase: "callback_transaction",
        kind: "callback_rejected",
        reason: "login_transaction_missing",
      },
    ],
  );
});

test("a stale callback in a browser that is already signed in goes to the Pages index", async (t) => {
  const env = fixture(t);
  t.mock.method(console, "warn", () => {});
  const session = await signedIn(env);
  for (const cookie of [session, `${LOGIN_COOKIE}=${"b".repeat(43)}; ${session}`]) {
    const response = await worker.fetch(callback(cookie), env);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/pages");
    assert.equal(
      response.headers
        .getSetCookie()
        .some((value) => value.startsWith(SERVER_SESSION_COOKIE + "=")),
      false,
      "a stale callback never replaces the session",
    );
  }
});
