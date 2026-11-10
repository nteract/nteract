import assert from "node:assert/strict";
import { test } from "node:test";
import { pageAccess, pageGrant } from "./access.mjs";
import { projectObject } from "./authz.mjs";
import { DocumentPolicy, leaseExpiryError } from "./policy.mjs";
import {
  PROJECT_ACCESS_EMPTY,
  projectAccessStep,
  resolveProjectAccess,
} from "./project-access.mjs";

const now = 1000;
const identity = { principal: "user:member", expiresAt: 100000, canWrite: true };
const project = {
  space_id: "prj_00000000-0000-4000-8000-000000000001",
  owner: "user:owner",
  acl: { revision: 1, members: { "user:member": { role: "editor", generation: 1 } } },
};
const metadata = {
  pageId: "page",
  owner: "user:owner",
  acl: { revision: 0, members: {} },
  projectAccess: { ...projectObject(project), members: project.acl.members, valid_until: 16000 },
};

test("Project snapshot transitions fence revisions only within the same owner and placement", () => {
  const snapshot = metadata.projectAccess;
  const apply = (state, value, observed = state, owner = "user:owner") =>
    projectAccessStep(state, { snapshot: value, observed, owner });
  const first = apply(PROJECT_ACCESS_EMPTY, snapshot);
  const revoked = apply(first, { ...snapshot, revision: 2, members: {} });
  assert.equal(apply(revoked, snapshot, first), revoked);
  assert.equal(
    apply(revoked, snapshot),
    revoked,
    "even a later request cannot install an older owner revision",
  );
  const clear = apply(revoked, null);
  assert.equal(clear.name, "unavailable");
  assert.equal(clear.snapshot, null);
  assert.deepEqual(clear.fence, revoked.fence);
  assert.equal(apply(clear, snapshot, first), clear);
  assert.equal(
    apply(clear, revoked.snapshot, revoked),
    clear,
    "late equal revision cannot undo a cleared grant",
  );
  const other = apply(revoked, { ...snapshot, id: "prj-other", revision: 0 });
  assert.equal(other.snapshot.revision, 0, "another Project's revision is independent");
  assert.equal(
    apply(other, revoked.snapshot, revoked),
    other,
    "late old placement cannot replace another Project",
  );
  const otherOwner = apply(revoked, { ...snapshot, revision: 0 }, revoked, "user:other");
  assert.equal(otherOwner.fence.owner, "user:other");
  assert.equal(otherOwner.snapshot.revision, 0);
  assert.equal(apply(revoked, null, first), revoked, "a stale failure cannot erase newer evidence");
  const fresh = apply(clear, { ...revoked.snapshot, valid_until: 32000 });
  assert.equal(fresh.name, "available", "a new checked resolution may restore availability");
});

test("lease expiry classification preserves credential and domain proof deadlines", () => {
  const identity = { expiresAt: 61000 };
  assert.equal(leaseExpiryError(identity, 16000).code, "project_policy_unavailable");
  assert.equal(
    leaseExpiryError({ ...identity, domainAccess: { expiresAt: 5000 } }, 16000).code,
    "project_policy_unavailable",
    "an irrelevant expired domain proof must not expire a Project member's credential",
  );
  assert.equal(leaseExpiryError(identity, 61000).code, "credential_expired");
  assert.equal(
    leaseExpiryError({ ...identity, domainAccess: { expiresAt: 16000 } }, 16000).code,
    "credential_expired",
  );
  const renewed = { expiresAt: 121000 };
  assert.equal(leaseExpiryError(renewed, 76000).code, "project_policy_unavailable");
  assert.equal(leaseExpiryError(renewed, 121000).code, "credential_expired");
});

test("Project grants apply to content only and expire closed", () => {
  const access = pageAccess(metadata, identity, { now });
  assert.equal(access.source, "project");
  assert.equal(access.canWrite, true);
  assert.equal(access.canManageAccess, false);
  assert.equal(access.canDelete, false);
  assert.equal(pageAccess(metadata, identity, { now: 16000 }).canRead, false);
  assert.equal(
    pageAccess({ ...metadata, deleted: true, trash: {} }, identity, { now }).canRead,
    false,
  );
  assert.equal(pageAccess(metadata, { ...identity, canWrite: false }, { now }).canWrite, false);
});

test("direct grants survive Project revocation and never propagate to children", () => {
  const direct = {
    ...metadata,
    acl: { revision: 2, members: { "user:member": { role: "commenter", generation: 2 } } },
  };
  assert.equal(pageAccess(direct, identity, { now }).role, "editor");
  assert.equal(pageAccess(direct, identity, { now: 16000 }).role, "commenter");
  assert.equal(pageGrant(direct, identity.principal, 16000).generation, 2);
  assert.equal(
    pageAccess({ owner: "user:owner", parent_id: "page" }, identity, { now }).canRead,
    false,
  );
});

test("Project write authority ends with its lease", () => {
  let clock = now;
  const policy = new DocumentPolicy({ metadata: () => metadata, now: () => clock });
  policy.account(identity, true);
  clock = 16000;
  assert.throws(() => policy.account(identity, true));
});

test("unrelated Project ACL revisions preserve existing author generation", () => {
  const changed = { ...metadata, projectAccess: { ...metadata.projectAccess, revision: 999 } };
  assert.equal(
    pageGrant(changed, identity.principal, now).generation,
    pageGrant(metadata, identity.principal, now).generation,
  );
});

test("a new grant cannot combine with placement observed before a move", async () => {
  let reads = 0;
  const env = {
    CATALOGS: {
      getByName: () => ({
        fetch: async () =>
          Response.json({ complete: true, space_id: ++reads === 1 ? project.space_id : null }),
      }),
    },
    PROJECTS: { getByName: () => ({ fetch: async () => Response.json(project) }) },
  };
  assert.equal(await resolveProjectAccess(env, metadata, now), null);
});

test("without a current Project snapshot, a direct viewer grant reads but can't write", () => {
  let current = {
    ...metadata,
    acl: { revision: 1, members: { [identity.principal]: { role: "viewer", generation: 1 } } },
  };
  const policy = new DocumentPolicy({ metadata: () => current, now: () => now });
  const fresh = current.projectAccess;
  for (const projectAccess of [null, { ...fresh, valid_until: now }]) {
    current = { ...current, projectAccess };
    assert.equal(policy.account(identity).role, "viewer");
    assert.throws(() => policy.account(identity, true));
  }
  current = { ...current, projectAccess: fresh };
  assert.equal(policy.account(identity, true).canWrite, true);
});

test("Project snapshots come only from complete owner Catalog placement", async () => {
  const env = {
    CATALOGS: {
      getByName: (owner) => ({
        fetch: async () => {
          assert.equal(owner, metadata.owner);
          return Response.json({ complete: true, space_id: project.space_id });
        },
      }),
    },
    PROJECTS: { getByName: () => ({ fetch: async () => Response.json(project) }) },
  };
  const snapshot = await resolveProjectAccess(env, metadata, now);
  assert.equal(snapshot.valid_until, 16000);
  assert.equal(snapshot.id, project.space_id);
  env.CATALOGS.getByName = () => ({
    fetch: async () => Response.json({ complete: false, space_id: project.space_id }),
  });
  assert.equal(await resolveProjectAccess(env, metadata, now), null);
});
