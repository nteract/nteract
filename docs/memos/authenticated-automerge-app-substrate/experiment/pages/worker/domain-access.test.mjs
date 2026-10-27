import assert from "node:assert/strict";
import { test } from "node:test";
import { createServerAppSession } from "@cloud/app-session.ts";
import { companyViewDomains, domainAccessForIdentity } from "./domain-access.mjs";
import { pageAccess, proposeAccessUpdate, restrictAccessDuringCommit } from "./access.mjs";
import { proposeSharingMutation, sharingProjection } from "./sharing.mjs";
import { DocumentPolicy } from "./policy.mjs";
import { Page } from "./index.mjs";

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
async function verifiedIdentity(email = "person@anaconda.com", verified = true, at = now) {
  const session = await createServerAppSession(
    env,
    {
      principal: employee.principal,
      metadata: { provider: "oidc", principalNamespace: namespace, email, emailVerified: verified },
    },
    "fixture-session",
    now / 1000 + 60,
    at / 1000,
  );
  return { ...employee, emailProof: { ...session, provider: "app-session" } };
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

test("a Gmail owner can choose only the host-approved viewer domain without creating memberships", async () => {
  const before = metadata();
  delete before.acl.domainView;
  const args = {
    action: "set_domain_view",
    domain: "anaconda.com",
    expected_revision: 1,
    idempotency_key: "enable-domain",
  };
  const enabled = await proposeSharingMutation(before, owner, args, now, env);
  assert.deepEqual(enabled.metadata.acl.domainView, domainView);
  assert.deepEqual(enabled.metadata.acl.members, {});
  assert.equal(before.acl.domainView, undefined);
  const projected = sharingProjection(
    enabled.metadata,
    { ...owner, expiresAt: Date.now() + 60_000 },
    env,
  );
  assert.deepEqual(projected.domainOptions, ["anaconda.com"]);
  assert.deepEqual(projected.domainView, domainView);
  assert.equal(
    (await proposeSharingMutation(enabled.metadata, owner, args, now, env)).replay,
    true,
  );
  await assert.rejects(proposeSharingMutation(before, employee, args, now, env), /Only the owner/);
  await assert.rejects(
    proposeSharingMutation(before, owner, { ...args, role: "editor" }, now, env),
    /view-only/,
  );
  await assert.rejects(
    proposeSharingMutation(before, owner, { ...args, domain: "gmail.com" }, now, env),
    /supported/,
  );
  await assert.rejects(
    proposeSharingMutation(
      enabled.metadata,
      owner,
      { ...args, idempotency_key: "stale-enable" },
      now,
      env,
    ),
    /Sharing changed/,
  );
  const restricted = await proposeSharingMutation(
    enabled.metadata,
    owner,
    {
      action: "set_domain_view",
      domain: null,
      expected_revision: 2,
      idempotency_key: "restrict-domain",
    },
    now,
    {},
  );
  assert.equal(restricted.metadata.acl.domainView, null);
  assert.deepEqual(restricted.metadata.acl.members, {});
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
