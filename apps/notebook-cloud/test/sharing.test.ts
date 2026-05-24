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
    const login = accessLogin({
      principal: "user:cloudflare-access:access-sub-1",
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
        subject: "user:cloudflare-access:access-sub-1",
        scope: "editor",
        actorLabel: "system/invite-resolution",
        inviteId: "invite-1",
      },
    ]);
    assert.equal(resolution.acceptedInvites[0]?.acceptedByPrincipal, login.principal);
    assert.doesNotMatch(resolution.aclGrants[0]?.subject ?? "", /alice@example.com/);
  });

  it("does not resolve invites from unverified emails or the wrong provider", () => {
    const invite = pendingInvite({ providerHint: "cloudflare-access" });

    assert.equal(
      resolvePendingInvitesForLogin({
        invites: [invite],
        login: accessLogin({ emailVerified: false }),
      }).aclGrants.length,
      0,
    );
    assert.equal(
      resolvePendingInvitesForLogin({
        invites: [invite],
        login: accessLogin({ provider: "dev" }),
      }).aclGrants.length,
      0,
    );
  });

  it("normalizes provider hints before resolving pending invites", () => {
    const invite = pendingInvite({ providerHint: " Cloudflare-Access " });

    const resolution = resolvePendingInvitesForLogin({
      invites: [invite],
      login: accessLogin({ provider: "cloudflare-access" }),
    });

    assert.equal(resolution.aclGrants.length, 1);
    assert.equal(resolution.profile.provider, "cloudflare-access");
  });

  it("keeps pending invite lookup keyed by normalized email plus provider hint", () => {
    assert.equal(normalizeInviteEmail(" Alice@Example.COM "), "alice@example.com");
    assert.equal(normalizeProviderHint(" Cloudflare-Access "), "cloudflare-access");
    assert.equal(
      inviteLookupKey(" Cloudflare-Access ", " Alice@Example.COM "),
      "cloudflare-access:alice@example.com",
    );
    assert.equal(inviteLookupKey(null, "alice@example.com"), "*:alice@example.com");
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
        principal: "user:cloudflare-access:access-sub-1",
        provider: "cloudflare-access",
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
});

function pendingInvite(overrides: Partial<PendingNotebookInvite> = {}): PendingNotebookInvite {
  return {
    id: "invite-1",
    notebookId: "notebook-1",
    email: "alice@example.com",
    providerHint: "cloudflare-access",
    scope: "editor",
    status: "pending",
    createdByActorLabel: "user:cloudflare-access:owner/smoke:owner",
    createdAt: "2026-05-24T11:00:00.000Z",
    expiresAt: "2026-06-24T11:00:00.000Z",
    ...overrides,
  };
}

function accessLogin(
  overrides: Partial<AuthenticatedLoginProfile> = {},
): AuthenticatedLoginProfile {
  return {
    principal: "user:cloudflare-access:access-sub-1",
    provider: "cloudflare-access",
    email: "alice@example.com",
    emailVerified: true,
    displayName: "Alice Example",
    ...overrides,
  };
}
