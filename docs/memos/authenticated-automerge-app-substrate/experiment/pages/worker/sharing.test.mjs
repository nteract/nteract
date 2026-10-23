import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claimInvitation,
  invitationMatches,
  proposeSharingMutation,
  sharingProjection,
} from "./sharing.mjs";
import { createServerAppSession } from "@cloud/app-session.ts";
const now = Date.now();
const owner = {
  principal: "anaconda:owner",
  namespace: "anaconda",
  displayName: "Owner",
  canWrite: true,
  expiresAt: now + 60000,
};
const editor = {
  ...owner,
  principal: "anaconda:editor",
  displayName: "Editor",
  verifiedEmail: "editor@example.com",
};
const base = { owner: owner.principal, ownerName: "Owner", deleted: false };
const inviteArgs = {
  action: "invite",
  email: " Editor@Example.com ",
  role: "editor",
  expected_revision: 0,
  idempotency_key: "invite-test-1",
};

test("invitation creates no principal grant and requires exact owner revision and scope", async () => {
  const result = await proposeSharingMutation(base, owner, inviteArgs, now);
  assert.equal(result.metadata.acl.revision, 1);
  assert.equal(Object.keys(result.metadata.acl.members).length, 0);
  assert.equal(Object.values(result.metadata.acl.invites)[0].email, "editor@example.com");
  await assert.rejects(proposeSharingMutation(base, editor, inviteArgs, now), /Only the owner/);
  await assert.rejects(
    proposeSharingMutation(base, { ...owner, canWrite: false }, inviteArgs, now),
    /Only the owner/,
  );
  await assert.rejects(
    proposeSharingMutation(
      result.metadata,
      owner,
      { ...inviteArgs, idempotency_key: "invite-test-2" },
      now,
    ),
    /Sharing changed/,
  );
  assert.equal(
    (await proposeSharingMutation(result.metadata, owner, inviteArgs, now)).replay,
    true,
  );
  await assert.rejects(
    proposeSharingMutation(result.metadata, owner, { ...inviteArgs, role: "viewer" }, now),
    /different request/,
  );
});
test("invitation requires verified email, trusted namespace, live expiry and becomes principal ACL", async () => {
  const { metadata } = await proposeSharingMutation(base, owner, inviteArgs, now);
  assert.equal(
    await claimInvitation(metadata, { ...editor, verifiedEmail: undefined }, {}, now),
    null,
  );
  assert.equal(await claimInvitation(metadata, { ...editor, namespace: "evil" }, {}, now), null);
  assert.equal(await claimInvitation(metadata, editor, {}, now + 8 * 24 * 3600 * 1000), null);
  const claimed = await claimInvitation(metadata, editor, {}, now);
  assert.equal(claimed.acl.members[editor.principal].role, "editor");
  assert.equal(claimed.acl.members[editor.principal].generation, 1);
  assert.equal(Object.keys(claimed.acl.invites).length, 0);
  assert.equal(sharingProjection(claimed, editor).access.canWrite, true);
  assert.equal(sharingProjection(claimed, { ...editor, canWrite: false }).access.canWrite, false);
  assert.equal(sharingProjection(claimed, editor).members, undefined);
  const revoked = await proposeSharingMutation(
    claimed,
    owner,
    {
      action: "set_role",
      principal: editor.principal,
      role: null,
      expected_revision: 2,
      idempotency_key: "revoke-test-1",
    },
    now,
  );
  assert.throws(() => sharingProjection(revoked.metadata, editor), /no longer have access/);
  assert.equal(await claimInvitation(revoked.metadata, editor, {}, now), null);
});
test("OIDC invitation proof is bound to the signed-in account, exact email and freshness", async () => {
  const env = { NOTEBOOK_CLOUD_APP_SESSION_SECRET: "a".repeat(64) };
  const verified = {
    principal: editor.principal,
    metadata: {
      provider: "oidc",
      principalNamespace: "anaconda",
      displayName: "Editor",
      email: "editor@example.com",
      emailVerified: true,
    },
  };
  const time = Math.floor(now / 1000);
  const session = await createServerAppSession(env, verified, "test-session", time + 300, time);
  const identity = {
    ...editor,
    verifiedEmail: undefined,
    emailProof: { ...session, provider: "app-session" },
  };
  const invite = {
    namespace: "anaconda",
    email: "editor@example.com",
    expiresAt: now + 7 * 24 * 3600 * 1000,
  };
  assert.equal(await invitationMatches(identity, invite, env, now), true);
  assert.equal(
    await invitationMatches({ ...identity, principal: "anaconda:impostor" }, invite, env, now),
    false,
  );
  assert.equal(
    await invitationMatches(identity, { ...invite, email: "other@example.com" }, env, now),
    false,
  );
  assert.equal(await invitationMatches(identity, invite, env, now + 7 * 3600 * 1000), false);
});

test("a stale invite cannot override a newer explicit viewer grant or removal", async () => {
  const invited = await proposeSharingMutation(base, owner, inviteArgs, now);
  for (const role of ["viewer", null]) {
    const explicit = await proposeSharingMutation(
      invited.metadata,
      owner,
      {
        action: "set_role",
        principal: editor.principal,
        role,
        expected_revision: 1,
        idempotency_key: "override-test",
      },
      now,
    );
    assert.equal(await claimInvitation(explicit.metadata, editor, {}, now), null);
    const reinvited = await proposeSharingMutation(
      explicit.metadata,
      owner,
      { ...inviteArgs, expected_revision: 2, idempotency_key: "reinvite-test" },
      now,
    );
    assert.equal(
      (await claimInvitation(reinvited.metadata, editor, {}, now)).acl.members[editor.principal]
        .role,
      "editor",
    );
  }
});

test("a pending host commit exposes only the intersection of old and new grants", async () => {
  const { restrictAccessDuringCommit, pageAccess } = await import("./access.mjs");
  const invited = await proposeSharingMutation(base, owner, inviteArgs, now);
  const granted = await claimInvitation(invited.metadata, editor, {}, now);
  assert.equal(
    pageAccess(restrictAccessDuringCommit(invited.metadata, granted), editor).canRead,
    false,
  );
  const removed = await proposeSharingMutation(
    granted,
    owner,
    {
      action: "set_role",
      principal: editor.principal,
      role: null,
      expected_revision: 2,
      idempotency_key: "commit-removal",
    },
    now,
  );
  assert.equal(
    pageAccess(restrictAccessDuringCommit(granted, removed.metadata), editor).canRead,
    false,
  );
  assert.equal(
    pageAccess(restrictAccessDuringCommit(granted, removed.metadata), owner).canManageAccess,
    true,
  );
});

test("a full sharing receipt window cannot block revocation or replay an evicted request", async () => {
  const invited = await proposeSharingMutation(base, owner, inviteArgs, now);
  let metadata = await claimInvitation(invited.metadata, editor, {}, now);
  const first = {
    action: "set_role",
    principal: editor.principal,
    role: "viewer",
    expected_revision: metadata.acl.revision,
    idempotency_key: "window-first",
  };
  metadata = (await proposeSharingMutation(metadata, owner, first, now)).metadata;
  for (let i = 0; i < 256; i++)
    metadata = (
      await proposeSharingMutation(
        metadata,
        owner,
        {
          action: "set_role",
          principal: editor.principal,
          role: i % 2 ? "viewer" : "editor",
          expected_revision: metadata.acl.revision,
          idempotency_key: `window-change-${i}`,
        },
        now,
      )
    ).metadata;
  const removal = {
    action: "set_role",
    principal: editor.principal,
    role: null,
    expected_revision: metadata.acl.revision,
    idempotency_key: "window-remove",
  };
  const removed = await proposeSharingMutation(metadata, owner, removal, now);
  assert.equal(removed.metadata.acl.members[editor.principal].role, "none");
  assert.equal(Object.keys(removed.metadata.acl.receipts).length, 256);
  assert.equal((await proposeSharingMutation(removed.metadata, owner, removal, now)).replay, true);
  await assert.rejects(
    proposeSharingMutation(removed.metadata, owner, first, now),
    /Sharing changed/,
  );
});

test("expired invitations do not consume the live invitation allowance", async () => {
  const metadata = {
    ...base,
    acl: {
      revision: 1,
      members: {},
      invites: Object.fromEntries(
        Array.from({ length: 100 }, (_, i) => [
          `${i}`,
          {
            id: `${i}`,
            email: `old${i}@example.com`,
            namespace: "anaconda",
            role: "viewer",
            expiresAt: now - 1,
          },
        ]),
      ),
    },
  };
  const result = await proposeSharingMutation(
    metadata,
    owner,
    { ...inviteArgs, expected_revision: 1 },
    now,
  );
  assert.equal(Object.keys(result.metadata.acl.invites).length, 1);
  assert.equal(Object.values(result.metadata.acl.invites)[0].email, "editor@example.com");
});

test("receipt retention follows revisions even with numeric idempotency keys", async () => {
  const invited = await proposeSharingMutation(base, owner, inviteArgs, now);
  let metadata = await claimInvitation(invited.metadata, editor, {}, now);
  metadata.acl.receipts = Object.fromEntries(
    Array.from({ length: 256 }, (_, i) => [
      `old-receipt-${i}`,
      { fingerprint: "old", receipt: { revision: i } },
    ]),
  );
  metadata.acl.revision = 300;
  metadata.acl.invites.expired = {
    id: "expired",
    email: "stale@example.com",
    role: "viewer",
    namespace: "anaconda",
    expiresAt: now - 1,
  };
  const action = { ...inviteArgs, expected_revision: 300, idempotency_key: "12345678" };
  const result = await proposeSharingMutation(metadata, owner, action, now);
  assert.equal(result.receipt.revision, 301, "even unchanged invite-to-member advances revision");
  assert.equal(result.metadata.acl.members[editor.principal].changedAtRevision, 301);
  assert.equal(result.metadata.acl.receipts["old-receipt-0"], undefined);
  assert.equal(result.metadata.acl.invites.expired, undefined);
  assert.equal((await proposeSharingMutation(result.metadata, owner, action, now)).replay, true);
});
