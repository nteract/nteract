import assert from "node:assert/strict";
import { test } from "node:test";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import { pageAccess, restrictAccessDuringCommit } from "./access.mjs";
import { issueAssetUpload, uploadIdentity, verifyAssetUpload } from "./asset-uploads.mjs";
import { errorResponse, HttpError, withDomainAccess } from "./auth.mjs";
import {
  listingRestricted,
  migrateCatalogIndex,
  queryCatalogIndex,
  reportPageIndex,
  restrictPageIndex,
} from "./catalog-index.mjs";
import { Page } from "./index.mjs";
import { KILO_MEMBERSHIP_SECONDS } from "./kilo-config.mjs";
import {
  organizationLeases,
  recordKiloMembership,
  resetMembershipCache,
} from "./kilo-membership.mjs";
import { identityAudienceKeys, organizationAudienceKey } from "./organization-access.mjs";
import { plainStub } from "./plain-stub.mjs";
import { Storage } from "./projects-fixture.mjs";
import { DocumentPolicy, leaseExpiryError } from "./policy.mjs";
import { proposeSharingMutation, sharingProjection } from "./sharing.mjs";
import { purgeImpact } from "./trash.mjs";

const now = Math.floor(Date.now() / 1000) * 1000;
const namespace = "user:kilo";
const acme = Object.freeze({ id: "org-acme", name: "Acme Research" });
const other = Object.freeze({ id: "org-other", name: "Other Guild" });
const owner = {
  principal: `${namespace}:owner`,
  namespace,
  canWrite: true,
  credentialKind: "oidc",
  expiresAt: now + 60_000,
};
const reader = {
  principal: `${namespace}:reader`,
  namespace,
  canWrite: true,
  credentialKind: "oidc",
  expiresAt: now + 60_000,
};
const lease = (organization = acme, expiresAt = now + 30_000) => ({
  ...organization,
  namespace,
  expiresAt,
});
const member = (organizations = [lease()]) => ({ ...reader, organizations });
const grant = (role = "viewer", organization = acme) => ({
  id: organization.id,
  name: organization.name,
  namespace,
  role,
});
const page = (organizationAccess) => ({
  pageId: "org-page",
  owner: owner.principal,
  deleted: false,
  acl: {
    revision: 1,
    members: {},
    invites: {},
    ...(organizationAccess && { organizationAccess }),
  },
});

function kiloEnv(t) {
  resetMembershipCache();
  return { DB: sqliteD1(t).open(), PAGES_KILO_APP_URL: "https://kilo.invalid" };
}
const setArgs = (organization_id, role, nonce = `set-${organization_id}-${role}`) => ({
  action: "set_organization_access",
  organization_id,
  ...(role !== undefined && { role }),
  expected_revision: 1,
  nonce,
});
async function rejectsWith(promise, status, code, pattern) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test("an owner without membership evidence is offered no organization and cannot set one", async (t) => {
  const env = kiloEnv(t);
  const projected = await sharingProjection(page(), owner, env, now);
  assert.deepEqual(projected.organizationOptions, []);
  assert.deepEqual(projected.organizationProof, {});
  assert.equal(projected.organizationAccess, null);
  assert.equal("organizationAccessOwnerVerified" in projected, false);
  await rejectsWith(
    proposeSharingMutation(page(), owner, setArgs(acme.id, "viewer"), now, env),
    403,
    "organization_proof_required",
    /organization you belong to/,
  );
  // Withdrawing needs no proof.
  const restricted = await proposeSharingMutation(page(), owner, setArgs(null), now, env);
  assert.equal(restricted.metadata.acl.organizationAccess, null);
  assert.equal(restricted.receipt.revision, 2);
  // A deployment whose provider reports no organizations shows nothing new.
  await recordKiloMembership(env, owner.principal, [acme], now);
  const anaconda = { DB: env.DB };
  const plain = await sharingProjection(page(), owner, anaconda, now);
  assert.deepEqual(plain.organizationOptions, []);
  assert.equal(plain.organizationAccess, null);
  await rejectsWith(
    proposeSharingMutation(page(), owner, setArgs(acme.id, "viewer"), now, anaconda),
    403,
    "organization_proof_required",
  );
});

test("an owner with current membership can share at each role, and only the owner can", async (t) => {
  const env = kiloEnv(t);
  await recordKiloMembership(env, owner.principal, [acme, other], now);
  const offered = await sharingProjection(page(), owner, env, now);
  assert.deepEqual(offered.organizationOptions, [acme, other]);
  assert.deepEqual(offered.organizationProof, { [acme.id]: "verified", [other.id]: "verified" });
  let metadata = page();
  let revision = 1;
  for (const role of ["viewer", "commenter", "editor", "viewer"]) {
    const result = await proposeSharingMutation(
      metadata,
      owner,
      { ...setArgs(acme.id, role, `role-${revision}`), expected_revision: revision },
      now,
      env,
    );
    revision++;
    assert.equal(result.receipt.revision, revision, "every change, a role change too, bumps it");
    assert.deepEqual(result.metadata.acl.organizationAccess, grant(role));
    assert.deepEqual(result.metadata.acl.members, {});
    metadata = result.metadata;
  }
  const projected = await sharingProjection(metadata, owner, env, now);
  assert.deepEqual(projected.organizationAccess, { ...acme, role: "viewer" });
  assert.equal(projected.organizationAccessOwnerVerified, true);
  // The same nonce replays; a reused nonce with another body is refused.
  const replay = await proposeSharingMutation(
    metadata,
    owner,
    { ...setArgs(acme.id, "viewer", "role-4"), expected_revision: 4 },
    now,
    env,
  );
  assert.equal(replay.replay, true);
  await rejectsWith(
    proposeSharingMutation(
      metadata,
      owner,
      { ...setArgs(acme.id, "editor", "role-4"), expected_revision: 4 },
      now,
      env,
    ),
    409,
    "nonce_conflict",
  );
  await assert.rejects(
    proposeSharingMutation(metadata, owner, setArgs(acme.id, "editor", "stale-nonce"), now, env),
    /Sharing changed/,
  );
  for (const bad of [{ role: "owner" }, { role: undefined }, { organization_id: "" }])
    await assert.rejects(
      proposeSharingMutation(
        metadata,
        owner,
        { ...setArgs(acme.id, "viewer", "bad-request"), ...bad, expected_revision: revision },
        now,
        env,
      ),
      { status: 400 },
    );
  await assert.rejects(
    proposeSharingMutation(page(), member(), setArgs(acme.id, "viewer"), now, env),
    /Only the owner/,
  );
  // A member reading access gets only its own access, never the options.
  const shared = page(grant("editor"));
  assert.deepEqual(Object.keys(await sharingProjection(shared, member(), env, now)), ["access"]);
});

test("stale evidence reports expired, refuses choosing or changing the role, and still withdraws", async (t) => {
  const env = kiloEnv(t);
  await recordKiloMembership(env, owner.principal, [acme], now);
  const later = now + KILO_MEMBERSHIP_SECONDS * 1000 + 1000;
  const aged = { ...owner, expiresAt: later + 60_000 };
  const shared = page(grant("commenter"));
  const projected = await sharingProjection(shared, aged, env, later);
  assert.deepEqual(projected.organizationOptions, []);
  assert.deepEqual(projected.organizationProof, { [acme.id]: "expired" });
  assert.deepEqual(projected.organizationAccess, { ...acme, role: "commenter" });
  assert.equal(projected.organizationAccessOwnerVerified, false);
  for (const args of [setArgs(acme.id, "editor"), setArgs(acme.id, "commenter")])
    await rejectsWith(
      proposeSharingMutation(shared, aged, args, later, env),
      403,
      "organization_proof_required",
      /Sign in again with the same account/,
    );
  await rejectsWith(
    proposeSharingMutation(page(), aged, setArgs(other.id, "viewer"), later, env),
    403,
    "organization_proof_required",
    /organization you belong to/,
  );
  const withdrawn = await proposeSharingMutation(shared, aged, setArgs(null), later, env);
  assert.equal(withdrawn.metadata.acl.organizationAccess, null);
  // A fresh exchange restores the proof.
  await recordKiloMembership(env, owner.principal, [acme], later);
  assert.deepEqual((await sharingProjection(shared, aged, env, later)).organizationProof, {
    [acme.id]: "verified",
  });
  const response = errorResponse(new HttpError(403, "Sign in", "organization_proof_required"));
  assert.equal((await response.json()).code, "organization_proof_required");
});

test("a Page has one link audience: neither kind replaces the other", async (t) => {
  const env = kiloEnv(t);
  await recordKiloMembership(env, owner.principal, [acme], now);
  const companyShared = page();
  companyShared.acl.domainView = { domain: "example.com", namespace };
  await rejectsWith(
    proposeSharingMutation(companyShared, owner, setArgs(acme.id, "viewer"), now, env),
    409,
    "link_audience_set",
    /everyone at example\.com\. Choose Restricted/,
  );
  const anaconda = {
    NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "user:anaconda",
    PAGES_COMPANY_VIEW_DOMAINS: "anaconda.com",
  };
  const anacondaOwner = { ...owner, principal: "user:anaconda:owner", namespace: "user:anaconda" };
  const organizationShared = {
    ...page(grant("editor")),
    owner: anacondaOwner.principal,
  };
  await rejectsWith(
    proposeSharingMutation(
      organizationShared,
      anacondaOwner,
      {
        action: "set_domain_view",
        domain: "anaconda.com",
        expected_revision: 1,
        nonce: "domain-set",
      },
      now,
      anaconda,
    ),
    409,
    "link_audience_set",
    /Acme Research\. Choose Restricted/,
  );
  // Neither was cleared, and Restricted for the other kind still applies.
  assert.deepEqual(organizationShared.acl.organizationAccess, grant("editor"));
  const cleared = await proposeSharingMutation(
    organizationShared,
    anacondaOwner,
    { action: "set_domain_view", domain: null, expected_revision: 1, nonce: "domain-null" },
    now,
    anaconda,
  );
  assert.deepEqual(cleared.metadata.acl.organizationAccess, grant("editor"));
});

test("an organization grant gives its role to current members only, with no member row", () => {
  const capabilities = (access) =>
    ["canRead", "canComment", "canWrite", "canManageAccess", "canDelete"].filter(
      (name) => access[name],
    );
  for (const [role, expected] of [
    ["viewer", ["canRead"]],
    ["commenter", ["canRead", "canComment"]],
    ["editor", ["canRead", "canComment", "canWrite"]],
  ]) {
    const metadata = page(grant(role));
    const access = pageAccess(metadata, member(), { now });
    assert.equal(access.role, role);
    assert.equal(access.source, "organization");
    assert.equal(access.generation, 0);
    assert.deepEqual(capabilities(access), expected);
    assert.deepEqual(metadata.acl.members, {});
    for (const outsider of [
      reader,
      member([lease(other)]),
      member([{ ...lease(), namespace: "user:anaconda" }]),
      member([lease(acme, now)]),
      { ...member(), expiresAt: now },
      { ...member(), namespace: "user:anaconda" },
    ])
      assert.equal(pageAccess(metadata, outsider, { now }).canRead, false);
  }
  // Comments follow the same grant: a commenter comments, a viewer doesn't.
  for (const [role, comments] of [
    ["viewer", false],
    ["commenter", true],
    ["editor", true],
  ]) {
    const policy = new DocumentPolicy({ metadata: () => page(grant(role)), now: () => now });
    if (comments) assert.equal(policy.account(member(), "comment").canComment, true);
    else assert.throws(() => policy.account(member(), "comment"), /Commenting is not allowed/);
    if (role !== "editor") assert.throws(() => policy.account(member(), true), /read-only/);
  }
  // A read-only credential keeps the role it holds but writes nothing.
  const readOnly = pageAccess(page(grant("editor")), { ...member(), canWrite: false }, { now });
  assert.equal(readOnly.role, "editor");
  assert.equal(readOnly.canWrite, false);
  assert.equal(readOnly.canComment, false);
});

test("a direct grant of higher rank wins, a tie is direct, and a removal blocks the organization", () => {
  const withMember = (role, row) => {
    const metadata = page(grant(role));
    metadata.acl.members[reader.principal] = row;
    return pageAccess(metadata, member(), { now });
  };
  const higher = withMember("viewer", { role: "editor", generation: 2 });
  assert.equal(higher.role, "editor");
  assert.equal(higher.source, undefined);
  assert.equal(higher.generation, 2);
  const organizationHigher = withMember("editor", { role: "viewer", generation: 1 });
  assert.equal(organizationHigher.role, "editor");
  assert.equal(organizationHigher.source, "organization");
  const tie = withMember("commenter", { role: "commenter", generation: 3 });
  assert.equal(tie.role, "commenter");
  assert.equal(tie.source, undefined, "on a tie the direct grant is the basis");
  for (const role of ["viewer", "commenter", "editor"]) {
    const removed = withMember(role, { role: "none", generation: 4 });
    assert.equal(removed.canRead, false, role);
  }
});

test("while a change commits, readers hold only what both grants allow", () => {
  const editor = page(grant("editor"));
  const at = (role, organization) => page(role && grant(role, organization));
  const during = (before, after, identity = member()) =>
    pageAccess(restrictAccessDuringCommit(before, after), identity, { now });
  assert.equal(during(at(null), editor).canRead, false, "a new grant waits for durability");
  assert.equal(during(editor, at(null)).canRead, false, "a withdrawal applies at once");
  const downgrade = during(editor, at("viewer"));
  assert.equal(downgrade.role, "viewer");
  assert.equal(downgrade.canWrite, false);
  assert.equal(during(at("viewer"), editor).role, "viewer", "an upgrade waits");
  const both = member([lease(acme), lease(other)]);
  assert.equal(during(editor, at("editor", other), both).canRead, false, "a switch waits");
  assert.equal(during(editor, editor).role, "editor");
});

test("withdrawal, a downgrade, the lease's end and a new exchange each end access", async (t) => {
  for (const change of ["withdraw", "downgrade", "lease", "exchange"]) {
    const env = kiloEnv(t);
    await recordKiloMembership(env, reader.principal, [acme], now);
    let identity = { ...reader, organizations: await organizationLeases(env, reader, now) };
    let metadata = page(grant("editor")),
      clock = now;
    const policy = new DocumentPolicy({ metadata: () => metadata, now: () => clock });
    assert.equal(policy.account(identity, true).canWrite, true);
    assert.equal(policy.leaseExpiresAt(identity), identity.expiresAt);
    if (change === "withdraw") metadata = page();
    else if (change === "downgrade") metadata = page(grant("viewer"));
    else if (change === "lease") {
      const short = { ...identity, organizations: [lease(acme, now + 1000)] };
      assert.equal(policy.leaseExpiresAt(short), now + 1000);
      assert.equal(leaseExpiryError(short, now + 1000).code, "credential_expired");
      identity = short;
      clock = now + 1000;
    } else {
      await recordKiloMembership(env, reader.principal, [other], now + 1000);
      identity = { ...reader, organizations: await organizationLeases(env, reader, now + 1000) };
    }
    assert.throws(() => policy.account(identity, true), /read-only|denied/i, change);
    if (change === "downgrade") assert.equal(policy.account(identity).role, "viewer");
    else assert.throws(() => policy.account(identity), /denied/i, change);
  }
});

test("an organization reader's listing row appears on open, lists under that audience only, and goes on withdraw", async (t) => {
  const db = sqliteD1(t).open();
  await migrateCatalogIndex(db);
  const env = { DB: db, PAGES_CATALOG_INDEX: "1", PAGES_KILO_APP_URL: "https://kilo.invalid" };
  const key = organizationAudienceKey(acme.id);
  assert.equal(key, "org:org-acme");
  assert.equal(organizationAudienceKey("a:b/c"), "org:a%3Ab%2Fc");
  const metadata = { ...page(grant("editor")), pageId: "00000001-0000-4000-8000-000000000000" };
  const rows = () =>
    db
      .rows("SELECT principal, role, source, domain FROM pages_catalog_access ORDER BY source")
      .map((row) => `${row.source}:${row.principal}:${row.role}:${row.domain}`);
  // Sharing alone writes nothing for the organization's other members.
  await reportPageIndex(env, {}, { metadata, title: "Plan", observedAt: "2026-10-01T00:00:00Z" });
  assert.deepEqual(rows(), [`owner:${owner.principal}:owner:null`]);
  await reportPageIndex(
    env,
    {},
    {
      metadata,
      title: "Plan",
      observedAt: "2026-10-01T00:01:00Z",
      reader: { principal: reader.principal, domain: key },
      readerOnly: true,
    },
  );
  assert.deepEqual(rows(), [
    `domain_opened:${reader.principal}:editor:${key}`,
    `owner:${owner.principal}:owner:null`,
  ]);
  // A reader of another audience opens nothing here.
  await reportPageIndex(
    env,
    {},
    {
      metadata,
      title: "Plan",
      observedAt: "2026-10-01T00:02:00Z",
      reader: { principal: `${namespace}:stranger`, domain: organizationAudienceKey(other.id) },
      readerOnly: true,
    },
  );
  assert.equal(rows().length, 2);
  const listed = (audiences) =>
    queryCatalogIndex(db, {
      principal: reader.principal,
      audiences,
      inTrash: false,
      needle: null,
      after: null,
      count: 10,
    });
  assert.equal((await listed([key])).length, 1);
  assert.equal((await listed(["example.com", key])).length, 1);
  assert.equal((await listed([])).length, 0);
  assert.equal((await listed([organizationAudienceKey(other.id)])).length, 0);
  assert.deepEqual(identityAudienceKeys(member([lease(), lease(other, now - 1)]), now), [key]);
  // A downgrade rewrites the row's role at the next report; a commenter lists
  // as a viewer.
  const commenter = {
    ...metadata,
    acl: { ...metadata.acl, revision: 2, organizationAccess: grant("commenter") },
  };
  await reportPageIndex(
    env,
    {},
    {
      metadata: commenter,
      title: "Plan",
      observedAt: "2026-10-01T00:03:00Z",
      reader: { principal: reader.principal, domain: key },
      readerOnly: true,
    },
  );
  assert.ok(rows().includes(`domain_opened:${reader.principal}:viewer:${key}`));
  const withdrawn = {
    ...commenter,
    acl: { ...commenter.acl, revision: 3, organizationAccess: null },
  };
  assert.equal(listingRestricted(commenter, withdrawn, env), true);
  const switched = {
    ...commenter,
    acl: { ...commenter.acl, revision: 3, organizationAccess: grant("commenter", other) },
  };
  assert.equal(listingRestricted(commenter, switched, env), true);
  await restrictPageIndex(env, {}, withdrawn);
  assert.deepEqual(rows(), [`owner:${owner.principal}:owner:null`]);
});

test("opening a Page through its organization reports that reader's row under the organization's key", async () => {
  const reports = [],
    projections = [],
    pending = [];
  const host = Object.assign(Object.create(Page.prototype), {
    plain: plainStub(),
    metadata: { ...page(grant("editor")), pageId: "test-page" },
    handle: { doc: () => ({ title: "Shared with an organization" }) },
    titleProjection: {
      name: "settled",
      record: { title: "Shared with an organization" },
      storage: { name: "stored" },
      delivery: { name: "delivered" },
    },
    contentActivity: { value: null },
    ctx: { waitUntil: (promise) => pending.push(promise) },
    env: {
      PAGES_CATALOG_INDEX: "1",
      DB: { prepare() {}, batch() {} },
      CATALOGS: {
        getByName(principal) {
          return {
            async fetch(request) {
              projections.push({ principal, body: await request.json() });
              return new Response(null);
            },
          };
        },
      },
    },
    reportIndex: async (details) => reports.push(details),
  });
  const live = Date.now() + 60_000;
  host.cacheTitle({ ...member([lease(acme, live)]), expiresAt: live });
  await Promise.all(pending.splice(0));
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].reader, {
    principal: reader.principal,
    domain: organizationAudienceKey(acme.id),
  });
  assert.deepEqual(
    projections.map(({ principal }) => principal),
    [reader.principal],
  );
  assert.deepEqual(host.metadata.acl.members, {});
  // A member of another organization reports nothing.
  host.cacheTitle({ ...member([lease(other, live)]), expiresAt: live });
  await Promise.all(pending.splice(0));
  assert.equal(reports.length, 1);
});

test("permanent deletion names the organization audience beside the company one", () => {
  const impact = purgeImpact(page(grant("editor")), null, null, "Plan");
  assert.equal(impact.domain_view, null);
  assert.deepEqual(impact.organization_access, { name: acme.name, role: "editor" });
  assert.equal(purgeImpact(page(), null, null, "Plan").organization_access, null);
});

test("an organization editor's upload capability carries its namespace, so the upload holds the same lease", async (t) => {
  const env = kiloEnv(t);
  await recordKiloMembership(env, reader.principal, [acme], now);
  const storage = new Storage();
  const pageId = "org-upload-page";
  const issued = await issueAssetUpload(storage, {
    pageId,
    identity: { ...member(), credentialKind: "kilo-token" },
    args: { page_id: pageId },
    origin: "https://pages.invalid",
    now,
  });
  const claims = await verifyAssetUpload(
    storage,
    issued.headers.Authorization.slice("Pages-Upload ".length),
    { pageId, now, grantActive: () => assert.fail("a Kilo capability names no grant") },
  );
  assert.equal(claims.namespace, namespace);
  const identity = await withDomainAccess(uploadIdentity(claims), env);
  assert.deepEqual(
    identity.organizations.map(({ id }) => id),
    [acme.id],
  );
  const metadata = { ...page(grant("editor")), pageId };
  assert.equal(pageAccess(metadata, identity, { now }).canWrite, true);
  assert.equal(
    pageAccess({ ...metadata, ...page(grant("viewer")) }, identity, { now }).canWrite,
    false,
  );
  // A capability without a namespace holds no organization lease.
  const bare = await withDomainAccess(uploadIdentity({ ...claims, namespace: undefined }), env);
  assert.equal(bare.organizations, undefined);
});
