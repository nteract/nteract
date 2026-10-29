import assert from "node:assert/strict";
import { test } from "node:test";
import { createServerAppSession } from "@cloud/app-session.ts";
import { companyViewDomains, domainAccessForIdentity } from "./domain-access.mjs";
import { pageAccess, proposeAccessUpdate, restrictAccessDuringCommit } from "./access.mjs";
import { proposeSharingMutation, sharingProjection } from "./sharing.mjs";
import { DocumentPolicy } from "./policy.mjs";
import { Page } from "./index.mjs";
import { errorResponse, HttpError } from "./auth.mjs";

const now = 1_800_000_000_000;
const namespace = "user:anaconda";
const env = {
  NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://page7.example",
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

class Storage {
  values = new Map();
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    this.values.set(key, structuredClone(value));
  }
  async list({ prefix = "" } = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)));
  }
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
          idempotency_key: "unsupported-domain",
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

const enableArgs = {
  action: "set_domain_view",
  domain: "anaconda.com",
  expected_revision: 1,
  idempotency_key: "enable-domain",
};
const restrictArgs = {
  action: "set_domain_view",
  domain: null,
  expected_revision: 1,
  idempotency_key: "restrict-domain",
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
    await rejectsWithStatus(
      proposeSharingMutation(before, identity, { ...enableArgs, role: "editor" }, now, env),
      400,
      /view-only/,
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
    assert.deepEqual(enabled.metadata.acl.domainView, domainView);
    assert.deepEqual(enabled.metadata.acl.members, {});
    assert.equal(before.acl.domainView, undefined);
    const projected = await sharingProjection(enabled.metadata, identity, env, now);
    assert.deepEqual(projected.domainOptions, ["anaconda.com"]);
    assert.deepEqual(projected.domainView, domainView);
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
        { ...enableArgs, idempotency_key: "stale-enable" },
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
    { ...enableArgs, idempotency_key: "after-sign-in" },
    later,
    env,
  );
  assert.deepEqual(enabled.metadata.acl.domainView, domainView);
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
  assert.deepEqual(projected.domainView, domainView);
  assert.equal(projected.domainViewOwnerVerified, false);
  assert.equal(
    (await sharingProjection(legacy, companyApiKeyOwner, env, now)).domainViewOwnerVerified,
    true,
  );
  const reader = pageAccess(legacy, { ...employee, domainAccess: lease }, { now });
  assert.equal(reader.canRead, true);
  assert.equal(reader.source, "domain");
  await rejectsWithStatus(
    proposeSharingMutation(
      legacy,
      owner,
      { ...enableArgs, idempotency_key: "reassert-legacy" },
      now,
      env,
    ),
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
  assert.deepEqual(
    await domainAccessForIdentity(
      env,
      { ...employee, credentialKind: "api-key", verifiedEmail: " Person@ANACONDA.COM " },
      now,
    ),
    { ...domainView, expiresAt: employee.expiresAt },
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

test("native domain readers cannot write, and domain revocation or proof expiry disconnects their lease", async () => {
  for (const change of ["write", "domain", "deny", "proof", "provider"]) {
    let doc = metadata(),
      clock = now,
      disconnected = false;
    const identity = { ...employee, domainAccess: lease };
    const policy = new DocumentPolicy({
      storage: new Storage(),
      metadata: () => doc,
      now: () => clock,
    });
    const key = "a".repeat(64);
    assert.equal(policy.leaseExpiresAt(identity), lease.expiresAt);
    assert.equal(policy.leaseExpiresAt({ ...identity, expiresAt: now + 1000 }), now + 1000);
    await policy.bind(key, "sender", identity, {
      reauthenticate: async () =>
        change === "provider" ? { ...identity, domainAccess: undefined } : identity,
      disconnect: async () => {
        disconnected = true;
      },
    });
    assert.equal(policy.bindings.get(key).writer, false);
    assert.equal((await policy.active(key)).principal, employee.principal);
    if (change === "domain") {
      doc = { ...doc, acl: { ...doc.acl, domainView: null } };
      await policy.refreshAccess();
    } else if (change === "deny") {
      doc = {
        ...doc,
        acl: proposeAccessUpdate(
          doc,
          owner,
          { principal: employee.principal, role: null, expected_revision: 1 },
          { now },
        ).acl,
      };
      await policy.refreshAccess();
    } else {
      if (change === "proof") clock = lease.expiresAt;
      if (change === "provider") clock += 15_001;
      await assert.rejects(policy.active(key, change === "write"), /read-only|access denied/i);
    }
    assert.equal(disconnected, true, change);
  }
});

test("domain reader signing keys stay readers across restart and later explicit editor admission", async () => {
  const storage = new Storage();
  let doc = metadata();
  const identity = { ...employee, domainAccess: lease },
    key = "b".repeat(64);
  let policy = new DocumentPolicy({ storage, metadata: () => doc, now: () => now });
  await policy.bind(key, "sender", identity, {
    reauthenticate: async () => identity,
    disconnect: async () => {},
  });
  await policy.close();
  doc = {
    ...doc,
    acl: proposeAccessUpdate(
      doc,
      owner,
      { principal: employee.principal, role: "editor", expected_revision: 1 },
      { now },
    ).acl,
  };
  policy = new DocumentPolicy({ storage, metadata: () => doc, now: () => now });
  await policy.load();
  await policy.bind(key, "sender", identity, {
    reauthenticate: async () => identity,
    disconnect: async () => {},
  });
  assert.equal(policy.bindings.get(key).writer, false);
  await assert.rejects(policy.active(key, true), /Signing key is read-only/);
});

test("opening a domain Page remembers only that reader's discovery entry, never a permanent grant", async () => {
  const doc = metadata(),
    calls = [],
    pending = [];
  const page = Object.assign(Object.create(Page.prototype), {
    metadata: { ...doc, pageId: "test-page" },
    handle: { doc: () => ({ title: "Shared by domain" }) },
    cachedTitle: "Shared by domain",
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
