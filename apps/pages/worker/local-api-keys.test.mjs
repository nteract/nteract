import assert from "node:assert/strict";
import { test } from "node:test";
import { identityProvider, localDevKeysEnabled } from "../identity-provider.mjs";
import { agentGuide } from "../agent-guide.mjs";
import { authenticate } from "./auth.mjs";
import worker from "./index.mjs";
import { quotaEvidence } from "./page-quota.mjs";
import {
  LOCAL_API_KEY_PREFIX,
  handleLocalApiKeyRequest,
  localDevPrincipal,
  mintLocalApiKey,
  readLocalApiKey,
} from "./local-api-keys.mjs";

const ORIGIN = "http://localhost:9894";
const SECRET = "a".repeat(48);
const DAY = 86_400_000;
const env = Object.freeze({
  NOTEBOOK_CLOUD_LOCAL_OIDC: "true",
  NOTEBOOK_CLOUD_PUBLIC_ORIGIN: ORIGIN,
  NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "pages-next-local",
  NOTEBOOK_CLOUD_APP_SESSION_SECRET: SECRET,
});
const NOW = Date.UTC(2026, 10, 13, 12);

const mint = (body, headers = {}) =>
  new Request(`${ORIGIN}/dev/api-key`, {
    method: "POST",
    headers: { "x-pages-dev": "1", ...headers },
    ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

const withKey = (key) =>
  new Request(`${ORIGIN}/api/pages`, { headers: { authorization: `Bearer ${key}` } });

const encode = (value) => Buffer.from(value).toString("base64url");

test("local keys are on only for a loopback server with the issuer, a namespace and a secret", () => {
  for (const origin of [ORIGIN, "http://127.0.0.1:9894", "http://[::1]:9894"])
    assert.equal(localDevKeysEnabled({ ...env, NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin }), true);
  for (const off of [
    undefined,
    {},
    { ...env, NOTEBOOK_CLOUD_LOCAL_OIDC: "false" },
    { ...env, NOTEBOOK_CLOUD_LOCAL_OIDC: undefined },
    { ...env, NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.example" },
    { ...env, NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://localhost.example.com" },
    { ...env, NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "not a url" },
    { ...env, NOTEBOOK_CLOUD_PUBLIC_ORIGIN: undefined },
    { ...env, NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: " " },
    { ...env, NOTEBOOK_CLOUD_APP_SESSION_SECRET: "short" },
    { ...env, NOTEBOOK_CLOUD_APP_SESSION_SECRET: undefined },
  ])
    assert.equal(localDevKeysEnabled(off), false, JSON.stringify(off));
});

test("a minted key reads back with its scope and expiry", async () => {
  const editor = await mintLocalApiKey(env, {}, NOW);
  assert.ok(editor.key.startsWith(LOCAL_API_KEY_PREFIX));
  assert.equal(editor.scope, "editor");
  assert.equal(editor.expiresAt, NOW + 30 * DAY);
  assert.deepEqual(await readLocalApiKey(env, editor.key, NOW), {
    scope: "editor",
    expiresAt: editor.expiresAt,
  });
  const viewer = await mintLocalApiKey(env, { scope: "viewer", days: 7 }, NOW);
  assert.deepEqual(await readLocalApiKey(env, viewer.key, NOW), {
    scope: "viewer",
    expiresAt: NOW + 7 * DAY,
  });
  assert.notEqual(editor.key, viewer.key);
});

test("a key ends at its expiry", async () => {
  const { key, expiresAt } = await mintLocalApiKey(env, { days: 1 }, NOW);
  assert.ok(await readLocalApiKey(env, key, expiresAt - 1));
  assert.equal(await readLocalApiKey(env, key, expiresAt), null);
  assert.equal(await readLocalApiKey(env, key, expiresAt + 1), null);
});

test("a key this server did not sign is refused", async () => {
  const { key } = await mintLocalApiKey(env, { scope: "viewer" }, NOW);
  const [payload, signature] = key.slice(LOCAL_API_KEY_PREFIX.length).split(".");
  const claim = (claims) => encode(JSON.stringify(claims));
  const forged = [
    `${LOCAL_API_KEY_PREFIX}${claim({ s: "editor", e: NOW + 1e9 })}.${signature}`,
    `${LOCAL_API_KEY_PREFIX}${claim({ s: "viewer", e: NOW + 1e12 })}.${signature}`,
    `${LOCAL_API_KEY_PREFIX}${payload}`,
    `${LOCAL_API_KEY_PREFIX}${payload}.`,
    `${LOCAL_API_KEY_PREFIX}.${signature}`,
    `${LOCAL_API_KEY_PREFIX}${payload}.${signature}.extra`,
    `${LOCAL_API_KEY_PREFIX}${payload}.${signature.slice(0, -2)}AA`,
    `${LOCAL_API_KEY_PREFIX}!!!.???`,
    LOCAL_API_KEY_PREFIX,
    "pages_" + key.slice(LOCAL_API_KEY_PREFIX.length),
    "",
  ];
  for (const token of forged) assert.equal(await readLocalApiKey(env, token, NOW), null, token);
  const other = { ...env, NOTEBOOK_CLOUD_APP_SESSION_SECRET: "b".repeat(48) };
  assert.equal(await readLocalApiKey(other, key, NOW), null);
  assert.ok(await readLocalApiKey(env, key, NOW));
});

test("a payload that is signed but is not a scope and expiry is refused", async () => {
  const hmac = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sign = async (payload) => {
    const signature = await crypto.subtle.sign(
      "HMAC",
      hmac,
      new TextEncoder().encode("pages-local-api-key.v1." + payload),
    );
    return `${LOCAL_API_KEY_PREFIX}${payload}.${Buffer.from(signature).toString("base64url")}`;
  };
  const good = encode(JSON.stringify({ s: "editor", e: NOW + 1000 }));
  assert.ok(
    await readLocalApiKey(env, await sign(good), NOW),
    "the signing here matches the server's",
  );
  for (const payload of [
    encode("not json"),
    encode("null"),
    encode(JSON.stringify({ s: "owner", e: NOW + 1000 })),
    encode(JSON.stringify({ s: "editor" })),
    encode(JSON.stringify({ s: "editor", e: "tomorrow" })),
  ])
    assert.equal(await readLocalApiKey(env, await sign(payload), NOW), null, payload);
});

test("minting refuses a scope or lifetime it does not take", async () => {
  for (const options of [
    { scope: "owner" },
    { scope: 1 },
    { days: 0 },
    { days: 366 },
    { days: 1.5 },
    { days: "7" },
    { days: null },
  ])
    await assert.rejects(mintLocalApiKey(env, options, NOW), {
      status: 400,
      code: "invalid_arguments",
    });
});

test("POST /dev/api-key mints a key for the account local sign-in uses", async () => {
  const response = await handleLocalApiKeyRequest(mint(), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.scope, "editor");
  assert.equal(body.principal, "pages-next-local:dev%40localhost");
  assert.equal(body.principal, localDevPrincipal(env));
  assert.ok(new Date(body.expires_at) > new Date());
  assert.ok(await readLocalApiKey(env, body.key));

  const viewer = await (
    await handleLocalApiKeyRequest(mint({ scope: "viewer", days: 2 }), env)
  ).json();
  assert.equal(viewer.scope, "viewer");
  assert.ok(Math.abs(new Date(viewer.expires_at) - (Date.now() + 2 * DAY)) < 5_000);
});

test("POST /dev/api-key refuses what a script would not send", async () => {
  const refuse = async (request, status, code) => {
    const response = await handleLocalApiKeyRequest(request, env);
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.code, code);
    assert.equal("key" in body, false);
  };
  await refuse(new Request(`${ORIGIN}/dev/api-key`, { method: "POST" }), 403, "access_denied");
  await refuse(mint(undefined, { origin: "https://evil.example" }), 403, "access_denied");
  await refuse(mint(undefined, { "sec-fetch-site": "cross-site" }), 403, "access_denied");
  await refuse(
    new Request(`${ORIGIN}/dev/api-key`, { headers: { "x-pages-dev": "1" } }),
    405,
    "method_not_allowed",
  );
  await refuse(mint("{"), 400, "invalid_arguments");
  await refuse(mint("[]"), 400, "invalid_arguments");
  await refuse(mint({ user: "alice@localhost" }), 400, "invalid_arguments");
  await refuse(mint({ scope: "owner" }), 400, "invalid_arguments");
  const sameOrigin = await handleLocalApiKeyRequest(mint(undefined, { origin: ORIGIN }), env);
  assert.equal(sameOrigin.status, 200);
});

test("the route is not there unless the server is a local dev server", async () => {
  assert.equal(await handleLocalApiKeyRequest(new Request(`${ORIGIN}/other`), env), null);
  for (const off of [
    { ...env, NOTEBOOK_CLOUD_LOCAL_OIDC: "false" },
    { ...env, NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.example" },
    { ...env, NOTEBOOK_CLOUD_APP_SESSION_SECRET: undefined },
  ])
    assert.equal(await handleLocalApiKeyRequest(mint(), off), null);
});

test("the gateway serves the route on a loopback host and not on another", async () => {
  const local = await worker.fetch(mint(), env);
  assert.equal(local.status, 200);
  assert.ok((await local.json()).key.startsWith(LOCAL_API_KEY_PREFIX));
  const remote = await worker.fetch(
    new Request("https://pages.example/dev/api-key", {
      method: "POST",
      headers: { "x-pages-dev": "1" },
    }),
    env,
  );
  assert.notEqual(remote.status, 200);
  assert.equal((await remote.text()).includes(LOCAL_API_KEY_PREFIX), false);
});

test("a local key authenticates as the local dev account", async () => {
  const editor = await mintLocalApiKey(env);
  const identity = await authenticate(withKey(editor.key), env);
  assert.equal(identity.principal, "pages-next-local:dev%40localhost");
  assert.equal(identity.displayName, "Local Developer");
  assert.equal(identity.credentialKind, "api-key");
  assert.equal(identity.canWrite, true);
  assert.equal(identity.namespace, "pages-next-local");
  assert.equal(identity.verifiedEmail, "dev@localhost");
  assert.ok(identity.verifiedEmailUntil > Date.now());
  assert.equal(quotaEvidence(identity).email, "dev@localhost");

  const viewer = await mintLocalApiKey(env, { scope: "viewer" });
  const read = await authenticate(withKey(viewer.key), env);
  assert.equal(read.principal, identity.principal);
  assert.equal(read.canWrite, false);
});

test("a local key is refused when invalid, expired, or on a server that mints none", async () => {
  const { key } = await mintLocalApiKey(env);
  const refused = (token, serverEnv, pattern) =>
    assert.rejects(authenticate(withKey(token), serverEnv), (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.code, "invalid_api_key");
      assert.match(error.message, pattern);
      return true;
    });
  await refused(key + "x", env, /invalid or expired/);
  await refused(key.replace(/.$/, key.endsWith("A") ? "B" : "A"), env, /invalid or expired/);
  const expired = await mintLocalApiKey(env, {}, Date.now() - 31 * DAY);
  await refused(expired.key, env, /invalid or expired/);
  await refused(key, { ...env, NOTEBOOK_CLOUD_LOCAL_OIDC: "false" }, /only by a local dev server/);
  const remote = { ...env, NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.example" };
  await assert.rejects(
    authenticate(
      new Request("https://pages.example/api/pages", {
        headers: { authorization: `Bearer ${key}` },
      }),
      remote,
    ),
    { status: 401, code: "invalid_api_key" },
  );
});

test("a valid local key is refused on a request that did not arrive on a loopback host", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("a local key must not leave this server");
  });
  const { key } = await mintLocalApiKey(env);
  for (const host of [
    "https://pages.example",
    "http://192.168.1.5:9894",
    "http://localhost.evil.test",
  ])
    await assert.rejects(
      authenticate(
        new Request(`${host}/api/pages`, {
          headers: { authorization: `Bearer ${key}` },
        }),
        env,
      ),
      { status: 401, code: "invalid_api_key" },
      host,
    );
  assert.equal(
    await handleLocalApiKeyRequest(
      new Request("https://pages.example/dev/api-key", {
        method: "POST",
        headers: { "x-pages-dev": "1" },
      }),
      env,
    ),
    null,
  );
  assert.equal(fetch.mock.callCount(), 0);
});

test("a local key never reaches the Anaconda verifier", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("a local key must not leave this server");
  });
  const { key } = await mintLocalApiKey(env);
  await authenticate(withKey(key), env);
  await assert.rejects(authenticate(withKey(key + "x"), env), { code: "invalid_api_key" });
  assert.equal(fetch.mock.callCount(), 0);
});

test("the guide and connect instructions of a local server say how to mint a key", () => {
  const key = identityProvider(env).apiKey;
  assert.equal(key.createUrl, null);
  assert.match(key.createGuide, /-X POST http:\/\/localhost:9894\/dev\/api-key/);
  assert.match(key.createGuide, /X-Pages-Dev: 1/);
  assert.match(key.connectInstructions, /\/dev\/api-key/);
  assert.doesNotMatch(key.connectInstructions, /Ask the deployment owner|href=/);
  const guide = agentGuide(env);
  assert.ok(guide.includes(key.createGuide));
  assert.doesNotMatch(guide, /anaconda\.com\/app\/profile\/api-keys/);
  const production = identityProvider({
    ...env,
    NOTEBOOK_CLOUD_LOCAL_OIDC: undefined,
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.example",
  }).apiKey;
  assert.doesNotMatch(production.createGuide, /dev\/api-key/);
});
