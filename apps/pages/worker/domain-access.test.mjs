import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createServerAppSession } from "@cloud/app-session.ts";
import { createAuthFixture } from "../auth-fixtures.mjs";
import { WRITTEN_FORMATS } from "../model/document-types.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import { companyViewDomains, domainAccessForIdentity } from "./domain-access.mjs";
import {
  audienceEditUntil,
  pageAccess,
  proposeAccessUpdate,
  restrictAccessDuringCommit,
} from "./access.mjs";
import { NO_ACTOR_CHAIN, decide, principalOf, projectObject } from "./authz.mjs";
import { PROJECT_ACCESS_LEASE_MS } from "./project-access.mjs";
import {
  ASSET_UPLOAD_TTL_MS,
  issueAssetUpload,
  uploaderEditUntil,
  uploadIdentity,
  uploadVerdict,
  verifyAssetUpload,
} from "./asset-uploads.mjs";
import { proposeSharingMutation, sharingProjection } from "./sharing.mjs";
import { DocumentPolicy, leaseExpiryError } from "./policy.mjs";
import worker, { Page } from "./index.mjs";
import { authenticate, errorResponse, HttpError, withDomainAccess } from "./auth.mjs";
import { accessRows, listingRestricted } from "./catalog-index.mjs";
import { plainStub } from "./plain-stub.mjs";
import { Storage } from "./projects-fixture.mjs";
import { purgeImpact } from "./trash.mjs";

const now = 1_800_000_000_000;
const namespace = "user:anaconda";
const env = {
  NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://page10.example",
  NOTEBOOK_CLOUD_APP_SESSION_SECRET: "domain-proof-fixture-secret-".repeat(2),
  NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: namespace,
  PAGES_COMPANY_VIEW_DOMAINS: "anaconda.com",
};
const owner = {
  principal: `${namespace}:owner`,
  namespace,
  canWrite: true,
  expiresAt: now + 60_000,
  verifiedEmail: "owner@gmail.com",
};
const employee = {
  principal: `${namespace}:employee`,
  namespace,
  canWrite: true,
  credentialKind: "oidc",
  expiresAt: now + 60_000,
};
const domainView = { domain: "anaconda.com", namespace };
// A grant set now names its role; a stored grant without one is a viewer grant.
const viewerGrant = { ...domainView, role: "viewer" };
const lease = { ...domainView, expiresAt: now + 30_000 };
const metadata = () => ({
  owner: owner.principal,
  acl: { revision: 1, members: {}, invites: {}, domainView },
});
async function verifiedIdentity(
  email = "person@anaconda.com",
  verified = true,
  at = now,
  principal = employee.principal,
) {
  const session = await createServerAppSession(
    env,
    {
      principal,
      metadata: { provider: "oidc", principalNamespace: namespace, email, emailVerified: verified },
    },
    "fixture-session",
    now / 1000 + 60,
    at / 1000,
  );
  return { ...employee, principal, emailProof: { ...session, provider: "app-session" } };
}

test("company sharing is disabled by default and rejects consumer or arbitrary configured domains", async () => {
  assert.deepEqual(companyViewDomains({}), []);
  assert.deepEqual(companyViewDomains(env), ["anaconda.com"]);
  for (const domains of [
    "gmail.com",
    "outlook.com",
    "example.org",
    "*.anaconda.com",
    "anaconda.com,gmail.com",
    "anaconda.com,",
  ]) {
    const unsupported = { ...env, PAGES_COMPANY_VIEW_DOMAINS: domains };
    assert.deepEqual(companyViewDomains(unsupported), []);
    await assert.rejects(
      proposeSharingMutation(
        metadata(),
        owner,
        {
          action: "set_domain_view",
          domain: domains,
          expected_revision: 1,
          nonce: "unsupported-domain",
        },
        now,
        unsupported,
      ),
      /supported company domain/,
    );
  }
  assert.deepEqual(
    companyViewDomains({ ...env, NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: undefined }),
    [],
  );
});

test("one allowlist value that isn't a valid hostname turns company sharing off", () => {
  assert.deepEqual(
    companyViewDomains({ ...env, PAGES_COMPANY_VIEW_DOMAINS: " anaconda.com " }),
    ["anaconda.com"],
    "spaces around an entry separate entries; they are not part of the value",
  );
  for (const [form, value] of [
    ["upper case", "Anaconda.com"],
    ["wildcard", "*.anaconda.com"],
    ["trailing dot", "anaconda.com."],
    ["inner whitespace", "anaconda .com"],
    ["tab", "anaconda.com\tx"],
    ["one label", "com"],
    ["empty label", "anaconda..com"],
    ["leading hyphen", "-anaconda.com"],
    ["trailing hyphen", "anaconda-.com"],
    ["underscore", "ana_conda.com"],
    ["label over 63", `${"a".repeat(64)}.com`],
    ["over 253", `${"a.".repeat(127)}com`],
    ["non-ASCII", "anacönda.com"],
    ["IPv4", "10.0.0.1"],
    ["numeric final label", "127.1"],
    ["IPv6", "[::1]"],
    ["port", "anaconda.com:443"],
    ["URL", "https://anaconda.com"],
  ])
    assert.deepEqual(
      companyViewDomains({ ...env, PAGES_COMPANY_VIEW_DOMAINS: `anaconda.com,${value}` }),
      [],
      form,
    );
});

const enableArgs = {
  action: "set_domain_view",
  domain: "anaconda.com",
  expected_revision: 1,
  nonce: "enable-domain",
};
const restrictArgs = {
  action: "set_domain_view",
  domain: null,
  expected_revision: 1,
  nonce: "restrict-domain",
};
const restrictedPage = (principal = owner.principal) => {
  const value = metadata();
  value.owner = principal;
  delete value.acl.domainView;
  return value;
};
const companyApiKeyOwner = {
  ...owner,
  credentialKind: "api-key",
  verifiedEmail: "Owner@Anaconda.com",
  verifiedEmailUntil: owner.expiresAt,
};
const ownerProofDenied = /Sign in with a verified anaconda\.com email to share with anaconda\.com/;
const ownerProofExpired =
  /anaconda\.com email verification expired\. Sign in again with the same account/;
async function rejectsWithStatus(promise, status, pattern, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.status, status);
    assert.match(error.message, pattern);
    if (code) assert.equal(error.code, code);
    return true;
  });
}

test("an owner without company email proof is offered no company audience and cannot set one", async () => {
  const stale = await verifiedIdentity(
    "owner@anaconda.com",
    true,
    now - 6 * 3600 * 1000 - 1000,
    owner.principal,
  );
  const staleGmail = await verifiedIdentity(
    "owner@gmail.com",
    true,
    now - 6 * 3600 * 1000 - 1000,
    owner.principal,
  );
  for (const [identity, proof] of [
    [{ ...owner, credentialKind: "api-key" }, "missing"],
    [owner, "missing"],
    [{ ...owner, credentialKind: "oidc", verifiedEmail: "owner@anaconda.com" }, "missing"],
    [{ ...companyApiKeyOwner, verifiedEmail: "owner@sub.anaconda.com" }, "missing"],
    [await verifiedIdentity("owner@gmail.com", true, now, owner.principal), "missing"],
    [await verifiedIdentity("owner@anaconda.com", false, now, owner.principal), "missing"],
    [staleGmail, "missing"],
    [{ ...stale, principal: `${namespace}:another-owner` }, "missing"],
    [stale, "expired"],
  ]) {
    const before = restrictedPage(identity.principal);
    const projected = await sharingProjection(before, identity, env, now);
    assert.deepEqual(projected.domainOptions, []);
    assert.deepEqual(projected.domainProof, { "anaconda.com": proof });
    assert.equal(projected.domainView, null);
    assert.equal("domainViewOwnerVerified" in projected, false);
    await rejectsWithStatus(
      proposeSharingMutation(before, identity, enableArgs, now, env),
      403,
      proof === "expired" ? ownerProofExpired : ownerProofDenied,
      "company_email_proof_required",
    );
    // Host allowlist and role checks still answer first, with their own errors.
    await rejectsWithStatus(
      proposeSharingMutation(before, identity, { ...enableArgs, domain: "gmail.com" }, now, env),
      400,
      /supported company domain/,
    );
    for (const role of ["owner", "none", null])
      await rejectsWithStatus(
        proposeSharingMutation(before, identity, { ...enableArgs, role }, now, env),
        400,
        /Can view, Can comment or Can edit/,
      );
    // A valid role still needs proof.
    await rejectsWithStatus(
      proposeSharingMutation(before, identity, { ...enableArgs, role: "editor" }, now, env),
      403,
      proof === "expired" ? ownerProofExpired : ownerProofDenied,
      "company_email_proof_required",
    );
    const restricted = await proposeSharingMutation(before, identity, restrictArgs, now, env);
    assert.equal(restricted.metadata.acl.domainView, null);
    assert.equal(restricted.receipt.revision, 2);
  }
});

test("an owner with a verified company email (API key or browser proof) can share with that company", async () => {
  const browserOwner = await verifiedIdentity("owner@anaconda.com", true, now, owner.principal);
  for (const identity of [companyApiKeyOwner, browserOwner]) {
    const before = restrictedPage();
    const offered = await sharingProjection(before, identity, env, now);
    assert.deepEqual(offered.domainOptions, ["anaconda.com"]);
    assert.deepEqual(offered.domainProof, { "anaconda.com": "verified" });
    assert.equal(offered.domainView, null);
    const enabled = await proposeSharingMutation(before, identity, enableArgs, now, env);
    assert.deepEqual(enabled.metadata.acl.domainView, viewerGrant);
    assert.deepEqual(enabled.metadata.acl.members, {});
    assert.equal(before.acl.domainView, undefined);
    const projected = await sharingProjection(enabled.metadata, identity, env, now);
    assert.deepEqual(projected.domainOptions, ["anaconda.com"]);
    assert.deepEqual(projected.domainView, viewerGrant);
    assert.equal(projected.domainViewOwnerVerified, true);
    assert.equal(
      (await proposeSharingMutation(enabled.metadata, identity, enableArgs, now, env)).replay,
      true,
    );
    // A replay returns the stored receipt even after the proof lapses; it
    // cannot apply a new audience.
    assert.equal(
      (await proposeSharingMutation(enabled.metadata, owner, enableArgs, now, env)).replay,
      true,
    );
    await assert.rejects(
      proposeSharingMutation(before, employee, enableArgs, now, env),
      /Only the owner/,
    );
    await assert.rejects(
      proposeSharingMutation(
        enabled.metadata,
        identity,
        { ...enableArgs, nonce: "stale-enable" },
        now,
        env,
      ),
      /Sharing changed/,
    );
    const restricted = await proposeSharingMutation(
      enabled.metadata,
      identity,
      { ...restrictArgs, expected_revision: 2 },
      now,
      {},
    );
    assert.equal(restricted.metadata.acl.domainView, null);
    assert.deepEqual(restricted.metadata.acl.members, {});
  }
});

test("company proof that expires mid-session reports expired, refuses enabling, and recovers on sign-in", async () => {
  const browserOwner = await verifiedIdentity("owner@anaconda.com", true, now, owner.principal);
  const page = restrictedPage();
  // The panel's last projection offered the company...
  assert.deepEqual((await sharingProjection(page, browserOwner, env, now)).domainOptions, [
    "anaconda.com",
  ]);
  // ...but the six-hour proof window closes before the owner picks it.
  const later = now + 6 * 3600 * 1000;
  const aged = { ...browserOwner, expiresAt: later + 60_000 };
  await rejectsWithStatus(
    proposeSharingMutation(page, aged, enableArgs, later, env),
    403,
    ownerProofExpired,
    "company_email_proof_required",
  );
  const expired = await sharingProjection(page, aged, env, later);
  assert.deepEqual(expired.domainOptions, []);
  assert.deepEqual(expired.domainProof, { "anaconda.com": "expired" });
  // OAuth carries the same browser proof and expires the same way.
  assert.deepEqual(
    (await sharingProjection(page, { ...aged, credentialKind: "oauth" }, env, later)).domainProof,
    { "anaconda.com": "expired" },
  );
  // Signing in again with the same account mints fresh proof.
  const renewed = await verifiedIdentity("owner@anaconda.com", true, later, owner.principal);
  const fresh = { ...renewed, expiresAt: later + 60_000 };
  assert.deepEqual((await sharingProjection(page, fresh, env, later)).domainProof, {
    "anaconda.com": "verified",
  });
  const enabled = await proposeSharingMutation(
    page,
    fresh,
    { ...enableArgs, nonce: "after-sign-in" },
    later,
    env,
  );
  assert.deepEqual(enabled.metadata.acl.domainView, viewerGrant);
});

test("the proof refusal code survives the HTTP error boundary", async () => {
  const response = errorResponse(
    new HttpError(403, "Sign in again", "company_email_proof_required"),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "Sign in again",
    code: "company_email_proof_required",
  });
});

test("a company audience the owner cannot prove stays readable, is flagged, and can only be withdrawn", async () => {
  // Stored before owner proof was required: the owner holds a Gmail account.
  const legacy = metadata();
  const projected = await sharingProjection(legacy, owner, env, now);
  assert.deepEqual(projected.domainOptions, []);
  assert.deepEqual(projected.domainView, viewerGrant);
  assert.equal(projected.domainViewOwnerVerified, false);
  assert.equal(
    (await sharingProjection(legacy, companyApiKeyOwner, env, now)).domainViewOwnerVerified,
    true,
  );
  const reader = pageAccess(legacy, { ...employee, domainAccess: lease }, { now });
  assert.equal(reader.canRead, true);
  assert.equal(reader.source, "domain");
  await rejectsWithStatus(
    proposeSharingMutation(legacy, owner, { ...enableArgs, nonce: "reassert-legacy" }, now, env),
    403,
    ownerProofDenied,
  );
  const restricted = await proposeSharingMutation(legacy, owner, restrictArgs, now, env);
  assert.equal(restricted.metadata.acl.domainView, null);
  assert.equal(
    pageAccess(restricted.metadata, { ...employee, domainAccess: lease }, { now }).canRead,
    false,
  );
  const after = await sharingProjection(restricted.metadata, owner, env, now);
  assert.equal(after.domainView, null);
  assert.equal("domainViewOwnerVerified" in after, false);
});

test("domain evidence requires verified exact company email and has a nonrenewable proof deadline", async () => {
  const verified = await verifiedIdentity();
  assert.deepEqual(await domainAccessForIdentity(env, verified, now), {
    ...domainView,
    expiresAt: verified.expiresAt,
  });
  assert.equal(
    await domainAccessForIdentity({ ...env, PAGES_COMPANY_VIEW_DOMAINS: "" }, verified, now),
    undefined,
  );
  for (const identity of [
    await verifiedIdentity("person@gmail.com"),
    await verifiedIdentity("person@sub.anaconda.com"),
    await verifiedIdentity("person@anaconda.com.evil.test"),
    await verifiedIdentity("person@anaconda.com", false),
    { ...verified, namespace: "user:another" },
    { ...verified, principal: `${namespace}:impostor` },
    { ...verified, emailProof: { ...verified.emailProof, verifiedEmailDomainBinding: undefined } },
    { ...employee, credentialKind: "oidc", verifiedEmail: "person@anaconda.com" },
  ])
    assert.equal(await domainAccessForIdentity(env, identity, now), undefined);
  const old = await verifiedIdentity("person@anaconda.com", true, now - 6 * 3600 * 1000 + 1000);
  assert.equal((await domainAccessForIdentity(env, old, now)).expiresAt, now + 1000);
  assert.equal(
    await domainAccessForIdentity(
      env,
      { ...old, credentialKind: "oauth", expiresAt: now + 24 * 3600 * 1000 },
      now + 1000,
    ),
    undefined,
  );
  const apiKey = {
    ...employee,
    credentialKind: "api-key",
    verifiedEmail: " Person@ANACONDA.COM ",
    verifiedEmailUntil: employee.expiresAt,
  };
  assert.deepEqual(await domainAccessForIdentity(env, apiKey, now), {
    ...domainView,
    expiresAt: employee.expiresAt,
  });
  // An API key's email is evidence until the provider answer behind it stops
  // being current, never past it, and not at all without that time.
  assert.deepEqual(
    await domainAccessForIdentity(env, { ...apiKey, verifiedEmailUntil: now + 1000 }, now),
    { ...domainView, expiresAt: now + 1000 },
  );
  for (const verifiedEmailUntil of [now, undefined, Number.NaN])
    assert.equal(
      await domainAccessForIdentity(env, { ...apiKey, verifiedEmailUntil }, now),
      undefined,
      String(verifiedEmailUntil),
    );
});

test("dynamic viewer authority never overrides an explicit grant or deny and expires independently", () => {
  const doc = metadata(),
    identity = { ...employee, domainAccess: lease };
  const access = pageAccess(doc, identity, { now });
  assert.equal(access.role, "viewer");
  assert.equal(access.source, "domain");
  for (const capability of ["canWrite", "canComment", "canManageAccess", "canDelete"])
    assert.equal(access[capability], false);
  assert.deepEqual(doc.acl.members, {});
  for (const denied of [
    { ...identity, domainAccess: undefined },
    { ...identity, expiresAt: now },
    { ...identity, domainAccess: { ...lease, expiresAt: now } },
    { ...identity, domainAccess: { ...lease, namespace: "user:other" } },
  ])
    assert.equal(pageAccess(doc, denied, { now }).canRead, false);
  for (const row of [
    { role: "none", generation: 1 },
    { role: "editor", generation: 0 },
    { role: "invalid", generation: 1 },
  ]) {
    doc.acl.members[employee.principal] = row;
    assert.equal(pageAccess(doc, identity, { now }).canRead, false);
  }
  doc.acl.members[employee.principal] = { role: "editor", generation: 2 };
  assert.equal(pageAccess(doc, identity, { now }).role, "editor");
  assert.equal(pageAccess(doc, identity, { now }).source, undefined);
});

test("pending domain changes expose only the old/new intersection", () => {
  const restricted = metadata();
  restricted.acl.domainView = null;
  const enabled = metadata(),
    identity = { ...employee, domainAccess: lease };
  assert.equal(
    pageAccess(restrictAccessDuringCommit(restricted, enabled), identity, { now }).canRead,
    false,
  );
  assert.equal(
    pageAccess(restrictAccessDuringCommit(enabled, restricted), identity, { now }).canRead,
    false,
  );
  assert.equal(
    pageAccess(restrictAccessDuringCommit(enabled, enabled), identity, { now }).canRead,
    true,
  );
  const denied = {
    ...enabled,
    acl: proposeAccessUpdate(
      enabled,
      owner,
      {
        principal: employee.principal,
        role: null,
        expected_revision: 1,
      },
      { now },
    ).acl,
  };
  assert.equal(
    pageAccess(restrictAccessDuringCommit(enabled, denied), identity, { now }).canRead,
    false,
    "a new explicit denial blocks domain fallback before its durability barrier",
  );
});

test("domain readers cannot write, and domain revocation or proof expiry ends their access", () => {
  for (const change of ["write", "domain", "deny", "proof"]) {
    let doc = metadata(),
      clock = now;
    const identity = { ...employee, domainAccess: lease };
    const policy = new DocumentPolicy({ metadata: () => doc, now: () => clock });
    assert.equal(policy.leaseExpiresAt(identity), lease.expiresAt);
    assert.equal(policy.leaseExpiresAt({ ...identity, expiresAt: now + 1000 }), now + 1000);
    assert.equal(policy.account(identity).canRead, true);
    if (change === "domain") doc = { ...doc, acl: { ...doc.acl, domainView: null } };
    else if (change === "deny")
      doc = {
        ...doc,
        acl: proposeAccessUpdate(
          doc,
          owner,
          { principal: employee.principal, role: null, expected_revision: 1 },
          { now },
        ).acl,
      };
    else if (change === "proof") clock = lease.expiresAt;
    assert.throws(
      () => policy.account(identity, change === "write"),
      /read-only|access denied|denied/i,
      change,
    );
  }
});

test("opening a domain Page remembers only that reader's discovery entry, never a permanent grant", async () => {
  const doc = metadata(),
    calls = [],
    pending = [];
  const page = Object.assign(Object.create(Page.prototype), {
    plain: plainStub(),
    metadata: { ...doc, pageId: "test-page" },
    handle: { doc: () => ({ title: "Shared by domain" }) },
    titleProjection: {
      name: "settled",
      record: { title: "Shared by domain" },
      storage: { name: "stored" },
      delivery: { name: "delivered" },
    },
    ctx: { waitUntil: (promise) => pending.push(promise) },
    env: {
      CATALOGS: {
        getByName(principal) {
          return {
            async fetch(request) {
              calls.push({ principal, body: await request.json() });
              return new Response(null);
            },
          };
        },
      },
    },
  });
  page.cacheTitle({
    ...employee,
    expiresAt: Date.now() + 60_000,
    domainAccess: { ...lease, expiresAt: Date.now() + 60_000 },
  });
  await Promise.all(pending);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].principal, employee.principal);
  assert.equal(calls[0].body.shared, true);
  assert.deepEqual(page.metadata.acl.members, {});
});

test("a domain reader's row is reported again when the Page's content moved since its last report", async () => {
  const doc = metadata(),
    reports = [],
    projections = [],
    pending = [];
  const page = Object.assign(Object.create(Page.prototype), {
    plain: plainStub(),
    metadata: { ...doc, pageId: "test-page" },
    handle: { doc: () => ({ title: "Shared by domain" }) },
    titleProjection: {
      name: "settled",
      record: { title: "Shared by domain" },
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
  const open = async () => {
    page.cacheTitle({
      ...employee,
      expiresAt: Date.now() + 60_000,
      domainAccess: { ...lease, expiresAt: Date.now() + 60_000 },
    });
    await Promise.all(pending.splice(0));
  };
  await open();
  await open();
  assert.equal(reports.length, 1, "once per host life while nothing changed");
  assert.equal(reports[0].readerOnly, true);
  assert.equal(reports[0].reader.principal, employee.principal);
  assert.equal(reports[0].keepTime, false);
  page.contentActivity.value = "2026-11-03T12:00:00.000Z";
  await open();
  await open();
  assert.equal(reports.length, 2, "again once the content time moved past the last report");
  assert.equal(reports[1].contentUpdatedAt, "2026-11-03T12:00:00.000Z");
  // A reader's open is its discovery: its projection carries no keep_time.
  assert.equal(projections.length, 4);
  for (const { body } of projections) assert.equal(body.keep_time, undefined);
});

for (const failing of ["catalog", "d1"]) {
  test(`a domain-only ${failing} failure retries discovery without invalidating owner delivery`, async () => {
    const pending = [],
      sent = [],
      reports = [];
    let fail = true;
    const state = {
      name: "settled",
      record: { title: "Shared by domain", observed_at: "2026-11-05T00:00:00Z", keep: true },
      storage: { name: "stored" },
      delivery: { name: "delivered" },
    };
    const page = Object.assign(Object.create(Page.prototype), {
      plain: plainStub(),
      metadata: { ...metadata(), pageId: "test-page" },
      handle: { doc: () => ({ title: "Shared by domain" }) },
      titleProjection: state,
      ctx: { waitUntil: (job) => pending.push(job) },
      env: {
        PAGES_CATALOG_INDEX: "1",
        DB: { prepare() {}, batch() {} },
        CATALOGS: {
          getByName: (principal) => ({
            fetch: async () => {
              sent.push(principal);
              return new Response(null, { status: fail && failing === "catalog" ? 503 : 200 });
            },
          }),
        },
      },
      reportIndex: async (details) => {
        reports.push(details);
        if (fail && failing === "d1") throw Error("reader report unavailable");
      },
    });
    const open = async () => {
      page.cacheTitle({
        ...employee,
        expiresAt: Date.now() + 60_000,
        domainAccess: { ...lease, expiresAt: Date.now() + 60_000 },
      });
      while (pending.length) await Promise.all(pending.splice(0));
    };
    await open();
    assert.equal(page.titleProjection, state);
    fail = false;
    await open();
    page.cacheTitle();
    while (pending.length) await Promise.all(pending.splice(0));
    assert.deepEqual(sent, [employee.principal, employee.principal]);
    assert.equal(reports.length, failing === "d1" ? 2 : 1);
    assert.ok(reports.every((report) => report.readerOnly));
    assert.equal(page.titleProjection, state);
  });
}

test("a domain discovery cannot clear an owner projection still pending", async () => {
  const jobs = [];
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const values = new Map();
  const doc = metadata();
  const page = Object.assign(Object.create(Page.prototype), {
    plain: plainStub(),
    metadata: { ...doc, pageId: "test-page" },
    handle: { doc: () => ({ title: "Shared by domain" }) },
    ctx: {
      waitUntil: (job) => jobs.push(job),
      storage: {
        put: async (key, value) => values.set(key, value),
        delete: async (key) => values.delete(key),
      },
    },
    env: {
      CATALOGS: {
        getByName: (principal) => ({
          fetch: () => (principal === doc.owner ? held : Promise.resolve(new Response(null))),
        }),
      },
    },
  });
  page.cacheTitle();
  const ownerWork = jobs.splice(0);
  page.cacheTitle({
    ...employee,
    expiresAt: Date.now() + 60_000,
    domainAccess: { ...lease, expiresAt: Date.now() + 60_000 },
  });
  while (jobs.length) await Promise.all(jobs.splice(0));
  assert.equal(values.get("host/title-projection/pending"), true);
  assert.equal(page.titleProjection.delivery.name, "sending");
  release(new Response(null));
  await Promise.all(ownerWork);
  while (jobs.length) await Promise.all(jobs.splice(0));
  assert.equal(values.get("host/title-projection/pending"), undefined);
});

test("a domain reader's failure during initial fanout does not invalidate owner delivery", async () => {
  const jobs = [],
    sent = [];
  const doc = metadata();
  const page = Object.assign(Object.create(Page.prototype), {
    plain: plainStub(),
    metadata: { ...doc, pageId: "test-page" },
    handle: { doc: () => ({ title: "Shared by domain" }) },
    ctx: {
      waitUntil: (job) => jobs.push(job),
      storage: { put: async () => {}, delete: async () => {} },
    },
    env: {
      CATALOGS: {
        getByName: (principal) => ({
          fetch: async () => {
            sent.push(principal);
            return new Response(null, { status: principal === doc.owner ? 200 : 503 });
          },
        }),
      },
    },
  });
  const open = async () => {
    page.cacheTitle({
      ...employee,
      expiresAt: Date.now() + 60_000,
      domainAccess: { ...lease, expiresAt: Date.now() + 60_000 },
    });
    while (jobs.length) await Promise.all(jobs.splice(0));
  };
  await open();
  assert.equal(page.titleProjection.name, "settled");
  await open();
  assert.deepEqual(sent, [doc.owner, employee.principal, employee.principal]);
});

// ---------------------------------------------------------------------------
// Roles through a company domain grant.

const grantAt = (role) => ({ ...domainView, role });
/** The fixture Page shared with the company domain at `role`, with no role
 * stored when `role` is undefined, and Restricted when it is null. */
const sharedAt = (role) => {
  const value = metadata();
  if (role === null) value.acl.domainView = null;
  else if (role !== undefined) value.acl.domainView = grantAt(role);
  return value;
};
const domainReader = { ...employee, domainAccess: lease };
const capabilities = (access) =>
  ["canRead", "canComment", "canWrite", "canManageAccess", "canDelete"].filter(
    (name) => access[name],
  );

test("an owner shares with a company domain at each role; widening needs current proof, narrowing and withdrawing none", async () => {
  let page = restrictedPage();
  let revision = 1;
  for (const role of ["viewer", "commenter", "editor", "viewer"]) {
    const result = await proposeSharingMutation(
      page,
      companyApiKeyOwner,
      { ...enableArgs, role, expected_revision: revision, nonce: `role-${revision}` },
      now,
      env,
    );
    revision++;
    assert.equal(result.receipt.revision, revision, "every change, a role change too, bumps it");
    assert.deepEqual(result.metadata.acl.domainView, grantAt(role));
    assert.deepEqual(result.metadata.acl.members, {});
    page = result.metadata;
  }
  page = (
    await proposeSharingMutation(
      page,
      companyApiKeyOwner,
      { ...enableArgs, role: "editor", expected_revision: revision, nonce: "to-editor" },
      now,
      env,
    )
  ).metadata;
  revision++;
  const projected = await sharingProjection(page, companyApiKeyOwner, env, now);
  assert.deepEqual(projected.domainView, grantAt("editor"));
  assert.equal(projected.domainViewOwnerVerified, true);
  // A grant stored without a role projects as the viewer grant it is.
  assert.deepEqual(
    (await sharingProjection(metadata(), companyApiKeyOwner, env, now)).domainView,
    viewerGrant,
  );
  // An owner whose proof lapsed may narrow the grant: lower its role on the
  // same domain, or withdraw it. Widening needs fresh proof.
  const stale = await verifiedIdentity(
    "owner@anaconda.com",
    true,
    now - 6 * 3600 * 1000 - 1000,
    owner.principal,
  );
  const asStale = (from, args, nonce) =>
    proposeSharingMutation(
      from,
      stale,
      { ...enableArgs, ...args, expected_revision: from.acl.revision, nonce },
      now,
      env,
    );
  const commenter = await asStale(page, { role: "commenter" }, "stale-commenter");
  assert.deepEqual(commenter.metadata.acl.domainView, grantAt("commenter"));
  const viewer = await asStale(commenter.metadata, { role: "viewer" }, "stale-viewer");
  assert.deepEqual(viewer.metadata.acl.domainView, grantAt("viewer"));
  // An omitted role is viewer, so against a stored editor grant it narrows.
  const omitted = await asStale(page, {}, "stale-omitted-role");
  assert.deepEqual(omitted.metadata.acl.domainView, grantAt("viewer"));
  const withNamespace = (namespace) => ({
    ...page,
    acl: { ...page.acl, domainView: { ...grantAt("editor"), namespace } },
  });
  // A stored grant without a role is a viewer grant: nothing lower to narrow to.
  for (const [from, args, label] of [
    [viewer.metadata, {}, "the same role, omitted"],
    [
      { ...page, acl: { ...page.acl, domainView: { ...domainView, role: "owner" } } },
      { role: "viewer" },
      "a stored grant with an invalid role",
    ],
    [withNamespace(namespace.toUpperCase()), { role: "viewer" }, "a namespace in other case"],
    [withNamespace(` ${namespace} `), { role: "viewer" }, "a namespace with whitespace"],
    [page, { role: "editor" }, "the same role"],
    [commenter.metadata, { role: "editor" }, "a higher role"],
    [viewer.metadata, { role: "commenter" }, "a higher role"],
    [viewer.metadata, { role: "viewer" }, "the same role"],
    [metadata(), { role: "viewer" }, "a role-less grant again"],
    [restrictedPage(), { role: "viewer" }, "a new grant"],
    [
      {
        ...page,
        acl: { ...page.acl, domainView: { ...grantAt("editor"), namespace: "user:other" } },
      },
      { role: "viewer" },
      "another namespace's grant",
    ],
  ])
    await rejectsWithStatus(
      asStale(from, args, `stale-${label.replaceAll(/\W/g, "-")}-${args.role}`),
      403,
      ownerProofExpired,
      "company_email_proof_required",
    );
  const withdrawn = await proposeSharingMutation(
    page,
    stale,
    { ...restrictArgs, expected_revision: revision },
    now,
    env,
  );
  assert.equal(withdrawn.metadata.acl.domainView, null);
  // A stored domain the deployment no longer allows can't be narrowed, only
  // withdrawn.
  const dropped = { ...env, PAGES_COMPANY_VIEW_DOMAINS: "" };
  await rejectsWithStatus(
    proposeSharingMutation(
      page,
      stale,
      { ...enableArgs, role: "viewer", expected_revision: revision, nonce: "dropped-viewer" },
      now,
      dropped,
    ),
    400,
    /supported company domain/,
  );
  const droppedWithdrawn = await proposeSharingMutation(
    page,
    stale,
    { ...restrictArgs, expected_revision: revision, nonce: "dropped-withdraw" },
    now,
    dropped,
  );
  assert.equal(droppedWithdrawn.metadata.acl.domainView, null);
});

test("a company domain grant gives its role to verified readers only, with no member row", () => {
  for (const [role, expected] of [
    [undefined, ["canRead"]],
    ["viewer", ["canRead"]],
    ["commenter", ["canRead", "canComment"]],
    ["editor", ["canRead", "canComment", "canWrite"]],
  ]) {
    const page = sharedAt(role);
    const access = pageAccess(page, domainReader, { now });
    assert.equal(access.role, role ?? "viewer");
    assert.equal(access.source, "domain");
    assert.equal(access.generation, 0);
    assert.deepEqual(capabilities(access), expected, String(role));
    assert.deepEqual(page.acl.members, {});
    for (const outsider of [
      employee,
      { ...employee, domainAccess: { ...lease, domain: "example.com" } },
      { ...employee, domainAccess: { ...lease, namespace: "user:other" } },
      { ...employee, domainAccess: { ...lease, expiresAt: now } },
      { ...domainReader, expiresAt: now },
    ])
      assert.equal(pageAccess(page, outsider, { now }).canRead, false, String(role));
  }
  // A stored role that names nothing grantable grants nothing.
  for (const role of ["owner", "none", null, "Editor"]) {
    const page = metadata();
    page.acl.domainView = grantAt(role);
    assert.equal(pageAccess(page, domainReader, { now }).canRead, false, String(role));
  }
  // Comments follow the grant: a commenter and an editor comment, a viewer doesn't.
  for (const [role, comments] of [
    ["viewer", false],
    ["commenter", true],
    ["editor", true],
  ]) {
    const policy = new DocumentPolicy({ metadata: () => sharedAt(role), now: () => now });
    if (comments) assert.equal(policy.account(domainReader, "comment").canComment, true);
    else assert.throws(() => policy.account(domainReader, "comment"), /Commenting is not allowed/);
    if (role === "editor") assert.equal(policy.account(domainReader, true).canWrite, true);
    else assert.throws(() => policy.account(domainReader, true), /read-only/);
  }
  // A read-only credential keeps the role it holds but writes nothing.
  const readOnly = pageAccess(sharedAt("editor"), { ...domainReader, canWrite: false }, { now });
  assert.equal(readOnly.role, "editor");
  assert.deepEqual(capabilities(readOnly), ["canRead"]);
});

test("against a direct grant, the higher rank wins, a tie is direct, and a removal blocks the domain at every role", () => {
  const withMember = (role, row) => {
    const page = sharedAt(role);
    page.acl.members[employee.principal] = row;
    return pageAccess(page, domainReader, { now });
  };
  const higher = withMember("viewer", { role: "editor", generation: 2 });
  assert.equal(higher.role, "editor");
  assert.equal(higher.source, undefined);
  assert.equal(higher.generation, 2);
  const domainHigher = withMember("editor", { role: "viewer", generation: 1 });
  assert.equal(domainHigher.role, "editor");
  assert.equal(domainHigher.source, "domain");
  assert.equal(domainHigher.canWrite, true);
  const tie = withMember("commenter", { role: "commenter", generation: 3 });
  assert.equal(tie.role, "commenter");
  assert.equal(tie.source, undefined, "on a tie the direct grant is the basis");
  for (const role of [undefined, "viewer", "commenter", "editor"])
    assert.equal(withMember(role, { role: "none", generation: 4 }).canRead, false, String(role));
});

test("while a domain change commits, readers hold only what both grants allow", () => {
  const during = (before, after) =>
    pageAccess(restrictAccessDuringCommit(before, after), domainReader, { now });
  assert.equal(during(sharedAt(null), sharedAt("editor")).canRead, false, "a new grant waits");
  assert.equal(during(sharedAt("editor"), sharedAt(null)).canRead, false, "withdrawal is at once");
  const downgrade = during(sharedAt("editor"), sharedAt("viewer"));
  assert.equal(downgrade.role, "viewer");
  assert.equal(downgrade.canWrite, false);
  assert.equal(
    during(sharedAt("commenter"), sharedAt("editor")).role,
    "commenter",
    "an upgrade waits",
  );
  assert.equal(
    during(sharedAt(undefined), sharedAt("editor")).role,
    "viewer",
    "a stored viewer grant too",
  );
  assert.equal(during(sharedAt("editor"), sharedAt(undefined)).role, "viewer");
  const elsewhere = sharedAt("editor");
  elsewhere.acl.domainView = { ...grantAt("editor"), domain: "example.com" };
  assert.equal(during(sharedAt("editor"), elsewhere).canRead, false, "a switch waits");
  assert.equal(during(sharedAt("editor"), sharedAt("editor")).role, "editor");
});

test("an owner's downgrade or withdrawal, or the proof's end, takes a domain editor's writes away", () => {
  for (const change of ["downgrade", "withdraw", "proof"]) {
    let page = sharedAt("editor"),
      clock = now;
    const policy = new DocumentPolicy({ metadata: () => page, now: () => clock });
    assert.equal(policy.account(domainReader, true).canWrite, true);
    assert.equal(policy.leaseExpiresAt(domainReader), lease.expiresAt);
    if (change === "downgrade") page = sharedAt("viewer");
    else if (change === "withdraw") page = sharedAt(null);
    else {
      // The decision ends with the domain lease, and its end reads as the
      // credential's own evidence ending.
      assert.equal(leaseExpiryError(domainReader, lease.expiresAt).code, "credential_expired");
      clock = lease.expiresAt;
    }
    assert.throws(() => policy.account(domainReader, true), /read-only|denied/i, change);
    if (change === "downgrade") assert.equal(policy.account(domainReader).role, "viewer");
    else assert.throws(() => policy.account(domainReader), /denied/i, change);
  }
});

test("a domain reader's listing row carries the grant's role, and a role change keeps the row", () => {
  const opened = { principal: employee.principal, domain: "anaconda.com" };
  const row = (page) =>
    accessRows(page, env, opened).rows.find((value) => value.source === "domain_opened");
  assert.equal(row(sharedAt("editor")).role, "editor");
  assert.equal(
    row(sharedAt("commenter")).role,
    "viewer",
    "the index lists a commenter as a viewer",
  );
  assert.equal(row(sharedAt(undefined)).role, "viewer");
  assert.equal(row(sharedAt("editor")).domain, "anaconda.com");
  assert.equal(listingRestricted(sharedAt("editor"), sharedAt("viewer"), env), false);
  assert.equal(listingRestricted(sharedAt("editor"), sharedAt(null), env), true);
});

test("permanent deletion names the company domain with its role", () => {
  assert.deepEqual(purgeImpact(sharedAt("editor"), null, null, "Plan").domain_view, {
    domain: "anaconda.com",
    role: "editor",
  });
  assert.deepEqual(purgeImpact(sharedAt(undefined), null, null, "Plan").domain_view, {
    domain: "anaconda.com",
    role: "viewer",
  });
  assert.equal(purgeImpact(sharedAt(null), null, null, "Plan").domain_view, null);
});

test("a domain editor's upload URL carries the issuer's domain lease and expires with it", async (t) => {
  // One clock for issue, lease derivation and the upload.
  let clock = now;
  t.mock.method(Date, "now", () => clock);
  const storage = new Storage();
  const pageId = "domain-upload-page";
  const page = { ...sharedAt("editor"), pageId };
  const uploadUrl = (identity, record = page) =>
    issueAssetUpload(storage, {
      pageId,
      identity,
      args: { page_id: pageId },
      origin: "https://pages.invalid",
      now: clock,
      accessUntil: (claims) => uploaderEditUntil(record, claims, env),
    });
  const tokenOf = (issued) => issued.headers.Authorization.slice("Pages-Upload ".length);
  const open = (issued) =>
    verifyAssetUpload(storage, tokenOf(issued), {
      pageId,
      now: clock,
      grantActive: () => assert.fail("an API-key capability names no grant"),
    });
  /** The Page host's upload check: verify the capability, derive its leases,
   * and decide edit access on the record as it is now. */
  const upload = async (issued, record = page, deployment = env) => {
    const identity = await withDomainAccess(uploadIdentity(await open(issued)), deployment);
    new DocumentPolicy({ metadata: () => record, now: () => clock }).account(identity, true);
    return identity;
  };
  // An API key's domain lease lasts as long as its 60-second identity, here
  // backed by a provider answer just as fresh.
  const apiKey = (verifiedEmail = "person@anaconda.com") =>
    withDomainAccess(
      {
        ...employee,
        credentialKind: "api-key",
        verifiedEmail,
        verifiedEmailUntil: clock + 60_000,
        expiresAt: clock + 60_000,
      },
      env,
    );
  const issuer = await apiKey();
  assert.equal(issuer.domainAccess.expiresAt, now + 60_000);
  const issued = await uploadUrl(issuer);
  // The URL says when it stops working: the lease's end, not ten minutes.
  assert.equal(issued.expires_at, new Date(now + 60_000).toISOString());
  const claims = await open(issued);
  assert.equal(claims.exp, now + 60_000);
  assert.equal(claims.domain, "anaconda.com");
  assert.equal(claims.domain_exp, now + 60_000);
  assert.deepEqual((await upload(issued)).domainAccess, { ...domainView, expiresAt: now + 60_000 });
  clock = now + 59_999;
  assert.equal((await upload(issued)).domainAccess.domain, "anaconda.com");
  // At domain_exp, replaying the capability derives no lease, and the upload
  // is refused.
  clock = now + 60_000;
  assert.equal((await withDomainAccess(uploadIdentity(claims), env)).domainAccess, undefined);
  await assert.rejects(upload(issued), { status: 401, code: "upload_capability_expired" });
  // Changes after issue refuse the upload at once: the owner withdraws the
  // grant, downgrades it to viewer, or the deployment drops the domain.
  for (const [change, record, deployment] of [
    ["withdrawn", { ...sharedAt(null), pageId }, env],
    ["downgraded", { ...sharedAt("viewer"), pageId }, env],
    ["not allowed", page, { ...env, PAGES_COMPANY_VIEW_DOMAINS: "" }],
  ]) {
    clock = now;
    const later = await uploadUrl(await apiKey());
    clock = now + 1000;
    assert.ok(await upload(later), change);
    const derived = await withDomainAccess(uploadIdentity(await open(later)), deployment);
    if (change === "not allowed") assert.equal(derived.domainAccess, undefined, change);
    await assert.rejects(upload(later, record, deployment), /read-only|denied/i, change);
  }
  // A caller who can't edit gets no URL.
  clock = now;
  await assert.rejects(uploadUrl(await apiKey("person@gmail.com")), { status: 403 });
  // A member editor who also holds the lease keeps the full ten minutes: the
  // upload doesn't depend on the lease.
  const memberPage = structuredClone(page);
  memberPage.acl.members[employee.principal] = { role: "editor", generation: 1 };
  const member = await uploadUrl(await apiKey(), memberPage);
  assert.equal(member.expires_at, new Date(now + ASSET_UPLOAD_TTL_MS).toISOString());
  assert.equal((await open(member)).domain_exp, now + 60_000);
  clock = now + 60_001;
  assert.equal((await upload(member, memberPage)).domainAccess, undefined);
  // An issuer without a domain lease issues a capability without one.
  clock = now;
  const plain = await uploadUrl({ ...employee, credentialKind: "api-key" }, memberPage);
  const bare = await open(plain);
  assert.equal(bare.domain, undefined);
  assert.equal((await withDomainAccess(uploadIdentity(bare), env)).domainAccess, undefined);
  // A payload's domain fields are well formed or the capability is invalid.
  for (const bad of [
    { namespace: undefined },
    { domain_exp: undefined },
    { domain_exp: claims.exp + 1 },
    { domain: 42 },
    { domain: undefined },
  ])
    assert.equal(
      uploadVerdict({ ...claims, ...bad }, { pageId, now }),
      "invalid",
      JSON.stringify(bad),
    );
});

test("a cached provider answer keeps its own deadline: an API key's domain lease and upload URL never outlive it", async (t) => {
  const fixture = await createAuthFixture();
  // The provider's answer for the key, read at each lookup.
  let email = "person@anaconda.com";
  let lookups = 0;
  t.mock.method(globalThis, "fetch", async (...args) => {
    lookups += 1;
    const body = await (await fixture.fetch(...args)).json();
    body.passport.profile.email = email;
    return Response.json(body);
  });
  const start = Date.now();
  let clock = start;
  t.mock.method(Date, "now", () => clock);
  const companyNamespace = fixture.env.NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE;
  const companyEnv = { ...fixture.env, PAGES_COMPANY_VIEW_DOMAINS: "anaconda.com" };
  const lease = (expiresAt) => ({ domain: "anaconda.com", namespace: companyNamespace, expiresAt });
  const token = fixture.apiKey();
  const signIn = () =>
    authenticate(
      new Request("https://pages.invalid/api/connect?page=test", {
        headers: { authorization: `Bearer ${token}` },
      }),
      companyEnv,
    );
  const first = await signIn();
  assert.equal(first.verifiedEmailUntil, start + 60_000);
  assert.deepEqual(first.domainAccess, lease(start + 60_000));
  // The account's email changes at the provider. Until its lookup expires the
  // verifier answers from it, with the old email, to a fresh 60-second
  // identity; the lease still ends when that lookup's answer does.
  email = "person@gmail.com";
  clock = start + 59_000;
  const cached = await signIn();
  assert.equal(lookups, 1);
  assert.equal(cached.verifiedEmail, "person@anaconda.com");
  assert.equal(cached.expiresAt, start + 119_000);
  assert.deepEqual(cached.domainAccess, lease(start + 60_000));
  // An upload URL issued from the cached answer, by a domain editor, signs
  // that deadline and ends with it.
  const storage = new Storage();
  const pageId = "domain-cache-upload-page";
  const page = {
    pageId,
    owner: `${companyNamespace}:owner`,
    acl: {
      revision: 1,
      members: {},
      invites: {},
      domainView: { domain: "anaconda.com", namespace: companyNamespace, role: "editor" },
    },
  };
  const issued = await issueAssetUpload(storage, {
    pageId,
    identity: cached,
    args: { page_id: pageId },
    origin: "https://pages.invalid",
    now: clock,
    accessUntil: (claims) => uploaderEditUntil(page, claims, companyEnv),
  });
  assert.equal(issued.expires_at, new Date(start + 60_000).toISOString());
  const claims = await verifyAssetUpload(
    storage,
    issued.headers.Authorization.slice("Pages-Upload ".length),
    { pageId, now: clock, grantActive: () => assert.fail("an API-key capability names no grant") },
  );
  assert.equal(claims.exp, start + 60_000);
  assert.equal(claims.domain_exp, start + 60_000);
  // Past the cache boundary a new lookup sees the changed email: no lease.
  clock = start + 61_001;
  const fresh = await signIn();
  assert.equal(lookups, 2);
  assert.equal(fresh.verifiedEmail, "person@gmail.com");
  assert.equal(fresh.domainAccess, undefined);
});

test("after a failed lookup, an API key's domain lease ends with the lookup that answered", async (t) => {
  const fixture = await createAuthFixture();
  // The provider is down for the first lookup only.
  let lookups = 0;
  t.mock.method(globalThis, "fetch", async (...args) => {
    lookups += 1;
    if (lookups === 1) return new Response("unavailable", { status: 503 });
    const body = await (await fixture.fetch(...args)).json();
    body.passport.profile.email = "person@anaconda.com";
    return Response.json(body);
  });
  t.mock.method(console, "error", () => {});
  const start = Date.now();
  let clock = start;
  t.mock.method(Date, "now", () => clock);
  const companyEnv = { ...fixture.env, PAGES_COMPANY_VIEW_DOMAINS: "anaconda.com" };
  const token = fixture.apiKey();
  const signIn = () =>
    authenticate(
      new Request("https://pages.invalid/api/connect?page=test", {
        headers: { authorization: `Bearer ${token}` },
      }),
      companyEnv,
    );
  await assert.rejects(signIn(), { status: 503 });
  // Nothing was cached, so the next call looks the account up, at +10 s.
  clock = start + 10_000;
  assert.equal((await signIn()).domainAccess.expiresAt, start + 70_000);
  // At +62 s the verifier still answers from that lookup, and the lease
  // ends with it, not 60 s from now.
  clock = start + 62_000;
  const cached = await signIn();
  assert.equal(lookups, 2);
  assert.equal(cached.expiresAt, start + 122_000);
  assert.equal(cached.domainAccess.expiresAt, start + 70_000);
});

test("an API-key agent edits through a company domain editor grant, publishes its presence, and loses the grant with its lease", async (t) => {
  const origin = "https://pages.invalid";
  const fixture = await createAuthFixture();
  t.mock.method(globalThis, "fetch", fixture.fetch);
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const companyEnv = {
    ...fixture.env,
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
    PAGES_COMPANY_VIEW_DOMAINS: "anaconda.com",
  };
  const pageId = "44444444-4444-4444-8444-444444444444";
  let doc = A.change(A.from(createPageData({ pageId, title: "Company Page" })), (draft) =>
    initializePage(draft, "Ship on Monday."),
  );
  t.after(() => A.free(doc));
  const presence = [];
  const page = Object.assign(Object.create(Page.prototype), {
    plain: plainStub(),
    env: companyEnv,
    ready: Promise.resolve(),
    tail: Promise.resolve(),
    ctx: { storage: new Storage() },
    metadata: {
      pageId,
      documentFormats: WRITTEN_FORMATS,
      owner: "user:anaconda-fixture:owner",
      deleted: false,
      acl: { revision: 1, members: {}, invites: {} },
    },
    handle: Object.assign(new EventEmitter(), {
      doc: () => doc,
      async update(fn) {
        doc = fn(doc);
      },
      broadcast() {},
    }),
    cacheTitle() {},
    flush: async () => {},
    publishAgentPresence(identity, type, ...rest) {
      presence.push({ principal: identity.principal, type });
      return Page.prototype.publishAgentPresence.call(this, identity, type, ...rest);
    },
  });
  page.policy = new DocumentPolicy({ metadata: () => page.metadata, now: () => clock });
  companyEnv.PAGES = { getByName: () => page };
  const share = (role) =>
    (page.metadata = {
      ...page.metadata,
      acl: {
        ...page.metadata.acl,
        domainView: role
          ? {
              domain: "anaconda.com",
              namespace: fixture.env.NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE,
              role,
            }
          : null,
      },
    });
  const call = (key, operation, args) =>
    worker.fetch(
      new Request(`${origin}/api/tools`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ operation, arguments: { page_id: pageId, ...args } }),
      }),
      companyEnv,
    );
  const edit = async (key, title) => {
    const read = await call(key, "read_page", {});
    if (read.status !== 200) return read;
    return call(key, "edit_page", {
      operations: [{ op: "set_title", title }],
      revision: (await read.json()).revision,
      nonce: crypto.randomUUID(),
    });
  };
  const key = fixture.apiKey({ email: "agent@anaconda.com" });
  share("editor");
  const written = await edit(key, "Edited through the company");
  assert.equal(written.status, 200, await written.clone().text());
  assert.equal(doc.title, "Edited through the company");
  assert.deepEqual(page.metadata.acl.members, {});
  const principal = `user:anaconda-fixture:${fixture.subject}`;
  assert.ok(
    presence.some((entry) => entry.principal === principal && entry.type === "write"),
    JSON.stringify(presence),
  );
  for (const role of ["commenter", "viewer"]) {
    share(role);
    const refused = await edit(key, `Edited as ${role}`);
    assert.equal(refused.status, 403, role);
    assert.match((await refused.json()).error, /read-only/);
    assert.equal(doc.title, "Edited through the company");
  }
  // A key whose account email is at another domain holds no lease.
  share("editor");
  const outsider = fixture.apiKey({ email: "agent@gmail.com" });
  assert.equal((await call(outsider, "read_page", {})).status, 403);
  // The lease is the key's 60-second identity: the policy refuses that
  // identity when it ends, and only a fresh check of the key renews it.
  const identity = await authenticate(
    new Request(`${origin}/mcp`, { headers: { authorization: `Bearer ${key}` } }),
    companyEnv,
  );
  assert.equal(identity.domainAccess.expiresAt, identity.expiresAt);
  assert.ok(identity.expiresAt <= clock + 60_000);
  assert.equal(page.policy.account(identity, true).canWrite, true);
  clock = identity.expiresAt;
  assert.throws(() => page.policy.account(identity, true), /credential expired/);
});

test("a company domain grant is Page-only: a Project never carries one to its Pages", () => {
  // A Project record that somehow holds a domain grant gives it to nobody:
  // projectObject reads only member rows and the organization grant.
  const record = {
    space_id: "prj_00000000-0000-4000-8000-000000000002",
    owner: owner.principal,
    acl: {
      revision: 2,
      members: {},
      invites: {},
      domainView: grantAt("editor"),
    },
  };
  assert.deepEqual(
    decide(principalOf(domainReader), NO_ACTOR_CHAIN, projectObject(record), now).capabilities,
    [],
  );
  const container = {
    ...projectObject(record),
    members: {},
    valid_until: now + PROJECT_ACCESS_LEASE_MS,
  };
  const inProject = (acl) => ({
    pageId: "in-project",
    owner: owner.principal,
    deleted: false,
    acl: { revision: 1, members: {}, invites: {}, ...acl },
    projectAccess: container,
  });
  assert.equal(pageAccess(inProject({}), domainReader, { now }).canRead, false);
  // The Page's own domain grant works on a Page in a Project, at its role,
  // and an upload depends on the domain lease, not the Project lease.
  const shared = inProject({ domainView: grantAt("editor") });
  const own = pageAccess(shared, domainReader, { now });
  assert.equal(own.canWrite, true);
  assert.equal(own.source, "domain");
  assert.ok(lease.expiresAt > now + PROJECT_ACCESS_LEASE_MS);
  assert.equal(audienceEditUntil(shared, domainReader, { now }), lease.expiresAt);
  // A tombstone on the Page blocks its domain grant there too.
  const removed = inProject({
    domainView: grantAt("editor"),
    members: { [employee.principal]: { role: "none", generation: 2 } },
  });
  assert.equal(pageAccess(removed, domainReader, { now }).canRead, false);
});
