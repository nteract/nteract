import assert from "node:assert/strict";
import { test } from "node:test";
import { pageAccess, pageGrant } from "./access.mjs";
import { projectObject } from "./authz.mjs";
import { DocumentPolicy } from "./policy.mjs";
import { resolveProjectAccess } from "./project-access.mjs";

const now = 1000;
const identity = { principal: "user:member", expiresAt: 100000, canWrite: true };
const project = {
  space_id: "prj-test",
  owner: "user:owner",
  acl: { revision: 1, members: { "user:member": { role: "editor", generation: 1 } } },
};
const metadata = {
  pageId: "page",
  owner: "user:owner",
  acl: { revision: 0, members: {} },
  projectAccess: { ...projectObject(project), members: project.acl.members, valid_until: 16000 },
};

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

test("native author authority expires and old Project generation cannot revive", () => {
  let clock = now;
  let current = metadata;
  const policy = new DocumentPolicy({ metadata: () => current, now: () => clock });
  const binding = {
    principal: identity.principal,
    writer: true,
    generation: pageGrant(metadata, identity.principal, now).generation,
  };
  assert.equal(policy.authorAllowed(binding), true);
  clock = 16000;
  assert.equal(policy.authorAllowed(binding), false);
  clock = 17000;
  current = {
    ...metadata,
    projectAccess: {
      ...metadata.projectAccess,
      revision: 3,
      members: { "user:member": { role: "editor", generation: 3 } },
      valid_until: 30000,
    },
  };
  assert.equal(policy.authorAllowed(binding), false);
});

test("unrelated Project ACL revisions preserve existing author generation", () => {
  const changed = { ...metadata, projectAccess: { ...metadata.projectAccess, revision: 999 } };
  assert.equal(
    pageGrant(changed, identity.principal, now).generation,
    pageGrant(metadata, identity.principal, now).generation,
  );
});

test("expired or missing Project leases deny live authority without retiring author keys", async () => {
  let clock = now;
  let current = metadata;
  const stored = new Map();
  const policy = new DocumentPolicy({
    metadata: () => current,
    now: () => clock,
    storage: { put: async (key, value) => stored.set(key, value) },
  });
  const binding = {
    principal: identity.principal,
    writer: true,
    generation: pageGrant(metadata, identity.principal, now).generation,
  };
  policy.bindings.set("key", binding);
  clock = 16001;
  for (const snapshot of [metadata.projectAccess, null]) {
    current = {
      ...metadata,
      projectAccess: snapshot,
      acl: { revision: 1, members: { "user:unrelated": { role: "viewer", generation: 1 } } },
    };
    await policy.refreshAccess();
    assert.equal(policy.bindings.get("key"), binding);
    assert.equal(policy.authorAllowed(binding), false);
    assert.equal(stored.size, 0);
  }
  current = { ...metadata, projectAccess: { ...metadata.projectAccess, valid_until: 30000 } };
  assert.equal(policy.authorAllowed(binding), true);
  const revoked = {
    ...project,
    acl: { revision: 2, members: { "user:member": { role: "none", generation: 2 } } },
  };
  current = {
    ...metadata,
    projectAccess: { ...projectObject(revoked), members: revoked.acl.members, valid_until: 30000 },
  };
  await policy.refreshAccess();
  assert.equal(policy.bindings.get("key").retired, true);
  assert.equal(stored.get("host/binding/key").retired, true);
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

test("reconnect with direct viewer fallback never retires an unknown Project editor key", async () => {
  let current = {
    ...metadata,
    acl: { revision: 1, members: { [identity.principal]: { role: "viewer", generation: 1 } } },
  };
  const stored = new Map();
  const policy = new DocumentPolicy({
    metadata: () => current,
    now: () => now,
    storage: { put: async (key, value) => stored.set(key, value) },
  });
  const key = "a".repeat(64);
  const binding = {
    principal: identity.principal,
    writer: true,
    commenter: true,
    generation: pageGrant(current, identity.principal, now).generation,
  };
  policy.bindings.set(key, binding);
  const options = { reauthenticate: async () => identity, disconnect: async () => {} };
  const fresh = current.projectAccess;
  for (const projectAccess of [null, { ...fresh, valid_until: now }]) {
    current = { ...current, projectAccess };
    assert.equal(policy.account(identity).role, "viewer");
    await assert.rejects(policy.bind(key, "sender", identity, options), {
      status: 503,
      code: "project_policy_unavailable",
    });
    assert.equal(policy.bindings.get(key), binding);
    assert.equal(policy.admissions.size, 0);
    assert.equal(stored.size, 0);
    assert.equal(policy.authorAllowed(binding), false);
  }
  current = { ...current, projectAccess: fresh };
  const release = await policy.bind(key, "sender", identity, options);
  assert.equal(policy.bindings.get(key).writer, true);
  assert.equal(policy.bindings.get(key).retired, false);
  assert.equal(policy.authorAllowed(policy.bindings.get(key)), true);
  release();
  const revoked = {
    ...project,
    acl: { revision: 2, members: { [identity.principal]: { role: "none", generation: 2 } } },
  };
  current = {
    ...current,
    projectAccess: { ...projectObject(revoked), members: revoked.acl.members, valid_until: 16000 },
  };
  const releaseReader = await policy.bind(key, "sender", identity, options);
  assert.equal(policy.bindings.get(key).writer, false);
  assert.equal(policy.bindings.get(key).retired, true);
  assert.equal(stored.get(`host/binding/${key}`).retired, true);
  releaseReader();
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
