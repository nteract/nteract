// The address Kilo vouches for, from its exchange to a claimed invitation:
// the exchange's parse, a browser session's email proof, a Kilo agent
// token's verified address and an OAuth grant made from a Kilo session.
import assert from "node:assert/strict";
import { test } from "node:test";
import { NOTEBOOK_CLOUD_IDENTITY_PROOF_MAX_AGE_SECONDS } from "@cloud/app-session.ts";
import { secretHash, SERVER_SESSION_COOKIE } from "@cloud/oidc-session-store.ts";
import { startLocalKiloHandoff } from "../scripts/fixtures/local-kilo-handoff.mjs";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import { authenticate } from "./auth.mjs";
import { companyViewDomains, verifiedCompanyDomains } from "./domain-access.mjs";
import { exchangeKiloCode, exchangeKiloToken, KiloProtocolError } from "./kilo-exchange.mjs";
import { handleKiloSignIn } from "./kilo-handoff.mjs";
import { handleOAuth } from "./oauth.mjs";
import { quotaEvidence } from "./page-quota.mjs";
import { indexProjectInvitations, invitedProjects } from "./project-invitations.mjs";
import { inviteEmail, MAX_INVITE_EMAIL_LENGTH } from "./invite-email.mjs";
import { claimInvitation, invitationMatches, proposeSharingMutation } from "./sharing.mjs";

const origin = "http://127.0.0.1:9477";
const audience = "pages-test";
const secret = "kilo-exchange-fixture-secret-0123456789";
const namespace = "user:kilo";
const address = "person@example.test";
const BINDING = "__Host-pages_kilo_handoff";
// Unique per test: the token lease outlives a test, and a token is its key.
let people = 0;
const person = (extra = {}) => ({
  id: `verified:${++people}`,
  name: "Example Person",
  verifiedEmail: " Person@Example.TEST ",
  ...extra,
});

/** A Kilo deployment beside a fake Kilo, with every console line captured.
 * Company-domain view is configured for the address's domain, so a test can
 * show it stays off anyway. */
async function fixture(t) {
  const kilo = await startLocalKiloHandoff({ deployments: { [audience]: origin }, secret });
  const env = {
    DB: sqliteD1(t).open(),
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
    NOTEBOOK_CLOUD_LOCAL_OIDC: "true",
    NOTEBOOK_CLOUD_OIDC_FLOW: "server",
    NOTEBOOK_CLOUD_OIDC_ISSUER: "https://issuer.example",
    NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "pages",
    NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: namespace,
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: "kilo-session-fixture-secret-".repeat(3),
    PAGES_COMPANY_VIEW_DOMAINS: "example.test",
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
  return { env, kilo, lines };
}

const request = (path, { cookie, headers = {} } = {}) =>
  new Request(new URL(path, origin), { headers: { ...(cookie && { cookie }), ...headers } });
const setCookie = (response, name) =>
  response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`))
    ?.split(";", 1)[0];

/** Signs `account` in through Kilo in one browser and returns its session
 * cookie. */
async function browserSignIn(env, kilo, account) {
  kilo.signIn(account);
  const started = await handleKiloSignIn(request("/api/auth/login?return_to=%2F"), env);
  const binding = setCookie(started, BINDING);
  const atKilo = await fetch(started.headers.get("location"), { redirect: "manual" });
  const back = await handleKiloSignIn(
    request(atKilo.headers.get("location"), { cookie: binding }),
    env,
  );
  assert.equal(back.status, 303);
  return setCookie(back, SERVER_SESSION_COOKIE);
}
const browserIdentity = async (env, kilo, account) =>
  authenticate(request("/whoami", { cookie: await browserSignIn(env, kilo, account) }), env);
const tokenIdentity = (env, kilo, account) =>
  authenticate(
    request("/mcp", {
      headers: { authorization: `Bearer ${kilo.mintToken(account, { audience })}` },
    }),
    env,
  );

const owner = {
  principal: `${namespace}:owner`,
  namespace,
  displayName: "Owner",
  canWrite: true,
};
let nonces = 0;
/** A Page's sharing metadata with one pending invitation for `email`. */
async function invitedPage(email, now = Date.now()) {
  const { metadata } = await proposeSharingMutation(
    { owner: owner.principal, ownerName: "Owner", deleted: false },
    { ...owner, expiresAt: now + 60_000 },
    { action: "invite", email, role: "editor", expected_revision: 0, nonce: `kilo-${++nonces}` },
    now,
  );
  return metadata;
}
/** A Project record with one pending invitation for `email`, indexed for
 * discovery as the Project host indexes it. */
async function invitedProject(env, email, now = Date.now()) {
  const metadata = await invitedPage(email, now);
  const record = { space_id: `project-${nonces}`, owner: owner.principal, acl: metadata.acl };
  await indexProjectInvitations(env, record);
  return { ...record, pageId: record.space_id, deleted: false };
}

/** What an identity can claim: a Page and a Project invitation to the
 * address, and neither one to another address. */
async function assertClaims(env, identity, now = Date.now()) {
  const page = await claimInvitation(await invitedPage(address, now), identity, env, now);
  assert.equal(page?.acl.members[identity.principal].role, "editor");
  const project = await invitedProject(env, " PERSON@example.test ", now);
  assert.ok((await invitedProjects(env, identity)).includes(project.space_id));
  const joined = await claimInvitation(project, identity, env, now);
  assert.equal(joined?.acl.members[identity.principal].role, "editor");
  assert.equal(
    await claimInvitation(await invitedPage("someone@example.test", now), identity, env, now),
    null,
  );
  const elsewhere = await invitedProject(env, "someone@example.test", now);
  assert.ok(!(await invitedProjects(env, identity)).includes(elsewhere.space_id));
  assert.equal(await claimInvitation(elsewhere, identity, env, now), null);
}
/** That an identity claims no invitation to the address at `at`, or now.
 * Discovery always checks against the clock, so it is checked only for now. */
async function assertClaimsNothing(env, identity, at) {
  const now = at ?? Date.now();
  assert.equal(await claimInvitation(await invitedPage(address, now), identity, env, now), null);
  const project = await invitedProject(env, address, now);
  if (at === undefined)
    assert.ok(!(await invitedProjects(env, identity)).includes(project.space_id));
  assert.equal(await claimInvitation(project, identity, env, now), null);
}

// U+0130 lowercases to two code units.
const dotted = `${"\u0130".repeat(240)}@example.test`;
/** Every `verified_email` the exchange must read as no address. */
const unusable = [
  null,
  42,
  true,
  {},
  [address],
  "",
  "   ",
  "no-at-sign",
  "two@at@signs.test",
  "@example.test",
  "person@",
  "with space@example.test",
  "slash/person@example.test",
  `${"a".repeat(255 - "@example.test".length)}@example.test`,
  // 253 code units that lowercase to 493: under the limit only before
  // normalizing.
  dotted,
];

const answer = (user) => async () => Response.json({ user, organizations: [] });
const exchangeCode = (user) =>
  exchangeKiloCode(answer(user), {
    appUrl: "https://kilo.invalid",
    secret,
    code: "code",
    audience,
    state: "state",
  });
const exchangeToken = (user) =>
  exchangeKiloToken(answer(user), {
    appUrl: "https://kilo.invalid",
    secret,
    token: "t.t.t",
    audience,
  });

test("the exchange keeps a usable verified address, normalized as an invitation stores it", async () => {
  for (const exchange of [exchangeCode, exchangeToken]) {
    assert.deepEqual(
      await exchange({ id: "person:1", name: "Example", verified_email: " Person@Example.TEST " }),
      { id: "person:1", name: "Example", verifiedEmail: address, organizations: [] },
    );
    assert.deepEqual(await exchange({ id: "person:1", name: "Example" }), {
      id: "person:1",
      name: "Example",
      organizations: [],
    });
    // An unverified address is another key, and is never read.
    assert.deepEqual(await exchange({ id: "person:1", name: "Example", email: address }), {
      id: "person:1",
      name: "Example",
      organizations: [],
    });
  }
});

test("a verified address Pages can't use reads as none, and the sign-in still succeeds", async () => {
  for (const exchange of [exchangeCode, exchangeToken])
    for (const value of unusable)
      assert.deepEqual(
        await exchange({ id: "person:1", name: "Example", verified_email: value }),
        { id: "person:1", name: "Example", organizations: [] },
        JSON.stringify(value),
      );
  // The longest usable address is kept.
  const longest = `${"a".repeat(254 - "@example.test".length)}@example.test`;
  assert.equal(
    (await exchangeCode({ id: "person:1", name: null, verified_email: longest })).verifiedEmail,
    longest,
  );
});

test("a Kilo browser session claims Page and Project invitations to its verified address", async (t) => {
  const { env, kilo, lines } = await fixture(t);
  const holder = person();
  const identity = await browserIdentity(env, kilo, holder);
  assert.equal(identity.credentialKind, "oidc");
  assert.equal(identity.verifiedEmail, undefined, "a session holds proof, not the address");
  assert.ok(Number.isSafeInteger(identity.emailProof.identityVerifiedAt));
  await assertClaims(env, identity);
  // Email quota rules can match this proof.
  assert.ok(quotaEvidence(identity));
  // The proof lasts 6 hours from sign-in; the session can last 8.
  const stale =
    (identity.emailProof.identityVerifiedAt + NOTEBOOK_CLOUD_IDENTITY_PROOF_MAX_AGE_SECONDS) * 1000;
  await assertClaimsNothing(env, identity, stale);
  for (const value of [address, holder.verifiedEmail, holder.verifiedEmail.trim()])
    assert.ok(!lines.some((line) => line.includes(value)), value);
  assert.ok(lines.some((line) => line.includes('"sign_in.succeeded"')));
});

test("a Kilo browser session without a verified address signs in and claims nothing", async (t) => {
  const { env, kilo } = await fixture(t);
  for (const holder of [
    person({ verifiedEmail: undefined, email: address }),
    person({ verifiedEmail: "not an address" }),
  ]) {
    if (holder.verifiedEmail === undefined) delete holder.verifiedEmail;
    const identity = await browserIdentity(env, kilo, holder);
    assert.equal(identity.emailProof.identityVerifiedAt, undefined);
    assert.equal(quotaEvidence(identity), null);
    await assertClaimsNothing(env, identity);
  }
});

test("a Kilo agent token claims Page and Project invitations to its verified address", async (t) => {
  const { env, kilo, lines } = await fixture(t);
  const holder = person();
  const identity = await tokenIdentity(env, kilo, holder);
  assert.equal(identity.credentialKind, "kilo-token");
  assert.equal(identity.verifiedEmail, address);
  await assertClaims(env, identity);
  // Quota rules read only API-key addresses and browser or OAuth proof.
  assert.equal(quotaEvidence(identity), null);
  // The leased account keeps the address: the next request asks Kilo nothing.
  const exchanged = kilo.exchanges().length;
  const token = kilo.mintToken(holder, {
    audience,
    claims: { iat: Math.floor(Date.now() / 1000) - 7 },
  });
  const first = await authenticate(
    request("/mcp", { headers: { authorization: `Bearer ${token}` } }),
    env,
  );
  const again = await authenticate(
    request("/mcp", { headers: { authorization: `Bearer ${token}` } }),
    env,
  );
  assert.equal(kilo.exchanges().length, exchanged + 1);
  assert.equal(first.verifiedEmail, address);
  assert.equal(again.verifiedEmail, address);
  for (const value of [address, holder.verifiedEmail.trim()])
    assert.ok(!lines.some((line) => line.includes(value)), value);
  assert.ok(lines.some((line) => line.includes('"kilo_token.accepted"')));
});

test("a Kilo agent token without a usable verified address claims nothing", async (t) => {
  const { env, kilo } = await fixture(t);
  for (const holder of [
    { id: `unverified:${++people}`, name: "Example Person", email: address },
    person({ verifiedEmail: 7 }),
  ]) {
    const identity = await tokenIdentity(env, kilo, holder);
    assert.equal(identity.verifiedEmail, undefined);
    await assertClaimsNothing(env, identity);
  }
});

test("company-domain view stays off for Kilo identities whatever Kilo verifies", async (t) => {
  const { env, kilo } = await fixture(t);
  // Configured for the address's domain, but Kilo reviews no company domains.
  assert.deepEqual(companyViewDomains(env), []);
  for (const identity of [
    await browserIdentity(env, kilo, person()),
    await tokenIdentity(env, kilo, person()),
  ]) {
    assert.equal(identity.domainAccess, undefined);
    assert.deepEqual(await verifiedCompanyDomains(env, identity), []);
  }
});

test("an OAuth client approved from a Kilo session keeps the session's email proof", async (t) => {
  const { env, kilo, lines } = await fixture(t);
  const cookie = await browserSignIn(env, kilo, person());
  const browser = await authenticate(request("/whoami", { cookie }), env);
  const verifier = "v".repeat(43);
  const authorize = new URLSearchParams({
    client_id: "pages-chatgpt",
    redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
    response_type: "code",
    resource: `${origin}/mcp`,
    code_challenge: await secretHash(verifier),
    code_challenge_method: "S256",
    scope: "pages:read pages:write",
    state: "client-state",
  });
  const screen = await handleOAuth(request(`/oauth/authorize?${authorize}`, { cookie }), env);
  assert.equal(screen.status, 200, await screen.clone().text());
  const text = await screen.text();
  const field = (name) => text.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1];
  const approved = await handleOAuth(
    new Request(`${origin}/oauth/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin,
        cookie,
      },
      body: new URLSearchParams({
        consent_id: field("consent_id"),
        csrf_token: field("csrf_token"),
        decision: "approve",
      }),
    }),
    env,
  );
  assert.equal(approved.status, 303, await approved.clone().text());
  const code = new URL(approved.headers.get("location")).searchParams.get("code");
  const issued = await handleOAuth(
    new Request(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "pages-chatgpt",
        redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
        resource: `${origin}/mcp`,
        code_verifier: verifier,
        code,
      }),
    }),
    env,
  );
  assert.equal(issued.status, 200, await issued.clone().text());
  const { access_token: accessToken } = await issued.json();
  const identity = await authenticate(
    request("/mcp", { headers: { authorization: `Bearer ${accessToken}` } }),
    env,
  );
  assert.equal(identity.credentialKind, "oauth");
  // The grant snapshots the session's proof, sign-in time included: it ages
  // from the browser sign-in, not from the grant.
  assert.deepEqual(identity.emailProof, browser.emailProof);
  await assertClaims(env, identity);
  const stale =
    (browser.emailProof.identityVerifiedAt + NOTEBOOK_CLOUD_IDENTITY_PROOF_MAX_AGE_SECONDS) * 1000;
  await assertClaimsNothing(env, identity, stale);
  assert.ok(!lines.some((line) => line.includes(address)));
});

test("what inviteEmail returns passes it again unchanged", () => {
  assert.equal(dotted.length, 253);
  assert.equal(dotted.trim().toLowerCase().length, 493);
  const usable = [
    address,
    " Person@Example.TEST ",
    `${"a".repeat(MAX_INVITE_EMAIL_LENGTH - "@example.test".length)}@example.test`,
    `${"İ".repeat(120)}@example.test`,
  ];
  for (const value of [...unusable, ...usable]) {
    const once = inviteEmail(value);
    assert.equal(inviteEmail(once), once, JSON.stringify(value));
    if (once !== null) assert.ok(once.length <= MAX_INVITE_EMAIL_LENGTH);
  }
  for (const value of unusable) assert.equal(inviteEmail(value), null, JSON.stringify(value));
});

test("an address that lowercases past the limit is no address, and matches no invitation", async (t) => {
  for (const exchange of [exchangeCode, exchangeToken])
    assert.deepEqual(await exchange({ id: "person:1", name: "Example", verified_email: dotted }), {
      id: "person:1",
      name: "Example",
      organizations: [],
    });
  // Inviting it is refused, so no stored invitation holds it.
  await assert.rejects(invitedPage(dotted), { status: 400 });
  // A credential that presents it declines every invitation instead of
  // failing the request.
  const invite = Object.values((await invitedPage(address)).acl.invites)[0];
  assert.equal(
    await invitationMatches(
      { principal: `${namespace}:x`, namespace, verifiedEmail: dotted },
      invite,
      {},
    ),
    false,
  );
  const { env, kilo } = await fixture(t);
  const identity = await tokenIdentity(env, kilo, person({ verifiedEmail: dotted }));
  assert.equal(identity.verifiedEmail, undefined);
  await assertClaimsNothing(env, identity);
});

test("an answer over the body limit is refused whatever field makes it large", async (t) => {
  const MAX_BODY_BYTES = 16 * 1024;
  // An answer of exactly `bytes` bytes whose verified_email is unusable.
  const sized = (bytes) => {
    const shape = (filler) => ({
      user: { id: "person:1", name: "Example", verified_email: filler },
      organizations: [],
    });
    const overhead = JSON.stringify(shape("")).length;
    const body = shape("x".repeat(bytes - overhead));
    assert.equal(JSON.stringify(body).length, bytes);
    return body;
  };
  for (const exchange of [
    (fetcher) =>
      exchangeKiloCode(fetcher, {
        appUrl: "https://kilo.invalid",
        secret,
        code: "c",
        audience,
        state: "s",
      }),
    (fetcher) =>
      exchangeKiloToken(fetcher, {
        appUrl: "https://kilo.invalid",
        secret,
        token: "t.t.t",
        audience,
      }),
  ]) {
    assert.deepEqual(await exchange(async () => Response.json(sized(MAX_BODY_BYTES))), {
      id: "person:1",
      name: "Example",
      organizations: [],
    });
    await assert.rejects(
      exchange(async () => Response.json(sized(MAX_BODY_BYTES + 1))),
      KiloProtocolError,
    );
  }
  // Through the real routes: the browser sign-in fails and the token is a 503.
  const { env, kilo, lines } = await fixture(t);
  const huge = person({ verifiedEmail: `${"x".repeat(MAX_BODY_BYTES)}@example.test` });
  kilo.signIn(huge);
  const started = await handleKiloSignIn(request("/api/auth/login?return_to=%2F"), env);
  const atKilo = await fetch(started.headers.get("location"), { redirect: "manual" });
  const back = await handleKiloSignIn(
    request(atKilo.headers.get("location"), { cookie: setCookie(started, BINDING) }),
    env,
  );
  assert.equal(back.status, 502);
  assert.equal(setCookie(back, SERVER_SESSION_COOKIE), undefined);
  await assert.rejects(tokenIdentity(env, kilo, huge), {
    status: 503,
    code: "sign_in_unavailable",
  });
  assert.ok(kilo.exchanges().length >= 2);
  assert.ok(!lines.some((line) => line.includes("x".repeat(64))));
});
