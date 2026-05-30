import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  inviteLookupKey,
  normalizeInviteEmail,
  normalizeProviderHint,
  publicViewerAclGrant,
  resolvePendingInvitesForLogin,
  shareTargetDisplay,
  type AuthenticatedLoginProfile,
  type PendingNotebookInvite,
} from "../src/sharing.ts";

describe("hosted notebook sharing prototype", () => {
  it("resolves a pending email invite to a principal ACL grant on first verified login", () => {
    const invite = pendingInvite({ email: " Alice@Example.COM " });
    const login = oidcLogin({
      principal: "user:oidc:oidc-sub-1",
      email: "alice@example.com",
      displayName: "Alice Example",
    });

    const resolution = resolvePendingInvitesForLogin({
      invites: [invite],
      login,
      now: "2026-05-24T12:00:00.000Z",
    });

    assert.deepEqual(resolution.aclGrants, [
      {
        notebookId: "notebook-1",
        subjectKind: "principal",
        subject: "user:oidc:oidc-sub-1",
        scope: "editor",
        actorLabel: "system/invite-resolution",
        inviteId: "invite-1",
      },
    ]);
    assert.equal(resolution.acceptedInvites[0]?.acceptedByPrincipal, login.principal);
    assert.doesNotMatch(resolution.aclGrants[0]?.subject ?? "", /alice@example.com/);
  });

  it("does not resolve invites from unverified emails or the wrong provider", () => {
    const invite = pendingInvite({ providerHint: "oidc" });

    assert.equal(
      resolvePendingInvitesForLogin({
        invites: [invite],
        login: oidcLogin({ emailVerified: false }),
      }).aclGrants.length,
      0,
    );
    assert.equal(
      resolvePendingInvitesForLogin({
        invites: [invite],
        login: oidcLogin({ provider: "dev" }),
      }).aclGrants.length,
      0,
    );
  });

  it("does not throw when an unverified login has a malformed email claim", () => {
    const resolution = resolvePendingInvitesForLogin({
      invites: [pendingInvite()],
      login: oidcLogin({ email: "noatsign", emailVerified: false }),
    });

    assert.equal(resolution.profile.email, null);
    assert.equal(resolution.aclGrants.length, 0);
  });

  it("skips malformed stored invites while resolving other valid invites", () => {
    const validInvite = pendingInvite({ id: "invite-valid" });
    const resolution = resolvePendingInvitesForLogin({
      invites: [
        pendingInvite({ id: "invite-bad-provider", providerHint: "okta/sso" }),
        pendingInvite({ id: "invite-bad-email", email: "bad invite" }),
        validInvite,
      ],
      login: oidcLogin(),
    });

    assert.deepEqual(
      resolution.acceptedInvites.map((invite) => invite.id),
      ["invite-valid"],
    );
  });

  it("expires invites with numeric time comparisons instead of ISO string ordering", () => {
    const resolution = resolvePendingInvitesForLogin({
      invites: [pendingInvite({ expiresAt: "2026-05-24T00:00:00Z" })],
      login: oidcLogin(),
      now: "2026-05-24T00:00:00.000Z",
    });

    assert.equal(resolution.aclGrants.length, 0);
  });

  it("normalizes provider hints before resolving pending invites", () => {
    const invite = pendingInvite({ providerHint: " OIDC " });

    const resolution = resolvePendingInvitesForLogin({
      invites: [invite],
      login: oidcLogin({ provider: "oidc" }),
    });

    assert.equal(resolution.aclGrants.length, 1);
    assert.equal(resolution.profile.provider, "oidc");
  });

  it("keeps pending invite lookup keyed by normalized email plus provider hint", () => {
    assert.equal(normalizeInviteEmail(" Alice@Example.COM "), "alice@example.com");
    assert.equal(normalizeProviderHint(" OIDC "), "oidc");
    assert.equal(inviteLookupKey(" OIDC ", " Alice@Example.COM "), "oidc:alice@example.com");
    assert.equal(inviteLookupKey(null, "alice@example.com"), "*:alice@example.com");
  });

  it("rejects structurally invalid invite emails", () => {
    assert.throws(() => normalizeInviteEmail("@@"), /invite email is invalid/);
    assert.throws(() => normalizeInviteEmail("a@b@c"), /invite email is invalid/);
    assert.throws(() => normalizeInviteEmail("@example.com"), /invite email is invalid/);
    assert.throws(() => normalizeInviteEmail("alice@"), /invite email is invalid/);
  });

  it("represents public viewers as explicit public ACL rows", () => {
    assert.deepEqual(publicViewerAclGrant("notebook-1", "user:dev:alice/desktop:test"), {
      notebookId: "notebook-1",
      subjectKind: "public",
      subject: "anonymous",
      scope: "viewer",
      actorLabel: "user:dev:alice/desktop:test",
    });
  });

  it("builds display labels for resolved principals, pending invites, and public viewers", () => {
    const principal = shareTargetDisplay({
      profile: {
        principal: "user:oidc:oidc-sub-1",
        provider: "oidc",
        email: "alice@example.com",
        displayName: "Alice Example",
        firstSeenAt: "2026-05-24T12:00:00.000Z",
        lastSeenAt: "2026-05-24T12:00:00.000Z",
      },
    });
    const pending = shareTargetDisplay({ pendingInvite: { email: "Bob@Example.com" } });
    const publicViewer = shareTargetDisplay({ publicViewer: true });

    assert.equal(principal.label, "Alice Example");
    assert.equal(pending.label, "bob@example.com");
    assert.deepEqual(publicViewer, { kind: "public_viewer", label: "Anyone with the link" });
  });

  it("uses a placeholder display label for malformed pending invite rows", () => {
    assert.deepEqual(shareTargetDisplay({ pendingInvite: { email: "" } }), {
      kind: "pending_invite",
      label: "Unknown invitee",
      email: "",
    });
  });
});

function pendingInvite(overrides: Partial<PendingNotebookInvite> = {}): PendingNotebookInvite {
  return {
    id: "invite-1",
    notebookId: "notebook-1",
    email: "alice@example.com",
    providerHint: "oidc",
    scope: "editor",
    status: "pending",
    createdByActorLabel: "user:oidc:owner/smoke:owner",
    createdAt: "2026-05-24T11:00:00.000Z",
    expiresAt: "2026-06-24T11:00:00.000Z",
    ...overrides,
  };
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
