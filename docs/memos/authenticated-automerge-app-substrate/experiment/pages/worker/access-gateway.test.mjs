import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createServerAppSession } from "@cloud/app-session.ts";
import {
  oidcDatabase,
  randomSecret,
  SERVER_SESSION_COOKIE,
  serverSessionContext,
  serverSessionId,
} from "@cloud/oidc-session-store.ts";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import worker, { Page } from "./index.mjs";
import { DocumentPolicy } from "./policy.mjs";

const pageId = "33333333-3333-4333-8333-333333333333";
const publicOrigin = "https://page5.runtimed.run";
const privateOrigin = "http://127.0.0.1:9475";

async function gatewayFixture(t) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const env = {
    ...auth.env,
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: publicOrigin,
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: "fixture-only-session-secret-".repeat(2),
    DB: {
      prepare(sql) {
        const statement = sqlite.prepare(sql);
        let bindings = [];
        return {
          bind(...values) {
            bindings = values;
            return this;
          },
          async first() {
            return statement.get(...bindings) ?? null;
          },
          async run() {
            statement.run(...bindings);
            return { success: true };
          },
        };
      },
    },
  };
  await oidcDatabase(env);
  const principal = `user:anaconda-fixture:${auth.subject}`;
  const token = randomSecret();
  const now = Math.floor(Date.now() / 1000);
  const session = await createServerAppSession(
    env,
    {
      principal,
      metadata: {
        provider: "oidc",
        principalNamespace: "user:anaconda-fixture",
        displayName: "Fixture Person",
      },
    },
    "fixture-session",
    now + 300,
    now,
  );
  sqlite
    .prepare(`INSERT INTO oidc_server_sessions
    (id, context, session_json, sealed, access_expires_at, idle_expires_at, absolute_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(
      await serverSessionId(env, token),
      serverSessionContext(env, publicOrigin),
      JSON.stringify(session),
      "unused-for-session-read",
      now + 300,
      now + 300,
      now + 300,
    );
  const page = Object.assign(Object.create(Page.prototype), {
    env,
    ready: Promise.resolve(),
    tail: Promise.resolve(),
    metadata: { pageId, owner: principal, ownerName: "Fixture Person", deleted: false },
    async installAccess(metadata) {
      this.metadata = metadata;
    },
  });
  page.policy = new DocumentPolicy({ metadata: () => page.metadata });
  const forwarded = [];
  env.PAGES = {
    getByName(id) {
      assert.equal(id, pageId);
      return {
        fetch(request) {
          forwarded.push(request.clone());
          return page.fetch(request);
        },
      };
    },
  };
  return {
    env,
    page,
    forwarded,
    cookie: `${SERVER_SESSION_COOKIE}=${token}`,
    bearer: `Bearer ${auth.apiKey()}`,
    request({ method = "GET", headers = {}, body } = {}) {
      return new Request(`${privateOrigin}/api/access?page=${pageId}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
  };
}

for (const credential of ["cookie", "bearer"]) {
  test(`proxied sharing GET without Origin reauthenticates the ${credential} on the Page`, async (t) => {
    const fixture = await gatewayFixture(t);
    const response = await worker.fetch(
      fixture.request({
        headers: {
          [credential === "cookie" ? "cookie" : "authorization"]: fixture[credential],
          "x-forwarded-host": "attacker.invalid",
          "x-forwarded-proto": "http",
        },
      }),
      fixture.env,
    );
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).access.role, "owner");
    assert.equal(fixture.forwarded.length, 1);
    const internal = fixture.forwarded[0];
    assert.equal(internal.method, "POST");
    assert.equal(new URL(internal.url).origin, privateOrigin);
    assert.equal(internal.headers.get("origin"), publicOrigin);
    assert.deepEqual(await internal.json(), { read: true });
  });
}

test("the sharing gateway rejects untrusted original requests before adding internal origin evidence", async (t) => {
  const fixture = await gatewayFixture(t);
  const cases = [
    { headers: {}, status: 401 },
    { headers: { cookie: `${SERVER_SESSION_COOKIE}=${"x".repeat(43)}` }, status: 401 },
    { method: "POST", headers: { cookie: fixture.cookie }, status: 403 },
    { headers: { cookie: fixture.cookie, origin: privateOrigin }, status: 403 },
    { headers: { cookie: fixture.cookie, "sec-fetch-site": "cross-site" }, status: 403 },
    { headers: { authorization: fixture.bearer, "sec-fetch-site": "cross-site" }, status: 403 },
    ...["GET", "POST"].flatMap((method) =>
      [{ cookie: fixture.cookie }, { authorization: fixture.bearer }].map((headers) => ({
        method,
        headers: { ...headers, origin: "https://attacker.invalid" },
        status: 403,
      })),
    ),
  ];
  for (const { status, ...options } of cases) {
    const response = await worker.fetch(
      fixture.request({ ...options, ...(options.method === "POST" ? { body: {} } : {}) }),
      fixture.env,
    );
    assert.equal(response.status, status);
  }
  assert.equal(fixture.forwarded.length, 0, "denied requests never reach the Page");
  assert.equal(fixture.page.metadata.acl, undefined);
});

test("a proxied cookie sharing write still requires and preserves the explicit public Origin", async (t) => {
  const fixture = await gatewayFixture(t);
  const response = await worker.fetch(
    fixture.request({
      method: "POST",
      headers: { cookie: fixture.cookie, origin: publicOrigin },
      body: {
        action: "invite",
        email: "reader@example.invalid",
        role: "viewer",
        expected_revision: 0,
        idempotency_key: "gateway-invitation",
      },
    }),
    fixture.env,
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).access.revision, 1);
  assert.equal(fixture.forwarded[0].headers.get("origin"), publicOrigin);
  assert.equal((await fixture.forwarded[0].json()).read, false);
});
