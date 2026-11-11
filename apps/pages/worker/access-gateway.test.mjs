import assert from "node:assert/strict";
import { test } from "node:test";
import { SERVER_SESSION_COOKIE } from "@cloud/oidc-session-store.ts";
import worker, { Page } from "./index.mjs";
import { gatewayFixture, pageId, privateOrigin, publicOrigin } from "./gateway-fixture.mjs";

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
        nonce: "gateway-invitation",
      },
    }),
    fixture.env,
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).access.revision, 1);
  assert.equal(fixture.forwarded[0].headers.get("origin"), publicOrigin);
  assert.equal((await fixture.forwarded[0].json()).read, false);
});

test("a session from the single secret keeps working after the keyring rotates to k2", async (t) => {
  const fixture = await gatewayFixture(t);
  // The Page reads the same env object, so both the gateway and the Page see k2.
  fixture.env.NOTEBOOK_CLOUD_APP_SESSION_KEYS = JSON.stringify({
    active: "k2",
    keys: {
      k1: fixture.env.NOTEBOOK_CLOUD_APP_SESSION_SECRET,
      k2: "rotated-gateway-session-key-".repeat(2),
    },
  });
  const response = await worker.fetch(
    fixture.request({ headers: { cookie: fixture.cookie } }),
    fixture.env,
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).access.role, "owner");

  fixture.env.NOTEBOOK_CLOUD_APP_SESSION_KEYS = JSON.stringify({
    active: "k2",
    keys: { k2: "rotated-gateway-session-key-".repeat(2) },
  });
  const retired = await worker.fetch(
    fixture.request({ headers: { cookie: fixture.cookie } }),
    fixture.env,
  );
  assert.equal(retired.status, 401, "a k1 session id is unknown once k1 is retired");
});

test("a malformed session keyring fails every request, health included, without logging a secret", async (t) => {
  const fixture = await gatewayFixture(t);
  const secret = "private-short-secret";
  fixture.env.NOTEBOOK_CLOUD_APP_SESSION_KEYS = JSON.stringify({
    active: "k2",
    keys: { k2: secret },
  });
  const logged = [];
  t.mock.method(console, "error", (...args) => logged.push(args));
  for (const url of [`${privateOrigin}/health`, fixture.request().url]) {
    const response = await worker.fetch(
      new Request(url, { headers: { cookie: fixture.cookie } }),
      fixture.env,
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "Pages is misconfigured",
      code: "server_misconfigured",
    });
  }
  assert.equal(fixture.forwarded.length, 0);
  assert.equal(logged.length, 2);
  assert.equal(logged[0][1].event, "config.session_keys_invalid");
  assert.match(logged[0][1].reason, /key k2 is shorter than 32 bytes/);
  assert.doesNotMatch(JSON.stringify(logged), /private-short-secret/);
});
