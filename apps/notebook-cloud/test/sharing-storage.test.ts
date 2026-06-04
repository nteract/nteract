import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  D1Value,
  Env,
} from "../src/cloudflare-types.ts";
import {
  createPendingNotebookInvite,
  canonicalAccountPrincipalForProfile,
  getPrincipalProfiles,
  resolveNotebookInvitesForLogin,
  upsertPrincipalProfile,
  type PendingNotebookInviteRow,
  type PrincipalProfileRow,
} from "../src/sharing-storage.ts";
import type { NotebookAclRow } from "../src/storage.ts";
import type { PrincipalAccountLinkRow } from "../src/storage.ts";
import type { AuthenticatedLoginProfile } from "../src/sharing.ts";

describe("hosted sharing storage", () => {
  it("keeps principal provider identity stable while refreshing profile metadata", async () => {
    const env = fakeEnv();
    await upsertPrincipalProfile(env, {
      principal: "user:oidc:oidc-sub-1",
      provider: "oidc",
      providerSubject: "oidc-sub-1",
      email: "alice@example.com",
      emailVerified: true,
      displayName: "Alice Example",
      timestamp: "2026-05-24T12:00:00.000Z",
    });

    const profile = await upsertPrincipalProfile(env, {
      principal: "user:oidc:oidc-sub-1",
      provider: "github",
      providerSubject: "github-sub-1",
      email: "alice-updated@example.com",
      emailVerified: true,
      displayName: "Alice Updated",
      timestamp: "2026-05-24T12:05:00.000Z",
    });

    assert.equal(profile?.provider, "oidc");
    assert.equal(profile?.provider_subject, "oidc-sub-1");
    assert.equal(profile?.email_normalized, "alice-updated@example.com");
    assert.equal(profile?.display_name, "Alice Updated");
    assert.equal(profile?.first_seen_at, "2026-05-24T12:00:00.000Z");
    assert.equal(profile?.last_seen_at, "2026-05-24T12:05:00.000Z");
  });

  it("loads multiple principal profiles in one batch", async () => {
    const env = fakeEnv();
    await upsertPrincipalProfile(env, {
      principal: "user:oidc:oidc-sub-1",
      provider: "oidc",
      providerSubject: "oidc-sub-1",
      email: "alice@example.com",
      emailVerified: true,
      displayName: "Alice Example",
      timestamp: "2026-05-24T12:00:00.000Z",
    });
    await upsertPrincipalProfile(env, {
      principal: "user:oidc:oidc-sub-2",
      provider: "oidc",
      providerSubject: "oidc-sub-2",
      email: "bob@example.com",
      emailVerified: true,
      displayName: "Bob Example",
      timestamp: "2026-05-24T12:01:00.000Z",
    });

    const profiles = await getPrincipalProfiles(env, [
      "user:oidc:oidc-sub-1",
      "user:oidc:oidc-sub-1",
      "missing",
      "user:oidc:oidc-sub-2",
    ]);

    assert.deepEqual(profiles.map((profile) => profile.principal).sort(), [
      "user:oidc:oidc-sub-1",
      "user:oidc:oidc-sub-2",
    ]);
  });

  it("loads principal profiles in chunks below D1 bind limits", async () => {
    const env = fakeEnv();
    const principals = Array.from({ length: 125 }, (_, index) => `user:oidc:oidc-sub-${index}`);
    for (const [index, principal] of principals.entries()) {
      await upsertPrincipalProfile(env, {
        principal,
        provider: "oidc",
        providerSubject: `oidc-sub-${index}`,
        email: `user-${index}@example.com`,
        emailVerified: true,
        displayName: `User ${index}`,
        timestamp: "2026-05-24T12:00:00.000Z",
      });
    }

    const profiles = await getPrincipalProfiles(env, principals);

    assert.equal(profiles.length, 125);
    assert.equal(env.DB.maxPrincipalProfileLookupBindCount, 50);
  });

  it("backfills provider subject when a profile was first seen without one", async () => {
    const env = fakeEnv();
    await resolveNotebookInvitesForLogin(env, oidcLogin(), "2026-05-24T12:00:00.000Z");

    const profile = await upsertPrincipalProfile(env, {
      principal: "user:oidc:oidc-sub-1",
      provider: "oidc",
      providerSubject: "oidc-sub-1",
      email: "alice@example.com",
      emailVerified: true,
      displayName: "Alice Example",
      timestamp: "2026-05-24T12:05:00.000Z",
    });

    assert.equal(profile?.provider, "oidc");
    assert.equal(profile?.provider_subject, "oidc-sub-1");
    assert.equal(profile?.first_seen_at, "2026-05-24T12:00:00.000Z");
    assert.equal(profile?.last_seen_at, "2026-05-24T12:05:00.000Z");
  });

  it("resolves verified email invites into principal ACL rows", async () => {
    const env = fakeEnv();
    await createPendingNotebookInvite(env, {
      id: "invite-1",
      notebookId: "notebook-1",
      email: " Alice@Example.COM ",
      providerHint: " OIDC ",
      scope: "editor",
      actorLabel: "user:oidc:owner/desktop:owner",
      expiresAt: "2026-06-24T11:00:00.000Z",
      timestamp: "2026-05-24T11:00:00.000Z",
    });

    const accountPrincipal = await oidcAccountPrincipal();
    const resolution = await resolveNotebookInvitesForLogin(
      env,
      oidcLogin(),
      "2026-05-24T12:00:00.000Z",
    );

    assert.deepEqual(
      resolution.acceptedInvites.map((invite) => invite.id),
      ["invite-1"],
    );
    assert.equal(
      env.DB.profiles.get("user:oidc:oidc-sub-1")?.email_normalized,
      "alice@example.com",
    );
    assert.equal(env.DB.invites.get("invite-1")?.status, "accepted");
    assert.equal(env.DB.invites.get("invite-1")?.accepted_by_principal, "user:oidc:oidc-sub-1");
    assert.deepEqual(env.DB.acl, [
      {
        notebook_id: "notebook-1",
        subject_kind: "principal",
        subject: accountPrincipal,
        scope: "editor",
        created_at: "2026-05-24T12:00:00.000Z",
        updated_at: "2026-05-24T12:00:00.000Z",
        created_by_actor_label: "system/invite-resolution",
      },
    ]);
    assert.doesNotMatch(env.DB.acl[0]?.subject ?? "", /alice@example.com/);
  });

  it("merges same-account OIDC and API-key ACL rows onto one canonical account subject", async () => {
    const env = fakeEnv();
    const apiKeyLogin = oidcLogin({
      principal: "user:anaconda:fdb3dc7d-c369-4a39-bf7d-e35b77a0bdd0",
      provider: "anaconda-api-key",
      principalNamespace: "user:anaconda",
      email: "rgbkrk@gmail.com",
      displayName: "Kyle Kelley",
    });
    const oidcBrowserLogin = oidcLogin({
      principal: "user:anaconda:fe0f6c3a-f7c7-4c04-9b8d-77e596da1375",
      provider: "oidc",
      principalNamespace: "user:anaconda",
      email: "rgbkrk@gmail.com",
      displayName: "Kyle Kelley",
    });
    const accountPrincipal = await canonicalAccountPrincipalForProfile(apiKeyLogin);
    assert.ok(accountPrincipal);
    env.DB.acl.push(
      aclRow({
        subject: apiKeyLogin.principal,
        scope: "owner",
        created_by_actor_label: `${apiKeyLogin.principal}/agent:runt-publish`,
      }),
      aclRow({
        subject: oidcBrowserLogin.principal,
        scope: "owner",
        created_by_actor_label: `${oidcBrowserLogin.principal}/browser:tab`,
      }),
    );

    await resolveNotebookInvitesForLogin(env, apiKeyLogin, "2026-05-24T12:00:00.000Z");
    await resolveNotebookInvitesForLogin(env, oidcBrowserLogin, "2026-05-24T12:01:00.000Z");

    assert.deepEqual(
      env.DB.acl.map((row) => [row.subject, row.scope]),
      [[accountPrincipal, "owner"]],
    );
    assert.equal(
      env.DB.accountLinks.get(apiKeyLogin.principal)?.canonical_principal,
      accountPrincipal,
    );
    assert.equal(
      env.DB.accountLinks.get(oidcBrowserLogin.principal)?.canonical_principal,
      accountPrincipal,
    );
    assert.equal(env.DB.profiles.get(accountPrincipal)?.display_name, "Kyle Kelley");
  });

  it("moves ACL rows from an old canonical account when a transport link changes", async () => {
    const env = fakeEnv();
    const oldLogin = oidcLogin({ email: "alice.old@example.com" });
    const newLogin = oidcLogin({ email: "alice.new@example.com" });
    const oldAccountPrincipal = await canonicalAccountPrincipalForProfile(oldLogin);
    const newAccountPrincipal = await canonicalAccountPrincipalForProfile(newLogin);
    assert.ok(oldAccountPrincipal);
    assert.ok(newAccountPrincipal);
    env.DB.accountLinks.set(
      oldLogin.principal,
      accountLinkRow({
        transport_principal: oldLogin.principal,
        canonical_principal: oldAccountPrincipal,
        email_normalized: "alice.old@example.com",
      }),
    );
    env.DB.acl.push(
      aclRow({
        subject: oldAccountPrincipal,
        scope: "editor",
      }),
    );

    await resolveNotebookInvitesForLogin(env, newLogin, "2026-05-24T12:02:00.000Z");

    assert.deepEqual(
      env.DB.acl.map((row) => [row.subject, row.scope, row.updated_at]),
      [[newAccountPrincipal, "editor", "2026-05-24T12:02:00.000Z"]],
    );
    assert.equal(
      env.DB.accountLinks.get(newLogin.principal)?.canonical_principal,
      newAccountPrincipal,
    );
  });

  it("copies ACL rows when an old canonical account is still linked elsewhere", async () => {
    const env = fakeEnv();
    const movingLogin = oidcLogin({ email: "moving.new@example.com" });
    const otherTransportPrincipal = "user:oidc:other-sub";
    const oldAccountPrincipal = await canonicalAccountPrincipalForProfile(
      oidcLogin({ email: "shared.old@example.com" }),
    );
    const newAccountPrincipal = await canonicalAccountPrincipalForProfile(movingLogin);
    assert.ok(oldAccountPrincipal);
    assert.ok(newAccountPrincipal);
    env.DB.accountLinks.set(
      movingLogin.principal,
      accountLinkRow({
        transport_principal: movingLogin.principal,
        canonical_principal: oldAccountPrincipal,
        email_normalized: "shared.old@example.com",
      }),
    );
    env.DB.accountLinks.set(
      otherTransportPrincipal,
      accountLinkRow({
        transport_principal: otherTransportPrincipal,
        canonical_principal: oldAccountPrincipal,
        email_normalized: "shared.old@example.com",
      }),
    );
    env.DB.acl.push(
      aclRow({
        subject: oldAccountPrincipal,
        scope: "editor",
      }),
    );

    await resolveNotebookInvitesForLogin(env, movingLogin, "2026-05-24T12:02:30.000Z");

    assert.deepEqual(
      env.DB.acl.map((row) => [row.subject, row.scope, row.updated_at]),
      [
        [oldAccountPrincipal, "editor", "2026-05-24T11:00:00.000Z"],
        [newAccountPrincipal, "editor", "2026-05-24T12:02:30.000Z"],
      ],
    );
    assert.equal(
      env.DB.accountLinks.get(movingLogin.principal)?.canonical_principal,
      newAccountPrincipal,
    );
    assert.equal(
      env.DB.accountLinks.get(otherTransportPrincipal)?.canonical_principal,
      oldAccountPrincipal,
    );
  });

  it("moves related profile ACL rows from an old canonical account before relinking", async () => {
    const env = fakeEnv();
    const currentLogin = oidcLogin({
      principal: "user:anaconda:current",
      provider: "oidc",
      principalNamespace: "user:anaconda",
      email: "shared@example.com",
    });
    const relatedLogin = oidcLogin({
      principal: "User:Anaconda:related:with-colon",
      provider: "anaconda-api-key",
      principalNamespace: "user:anaconda",
      email: "shared@example.com",
    });
    const relatedOldAccountPrincipal = await canonicalAccountPrincipalForProfile({
      ...relatedLogin,
      email: "related.old@example.com",
    });
    const sharedAccountPrincipal = await canonicalAccountPrincipalForProfile(currentLogin);
    assert.ok(relatedOldAccountPrincipal);
    assert.ok(sharedAccountPrincipal);
    env.DB.profiles.set(
      relatedLogin.principal,
      profileRow({
        principal: relatedLogin.principal,
        provider: relatedLogin.provider,
        email_normalized: "shared@example.com",
        email_verified: 1,
      }),
    );
    env.DB.accountLinks.set(
      relatedLogin.principal,
      accountLinkRow({
        transport_principal: relatedLogin.principal,
        canonical_principal: relatedOldAccountPrincipal,
        provider: "user:anaconda",
        email_normalized: "related.old@example.com",
      }),
    );
    env.DB.acl.push(
      aclRow({
        subject: relatedOldAccountPrincipal,
        scope: "owner",
      }),
    );

    await resolveNotebookInvitesForLogin(env, currentLogin, "2026-05-24T12:03:00.000Z");

    assert.deepEqual(
      env.DB.acl.map((row) => [row.subject, row.scope, row.updated_at]),
      [[sharedAccountPrincipal, "owner", "2026-05-24T12:03:00.000Z"]],
    );
    assert.equal(
      env.DB.accountLinks.get(relatedLogin.principal)?.canonical_principal,
      sharedAccountPrincipal,
    );
  });

  it("does not duplicate ACL rows when invite resolution reruns", async () => {
    const env = fakeEnv();
    await createPendingNotebookInvite(env, {
      id: "invite-1",
      notebookId: "notebook-1",
      email: "alice@example.com",
      providerHint: null,
      scope: "viewer",
      actorLabel: "user:oidc:owner/desktop:owner",
      timestamp: "2026-05-24T11:00:00.000Z",
    });

    await resolveNotebookInvitesForLogin(env, oidcLogin(), "2026-05-24T12:00:00.000Z");
    const second = await resolveNotebookInvitesForLogin(
      env,
      oidcLogin({ displayName: "Alice Updated" }),
      "2026-05-24T12:05:00.000Z",
    );

    assert.equal(second.aclGrants.length, 0);
    assert.equal(env.DB.acl.length, 1);
    assert.equal(env.DB.profiles.get("user:oidc:oidc-sub-1")?.display_name, "Alice Updated");
    assert.equal(
      env.DB.profiles.get("user:oidc:oidc-sub-1")?.first_seen_at,
      "2026-05-24T12:00:00.000Z",
    );
    assert.equal(
      env.DB.profiles.get("user:oidc:oidc-sub-1")?.last_seen_at,
      "2026-05-24T12:05:00.000Z",
    );
    assert.equal(second.profile.firstSeenAt, "2026-05-24T12:00:00.000Z");
    assert.equal(second.profile.lastSeenAt, "2026-05-24T12:05:00.000Z");
  });

  it("accepts multiple pending invites in one resolution batch", async () => {
    const env = fakeEnv();
    await createPendingNotebookInvite(env, {
      id: "invite-1",
      notebookId: "notebook-1",
      email: "alice@example.com",
      providerHint: "oidc",
      scope: "editor",
      actorLabel: "user:oidc:owner/desktop:owner",
      timestamp: "2026-05-24T11:00:00.000Z",
    });
    await createPendingNotebookInvite(env, {
      id: "invite-2",
      notebookId: "notebook-2",
      email: "alice@example.com",
      providerHint: null,
      scope: "viewer",
      actorLabel: "user:oidc:owner/desktop:owner",
      timestamp: "2026-05-24T11:01:00.000Z",
    });

    const resolution = await resolveNotebookInvitesForLogin(
      env,
      oidcLogin(),
      "2026-05-24T12:00:00.000Z",
    );

    assert.deepEqual(
      resolution.acceptedInvites.map((invite) => invite.id),
      ["invite-1", "invite-2"],
    );
    assert.deepEqual(
      resolution.aclGrants.map((grant) => [grant.notebookId, grant.scope]),
      [
        ["notebook-1", "editor"],
        ["notebook-2", "viewer"],
      ],
    );
    assert.equal(env.DB.invites.get("invite-1")?.status, "accepted");
    assert.equal(env.DB.invites.get("invite-2")?.status, "accepted");
    assert.deepEqual(
      env.DB.acl.map((row) => [row.notebook_id, row.scope]),
      [
        ["notebook-1", "editor"],
        ["notebook-2", "viewer"],
      ],
    );
  });

  it("reports only successful accepts from a partial multi-invite batch", async () => {
    const env = fakeEnv();
    await createPendingNotebookInvite(env, {
      id: "invite-stolen",
      notebookId: "notebook-1",
      email: "alice@example.com",
      providerHint: "oidc",
      scope: "editor",
      actorLabel: "user:oidc:owner/desktop:owner",
      timestamp: "2026-05-24T11:00:00.000Z",
    });
    await createPendingNotebookInvite(env, {
      id: "invite-kept",
      notebookId: "notebook-2",
      email: "alice@example.com",
      providerHint: "oidc",
      scope: "viewer",
      actorLabel: "user:oidc:owner/desktop:owner",
      timestamp: "2026-05-24T11:01:00.000Z",
    });
    env.DB.beforeInviteAccept = (inviteId) => {
      if (inviteId !== "invite-stolen") {
        return;
      }
      const invite = env.DB.invites.get(inviteId)!;
      invite.status = "accepted";
      invite.accepted_by_principal = "user:oidc:other";
      invite.accepted_at = "2026-05-24T11:59:00.000Z";
    };

    const resolution = await resolveNotebookInvitesForLogin(
      env,
      oidcLogin(),
      "2026-05-24T12:00:00.000Z",
    );

    assert.deepEqual(
      resolution.acceptedInvites.map((invite) => invite.id),
      ["invite-kept"],
    );
    assert.deepEqual(
      resolution.aclGrants.map((grant) => grant.inviteId),
      ["invite-kept"],
    );
    assert.deepEqual(
      env.DB.acl.map((row) => row.notebook_id),
      ["notebook-2"],
    );
  });

  it("skips stale invites whose notebook parent disappeared", async () => {
    const env = fakeEnv();
    await createPendingNotebookInvite(env, {
      id: "invite-stale",
      notebookId: "notebook-deleted",
      email: "alice@example.com",
      providerHint: "oidc",
      scope: "editor",
      actorLabel: "user:oidc:owner/desktop:owner",
      timestamp: "2026-05-24T11:00:00.000Z",
    });
    await createPendingNotebookInvite(env, {
      id: "invite-live",
      notebookId: "notebook-live",
      email: "alice@example.com",
      providerHint: "oidc",
      scope: "viewer",
      actorLabel: "user:oidc:owner/desktop:owner",
      timestamp: "2026-05-24T11:01:00.000Z",
    });
    env.DB.deletedNotebookIds.add("notebook-deleted");

    const resolution = await resolveNotebookInvitesForLogin(
      env,
      oidcLogin(),
      "2026-05-24T12:00:00.000Z",
    );

    assert.deepEqual(
      resolution.acceptedInvites.map((invite) => invite.id),
      ["invite-live"],
    );
    assert.equal(env.DB.invites.get("invite-stale")?.status, "pending");
    assert.equal(env.DB.invites.get("invite-live")?.status, "accepted");
    assert.deepEqual(
      env.DB.acl.map((row) => row.notebook_id),
      ["notebook-live"],
    );
  });

  it("returns an existing pending invite instead of creating a duplicate", async () => {
    const env = fakeEnv();
    const first = await createPendingNotebookInvite(env, {
      id: "invite-1",
      notebookId: "notebook-1",
      email: "alice@example.com",
      providerHint: "oidc",
      scope: "editor",
      actorLabel: "user:oidc:owner/desktop:owner",
      timestamp: "2026-05-24T11:00:00.000Z",
    });
    const second = await createPendingNotebookInvite(env, {
      id: "invite-2",
      notebookId: "notebook-1",
      email: " Alice@Example.com ",
      providerHint: " OIDC ",
      scope: "editor",
      actorLabel: "user:oidc:owner/desktop:owner",
      timestamp: "2026-05-24T11:05:00.000Z",
    });

    assert.equal(first?.id, "invite-1");
    assert.equal(second?.id, "invite-1");
    assert.equal(env.DB.invites.size, 1);
  });

  it("recovers when a concurrent duplicate pending invite wins the insert race", async () => {
    const env = fakeEnv();
    env.DB.beforeInviteInsert = ({ notebookId, emailNormalized, providerHint, scope }) => {
      env.DB.invites.set("invite-raced", {
        id: "invite-raced",
        notebook_id: notebookId,
        email_normalized: emailNormalized,
        provider_hint: providerHint,
        scope,
        status: "pending",
        invited_by_actor_label: "user:oidc:owner/desktop:owner",
        accepted_by_principal: null,
        token_hash: null,
        created_at: "2026-05-24T11:00:00.000Z",
        expires_at: null,
        accepted_at: null,
        revoked_at: null,
        revoked_by_actor_label: null,
      });
      env.DB.beforeInviteInsert = undefined;
    };

    const invite = await createPendingNotebookInvite(env, {
      id: "invite-loser",
      notebookId: "notebook-1",
      email: "alice@example.com",
      providerHint: "oidc",
      scope: "editor",
      actorLabel: "user:oidc:owner/desktop:owner",
      timestamp: "2026-05-24T11:01:00.000Z",
    });

    assert.equal(invite?.id, "invite-raced");
    assert.equal(env.DB.invites.size, 1);
  });

  it("stores a profile but skips malformed or unverified email invite lookup", async () => {
    const env = fakeEnv();
    await createPendingNotebookInvite(env, {
      id: "invite-1",
      notebookId: "notebook-1",
      email: "alice@example.com",
      providerHint: "oidc",
      scope: "editor",
      actorLabel: "user:oidc:owner/desktop:owner",
    });

    const malformed = await resolveNotebookInvitesForLogin(
      env,
      oidcLogin({ email: "noatsign" }),
      "2026-05-24T12:00:00.000Z",
    );
    const unverified = await resolveNotebookInvitesForLogin(
      env,
      oidcLogin({ emailVerified: false }),
      "2026-05-24T12:01:00.000Z",
    );

    assert.equal(malformed.aclGrants.length, 0);
    assert.equal(unverified.aclGrants.length, 0);
    assert.equal(env.DB.invites.get("invite-1")?.status, "pending");
    assert.equal(env.DB.profiles.get("user:oidc:oidc-sub-1")?.email_normalized, null);
    assert.equal(env.DB.profiles.get("user:oidc:oidc-sub-1")?.email_verified, 0);
  });

  it("honors provider hints while allowing explicit provider-wildcard invites", async () => {
    const env = fakeEnv();
    await createPendingNotebookInvite(env, {
      id: "invite-wildcard",
      notebookId: "notebook-1",
      email: "alice@example.com",
      providerHint: null,
      scope: "viewer",
      actorLabel: "user:oidc:owner/desktop:owner",
    });
    await createPendingNotebookInvite(env, {
      id: "invite-github",
      notebookId: "notebook-1",
      email: "alice@example.com",
      providerHint: "github",
      scope: "editor",
      actorLabel: "user:oidc:owner/desktop:owner",
    });

    const resolution = await resolveNotebookInvitesForLogin(
      env,
      oidcLogin({ provider: "oidc" }),
      "2026-05-24T12:00:00.000Z",
    );

    assert.deepEqual(
      resolution.acceptedInvites.map((invite) => invite.id),
      ["invite-wildcard"],
    );
    assert.equal(env.DB.invites.get("invite-github")?.status, "pending");
  });

  it("does not return or accept expired pending invites from storage resolution", async () => {
    const env = fakeEnv();
    await createPendingNotebookInvite(env, {
      id: "invite-expired",
      notebookId: "notebook-1",
      email: "alice@example.com",
      providerHint: "oidc",
      scope: "editor",
      actorLabel: "user:oidc:owner/desktop:owner",
      expiresAt: "2026-05-24T11:59:59.000Z",
      timestamp: "2026-05-24T11:00:00.000Z",
    });

    const resolution = await resolveNotebookInvitesForLogin(
      env,
      oidcLogin(),
      "2026-05-24T12:00:00.000Z",
    );

    assert.equal(resolution.acceptedInvites.length, 0);
    assert.equal(resolution.aclGrants.length, 0);
    assert.equal(env.DB.acl.length, 0);
    assert.equal(env.DB.invites.get("invite-expired")?.status, "pending");
  });

  it("expires storage invites with numeric time comparisons instead of string ordering", async () => {
    const env = fakeEnv();
    await createPendingNotebookInvite(env, {
      id: "invite-expired-no-fraction",
      notebookId: "notebook-1",
      email: "alice@example.com",
      providerHint: "oidc",
      scope: "editor",
      actorLabel: "user:oidc:owner/desktop:owner",
      expiresAt: "2026-05-24T00:00:00Z",
      timestamp: "2026-05-23T23:00:00.000Z",
    });

    const resolution = await resolveNotebookInvitesForLogin(
      env,
      oidcLogin(),
      "2026-05-24T00:00:00.000Z",
    );

    assert.equal(resolution.acceptedInvites.length, 0);
    assert.equal(resolution.aclGrants.length, 0);
    assert.equal(env.DB.acl.length, 0);
    assert.equal(env.DB.invites.get("invite-expired-no-fraction")?.status, "pending");
  });

  it("does not re-accept revoked invites from storage resolution", async () => {
    const env = fakeEnv();
    await createPendingNotebookInvite(env, {
      id: "invite-revoked",
      notebookId: "notebook-1",
      email: "alice@example.com",
      providerHint: "oidc",
      scope: "editor",
      actorLabel: "user:oidc:owner/desktop:owner",
      timestamp: "2026-05-24T11:00:00.000Z",
    });
    env.DB.invites.get("invite-revoked")!.status = "revoked";
    env.DB.invites.get("invite-revoked")!.revoked_at = "2026-05-24T11:30:00.000Z";

    const resolution = await resolveNotebookInvitesForLogin(
      env,
      oidcLogin(),
      "2026-05-24T12:00:00.000Z",
    );

    assert.equal(resolution.acceptedInvites.length, 0);
    assert.equal(resolution.aclGrants.length, 0);
    assert.equal(env.DB.acl.length, 0);
    assert.equal(env.DB.invites.get("invite-revoked")?.status, "revoked");
  });

  it("reports only invites whose row actually transitioned to accepted", async () => {
    const env = fakeEnv();
    await createPendingNotebookInvite(env, {
      id: "invite-raced",
      notebookId: "notebook-1",
      email: "alice@example.com",
      providerHint: "oidc",
      scope: "editor",
      actorLabel: "user:oidc:owner/desktop:owner",
    });
    env.DB.beforeInviteAccept = (inviteId) => {
      env.DB.invites.get(inviteId)!.status = "accepted";
      env.DB.beforeInviteAccept = undefined;
    };

    const resolution = await resolveNotebookInvitesForLogin(
      env,
      oidcLogin(),
      "2026-05-24T12:00:00.000Z",
    );

    assert.equal(resolution.acceptedInvites.length, 0);
    assert.equal(resolution.aclGrants.length, 0);
  });

  it("rejects invalid pending invite inputs before they become ACL material", async () => {
    const env = fakeEnv();
    await assert.rejects(
      () =>
        createPendingNotebookInvite(env, {
          notebookId: "notebook-1",
          email: "not an email",
          scope: "viewer",
          actorLabel: "user:oidc:owner/desktop:owner",
        }),
      /invite email is invalid/,
    );
    await assert.rejects(
      () =>
        createPendingNotebookInvite(env, {
          notebookId: "notebook-1",
          email: "alice@example.com",
          scope: "owner" as never,
          actorLabel: "user:oidc:owner/desktop:owner",
        }),
      /invite scope must be viewer or editor/,
    );
    await assert.rejects(
      () =>
        createPendingNotebookInvite(env, {
          notebookId: "notebook-1",
          email: "alice@example.com",
          scope: "editor",
          actorLabel: "user:oidc:owner/desktop:owner",
          expiresAt: "not a date",
        }),
      /invite expiry is invalid/,
    );
  });
});

function fakeEnv(): Env & { DB: FakeD1 } {
  return { DB: new FakeD1() } as Env & { DB: FakeD1 };
}

function oidcLogin(overrides: Partial<AuthenticatedLoginProfile> = {}): AuthenticatedLoginProfile {
  return {
    principal: "user:oidc:oidc-sub-1",
    provider: "oidc",
    email: "alice@example.com",
    emailVerified: true,
    displayName: "Alice Example",
    ...overrides,
  };
}

async function oidcAccountPrincipal(
  overrides: Partial<AuthenticatedLoginProfile> = {},
): Promise<string> {
  const principal = await canonicalAccountPrincipalForProfile(oidcLogin(overrides));
  assert.ok(principal);
  return principal;
}

function aclRow(overrides: Partial<NotebookAclRow> = {}): NotebookAclRow {
  return {
    notebook_id: "notebook-1",
    subject_kind: "principal",
    subject: "user:oidc:oidc-sub-1",
    scope: "viewer",
    created_at: "2026-05-24T11:00:00.000Z",
    updated_at: "2026-05-24T11:00:00.000Z",
    created_by_actor_label: "system/test",
    ...overrides,
  };
}

function accountLinkRow(overrides: Partial<PrincipalAccountLinkRow> = {}): PrincipalAccountLinkRow {
  return {
    transport_principal: "user:oidc:oidc-sub-1",
    canonical_principal: "account:oidc:email:test",
    provider: "oidc",
    email_normalized: "alice@example.com",
    first_seen_at: "2026-05-24T11:00:00.000Z",
    last_seen_at: "2026-05-24T11:00:00.000Z",
    ...overrides,
  };
}

function profileRow(overrides: Partial<PrincipalProfileRow> = {}): PrincipalProfileRow {
  return {
    principal: "user:oidc:oidc-sub-1",
    provider: "oidc",
    provider_subject: null,
    email_normalized: "alice@example.com",
    email_verified: 1,
    display_name: "Alice Example",
    avatar_url: null,
    first_seen_at: "2026-05-24T11:00:00.000Z",
    last_seen_at: "2026-05-24T11:00:00.000Z",
    raw_claims_json: null,
    ...overrides,
  };
}

class FakeD1 implements D1Database {
  readonly profiles = new Map<string, PrincipalProfileRow>();
  readonly accountLinks = new Map<string, PrincipalAccountLinkRow>();
  readonly invites = new Map<string, PendingNotebookInviteRow>();
  readonly acl: NotebookAclRow[] = [];
  readonly deletedNotebookIds = new Set<string>();
  maxPrincipalProfileLookupBindCount = 0;
  beforeInviteInsert?: (input: {
    notebookId: string;
    emailNormalized: string;
    providerHint: string | null;
    scope: PendingNotebookInviteRow["scope"];
  }) => void;
  beforeInviteAccept?: (inviteId: string) => void;

  prepare(query: string): D1PreparedStatement {
    return new FakeD1Statement(this, query);
  }

  async exec(): Promise<D1Result> {
    return okResult();
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    // This test fake intentionally does not model D1's transaction rollback.
    // The sharing-storage tests only assert successful guarded batches.
    const results: D1Result<T>[] = [];
    for (const statement of statements) {
      results.push(await statement.run<T>());
    }
    return results;
  }
}

class FakeD1Statement implements D1PreparedStatement {
  private values: D1Value[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly query: string,
  ) {}

  bind(...values: D1Value[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.query.includes("FROM principal_account_links")) {
      if (this.query.includes("canonical_principal = ?")) {
        const [canonicalPrincipal, exceptTransportPrincipal] = this.values as [string, string];
        return (
          ([...this.db.accountLinks.values()].find(
            (link) =>
              link.canonical_principal === canonicalPrincipal &&
              link.transport_principal !== exceptTransportPrincipal,
          ) as T | undefined) ?? null
        );
      }
      return (this.db.accountLinks.get(this.values[0] as string) as T | undefined) ?? null;
    }
    if (this.query.includes("FROM principal_profiles")) {
      return (this.db.profiles.get(this.values[0] as string) as T | undefined) ?? null;
    }
    if (this.query.includes("FROM notebook_invites")) {
      if (this.query.includes("WHERE notebook_id = ?")) {
        const [notebookId, email, scope, providerHint] = this.values as [
          string,
          string,
          PendingNotebookInviteRow["scope"],
          string | null,
          string | null,
        ];
        return (
          ([...this.db.invites.values()].find(
            (invite) =>
              invite.notebook_id === notebookId &&
              invite.email_normalized === email &&
              invite.scope === scope &&
              invite.status === "pending" &&
              invite.provider_hint === providerHint,
          ) as T | undefined) ?? null
        );
      }
      return (this.db.invites.get(this.values[0] as string) as T | undefined) ?? null;
    }
    return null;
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    if (this.query.includes("INSERT INTO principal_profiles")) {
      const [
        principal,
        provider,
        providerSubject,
        emailNormalized,
        emailVerified,
        displayName,
        avatarUrl,
        firstSeenAt,
        lastSeenAt,
        rawClaimsJson,
      ] = this.values as [
        string,
        string,
        string | null,
        string | null,
        number,
        string | null,
        string | null,
        string,
        string,
        string | null,
      ];
      const existing = this.db.profiles.get(principal);
      this.db.profiles.set(principal, {
        principal,
        provider: existing?.provider ?? provider,
        provider_subject: existing?.provider_subject ?? providerSubject,
        email_normalized: emailNormalized,
        email_verified: emailVerified,
        display_name: displayName,
        avatar_url: avatarUrl,
        first_seen_at: existing?.first_seen_at ?? firstSeenAt,
        last_seen_at: lastSeenAt,
        raw_claims_json: rawClaimsJson,
      });
    } else if (this.query.includes("INSERT INTO principal_account_links")) {
      const [
        transportPrincipal,
        canonicalPrincipal,
        provider,
        emailNormalized,
        firstSeenAt,
        lastSeenAt,
      ] = this.values as [string, string, string, string | null, string, string];
      const existing = this.db.accountLinks.get(transportPrincipal);
      this.db.accountLinks.set(transportPrincipal, {
        transport_principal: transportPrincipal,
        canonical_principal: canonicalPrincipal,
        provider,
        email_normalized: emailNormalized,
        first_seen_at: existing?.first_seen_at ?? firstSeenAt,
        last_seen_at: lastSeenAt,
      });
    } else if (
      this.query.includes("INSERT INTO notebook_acl") &&
      this.query.includes("FROM notebook_acl")
    ) {
      const [canonicalPrincipal, updatedAt, transportPrincipal] = this.values as [
        string,
        string,
        string,
      ];
      const rows = this.db.acl.filter(
        (row) => row.subject_kind === "principal" && row.subject === transportPrincipal,
      );
      for (const row of rows) {
        this.insertAclIfMissing({
          ...row,
          subject: canonicalPrincipal,
          updated_at: updatedAt,
        });
      }
    } else if (
      this.query.includes("DELETE FROM notebook_acl") &&
      this.query.includes("subject_kind = 'principal'")
    ) {
      const [transportPrincipal, canonicalPrincipal] = this.values as [string, string];
      const retained = this.db.acl.filter(
        (row) =>
          !(
            row.subject_kind === "principal" &&
            row.subject === transportPrincipal &&
            this.db.acl.some(
              (target) =>
                target.notebook_id === row.notebook_id &&
                target.subject_kind === "principal" &&
                target.subject === canonicalPrincipal &&
                target.scope === row.scope,
            )
          ),
      );
      this.db.acl.splice(0, this.db.acl.length, ...retained);
    } else if (this.query.includes("INSERT INTO notebook_invites")) {
      const [
        id,
        notebookId,
        emailNormalized,
        providerHint,
        scope,
        actorLabel,
        tokenHash,
        createdAt,
        expiresAt,
      ] = this.values as [
        string,
        string,
        string,
        string | null,
        PendingNotebookInviteRow["scope"],
        string,
        string | null,
        string,
        string | null,
      ];
      this.db.beforeInviteInsert?.({
        notebookId,
        emailNormalized,
        providerHint,
        scope,
      });
      const duplicate = [...this.db.invites.values()].find(
        (invite) =>
          invite.notebook_id === notebookId &&
          invite.email_normalized === emailNormalized &&
          invite.provider_hint === providerHint &&
          invite.scope === scope &&
          invite.status === "pending",
      );
      if (duplicate) {
        throw new Error("D1_ERROR: UNIQUE constraint failed: notebook_invites pending invite");
      }
      this.db.invites.set(id, {
        id,
        notebook_id: notebookId,
        email_normalized: emailNormalized,
        provider_hint: providerHint,
        scope,
        status: "pending",
        invited_by_actor_label: actorLabel,
        accepted_by_principal: null,
        token_hash: tokenHash,
        created_at: createdAt,
        expires_at: expiresAt,
        accepted_at: null,
        revoked_at: null,
        revoked_by_actor_label: null,
      });
    } else if (
      this.query.includes("INSERT INTO notebook_acl") &&
      this.query.includes("FROM notebook_invites")
    ) {
      const [
        subject,
        createdAt,
        updatedAt,
        actorLabel,
        inviteId,
        acceptedByPrincipal,
        acceptedAt,
        email,
        providerHint,
        now,
      ] = this.values as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string | null,
        string,
      ];
      const invite = this.db.invites.get(inviteId);
      if (
        invite &&
        !this.db.deletedNotebookIds.has(invite.notebook_id) &&
        inviteCanGrantAcl(invite, acceptedByPrincipal, acceptedAt, email, providerHint, now)
      ) {
        this.insertAclIfMissing({
          notebook_id: invite.notebook_id,
          subject_kind: "principal",
          subject,
          scope: invite.scope,
          created_at: createdAt,
          updated_at: updatedAt,
          created_by_actor_label: actorLabel,
        });
        return okResult([], { changes: 1 });
      }
    } else if (this.query.includes("UPDATE notebook_invites")) {
      const [principal, acceptedAt, inviteId, email, providerHint, now] = this.values as [
        string,
        string,
        string,
        string,
        string | null,
        string,
      ];
      this.db.beforeInviteAccept?.(inviteId);
      const invite = this.db.invites.get(inviteId);
      if (
        invite &&
        !this.db.deletedNotebookIds.has(invite.notebook_id) &&
        inviteCanResolve(invite, email, providerHint, now)
      ) {
        invite.status = "accepted";
        invite.accepted_by_principal = principal;
        invite.accepted_at = acceptedAt;
        return okResult([], { changes: 1 });
      }
    }
    return okResult();
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    if (this.query.startsWith("PRAGMA table_info")) {
      return okResult([{ name: "runtime_snapshot_key" }, { name: "runtime_state_doc_id" }] as T[]);
    }
    if (this.query.includes("FROM principal_profiles")) {
      if (this.query.includes("email_normalized = ?")) {
        const [email] = this.values as [string];
        return okResult(
          [...this.db.profiles.values()].filter(
            (profile) => profile.email_normalized === email && profile.email_verified === 1,
          ) as T[],
        );
      }
      const principals = new Set(this.values as string[]);
      this.db.maxPrincipalProfileLookupBindCount = Math.max(
        this.db.maxPrincipalProfileLookupBindCount,
        this.values.length,
      );
      if (this.values.length > 100) {
        throw new Error("D1_ERROR: too many SQL variables");
      }
      return okResult(
        [...this.db.profiles.values()].filter((profile) =>
          principals.has(profile.principal),
        ) as T[],
      );
    }
    if (this.query.includes("FROM notebook_invites")) {
      const [email, provider, now] = this.values as [string, string, string];
      return okResult(
        [...this.db.invites.values()].filter(
          (invite) =>
            invite.status === "pending" &&
            invite.email_normalized === email &&
            (invite.provider_hint === provider || invite.provider_hint === null) &&
            inviteCanResolveAt(invite, now),
        ) as T[],
      );
    }
    return okResult([]);
  }

  private insertAclIfMissing(row: NotebookAclRow): void {
    const existing = this.db.acl.find(
      (candidate) =>
        candidate.notebook_id === row.notebook_id &&
        candidate.subject_kind === row.subject_kind &&
        candidate.subject === row.subject &&
        candidate.scope === row.scope,
    );
    if (existing) {
      existing.updated_at = row.updated_at;
      return;
    }
    this.db.acl.push(row);
  }
}

function inviteCanResolve(
  invite: PendingNotebookInviteRow,
  email: string,
  providerHint: string | null,
  now: string,
): boolean {
  if (
    invite.status !== "pending" ||
    invite.email_normalized !== email ||
    (invite.provider_hint !== null && invite.provider_hint !== providerHint)
  ) {
    return false;
  }
  if (!invite.expires_at) {
    return true;
  }
  const expiresAtMs = Date.parse(invite.expires_at);
  const nowMs = Date.parse(now);
  return Number.isFinite(expiresAtMs) && Number.isFinite(nowMs) && expiresAtMs > nowMs;
}

function inviteCanGrantAcl(
  invite: PendingNotebookInviteRow,
  acceptedByPrincipal: string,
  acceptedAt: string,
  email: string,
  providerHint: string | null,
  now: string,
): boolean {
  if (
    invite.status !== "accepted" ||
    invite.accepted_by_principal !== acceptedByPrincipal ||
    invite.accepted_at !== acceptedAt ||
    invite.email_normalized !== email ||
    (invite.provider_hint !== null && invite.provider_hint !== providerHint)
  ) {
    return false;
  }
  if (!invite.expires_at) {
    return true;
  }
  const expiresAtMs = Date.parse(invite.expires_at);
  const nowMs = Date.parse(now);
  return Number.isFinite(expiresAtMs) && Number.isFinite(nowMs) && expiresAtMs > nowMs;
}

function inviteCanResolveAt(invite: PendingNotebookInviteRow, now: string): boolean {
  if (!invite.expires_at) {
    return true;
  }
  const expiresAtMs = Date.parse(invite.expires_at);
  const nowMs = Date.parse(now);
  return Number.isFinite(expiresAtMs) && Number.isFinite(nowMs) && expiresAtMs > nowMs;
}

function okResult<T = unknown>(
  results: T[] = [],
  meta: Record<string, unknown> = { changes: results.length },
): D1Result<T> {
  return { success: true, results, meta };
}
