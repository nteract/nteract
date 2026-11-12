import assert from "node:assert/strict";
import { test } from "node:test";
import { secretHash, SERVER_SESSION_COOKIE } from "@cloud/oidc-session-store.ts";
import { startLocalKiloHandoff } from "../scripts/fixtures/local-kilo-handoff.mjs";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import { authenticate } from "./auth.mjs";
import { KILO_MEMBERSHIP_SECONDS } from "./kilo-config.mjs";
import { kiloOrganizations, MAX_ORGANIZATIONS } from "./kilo-exchange.mjs";
import { handleKiloSignIn } from "./kilo-handoff.mjs";
import {
  CACHE_MS,
  membershipRecord,
  organizationLeases,
  organizationProof,
  recordKiloMembership,
  resetMembershipCache,
} from "./kilo-membership.mjs";
import { exchangeAuthorizationCode, issueAuthorizationCode } from "./oauth-store.mjs";

const origin = "http://127.0.0.1:9477";
const audience = "pages-test";
const secret = "kilo-exchange-fixture-secret-0123456789";
// Distinctive, so a log line that carried one would be found.
const sentinel = Object.freeze({ id: "org-sentinel-7f3a", name: "Sentinel Works 7f3a" });
const second = Object.freeze({ id: "org-second-91c2", name: "Second Guild 91c2" });
let people = 0;
const person = (organizations = [sentinel]) => ({
  id: `member-${++people}`,
  name: "Example Member",
  organizations: organizations.map((entry) => ({ ...entry, role: "member" })),
});
const principalOf = (account) => `user:kilo:${encodeURIComponent(account.id)}`;

async function fixture(t) {
  const kilo = await startLocalKiloHandoff({ deployments: { [audience]: origin }, secret });
  const env = {
    DB: sqliteD1(t).open(),
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
    NOTEBOOK_CLOUD_LOCAL_OIDC: "true",
    NOTEBOOK_CLOUD_OIDC_FLOW: "server",
    NOTEBOOK_CLOUD_OIDC_ISSUER: "https://issuer.example",
    NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "pages",
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: "kilo-session-fixture-secret-".repeat(3),
    PAGES_KILO_APP_URL: kilo.origin,
    PAGES_KILO_AUDIENCE: audience,
    PAGES_KILO_EXCHANGE_SECRET: secret,
  };
  const lines = [];
  for (const method of ["info", "warn", "error", "log"])
    t.mock.method(console, method, (...args) =>
      lines.push(
        args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
      ),
    );
  t.after(() => kilo.close());
  resetMembershipCache();
  return { env, kilo, lines };
}

const request = (path, headers = {}) => new Request(new URL(path, origin), { headers });
const setCookie = (response, name) =>
  response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`))
    ?.split(";", 1)[0];

/** A browser sign-in through the fake Kilo; returns the session cookie. */
async function browserSignIn(env, kilo, account) {
  kilo.signIn(account);
  const started = await handleKiloSignIn(request("/api/auth/login"), env);
  const binding = setCookie(started, "__Host-pages_kilo_handoff");
  const atKilo = await fetch(started.headers.get("location"), { redirect: "manual" });
  const done = await handleKiloSignIn(
    request(atKilo.headers.get("location"), { cookie: binding }),
    env,
  );
  assert.equal(done.status, 303);
  return setCookie(done, SERVER_SESSION_COOKIE);
}

/** A Pages OAuth access token whose consent snapshot names `account`. */
async function oauthToken(env, account) {
  const verifier = "v".repeat(43);
  const redirectUri = "https://chatgpt.com/connector_platform/oauth_redirect";
  const clientId = "https://chatgpt.com/oauth/client.json";
  const resource = `${origin}/mcp`;
  const { code } = await issueAuthorizationCode(env, {
    clientId,
    redirectUri,
    resource,
    scope: "pages:read pages:write",
    codeChallenge: await secretHash(verifier),
    identity: {
      principal: principalOf(account),
      namespace: "user:kilo",
      displayName: account.name,
    },
  });
  return (
    await exchangeAuthorizationCode(env, {
      code,
      clientId,
      redirectUri,
      resource,
      codeVerifier: verifier,
    })
  ).access_token;
}

const bearer = (token) => request("/mcp", { authorization: `Bearer ${token}` });
const named = (identity) => (identity.organizations ?? []).map(({ id, name }) => ({ id, name }));

test("Kilo's organizations are kept by id and name, in order, and never fail a sign-in", () => {
  assert.deepEqual(
    kiloOrganizations([
      { id: "a", name: " Alpha ", role: "owner" },
      { id: "b", name: "" },
      { id: "c" },
      { id: "a", name: "Again" },
      { id: " padded" },
      { id: "" },
      { id: 7, name: "Number" },
      null,
      "text",
      { id: "x".repeat(256) },
      { id: "x".repeat(255), name: "n".repeat(250) },
    ]),
    [
      { id: "a", name: "Alpha" },
      { id: "b", name: "b" },
      { id: "c", name: "c" },
      { id: "x".repeat(255), name: "n".repeat(200) },
    ],
  );
  for (const absent of [undefined, null, {}, "orgs", 3, { 0: { id: "a" } }])
    assert.deepEqual(kiloOrganizations(absent), []);
  const many = Array.from({ length: 60 }, (_, index) => ({ id: `org-${index}`, name: "N" }));
  const kept = kiloOrganizations([{ id: "" }, ...many]);
  assert.equal(kept.length, MAX_ORGANIZATIONS);
  assert.deepEqual(
    kept.map(({ id }) => id),
    many.slice(0, MAX_ORGANIZATIONS).map(({ id }) => id),
  );
});

test("an exchange answer with a missing or malformed organizations list still signs in", async (t) => {
  const { env, kilo } = await fixture(t);
  for (const organizations of [undefined, null, "none", [{ id: 4 }]]) {
    const account = person([]);
    kilo.respond((req, res) =>
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ user: { id: account.id, name: account.name }, organizations })),
    );
    const cookie = await browserSignIn(env, kilo, account);
    const identity = await authenticate(request("/", { cookie }), env);
    assert.equal(identity.principal, principalOf(account));
    assert.equal(identity.organizations, undefined);
    assert.deepEqual((await membershipRecord(env, identity.principal)).organizations, []);
  }
});

test("the evidence record is replaced only by a report sent later", async (t) => {
  const { env } = await fixture(t);
  const principal = "user:kilo:fenced";
  const at = Date.now();
  await recordKiloMembership(env, principal, [sentinel], at);
  // A slow exchange sent earlier lands later: it changes nothing.
  await recordKiloMembership(env, principal, [], at - 60_000);
  resetMembershipCache();
  assert.deepEqual(await membershipRecord(env, principal), {
    organizations: [sentinel],
    verifiedAt: Math.floor(at / 1000),
  });
  // Another isolate's newer report wins over this isolate's older view.
  await env.DB.prepare("UPDATE kilo_memberships SET organizations = ?, verified_at = ?")
    .bind(JSON.stringify([second]), Math.floor(at / 1000) + 120)
    .run();
  await recordKiloMembership(env, principal, [], at + 60_000);
  resetMembershipCache();
  assert.deepEqual((await membershipRecord(env, principal)).organizations, [second]);
  // A later report with other organizations always lands.
  await recordKiloMembership(env, principal, [sentinel, second], at + 180_000);
  resetMembershipCache();
  assert.deepEqual(await membershipRecord(env, principal), {
    organizations: [sentinel, second],
    verifiedAt: Math.floor(at / 1000) + 180,
  });
});

test("an equal report within five minutes isn't written again; a changed one always is", async (t) => {
  const { env } = await fixture(t);
  const principal = "user:kilo:rewrites";
  const writes = t.mock.method(env.DB, "prepare");
  const inserts = () =>
    writes.mock.calls.filter(({ arguments: [sql] }) =>
      sql.startsWith("INSERT INTO kilo_memberships "),
    ).length;
  const at = Date.now();
  await recordKiloMembership(env, principal, [sentinel], at);
  await recordKiloMembership(env, principal, [sentinel], at + 60_000);
  await recordKiloMembership(env, principal, [sentinel], at + 4 * 60_000);
  assert.equal(inserts(), 1);
  await recordKiloMembership(env, principal, [], at + 4 * 60_000 + 1000);
  assert.equal(inserts(), 2, "a changed set is written however soon");
  await recordKiloMembership(env, principal, [], at + 10 * 60_000);
  assert.equal(inserts(), 3, "equal evidence is refreshed after five minutes");
});

test("a browser cookie, a Pages OAuth token and a Kilo agent token carry the same organizations", async (t) => {
  const { env, kilo } = await fixture(t);
  const account = person([sentinel, second]);
  const cookie = await browserSignIn(env, kilo, account);
  const browser = await authenticate(request("/", { cookie }), env);
  const agent = await authenticate(bearer(await oauthToken(env, account)), env);
  const token = await authenticate(bearer(kilo.mintToken(account, { audience })), env);
  for (const identity of [browser, agent, token]) {
    assert.equal(identity.principal, principalOf(account));
    assert.deepEqual(named(identity), [sentinel, second]);
    for (const lease of identity.organizations) {
      assert.equal(lease.namespace, "user:kilo");
      assert.ok(lease.expiresAt <= identity.expiresAt);
    }
  }
  // Kilo was asked once for the sign-in and once for the token; the OAuth
  // identity read the evidence they left.
  assert.equal(kilo.exchanges().length, 2);
});

test("an OAuth agent loses its person's organizations when the evidence ages out, and regains them after a new exchange", async (t) => {
  const { env, kilo } = await fixture(t);
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const account = person([sentinel]);
  // The person's last exchange was nearly eight hours ago.
  const sentAt = clock - KILO_MEMBERSHIP_SECONDS * 1000 + 5000;
  await recordKiloMembership(env, principalOf(account), account.organizations, sentAt);
  const access = await oauthToken(env, account);
  const fresh = await authenticate(bearer(access), env);
  assert.deepEqual(named(fresh), [sentinel]);
  assert.equal(
    fresh.organizations[0].expiresAt,
    (Math.floor(sentAt / 1000) + KILO_MEMBERSHIP_SECONDS) * 1000,
  );
  clock += 6000;
  const aged = await authenticate(bearer(access), env);
  assert.equal(aged.organizations, undefined);
  assert.deepEqual(await organizationProof(env, aged, [sentinel.id, "org-other"]), {
    [sentinel.id]: "expired",
    "org-other": "missing",
  });
  // The person's agent token exchange renews the evidence for every credential.
  await authenticate(bearer(kilo.mintToken(account, { audience, claims: { n: 1 } })), env);
  const renewed = await authenticate(bearer(access), env);
  assert.deepEqual(named(renewed), [sentinel]);
  // A later exchange that no longer lists it removes it, for every credential
  // within one cache window.
  clock += 1000;
  const left = { ...account, organizations: [] };
  await authenticate(bearer(kilo.mintToken(left, { audience, claims: { n: 2 } })), env);
  clock += CACHE_MS;
  assert.equal((await authenticate(bearer(access), env)).organizations, undefined);
});

test("only a Kilo identity on a deployment that reports organizations holds a lease", async (t) => {
  const { env } = await fixture(t);
  const principal = "user:kilo:leases";
  const now = Date.now();
  await recordKiloMembership(env, principal, [sentinel], now);
  const identity = { principal, namespace: "user:kilo", expiresAt: now + 60_000 };
  assert.deepEqual(await organizationLeases(env, identity, now), [
    { ...sentinel, namespace: "user:kilo", expiresAt: now + 60_000 },
  ]);
  for (const [other, otherEnv] of [
    [{ ...identity, namespace: "user:anaconda" }, env],
    [{ ...identity, principal: "user:kilox:leases" }, env],
    [{ ...identity, expiresAt: now }, env],
    [identity, { ...env, PAGES_KILO_APP_URL: undefined }],
  ])
    assert.deepEqual(await organizationLeases(otherEnv, other, now), []);
});

test("no organization id or name reaches a log line", async (t) => {
  const { env, kilo, lines } = await fixture(t);
  const account = person([sentinel, second]);
  const cookie = await browserSignIn(env, kilo, account);
  await authenticate(request("/", { cookie }), env);
  await authenticate(bearer(kilo.mintToken(account, { audience })), env);
  await authenticate(bearer(await oauthToken(env, account)), env);
  const logged = lines.join("\n");
  for (const value of [sentinel.id, sentinel.name, second.id, second.name])
    assert.equal(logged.includes(value), false, value);
  const accepted = lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .find((event) => event?.action === "kilo_token.accepted");
  assert.equal(accepted.organizations, 2);
});
