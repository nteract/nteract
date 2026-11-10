import assert from "node:assert/strict";
import test from "node:test";
import { createLocalOidcIssuer } from "@nteract/local-oidc";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import { localOidcStore } from "./local-oidc-store.mjs";

const ISSUER = "http://localhost:8787/dev/oidc";
const CLIENT_ID = "pages-e2e";
const REDIRECT_URI = "http://localhost:8787/oidc";

// Two D1 connections to one SQLite file stand in for two gateway isolates.
function isolates(t) {
  const { open } = sqliteD1(t, "pages-local-oidc-");
  return [open(), open()].map((db) => ({
    db,
    issuer: createLocalOidcIssuer({
      issuerUrl: ISSUER,
      clientId: CLIENT_ID,
      users: [{ email: "dev@localhost", name: "Local Owner" }],
      store: localOidcStore(db),
    }),
  }));
}

async function verifyRs256(token, jwks) {
  const [header, body, signature] = token.split(".");
  const { kid } = JSON.parse(Buffer.from(header, "base64url"));
  const jwk = jwks.keys.find((key) => key.kid === kid);
  assert.ok(jwk, "the JWKS publishes the token's signing key");
  const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const key = await crypto.subtle.importKey("jwk", jwk, algorithm, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    algorithm,
    key,
    Buffer.from(signature, "base64url"),
    new TextEncoder().encode(`${header}.${body}`),
  );
  assert.ok(valid, "the token signature verifies");
  return JSON.parse(Buffer.from(body, "base64url"));
}

async function authorize(issuer) {
  const url = new URL(`${ISSUER}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("nonce", "n-1");
  const response = await issuer.handle(new Request(url));
  assert.equal(response.status, 302);
  return new URL(response.headers.get("location")).searchParams.get("code");
}

function exchange(issuer, code) {
  return issuer.handle(
    new Request(`${ISSUER}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
      }),
    }),
  );
}

test("a code issued in one isolate redeems in another, signed with the shared key", async (t) => {
  const [a, b] = isolates(t);
  const code = await authorize(a.issuer);
  const response = await exchange(b.issuer, code);
  assert.equal(response.status, 200);
  const tokens = await response.json();

  // The token from isolate B verifies against isolate A's JWKS: the callback's
  // JWKS fetch can land in either isolate.
  const payload = await verifyRs256(tokens.id_token, await a.issuer.jwks());
  assert.equal(payload.iss, ISSUER);
  assert.equal(payload.aud, CLIENT_ID);
  assert.equal(payload.email, "dev@localhost");
  assert.equal(payload.nonce, "n-1");
  assert.deepEqual(await a.issuer.jwks(), await b.issuer.jwks());
  assert.deepEqual(a.db.rows("SELECT code FROM local_oidc_codes"), []);
});

test("concurrent redemptions of one code across isolates admit exactly one", async (t) => {
  const [a, b] = isolates(t);
  const code = await authorize(a.issuer);
  const responses = await Promise.all([exchange(a.issuer, code), exchange(b.issuer, code)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 400]);
  const rejected = responses.find((r) => r.status === 400);
  assert.equal((await rejected.json()).error, "invalid_grant");
  assert.equal((await exchange(b.issuer, code)).status, 400);
});

test("racing isolates settle on the first saved signing key", async (t) => {
  const [a, b] = isolates(t);
  const [first, second] = await Promise.all([a.issuer.jwks(), b.issuer.jwks()]);
  assert.equal(first.keys[0].kid, second.keys[0].kid);
  assert.equal(first.keys[0].d, undefined);
  assert.equal(a.db.rows("SELECT id FROM local_oidc_keys").length, 1);
});

test("expired codes are refused and pruned on the next issue", async (t) => {
  const [a, b] = isolates(t);
  const code = await authorize(a.issuer);
  a.db.sqlite.prepare("UPDATE local_oidc_codes SET expires_at = 0").run();
  assert.equal((await exchange(b.issuer, code)).status, 400);

  const stale = await authorize(a.issuer);
  a.db.sqlite.prepare("UPDATE local_oidc_codes SET expires_at = 0").run();
  await authorize(b.issuer);
  assert.equal(
    a.db.rows("SELECT code FROM local_oidc_codes WHERE code = ?", stale).length,
    0,
    "an expired code is deleted when another is issued",
  );
});

test("no D1 binding leaves the issuer on its in-memory default", () => {
  assert.equal(localOidcStore(undefined), undefined);
  assert.equal(localOidcStore({}), undefined);
});
