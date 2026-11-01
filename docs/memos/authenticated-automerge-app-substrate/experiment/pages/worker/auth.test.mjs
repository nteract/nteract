import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import {
  agentLabel,
  authenticate,
  bearerDriver,
  requireSameOrigin,
  readJson,
  errorResponse,
  logFailure,
} from "./auth.mjs";
import worker from "./index.mjs";
import { recordPersistenceTimeout } from "./record-persistence.mjs";

test("authenticated sessions advertise Wordgard regardless of legacy editor configuration", async (t) => {
  const fixture = await createAuthFixture();
  t.mock.method(globalThis, "fetch", fixture.fetch);
  const token = fixture.apiKey();
  for (const configured of [undefined, "prosemirror", "wordgard"]) {
    const response = await worker.fetch(
      new Request("https://pages.invalid/api/auth/session", {
        headers: { authorization: `Bearer ${token}` },
      }),
      { ...fixture.env, PAGES_EDITOR: configured },
    );
    assert.equal(response.status, 200);
    const session = await response.json();
    assert.equal(session.editor, "wordgard");
    assert.equal(session.canWrite, true);
  }
});

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

test("an API key can't present itself as a person in the browser", async (t) => {
  const fixture = await createAuthFixture();
  t.mock.method(globalThis, "fetch", fixture.fetch);
  const token = fixture.apiKey();
  const as = (headers, query = "") =>
    authenticate(
      new Request(`https://pages.invalid/api/connect?page=test${query}`, {
        headers: { authorization: `Bearer ${token}`, ...headers },
      }),
      fixture.env,
    );
  for (const label of ["Browser", " browser ", "BROWSER"])
    assert.equal((await as({ "x-pages-driver": label })).driver, "API", label);
  assert.equal((await as({}, "&driver=Browser")).driver, "API");
  assert.equal((await as({})).driver, "API");
  assert.equal((await as({ "x-pages-driver": "Kilo" })).driver, "Kilo");
  assert.equal((await as({ "x-pages-driver": "Browser extension" })).driver, "Browser extension");
  // The agent label is a separate field and doesn't change the driver.
  const agent = await as({ "x-pages-driver": "Browser", "x-pages-agent": "release agent" });
  assert.equal(agent.driver, "API");
  assert.equal(agent.agent, "release agent");
  assert.equal(bearerDriver("Browser"), "API");
  assert.equal(bearerDriver("Mobile"), "Mobile");
});

test("API-key invitation identity comes from provider whoami and configured namespace, never caller claims", async (t) => {
  const fixture = await createAuthFixture();
  const verified = fixture.apiKey({ claimedSubject: "spoofed-subject" });
  const noEmail = fixture.apiKey();
  const rejected = fixture.apiKey({ status: 401 });
  const forwarded = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const headers = new Headers(options?.headers);
    forwarded.push(headers);
    const response = await fixture.fetch(url, options);
    if (!response.ok) return response;
    const body = await response.json();
    if (headers.get("authorization") === `Bearer ${noEmail}`) delete body.passport.profile.email;
    else body.passport.profile.email = "  provider@example.invalid  ";
    // Namespace is deployment configuration, even if the provider response
    // contains an extra field with that name.
    body.passport.principalNamespace = "untrusted-response-namespace";
    return Response.json(body);
  });
  const request = (token) =>
    new Request(
      "https://pages.invalid/api/auth/session?principal=spoofed:subject&namespace=spoofed&email=attacker@example.invalid",
      {
        headers: {
          authorization: `Bearer ${token}`,
          "x-pages-driver": "ChatGPT",
          "x-principal": "spoofed:subject",
          "x-principal-namespace": "spoofed",
          "x-notebook-cloud-principal": "spoofed:subject",
          "x-notebook-cloud-principal-namespace": "spoofed",
          "x-notebook-cloud-email": "attacker@example.invalid",
          "x-pages-verified-email": "attacker@example.invalid",
          "x-email-verified": "true",
          "x-email-proof": "attacker-proof",
        },
      },
    );
  const identity = await authenticate(request(verified), fixture.env);
  assert.equal(identity.principal, `user:anaconda-fixture:${fixture.subject}`);
  assert.equal(identity.namespace, "user:anaconda-fixture");
  assert.equal(identity.verifiedEmail, "provider@example.invalid");
  assert.equal(identity.emailProof, undefined);
  assert.equal(identity.credentialKind, "api-key");
  const missingEmail = await authenticate(request(noEmail), fixture.env);
  assert.equal(missingEmail.namespace, "user:anaconda-fixture");
  assert.equal(
    missingEmail.verifiedEmail,
    undefined,
    "caller claims cannot supply a missing provider email",
  );
  await assert.rejects(authenticate(request(rejected), fixture.env), /validation failed/);
  assert.equal(forwarded.length, 3, "each key is checked with the provider");
  for (const headers of forwarded) {
    assert.deepEqual([...headers.keys()].sort(), ["authorization", "user-agent"]);
    assert.ok(
      [verified, noEmail, rejected].some(
        (token) => headers.get("authorization") === `Bearer ${token}`,
      ),
    );
  }
  const response = await worker.fetch(request(verified), fixture.env);
  assert.equal(response.status, 200);
  const projection = await response.json();
  assert.deepEqual(projection.identity, {
    principal: identity.principal,
    displayName: identity.displayName,
    driver: "ChatGPT",
  });
  for (const privateField of [
    "verifiedEmail",
    "email",
    "emailProof",
    "verifiedEmailBinding",
    "namespace",
  ])
    assert.equal(Object.hasOwn(projection.identity, privateField), false);
  assert.equal(JSON.stringify(projection).includes("provider@example.invalid"), false);
  assert.equal(JSON.stringify(projection).includes("attacker-proof"), false);
});

test("an MCP session id becomes an account-scoped presence tag, never the raw id", async (t) => {
  const fixture = await createAuthFixture();
  t.mock.method(globalThis, "fetch", fixture.fetch);
  const request = (session, path = "/mcp") =>
    new Request(`https://pages.invalid${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.apiKey()}`,
        ...(session !== undefined && { "mcp-session-id": session }),
      },
    });
  const a = await authenticate(request("11111111-2222-4333-8444-555555555555"), fixture.env);
  const b = await authenticate(request("66666666-7777-4888-9999-000000000000"), fixture.env);
  const again = await authenticate(request("11111111-2222-4333-8444-555555555555"), fixture.env);
  assert.match(a.session, /^[0-9a-f]{16}$/);
  assert.equal(again.session, a.session, "stable per session");
  assert.notEqual(b.session, a.session, "distinct per session");
  assert.ok(!a.session.includes("1111"), "never the raw id");
  const none = await authenticate(request(undefined), fixture.env);
  assert.equal(none.session, undefined);
  for (const bad of ["short", "has space here!", "x".repeat(200)])
    await assert.rejects(authenticate(request(bad), fixture.env), /Invalid MCP session id/);
  // Internal forwards from /mcp keep the session.
  const forwarded = await authenticate(
    request("11111111-2222-4333-8444-555555555555", "/internal/tool"),
    fixture.env,
  );
  assert.equal(forwarded.session, a.session);
  // Other public routes ignore the header, even a malformed one.
  for (const path of ["/api/tools", "/api/connect?page=test"]) {
    const ignored = await authenticate(request("not valid!", path), fixture.env);
    assert.equal(ignored.session, undefined, path);
  }
});

test("a blank agent label means no label, so an unset {env:...} template still connects", () => {
  const request = (value) =>
    new Request("https://pages.test/mcp", {
      headers: value === undefined ? {} : { "x-pages-agent": value },
    });
  assert.equal(agentLabel(request()), undefined);
  assert.equal(agentLabel(request("")), undefined);
  assert.equal(agentLabel(request("   ")), undefined);
  assert.equal(agentLabel(request(" release agent ")), "release agent");
  assert.throws(() => agentLabel(request("x".repeat(81))), /Invalid agent label/);
  assert.throws(() => agentLabel(request("a\tb")), /Invalid agent label/);
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
  logFailure(
    Object.assign(Error("private principal and token"), {
      status: 503,
      code: "native_admission_timeout",
    }),
    "native-admission",
  );
  assert.equal(logs[2][1].reason, "native_admission_timeout");
  logFailure(
    Object.assign(Error("private body"), {
      status: 503,
      code: "private-token-value",
    }),
    "native-admission",
  );
  assert.equal(logs[3][1].reason, undefined);
  assert.equal(JSON.stringify(logs).includes("private"), false);
});

test("an unexpected 500 logs where it was thrown, without its message", async (t) => {
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  class BackendError extends Error {
    constructor(operation, code, message) {
      super(message);
      Object.assign(this, { name: "BackendError", operation, code });
    }
  }
  function reservedUnion() {
    // A multi-line message must not be read as stack frames.
    throw new BackendError("store", "conflict", "secret page text\n    at leakedName (x:1:1)");
  }
  function reserveRecords() {
    reservedUnion();
  }
  let thrown;
  try {
    reserveRecords();
  } catch (error) {
    thrown = new AggregateError([error], "Accepted bridge mutations failed");
  }
  const response = errorResponse(thrown, "page");
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Pages request failed" });
  const [, record] = logs[0];
  assert.equal(record.errorType, "AggregateError");
  assert.deepEqual(record.cause.origin.slice(0, 2), ["reservedUnion", "reserveRecords"]);
  assert.equal(record.cause.errorType, "BackendError");
  assert.equal(record.cause.backend, "store/conflict");
  assert.ok(record.origin.length <= 3);
  const text = JSON.stringify(logs);
  assert.equal(text.includes("secret"), false);
  assert.equal(text.includes("leakedName"), false);
  assert.equal(text.includes("Accepted bridge"), false);
  // Thrown non-objects still produce a bounded record instead of a second failure.
  assert.equal(errorResponse(undefined, "page").status, 500);
  assert.equal(logs[1][1].errorType, "Error");
});

test("retryable server failures tell the caller to repeat the same request", async (t) => {
  t.mock.method(console, "error", () => {});
  const response = errorResponse(recordPersistenceTimeout(), "page");
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, "record_persistence_timeout");
  assert.equal(body.retryable, true);
  assert.match(body.error, /same idempotency_key and retry_token/);
  // Other server failures keep the generic message.
  const hidden = errorResponse(Object.assign(Error("private"), { status: 503, code: "x" }));
  assert.deepEqual(await hidden.json(), { error: "Pages request failed" });
});

test("passage-conflict transport exposes only bounded recovery addresses", async () => {
  const error = Object.assign(Error("Target changed"), {
    status: 409,
    code: "edit_conflict",
    details: {
      current_heads: ["a".repeat(64)],
      conflicts: Array.from({ length: 20 }, () => ({
        block_id: "b".repeat(200),
        node_index: 2,
        reason: "Changed".repeat(100),
        markdown: "Do not leak arbitrary fields",
      })),
      private: "hidden",
    },
  });
  const response = errorResponse(error);
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.code, "edit_conflict");
  assert.equal(body.conflicts.length, 10);
  assert.equal(body.conflicts[0].block_id.length, 128);
  assert.equal(body.conflicts[0].reason.length, 240);
  assert.deepEqual(body.current_heads, error.details.current_heads);
  assert.equal(body.conflicts[0].markdown, undefined);
  assert.equal(body.private, undefined);
});
