import type { ConnectionScope } from "./auth-shared.ts";

export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";

export interface PendingNotebookInvite {
  id: string;
  notebookId: string;
  email: string;
  providerHint: string | null;
  scope: Exclude<ConnectionScope, "owner" | "runtime_peer">;
  status: InviteStatus;
  createdByActorLabel: string;
  createdAt: string;
  expiresAt: string | null;
  acceptedByPrincipal?: string | null;
  acceptedAt?: string | null;
}

export interface AuthenticatedLoginProfile {
  principal: string;
  provider: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
}

export interface PrincipalProfile {
  principal: string;
  provider: string;
  email: string | null;
  displayName: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface InviteAclGrant {
  notebookId: string;
  subjectKind: "principal";
  subject: string;
  scope: PendingNotebookInvite["scope"];
  actorLabel: string;
  inviteId: string;
}

export interface InviteResolution {
  profile: PrincipalProfile;
  acceptedInvites: PendingNotebookInvite[];
  aclGrants: InviteAclGrant[];
}

export type ShareTargetDisplay =
  | {
      kind: "principal";
      label: string;
      principal: string;
      email: string | null;
    }
  | {
      kind: "pending_invite";
      label: string;
      email: string;
    }
  | {
      kind: "public_viewer";
      label: string;
    };

const INVITE_RESOLUTION_ACTOR_LABEL = "system/invite-resolution";

export function normalizeInviteEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (
    !normalized ||
    normalized.includes("/") ||
    /\s/.test(normalized) ||
    !normalized.includes("@")
  ) {
    throw new Error("invite email is invalid");
  }
  return normalized;
}

export function inviteLookupKey(provider: string | null, email: string): string {
  const providerKey = normalizeProviderHint(provider) ?? "*";
  return `${providerKey}:${normalizeInviteEmail(email)}`;
}

export function normalizeProviderHint(provider: string | null): string | null {
  const normalized = provider?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return null;
  }
  if (normalized.includes("/") || /\s/.test(normalized)) {
    throw new Error("invite provider hint is invalid");
  }
  return normalized;
}

export function resolvePendingInvitesForLogin({
  invites,
  login,
  now = new Date().toISOString(),
}: {
  invites: PendingNotebookInvite[];
  login: AuthenticatedLoginProfile;
  now?: string;
}): InviteResolution {
  const profile: PrincipalProfile = {
    principal: login.principal,
    provider: normalizeProvider(login.provider),
    email: login.email ? normalizeInviteEmail(login.email) : null,
    displayName: login.displayName?.trim() || null,
    firstSeenAt: now,
    lastSeenAt: now,
  };

  if (!login.email || !login.emailVerified) {
    return { profile, acceptedInvites: [], aclGrants: [] };
  }

  const loginEmail = normalizeInviteEmail(login.email);
  const loginProvider = normalizeProvider(login.provider);
  const acceptedInvites = invites
    .filter((invite) => inviteMatchesLogin(invite, loginEmail, loginProvider, now))
    .map((invite) => ({
      ...invite,
      status: "accepted" as const,
      acceptedByPrincipal: login.principal,
      acceptedAt: now,
    }));

  const aclGrants = acceptedInvites.map((invite) => ({
    notebookId: invite.notebookId,
    subjectKind: "principal" as const,
    subject: login.principal,
    scope: invite.scope,
    actorLabel: INVITE_RESOLUTION_ACTOR_LABEL,
    inviteId: invite.id,
  }));

  return { profile, acceptedInvites, aclGrants };
}

export function publicViewerAclGrant(
  notebookId: string,
  actorLabel: string,
): {
  notebookId: string;
  subjectKind: "public";
  subject: "anonymous";
  scope: "viewer";
  actorLabel: string;
} {
  return {
    notebookId,
    subjectKind: "public",
    subject: "anonymous",
    scope: "viewer",
    actorLabel,
  };
}

export function shareTargetDisplay(input: {
  profile?: PrincipalProfile | null;
  pendingInvite?: Pick<PendingNotebookInvite, "email"> | null;
  publicViewer?: boolean;
}): ShareTargetDisplay {
  if (input.publicViewer) {
    return { kind: "public_viewer", label: "Anyone with the link" };
  }
  if (input.profile) {
    return {
      kind: "principal",
      label: input.profile.displayName || input.profile.email || input.profile.principal,
      principal: input.profile.principal,
      email: input.profile.email,
    };
  }
  if (input.pendingInvite) {
    return {
      kind: "pending_invite",
      label: normalizeInviteEmail(input.pendingInvite.email),
      email: normalizeInviteEmail(input.pendingInvite.email),
    };
  }
  throw new Error("share target display requires a profile, pending invite, or public viewer flag");
}

function inviteMatchesLogin(
  invite: PendingNotebookInvite,
  loginEmail: string,
  loginProvider: string,
  now: string,
): boolean {
  if (invite.status !== "pending") {
    return false;
  }
  if (invite.expiresAt && invite.expiresAt <= now) {
    return false;
  }
  if (normalizeInviteEmail(invite.email) !== loginEmail) {
    return false;
  }
  const providerHint = normalizeProviderHint(invite.providerHint);
  return !providerHint || providerHint === loginProvider;
}

function normalizeProvider(provider: string): string {
  const normalized = normalizeProviderHint(provider);
  if (!normalized) {
    throw new Error("login provider is invalid");
  }
  return normalized;
}
