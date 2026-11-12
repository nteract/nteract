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
import { invitationMatches } from "./sharing.mjs";

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
  assert.deepEqual(await membershipRecord(env, principal), {
    organizations: [sentinel],
    verifiedAtMs: at,
  });
  // Another isolate's newer report wins over this isolate's older answer.
  await env.DB.prepare("UPDATE kilo_memberships SET organizations = ?, verified_at_ms = ?")
    .bind(JSON.stringify([second]), at + 120_000)
    .run();
  await recordKiloMembership(env, principal, [], at + 60_000);
  assert.deepEqual((await membershipRecord(env, principal)).organizations, [second]);
  // A later report with other organizations always lands.
  await recordKiloMembership(env, principal, [sentinel, second], at + 180_000);
  assert.deepEqual(await membershipRecord(env, principal), {
    organizations: [sentinel, second],
    verifiedAtMs: at + 180_000,
  });
});

const columns = async (env) =>
  (await env.DB.prepare("SELECT name FROM pragma_table_info('kilo_memberships')").all()).results
    .map(({ name }) => name)
    .sort();
const versions = async (env) =>
  (
    await env.DB.prepare("SELECT version FROM kilo_membership_schema ORDER BY version").all()
  ).results.map(({ version }) => version);

test("a fresh database gets the millisecond evidence table", async (t) => {
  const { env } = await fixture(t);
  const at = Date.now();
  await recordKiloMembership(env, "user:kilo:fresh", [sentinel], at);
  assert.deepEqual(await versions(env), [1, 2]);
  assert.deepEqual(await columns(env), ["organizations", "principal", "verified_at_ms"]);
  assert.deepEqual(await membershipRecord(env, "user:kilo:fresh"), {
    organizations: [sentinel],
    verifiedAtMs: at,
  });
});

test("a database that ran the seconds table drops its rows and takes millisecond evidence", async (t) => {
  const { env } = await fixture(t);
  // The first migration as it shipped, with one row written under it.
  for (const sql of [
    `CREATE TABLE kilo_membership_schema (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`,
    `CREATE TABLE kilo_memberships (
      principal TEXT PRIMARY KEY,
      organizations TEXT NOT NULL,
      verified_at INTEGER NOT NULL
    )`,
    `INSERT INTO kilo_membership_schema VALUES (1, 'memberships', '2026-11-11T00:00:00.000Z')`,
  ])
    await env.DB.prepare(sql).run();
  await env.DB.prepare("INSERT INTO kilo_memberships VALUES (?, ?, ?)")
    .bind("user:kilo:upgraded", JSON.stringify([second]), Math.floor(Date.now() / 1000))
    .run();
  assert.equal(
    await membershipRecord(env, "user:kilo:upgraded"),
    null,
    "a seconds row is not evidence",
  );
  assert.deepEqual(await versions(env), [1, 2]);
  assert.deepEqual(await columns(env), ["organizations", "principal", "verified_at_ms"]);
  const at = Date.now();
  await recordKiloMembership(env, "user:kilo:upgraded", [sentinel], at);
  assert.deepEqual(await membershipRecord(env, "user:kilo:upgraded"), {
    organizations: [sentinel],
    verifiedAtMs: at,
  });
});

/** A second isolate: its own copy of the module, so its own cache. */
const otherIsolate = () => import(`./kilo-membership.mjs?isolate=${Math.random()}`);
const stored = async (env, principal) => {
  const row = await env.DB.prepare("SELECT organizations FROM kilo_memberships WHERE principal = ?")
    .bind(principal)
    .first();
  return JSON.parse(row.organizations);
};

test("a newer exchange's empty answer wins over another isolate's listing, whatever this isolate cached", async (t) => {
  const { env } = await fixture(t);
  const principal = "user:kilo:interleaved";
  const a = await otherIsolate();
  const b = await otherIsolate();
  const at = Date.now();
  // A caches an empty set; B records an exchange that lists the organization.
  await a.recordKiloMembership(env, principal, [], at);
  assert.deepEqual((await a.membershipRecord(env, principal)).organizations, []);
  await b.recordKiloMembership(env, principal, [sentinel], at + 1000);
  // A newer exchange reaches A and lists none: it must be written.
  await a.recordKiloMembership(env, principal, [], at + 2000);
  assert.deepEqual(await stored(env, principal), []);
  a.resetMembershipCache();
  assert.deepEqual((await a.membershipRecord(env, principal)).organizations, []);
  // An exchange sent between the two but delivered last changes nothing.
  await b.recordKiloMembership(env, principal, [sentinel], at + 1500);
  b.resetMembershipCache();
  assert.deepEqual((await b.membershipRecord(env, principal)).organizations, []);
});

test("the fence orders exchanges by the millisecond, and a tie never adds an organization", async (t) => {
  const { env } = await fixture(t);
  const principal = "user:kilo:subsecond";
  const second0 = Math.floor(Date.now() / 1000) * 1000;
  await recordKiloMembership(env, principal, [sentinel], second0 + 100);
  await recordKiloMembership(env, principal, [], second0 + 800);
  assert.deepEqual(await stored(env, principal), [], "a later answer in the same second wins");
  const tie = second0 + 5000;
  await recordKiloMembership(env, principal, [sentinel, second], tie - 1);
  await recordKiloMembership(env, principal, [second, { id: "org-third", name: "Third" }], tie);
  await recordKiloMembership(env, principal, [sentinel, second], tie);
  assert.deepEqual(await stored(env, principal), [second], "same millisecond: only what both list");
  resetMembershipCache();
  assert.deepEqual((await membershipRecord(env, principal)).organizations, [second]);
});

test("every exchange writes, even with an unchanged answer", async (t) => {
  const { env } = await fixture(t);
  const principal = "user:kilo:rewrites";
  const writes = t.mock.method(env.DB, "prepare");
  const inserts = () =>
    writes.mock.calls.filter(({ arguments: [sql] }) =>
      sql.startsWith("INSERT INTO kilo_memberships "),
    ).length;
  const at = Date.now();
  for (const offset of [0, 1000, 2000])
    await recordKiloMembership(env, principal, [sentinel], at + offset);
  assert.equal(inserts(), 3);
});

test("a leased agent token writes its exchange's evidence once, not once per request", async (t) => {
  const { env, kilo } = await fixture(t);
  const writes = t.mock.method(env.DB, "prepare");
  const inserts = () =>
    writes.mock.calls.filter(({ arguments: [sql] }) =>
      sql.startsWith("INSERT INTO kilo_memberships "),
    ).length;
  const account = person([sentinel]);
  const token = kilo.mintToken(account, { audience });
  for (let request = 0; request < 3; request++) await authenticate(bearer(token), env);
  assert.equal(kilo.exchanges().length, 1);
  assert.equal(inserts(), 1);
  await authenticate(bearer(kilo.mintToken(account, { audience, claims: { n: 1 } })), env);
  assert.equal(inserts(), 2, "a new exchange writes again, even with the same answer");
});

/** Makes the next `count` evidence writes fail as an unreachable D1 would,
 * 50 ms after they start so concurrent requests meet them in flight, and
 * counts every evidence write attempted. */
function failEvidenceWrites(t, env, count) {
  const prepare = env.DB.prepare.bind(env.DB);
  let failures = count;
  let attempts = 0;
  t.mock.method(env.DB, "prepare", (sql) => {
    if (!sql.startsWith("INSERT INTO kilo_memberships ")) return prepare(sql);
    attempts++;
    if (failures-- > 0)
      return {
        bind: () => ({
          run: () =>
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("D1 is unreachable")), 50),
            ),
        }),
      };
    return prepare(sql);
  });
  return () => attempts;
}

test("requests on one leased answer share its write, and none goes on past a failed one", async (t) => {
  const { env, kilo } = await fixture(t);
  const account = person([sentinel]);
  // An older exchange listed an organization the new answer leaves out.
  await recordKiloMembership(env, principalOf(account), [second], Date.now() - 5000);
  const attempts = failEvidenceWrites(t, env, 1);
  const token = kilo.mintToken(account, { audience });
  const [first, concurrent] = await Promise.allSettled([
    authenticate(bearer(token), env),
    authenticate(bearer(token), env),
  ]);
  for (const result of [first, concurrent]) {
    assert.equal(result.status, "rejected", "no request goes on with the older listing");
    const { status, code, retryable } = result.reason;
    assert.deepEqual({ status, code, retryable }, {
      status: 503,
      code: "sign_in_unavailable",
      retryable: true,
    });
  }
  assert.equal(attempts(), 1, "the concurrent request awaited the first request's write");
  assert.equal(kilo.exchanges().length, 1);
  const [retried, alongside] = await Promise.all([
    authenticate(bearer(token), env),
    authenticate(bearer(token), env),
  ]);
  assert.equal(attempts(), 2, "the failed write was forgotten and tried once more");
  assert.deepEqual(named(retried), [sentinel]);
  assert.deepEqual(named(alongside), [sentinel]);
  assert.equal(kilo.exchanges().length, 1, "the retry reused the lease, not Kilo");
});

test("a browser sign-in whose evidence write fails gets a retryable failure page and no session", async (t) => {
  const { env, kilo } = await fixture(t);
  const account = person([sentinel]);
  failEvidenceWrites(t, env, 1);
  kilo.signIn(account);
  const started = await handleKiloSignIn(request("/api/auth/login"), env);
  const binding = setCookie(started, "__Host-pages_kilo_handoff");
  const atKilo = await fetch(started.headers.get("location"), { redirect: "manual" });
  const failed = await handleKiloSignIn(
    request(atKilo.headers.get("location"), { cookie: binding }),
    env,
  );
  assert.equal(failed.status, 503);
  assert.equal(setCookie(failed, SERVER_SESSION_COOKIE), undefined);
  assert.match(await failed.text(), /Try again/);
  const cookie = await browserSignIn(env, kilo, account);
  const identity = await authenticate(request("/whoami", { cookie }), env);
  assert.deepEqual(named(identity), [sentinel]);
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
  assert.equal(fresh.organizations[0].expiresAt, sentAt + KILO_MEMBERSHIP_SECONDS * 1000);
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

test("one Kilo sign-in gives both an email proof and organization leases, in a browser and to an agent token", async (t) => {
  const { env, kilo } = await fixture(t);
  const account = { ...person([sentinel]), verifiedEmail: "Member@Example.TEST" };
  const invite = (identity) => ({
    email: "member@example.test",
    namespace: identity.namespace,
    expiresAt: Date.now() + 60_000,
  });
  const cookie = await browserSignIn(env, kilo, account);
  const browser = await authenticate(request("/", { cookie }), env);
  assert.ok(Number.isSafeInteger(browser.emailProof.identityVerifiedAt));
  assert.equal(await invitationMatches(browser, invite(browser), env), true);
  assert.deepEqual(named(browser), [sentinel]);
  const agent = await authenticate(bearer(kilo.mintToken(account, { audience })), env);
  assert.equal(agent.verifiedEmail, "member@example.test");
  assert.equal(await invitationMatches(agent, invite(agent), env), true);
  assert.deepEqual(named(agent), [sentinel]);
});
