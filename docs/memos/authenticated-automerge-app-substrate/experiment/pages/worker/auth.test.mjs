import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { authenticate, requireSameOrigin, readJson, errorResponse, logFailure } from "./auth.mjs";

test("API keys use production scope checks and ignore claimed account/operator headers", async (t) => {
  const fixture = await createAuthFixture();
  t.mock.method(globalThis, "fetch", fixture.fetch);
  const request = (token) =>
    new Request("https://pages.invalid/api/connect?page=test", {
      headers: {
        authorization: `Bearer ${token}`,
        "x-pages-driver": "ChatGPT",
        "x-principal": "system:admin",
        "x-scope": "editor",
        "x-operator": "administrator",
        "x-notebook-cloud-principal": "system:admin",
      },
    });
  const identity = await authenticate(request(fixture.apiKey()), fixture.env);
  assert.equal(identity.principal, `user:anaconda-fixture:${fixture.subject}`);
  assert.equal(identity.displayName, "Fixture Person");
  assert.equal(identity.driver, "ChatGPT");
  assert.equal(identity.canWrite, true);
  const reader = await authenticate(
    request(fixture.apiKey({ scopes: ["cloud:read"] })),
    fixture.env,
  );
  assert.equal(reader.canWrite, false);
  await assert.rejects(
    authenticate(request(fixture.apiKey({ scopes: [] })), fixture.env),
    /scopes do not allow/,
  );
});

test("cookie writes and WebSocket upgrades require same-origin, API keys never permit foreign Origin", () => {
  const env = { NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.invalid" };
  assert.throws(
    () =>
      requireSameOrigin(
        new Request("https://pages.invalid/api/tools", {
          method: "POST",
          headers: { cookie: "some-session" },
        }),
        env,
      ),
    /Origin is required/,
  );
  assert.throws(
    () =>
      requireSameOrigin(
        new Request("https://pages.invalid/api/sync", {
          headers: { cookie: "some-session", upgrade: "websocket", origin: "https://evil.invalid" },
        }),
        env,
      ),
    /Pages origin/,
  );
  assert.throws(
    () =>
      requireSameOrigin(
        new Request("https://pages.invalid/api/tools", {
          method: "POST",
          headers: { authorization: "Bearer key", origin: "https://evil.invalid" },
        }),
        env,
      ),
    /Pages origin/,
  );
  requireSameOrigin(
    new Request("https://pages.invalid/api/tools", {
      method: "POST",
      headers: { authorization: "Bearer key" },
    }),
    env,
  );
});

test("JSON API bounds body memory and rejects malformed input", async () => {
  await assert.rejects(
    readJson(new Request("https://pages.invalid/", { method: "POST", body: "x" })),
    /Invalid JSON/,
  );
  await assert.rejects(
    readJson(
      new Request("https://pages.invalid/", { method: "POST", body: "x".repeat(1024 * 1024 + 1) }),
    ),
    /too large/,
  );
});

test("server diagnostics identify the boundary without exposing provider errors or credentials", async (t) => {
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  const failure = Object.assign(new Error("provider body contains secret-token"), {
    name: "AuthError",
    status: 503,
  });
  const response = errorResponse(failure, "gateway");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Pages request failed" });
  assert.equal(logs[0][1].stage, "gateway");
  assert.equal(logs[0][1].errorType, "AuthError");
  assert.equal(logs[0][1].status, 503);
  assert.equal(JSON.stringify(logs).includes("secret-token"), false);
  errorResponse(Object.assign(new Error("Sign in"), { status: 401 }), "page");
  assert.equal(logs.length, 1, "ordinary denied HTTP requests are not server failures");
  logFailure(
    Object.assign(new Error("token"), { name: "sensitive-token-name", status: 403 }),
    "native-admission",
  );
  assert.equal(logs[1][1].errorType, "Error");
  assert.equal(JSON.stringify(logs).includes("token"), false);
});
