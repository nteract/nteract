import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthenticator } from "./auth.mjs";
import { createAuthFixture } from "./auth-fixtures.mjs";

test("wrapper uses production verifiers with explicit OIDC and API-key namespace mapping", async (t) => {
  const fixture = await createAuthFixture();
  t.mock.method(globalThis, "fetch", fixture.fetch);
  const auth = await createAuthenticator({ env: fixture.env });
  const oidc = await auth.authenticateOidcIdToken(await fixture.sign(), {
    nonce: fixture.nonce,
    driver: "mobile",
  });
  const api = await auth.authenticateApiKey(fixture.apiKey(), { driver: "ChatGPT", write: true });
  assert.equal(oidc.principal, `user:anaconda-fixture:${fixture.subject}`);
  assert.equal(oidc.principal, api.principal);
  assert.equal(oidc.displayName, "Fixture Person");
  assert.equal(api.displayName, oidc.displayName);
  assert.equal(oidc.credentialKind, "oidc");
  assert.equal(api.credentialKind, "api-key");
  assert.equal(oidc.canWrite, true);
  assert.equal(api.canWrite, true);
  assert.equal(api.driver, "ChatGPT");
  assert.ok(Object.isFrozen(oidc));
  assert.ok(Object.isFrozen(api));
  assert.equal(auth.isVerifiedIdentity(api), true);
  assert.equal(auth.isVerifiedIdentity({ ...api }), false);
  assert.throws(() => {
    api.principal = "user:someone-else";
  }, TypeError);
  assert.ok(api.expiresAt <= Date.now() + 60_000);
  assert.equal(oidc.expiresAt, (fixture.now + 300) * 1000);
});

test("OIDC rejects wrong issuer, audience, expiry, nonce, token role, and signature using production verification", async (t) => {
  const fixture = await createAuthFixture();
  t.mock.method(globalThis, "fetch", fixture.fetch);
  const auth = await createAuthenticator({ env: fixture.env });
  for (const [claims, error] of [
    [{ iss: "https://wrong-issuer.invalid" }, /issuer/],
    [{ aud: "different-client" }, /audience/],
    [{ iat: fixture.now - 200, exp: fixture.now - 100 }, /expiry/],
    [{ nonce: "attacker-nonce" }, /nonce/],
    [{ token_use: "access" }, /token use/],
  ]) {
    await assert.rejects(
      auth.authenticateOidcIdToken(await fixture.sign(claims), {
        nonce: fixture.nonce,
        driver: "mobile",
      }),
      error,
    );
  }
  const valid = await fixture.sign();
  const parts = valid.split(".");
  const signature = Buffer.from(parts[2], "base64url");
  signature[0] ^= 1;
  parts[2] = signature.toString("base64url");
  await assert.rejects(
    auth.authenticateOidcIdToken(parts.join("."), { nonce: fixture.nonce, driver: "mobile" }),
    /signature/,
  );
  await assert.rejects(
    auth.authenticateOidcIdToken(valid, { driver: "mobile" }),
    /transaction nonce/,
  );
});

test("API-key provider scopes cap writing even when driver or caller claims writer", async (t) => {
  const fixture = await createAuthFixture();
  t.mock.method(globalThis, "fetch", fixture.fetch);
  const auth = await createAuthenticator({ env: fixture.env });
  const token = fixture.apiKey({ scopes: ["cloud:read"] });
  const identity = await auth.authenticateApiKey(token, {
    driver: "administrator",
    principal: "system",
    displayName: "Forged name",
    canWrite: true,
  });
  assert.equal(identity.canWrite, false);
  assert.equal(identity.principal, `user:anaconda-fixture:${fixture.subject}`);
  assert.equal(identity.displayName, "Fixture Person");
  await assert.rejects(
    auth.authenticateApiKey(token, { driver: "ChatGPT", write: true }),
    /scopes do not allow/,
  );
  await assert.rejects(
    auth.authenticateApiKey(fixture.apiKey({ scopes: [] }), { driver: "mobile" }),
    /scopes do not allow/,
  );
});

test("API-key validator rejects non-API passport and provider rejection", async (t) => {
  const fixture = await createAuthFixture();
  t.mock.method(globalThis, "fetch", fixture.fetch);
  const auth = await createAuthenticator({ env: fixture.env });
  await assert.rejects(
    auth.authenticateApiKey(fixture.apiKey({ source: "oidc" }), { driver: "ChatGPT" }),
    /not an API key/,
  );
  await assert.rejects(
    auth.authenticateApiKey(fixture.apiKey({ status: 401 }), { driver: "ChatGPT" }),
    /validation failed/,
  );
});

test("matching name and subject do not link providers without explicit namespace mapping", async (t) => {
  const fixture = await createAuthFixture();
  t.mock.method(globalThis, "fetch", fixture.fetch);
  const env = { ...fixture.env };
  delete env.NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE;
  delete env.NOTEBOOK_CLOUD_ANACONDA_API_KEY_PRINCIPAL_NAMESPACE;
  const auth = await createAuthenticator({ env });
  const oidc = await auth.authenticateOidcIdToken(await fixture.sign(), {
    nonce: fixture.nonce,
    driver: "mobile",
  });
  const api = await auth.authenticateApiKey(fixture.apiKey(), { driver: "ChatGPT" });
  assert.notEqual(oidc.principal, api.principal);
  assert.equal(oidc.displayName, api.displayName);
});

test("credential admission rejects invalid lifetime configuration and past OIDC expiry within verifier clock tolerance", async (t) => {
  const fixture = await createAuthFixture();
  t.mock.method(globalThis, "fetch", fixture.fetch);
  await assert.rejects(
    createAuthenticator({ env: fixture.env, apiKeySessionTtlMs: 120_000 }),
    /admission lifetime/,
  );
  const auth = await createAuthenticator({ env: fixture.env });
  await assert.rejects(
    auth.authenticateOidcIdToken(
      await fixture.sign({ iat: fixture.now - 10, exp: fixture.now - 1 }),
      { nonce: fixture.nonce, driver: "mobile" },
    ),
    /expired/,
  );
});
