import assert from "node:assert/strict";
import { test } from "node:test";
import { SERVER_SESSION_COOKIE } from "@nteract/session";
import { startLocalKiloHandoff } from "../scripts/fixtures/local-kilo-handoff.mjs";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import worker from "./index.mjs";
import { KILO_MEMBERSHIP_SECONDS } from "./kilo-config.mjs";
import { KILO_MEMBER_SEARCH_PATH, kiloDirectory, kiloMembers } from "./kilo-directory.mjs";
import { MAX_PROOF_LENGTH, exchangeKiloCode } from "./kilo-exchange.mjs";
import { handleKiloSignIn } from "./kilo-handoff.mjs";
import {
  DirectoryProtocolError,
  DirectoryRateLimited,
  DirectoryUnavailable,
} from "./organization-directory.mjs";
import {
  directoryCredential,
  membershipRecord,
  recordOrganizationMemberships,
  resetMembershipCache,
} from "./organization-memberships.mjs";
import { world } from "./projects-fixture.mjs";

const acme = Object.freeze({ id: "org-acme-5d1e", name: "Acme Research" });
const other = Object.freeze({ id: "org-other-8b20", name: "Other Guild" });
// Distinctive, so a log line or a response that carried one would be found.
const PROOF = "proof-sentinel-3c9a.signature";

// --- Kilo as the organization directory ------------------------------------

const client = {
  appUrl: "https://kilo.example",
  secret: "deployment-secret-0123456789-0123456789",
  audience: "pages-test",
};
const directoryEnv = {
  PAGES_KILO_APP_URL: client.appUrl,
  PAGES_KILO_AUDIENCE: client.audience,
  PAGES_KILO_EXCHANGE_SECRET: client.secret,
};
const searcher = {
  principal: "user:kilo:searcher%2F1",
  organizationId: acme.id,
  credential: PROOF,
};

/** Kilo as a directory whose fetch answers `status` with `body`, recording
 * each call. */
function answering(status, body) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  };
  return { directory: kiloDirectory(directoryEnv, { fetcher }), fetcher, calls };
}

test("a search posts the searcher's proof and query to Kilo on the deployment secret", async () => {
  const { directory, calls } = answering(200, {
    members: [{ id: "jes-1", name: "Jesse Doe", image_url: "https://avatars.example/j.png" }],
  });
  assert.equal(directory.provider, "kilo");
  assert.equal(directory.namespace, "user:kilo");
  assert.equal(directory.evidenceSeconds, KILO_MEMBERSHIP_SECONDS);
  assert.equal(directory.memberPrincipal("a/b"), "user:kilo:a%2Fb");
  const answer = await directory.search({ ...searcher, query: "jes" });
  assert.deepEqual(answer, {
    members: [{ id: "jes-1", name: "Jesse Doe", imageUrl: "https://avatars.example/j.png" }],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://kilo.example${KILO_MEMBER_SEARCH_PATH}`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${client.secret}`);
  assert.deepEqual(calls[0].body, {
    audience: "pages-test",
    searcher_id: "searcher/1",
    organization_id: acme.id,
    proof: PROOF,
    query: "jes",
  });
});

test("the directory reads what an exchange reported, credential included", () => {
  const { directory } = answering(200, {});
  assert.deepEqual(directory.memberships({ organizations: [acme], memberSearchProof: PROOF }), {
    organizations: [acme],
    credential: PROOF,
  });
  assert.deepEqual(directory.memberships({ organizations: [] }), {
    organizations: [],
    credential: null,
  });
});

test("members Pages can't show, or that could show an address, are dropped", () => {
  const many = Array.from({ length: 14 }, (_, index) => ({
    id: `m-${index}`,
    name: `Member ${index}`,
  }));
  assert.equal(kiloMembers(many).length, 10, "at most ten");
  assert.deepEqual(
    kiloMembers([
      { id: "a", name: "  Ada Lovelace  ", image_url: null },
      { id: "a", name: "Repeat" },
      { id: "", name: "No id" },
      { id: " padded", name: "Padded id" },
      { id: 7, name: "Number id" },
      { id: "b", name: "" },
      { id: "c", name: "   " },
      { id: "d", name: "someone@example.test" },
      { id: "e", name: "someone\uFF20example.test" },
      { id: "f", name: "Grace Hopper", image_url: "http://avatars.example/g.png" },
      { id: "g", name: "Alan Turing", image_url: "javascript:alert(1)" },
      { id: "h", name: "Edsger Dijkstra", image_url: "https://user:pass@avatars.example/e.png" },
      null,
    ]),
    [
      { id: "a", name: "Ada Lovelace", imageUrl: null },
      { id: "f", name: "Grace Hopper", imageUrl: null },
      { id: "g", name: "Alan Turing", imageUrl: null },
      { id: "h", name: "Edsger Dijkstra", imageUrl: null },
    ],
  );
  assert.throws(() => kiloMembers(undefined), DirectoryProtocolError);
  assert.throws(() => kiloMembers({}), DirectoryProtocolError);
});

test("Kilo's refusals and failures become the directory's", async () => {
  const search = (status, body) =>
    answering(status, body).directory.search({ ...searcher, query: "jes" });
  for (const [status, error, refused] of [
    [400, "invalid_request", "request"],
    [401, "invalid_proof", "credential"],
    [403, "not_a_member", "membership"],
  ])
    assert.deepEqual(await search(status, { error }), { refused });
  for (const [status, body] of [
    [401, { error: "invalid_token" }],
    [403, { error: "account_unavailable" }],
    [404, { error: "not_found" }],
    [302, undefined],
    [200, { users: [] }],
  ])
    await assert.rejects(search(status, body), DirectoryProtocolError, String(status));
  await assert.rejects(search(429, { error: "RATE_LIMITED" }), DirectoryRateLimited);
  for (const [status, body] of [
    [401, { error: "invalid_client" }],
    [500, {}],
    [503, { error: "RATE_LIMIT_UNAVAILABLE" }],
  ])
    await assert.rejects(search(status, body), DirectoryUnavailable, String(status));
  const unreachable = kiloDirectory(directoryEnv, {
    fetcher: async () => {
      throw new TypeError("network");
    },
  });
  await assert.rejects(unreachable.search({ ...searcher, query: "jes" }), DirectoryUnavailable);
  // A deployment without Kilo's settings can't ask at all.
  await assert.rejects(
    kiloDirectory({}, { fetcher: answering(200, {}).fetcher }).search({
      ...searcher,
      query: "jes",
    }),
    DirectoryUnavailable,
  );
});

test("a resolve answers the one member asked for or nobody, and nothing else", async () => {
  const one = answering(200, { members: [{ id: "jes-1", name: "Jesse Doe", image_url: null }] });
  assert.deepEqual(await one.directory.resolve({ ...searcher, memberId: "jes-1" }), {
    member: { id: "jes-1", name: "Jesse Doe", imageUrl: null },
  });
  assert.equal(one.calls[0].body.member_id, "jes-1");
  assert.equal("query" in one.calls[0].body, false);
  assert.deepEqual(
    await answering(200, { members: [] }).directory.resolve({ ...searcher, memberId: "jes-1" }),
    { member: null },
  );
  assert.deepEqual(
    await answering(401, { error: "invalid_proof" }).directory.resolve({
      ...searcher,
      memberId: "jes-1",
    }),
    { refused: "credential" },
  );
  for (const members of [
    [{ id: "someone-else", name: "Someone Else" }],
    [
      { id: "jes-1", name: "Jesse Doe" },
      { id: "jes-2", name: "Jesse Roe" },
    ],
  ])
    await assert.rejects(
      answering(200, { members }).directory.resolve({ ...searcher, memberId: "jes-1" }),
      DirectoryProtocolError,
    );
});

test("the exchange keeps a usable proof and signs in without one it can't use", async () => {
  const exchanged = async (proof) =>
    exchangeKiloCode(
      answering(200, {
        user: { id: "person-1", name: "Person" },
        organizations: [],
        ...(proof !== undefined && { member_search_proof: proof }),
      }).fetcher,
      { ...client, code: "code", state: "state" },
    );
  assert.equal((await exchanged(PROOF)).memberSearchProof, PROOF);
  for (const unusable of [
    undefined,
    null,
    "",
    7,
    { proof: PROOF },
    "has space",
    "x".repeat(MAX_PROOF_LENGTH + 1),
  ]) {
    const account = await exchanged(unusable);
    assert.equal(account.id, "person-1", String(unusable));
    assert.equal("memberSearchProof" in account, false, String(unusable));
  }
});

// --- The credential, kept with the membership record ------------------------

const kiloEnv = (t) => ({
  DB: sqliteD1(t).open(),
  PAGES_KILO_APP_URL: "https://kilo.example",
  PAGES_KILO_AUDIENCE: "pages-test",
  PAGES_KILO_EXCHANGE_SECRET: "deployment-secret-0123456789-0123456789",
});
const kiloIdentity = (principal, now) => ({
  principal,
  namespace: "user:kilo",
  expiresAt: now + 60_000,
});

test("the newest exchange's credential is kept, a newer exchange without one clears it, and it ages out with the evidence", async (t) => {
  const env = kiloEnv(t);
  resetMembershipCache();
  const principal = "user:kilo:proof-holder";
  const at = Date.now();
  const who = kiloIdentity(principal, at);
  await recordOrganizationMemberships(env, principal, [acme], at, PROOF);
  assert.equal(await directoryCredential(env, who, at), PROOF);
  // The record every identity reads doesn't carry it.
  assert.deepEqual(Object.keys(await membershipRecord(env, principal, at)).sort(), [
    "organizations",
    "verifiedAtMs",
  ]);
  // An older exchange changes nothing; one in the same millisecond keeps the
  // proof it doesn't replace.
  await recordOrganizationMemberships(env, principal, [acme], at - 1, "older-proof");
  await recordOrganizationMemberships(env, principal, [acme], at, null);
  assert.equal(await directoryCredential(env, who, at), PROOF);
  await recordOrganizationMemberships(env, principal, [acme], at + 1, null);
  assert.equal(await directoryCredential(env, who, at + 1), null, "a newer exchange without one");
  await recordOrganizationMemberships(env, principal, [acme], at + 2, "newer-proof");
  assert.equal(await directoryCredential(env, who, at + 2), "newer-proof");
  const end = at + 2 + KILO_MEMBERSHIP_SECONDS * 1000;
  assert.equal(
    await directoryCredential(env, { ...who, expiresAt: end + 1 }, end - 1),
    "newer-proof",
  );
  assert.equal(await directoryCredential(env, { ...who, expiresAt: end + 1 }, end), null);
  // Only a live Kilo identity reads one.
  assert.equal(await directoryCredential(env, { ...who, expiresAt: at }, at + 2), null);
  assert.equal(
    await directoryCredential(
      env,
      { ...who, principal: "user:other:x", namespace: "user:other" },
      at,
    ),
    null,
  );
});

// --- Browser sign-in and the search route ----------------------------------

const origin = "http://127.0.0.1:9479";
const audience = "pages-member-test";
const secret = "kilo-exchange-fixture-secret-0123456789";

async function signedIn(t, { memberSearch = true } = {}) {
  const kilo = await startLocalKiloHandoff({
    deployments: { [audience]: origin },
    secret,
    memberSearch,
  });
  t.after(() => kilo.close());
  resetMembershipCache();
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
  const account = {
    id: "searcher-person",
    name: "Searcher Person",
    organizations: [
      { ...acme, role: "member" },
      { ...other, role: "member" },
    ],
  };
  kilo.members(acme.id, [
    { id: "jesse-person", name: "Jesse Doe", image_url: "https://avatars.example/jesse.png" },
    { id: "jessica-person", name: "Jessica Roe" },
    { id: "address-person", name: "jes@example.test" },
    { id: "jordan-person", name: "Jordan Poe" },
  ]);
  kilo.members(other.id, [{ id: "jesper-person", name: "Jesper Other" }]);
  kilo.signIn(account);
  const at = (path, headers = {}) => new Request(new URL(path, origin), { headers });
  const started = await handleKiloSignIn(at("/api/auth/login"), env);
  const binding = started.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-pages_kilo_handoff="))
    .split(";", 1)[0];
  const atKilo = await fetch(started.headers.get("location"), { redirect: "manual" });
  const done = await handleKiloSignIn(at(atKilo.headers.get("location"), { cookie: binding }), env);
  assert.equal(done.status, 303);
  const cookie = done.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${SERVER_SESSION_COOKIE}=`))
    .split(";", 1)[0];
  const search = async (body, headers = {}) => {
    const response = await worker.fetch(
      new Request(new URL("/api/organization-members", origin), {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      env,
    );
    return { status: response.status, body: await response.json() };
  };
  return { kilo, env, cookie, search, lines };
}

test("a signed-in person finds colleagues by name in their organization, with names and avatars only", async (t) => {
  const { kilo, search, lines } = await signedIn(t);
  const found = await search({ organization_id: acme.id, query: "  jes " });
  assert.equal(found.status, 200, JSON.stringify(found.body));
  assert.deepEqual(found.body, {
    members: [
      { id: "jesse-person", name: "Jesse Doe", image_url: "https://avatars.example/jesse.png" },
      { id: "jessica-person", name: "Jessica Roe", image_url: null },
    ],
  });
  // The person searching never finds themself.
  const self = await search({ organization_id: acme.id, query: "Searcher" });
  assert.deepEqual(self.body, { members: [] });
  // Another of their organizations is searched only when named.
  const elsewhere = await search({ organization_id: other.id, query: "jes" });
  assert.deepEqual(
    elsewhere.body.members.map(({ id }) => id),
    ["jesper-person"],
  );
  const calls = kilo.memberCalls();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].fields, [
    "audience",
    "organization_id",
    "proof",
    "query",
    "searcher_id",
  ]);
  assert.equal(calls[0].searcher_id, "searcher-person");
  assert.equal(calls[0].query, "jes", "the query is trimmed");
  assert.equal(calls[0].authorization, `Bearer ${secret}`);
  // The proof went only to Kilo: never to a log line or a response.
  const proof = calls[0].proof;
  assert.ok(proof);
  assert.equal(lines.join("\n").includes(proof), false);
  assert.equal(JSON.stringify([found, self, elsewhere]).includes(proof), false);
});

test("a search Pages can refuse never reaches Kilo", async (t) => {
  const { kilo, search } = await signedIn(t);
  for (const [body, status] of [
    [{ organization_id: acme.id, query: "j" }, 400],
    [{ organization_id: acme.id, query: " j  " }, 400],
    [{ organization_id: acme.id, query: "x".repeat(101) }, 400],
    [{ organization_id: acme.id }, 400],
    [{ organization_id: acme.id, query: "jes", member_id: "jesse-person" }, 400],
    [{ query: "jes" }, 400],
    [{ organization_id: "org-not-mine", query: "jes" }, 403],
  ]) {
    const refused = await search(body);
    assert.equal(refused.status, status, JSON.stringify(body));
  }
  const notMine = await search({ organization_id: "org-not-mine", query: "jes" });
  assert.equal(notMine.body.code, "organization_proof_required");
  assert.equal(
    (await search({ organization_id: acme.id, query: "jes" }, { origin: "https://evil.example" }))
      .status,
    403,
  );
  assert.equal(kilo.memberCalls().length, 0);
});

test("with a Kilo that sends no proof, search is off and Kilo is never asked", async (t) => {
  const { kilo, search } = await signedIn(t, { memberSearch: false });
  const refused = await search({ organization_id: acme.id, query: "jes" });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "organization_proof_required");
  assert.equal(kilo.memberCalls().length, 0);
});

test("Kilo's refusals and failures reach the dialog as codes it can act on", async (t) => {
  const { kilo, search } = await signedIn(t);
  const answer = (status, body) =>
    kilo.respondMembers((req, res) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)),
    );
  const cases = [
    [401, { error: "invalid_proof" }, 403, "organization_proof_required"],
    [403, { error: "not_a_member" }, 403, "organization_proof_required"],
    [401, { error: "invalid_client" }, 503, "member_search_unavailable"],
    [503, { error: "RATE_LIMIT_UNAVAILABLE" }, 503, "member_search_unavailable"],
    [200, { nope: true }, 503, "member_search_unavailable"],
    [429, { error: "RATE_LIMITED" }, 429, undefined],
  ];
  for (const [status, body, expected, code] of cases) {
    answer(status, body);
    const refused = await search({ organization_id: acme.id, query: "jes" });
    assert.equal(refused.status, expected, JSON.stringify(body));
    assert.equal(refused.body.code, code, JSON.stringify(body));
  }
});

// --- Granting a pick, on a Page and on a Project ----------------------------

/** A direct call to a host's sharing route, as the gateway forwards one. */
const hostAccess = async (w, who, url, body) => {
  const response = await url.fetch(
    new Request(`https://pages.invalid${url.path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${w.token(who)}`,
        "x-pages-driver": "Member picker test",
      },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() };
};
const pageAccess = (w, pageId) => ({
  path: "/internal/access",
  fetch: (request) => w.env.PAGES.getByName(pageId).fetch(request),
});
const projectAccess = (w, projectId) => ({
  path: "/internal/space/access",
  fetch: (request) => w.env.PROJECTS.getByName(projectId).fetch(request),
});

async function pickWorld(t, { memberSearch = true } = {}) {
  const w = await world(t, {
    kilo: { owner: [acme], member: [acme], stranger: [other] },
    memberSearch,
  });
  w.kilo.members(acme.id, [{ id: "jesse-person", name: "Jesse Doe" }]);
  return w;
}

test("an owner grants a Page to a colleague Kilo confirms, under the name Kilo sends", async (t) => {
  const w = await pickWorld(t);
  const { page_id } = (await w.createPage({ title: "Plans" })).body;
  const read = await hostAccess(w, "owner", pageAccess(w, page_id), { read: true });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.memberSearch, true);
  const nonce = w.key();
  const args = {
    action: "grant_organization_member",
    organization_id: acme.id,
    member_id: "jesse-person",
    role: "commenter",
    // Ignored: the grant takes the name Kilo sends.
    name: "Forged Name",
    principal: "user:kilo:someone-else",
    expected_revision: read.body.access.revision,
    nonce,
  };
  const granted = await hostAccess(w, "owner", pageAccess(w, page_id), args);
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.deepEqual(
    granted.body.members.map(({ principal, role, displayName }) => ({
      principal,
      role,
      displayName,
    })),
    [{ principal: "user:kilo:jesse-person", role: "commenter", displayName: "Jesse Doe" }],
  );
  const calls = w.kilo.memberCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].member_id, "jesse-person");
  assert.equal(calls[0].searcher_id, "owner-person");
  // A retry replays the receipt without asking Kilo again.
  const replay = await hostAccess(w, "owner", pageAccess(w, page_id), args);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.deepEqual(replay.body.receipt, granted.body.receipt);
  assert.equal(w.kilo.memberCalls().length, 1);
  // The grant is a plain member row: removing it is set_role.
  const removed = await hostAccess(w, "owner", pageAccess(w, page_id), {
    action: "set_role",
    principal: "user:kilo:jesse-person",
    role: null,
    expected_revision: granted.body.access.revision,
    nonce: w.key(),
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.deepEqual(removed.body.members, []);
});

test("a pick Kilo doesn't confirm grants nothing", async (t) => {
  const w = await pickWorld(t);
  const { page_id } = (await w.createPage({ title: "Plans" })).body;
  const page = pageAccess(w, page_id);
  const grant = (args) =>
    hostAccess(w, "owner", page, {
      action: "grant_organization_member",
      organization_id: acme.id,
      member_id: "jesse-person",
      role: "viewer",
      expected_revision: 0,
      nonce: w.key(),
      ...args,
    });
  const answer = (status, body) =>
    w.kilo.respondMembers((req, res) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)),
    );
  // Someone in another organization, or nobody at all.
  for (const member_id of ["stranger-person", "nobody-person"]) {
    const refused = await grant({ member_id });
    assert.equal(refused.status, 404, member_id);
    assert.equal(refused.body.code, "member_not_found");
  }
  // An organization the owner holds no lease for is refused before Kilo.
  const calls = w.kilo.memberCalls().length;
  const notMine = await grant({ organization_id: other.id });
  assert.equal(notMine.status, 403);
  assert.equal(notMine.body.code, "organization_proof_required");
  assert.equal(w.kilo.memberCalls().length, calls);
  // Kilo refusing the proof or the membership, or not answering.
  answer(401, { error: "invalid_proof" });
  assert.equal((await grant({})).body.code, "organization_proof_required");
  answer(403, { error: "not_a_member" });
  assert.equal((await grant({})).body.code, "organization_proof_required");
  answer(503, { error: "RATE_LIMIT_UNAVAILABLE" });
  const down = await grant({});
  assert.equal(down.status, 503);
  assert.equal(down.body.code, "member_search_unavailable");
  assert.equal(down.body.retryable, true);
  // A role that isn't grantable, or no member id, never reaches a grant.
  assert.equal((await grant({ role: null })).status, 400);
  assert.equal((await grant({ member_id: "" })).status, 400);
  const read = await hostAccess(w, "owner", page, { read: true });
  assert.deepEqual(read.body.members, []);
  assert.equal(read.body.access.revision, 0);
});

test("without a proof from Kilo the dialog gets no picker and a pick is refused before Kilo", async (t) => {
  const w = await pickWorld(t, { memberSearch: false });
  const { page_id } = (await w.createPage({ title: "Plans" })).body;
  const page = pageAccess(w, page_id);
  const read = await hostAccess(w, "owner", page, { read: true });
  assert.equal(read.body.memberSearch, false);
  assert.deepEqual(read.body.organizationOptions, [acme]);
  const refused = await hostAccess(w, "owner", page, {
    action: "grant_organization_member",
    organization_id: acme.id,
    member_id: "jesse-person",
    role: "viewer",
    expected_revision: 0,
    nonce: w.key(),
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "organization_proof_required");
});

test("an owner grants a Project to a colleague Kilo confirms, and it reaches their list", async (t) => {
  const w = await pickWorld(t);
  const { project_id } = await w.createProject("Guild");
  const project = projectAccess(w, project_id);
  const read = await hostAccess(w, "owner", project, { space_id: project_id, read: true });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.memberSearch, true);
  const args = {
    space_id: project_id,
    action: "grant_organization_member",
    organization_id: acme.id,
    member_id: "member-person",
    role: "editor",
    expected_revision: 0,
    nonce: w.key(),
  };
  const granted = await hostAccess(w, "owner", project, args);
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.deepEqual(granted.body.members["user:kilo:member-person"].role, "editor");
  assert.equal(granted.body.members["user:kilo:member-person"].displayName, "Member Person");
  const replay = await hostAccess(w, "owner", project, args);
  assert.deepEqual(replay.body.members, granted.body.members);
  assert.equal(w.kilo.memberCalls().length, 1, "a retry doesn't ask Kilo again");
  const listed = await w.call("member", "list_projects", {});
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(
    listed.body.projects.map(({ project_id }) => project_id),
    [project_id],
  );
  // A member can't pick for the owner's Project.
  const member = await hostAccess(w, "member", project, {
    ...args,
    member_id: "jesse-person",
    expected_revision: granted.body.revision,
    nonce: w.key(),
  });
  assert.equal(member.status, 403);
  const unknown = await hostAccess(w, "owner", project, {
    ...args,
    member_id: "nobody-person",
    expected_revision: granted.body.revision,
    nonce: w.key(),
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, "member_not_found");
});

test("only the owner picks: an editor's pick is refused before the directory is asked", async (t) => {
  const w = await pickWorld(t);
  const { page_id } = (await w.createPage({ title: "Plans" })).body;
  const page = pageAccess(w, page_id);
  const shared = await hostAccess(w, "owner", page, {
    action: "set_role",
    principal: "user:kilo:member-person",
    role: "editor",
    expected_revision: 0,
    nonce: w.key(),
  });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  const refused = await hostAccess(w, "member", page, {
    action: "grant_organization_member",
    organization_id: acme.id,
    member_id: "jesse-person",
    role: "viewer",
    expected_revision: shared.body.access.revision,
    nonce: w.key(),
  });
  assert.equal(refused.status, 403);
  assert.equal(w.kilo.memberCalls().length, 0);
});

test("Kilo's Retry-After on a 429 reaches the dialog", async (t) => {
  const limited = kiloDirectory(directoryEnv, {
    fetcher: async () =>
      new Response(JSON.stringify({ error: "RATE_LIMITED" }), {
        status: 429,
        headers: { "retry-after": "30" },
      }),
  });
  await assert.rejects(limited.search({ ...searcher, query: "jes" }), (error) => {
    assert.ok(error instanceof DirectoryRateLimited);
    assert.equal(error.retryAfterMs, 30_000);
    return true;
  });
  const { kilo, cookie, env } = await signedIn(t);
  kilo.respondMembers((req, res) =>
    res
      .writeHead(429, { "content-type": "application/json", "retry-after": "12" })
      .end(JSON.stringify({ error: "RATE_LIMITED" })),
  );
  const response = await worker.fetch(
    new Request(new URL("/api/organization-members", origin), {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ organization_id: acme.id, query: "jes" }),
    }),
    env,
  );
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "12");
  assert.equal((await response.json()).retry_after_ms, 12_000);
});
