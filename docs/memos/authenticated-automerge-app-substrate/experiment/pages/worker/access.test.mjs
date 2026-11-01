import assert from "node:assert/strict";
import { test } from "node:test";
import { pageAccess, pageGrant, proposeAccessUpdate } from "./access.mjs";

const owner = { principal: "user:owner", canWrite: true, expiresAt: 10000 };
const editor = { ...owner, principal: "user:editor" };
const viewer = { ...owner, principal: "user:viewer" };
const options = { now: 1000 };
const metadata = () => ({
  owner: owner.principal,
  acl: {
    revision: 2,
    members: {
      [editor.principal]: { role: "editor", generation: 1 },
      [viewer.principal]: { role: "viewer", generation: 1 },
    },
  },
});
const update = (doc, identity, principal, role, revision = doc.acl?.revision ?? 0) =>
  proposeAccessUpdate(doc, identity, { principal, role, expected_revision: revision }, options);

function status(value) {
  return (error) => error.status === value;
}

test("legacy Pages are owner-only and capabilities combine role with credential ceiling", () => {
  assert.deepEqual(pageAccess({ owner: owner.principal }, owner, options), {
    role: "owner",
    revision: 0,
    generation: 0,
    canRead: true,
    canWrite: true,
    canComment: true,
    canManageAccess: true,
    canDelete: true,
  });
  assert.equal(pageAccess({ owner: owner.principal }, editor, options).canRead, false);
  const doc = metadata();
  for (const credential of [owner, editor, viewer]) {
    const writable = pageAccess(doc, credential, options);
    assert.equal(writable.canWrite, credential !== viewer);
    assert.equal(writable.canComment, writable.canWrite);
    assert.equal(writable.canManageAccess, credential === owner);
    assert.equal(writable.canDelete, credential === owner);
    const readonly = pageAccess(doc, { ...credential, canWrite: false }, options);
    assert.equal(readonly.canRead, true);
    assert.equal(readonly.canWrite, false);
    assert.equal(readonly.canComment, false);
    assert.equal(readonly.canManageAccess, false);
    assert.equal(readonly.canDelete, false);
  }
});

test("deleted Pages, expired credentials, missing members and inherited member rows grant no access", () => {
  const doc = metadata();
  assert.equal(pageAccess({ ...doc, deleted: true }, owner, options).role, "none");
  assert.equal(pageAccess(doc, { ...owner, expiresAt: 1000 }, options).canRead, false);
  assert.equal(pageAccess(doc, { ...owner, expiresAt: undefined }, options).canRead, false);
  assert.equal(pageAccess(doc, undefined, options).canRead, false);
  assert.equal(pageAccess(doc, { ...owner, principal: "user:unknown" }, options).canRead, false);
  const inherited = { ...doc, acl: { revision: 0, members: Object.create(doc.acl.members) } };
  assert.equal(pageAccess(inherited, editor, options).canRead, false);
  for (const row of [
    { role: "owner", generation: 1 },
    { role: "editor", generation: 0 },
    { role: "editor", generation: "1" },
  ]) {
    doc.acl.members[editor.principal] = row;
    assert.equal(pageAccess(doc, editor, options).canRead, false);
  }
});

test("owner-only proposals preserve input, display metadata and invites", () => {
  const doc = metadata();
  doc.acl.invites = { invitation: { email: "person@example.org" } };
  doc.acl.members[editor.principal].displayName = "Collaborator";
  doc.acl.members[editor.principal].email = "person@example.org";
  const before = structuredClone(doc);
  const result = update(doc, owner, editor.principal, "viewer");
  assert.deepEqual(doc, before);
  assert.equal(result.acl.revision, 3);
  assert.deepEqual(result.acl.invites, before.acl.invites);
  assert.deepEqual(result.acl.members[editor.principal], {
    role: "viewer",
    generation: 2,
    displayName: "Collaborator",
    email: "person@example.org",
    changedAtRevision: 3,
  });
  for (const identity of [
    editor,
    viewer,
    { ...owner, canWrite: false },
    { ...owner, expiresAt: 1000 },
  ])
    assert.throws(() => update(doc, identity, editor.principal, "viewer"), status(403));
  assert.throws(() => update(doc, owner, owner.principal, "viewer"), status(400));
});

test("role changes, removal and regrant advance generation; no-op and unrelated grants do not", () => {
  let doc = metadata();
  for (const [role, generation] of [
    ["viewer", 2],
    [null, 3],
    ["editor", 4],
  ]) {
    const result = update(doc, owner, editor.principal, role);
    doc = { ...doc, acl: result.acl };
    assert.equal(pageGrant(doc, editor.principal).generation, generation);
    assert.equal(pageGrant(doc, editor.principal).role, role ?? "none");
  }
  const revision = doc.acl.revision;
  const unchanged = update(doc, owner, editor.principal, "editor");
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.acl.revision, revision);
  const other = update(doc, owner, "user:another", "editor");
  assert.equal(other.acl.members[editor.principal].generation, 4);
  assert.equal(other.acl.members["user:another"].generation, 1);
  const removal = update(doc, owner, "user:absent", null);
  assert.equal(removal.changed, true);
  assert.equal(removal.acl.members["user:absent"].role, "none");
  assert.equal(removal.acl.members["user:absent"].changedAtRevision, revision + 1);
});

test("revision guards and explicit target validation reject stale or malformed mutations", () => {
  const doc = metadata();
  assert.throws(() => update(doc, owner, editor.principal, "viewer", 1), status(409));
  for (const revision of [undefined, -1, "2", 2.5])
    assert.throws(
      () =>
        proposeAccessUpdate(
          doc,
          owner,
          { principal: editor.principal, role: "editor", expected_revision: revision },
          options,
        ),
      status(400),
    );
  for (const principal of [
    null,
    "",
    "no_namespace",
    " user:x",
    "user:x y",
    "user:x\n",
    "user:" + "x".repeat(513),
  ])
    assert.throws(() => update(doc, owner, principal, "editor"), status(400));
  for (const role of ["owner", "reviewer", "public", "none", undefined])
    assert.throws(() => update(doc, owner, editor.principal, role), status(400));
});

test("100 active member limit permits revocation and retains generations for regrant", () => {
  const doc = {
    owner: owner.principal,
    acl: {
      revision: 100,
      members: Object.fromEntries(
        Array.from({ length: 100 }, (_, i) => [`user:${i}`, { role: "viewer", generation: 1 }]),
      ),
    },
  };
  assert.throws(() => update(doc, owner, "user:new", "viewer"), status(409));
  assert.equal(update(doc, owner, "user:0", "editor").acl.members["user:0"].generation, 2);
  doc.acl = update(doc, owner, "user:0", null).acl;
  assert.equal(doc.acl.members["user:0"].generation, 2);
  doc.acl = update(doc, owner, "user:new", "viewer").acl;
  assert.throws(() => update(doc, owner, "user:0", "viewer"), status(409));
});
