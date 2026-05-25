import type { D1PreparedStatement, Env } from "./cloudflare-types.ts";
import { ensureCatalogSchema } from "./storage.ts";
import {
  normalizeInviteEmail,
  normalizeProviderHint,
  resolvePendingInvitesForLogin,
  type AuthenticatedLoginProfile,
  type InviteResolution,
  type PendingNotebookInvite,
} from "./sharing.ts";

export interface PrincipalProfileRow {
  principal: string;
  provider: string;
  provider_subject: string | null;
  email_normalized: string | null;
  email_verified: number;
  display_name: string | null;
  avatar_url: string | null;
  first_seen_at: string;
  last_seen_at: string;
  raw_claims_json: string | null;
}

export interface PrincipalProfileInput {
  principal: string;
  provider: string;
  providerSubject?: string | null;
  email?: string | null;
  emailVerified?: boolean;
  displayName?: string | null;
  avatarUrl?: string | null;
  rawClaimsJson?: string | null;
  timestamp?: string;
}

export interface PendingNotebookInviteRow {
  id: string;
  notebook_id: string;
  email_normalized: string;
  provider_hint: string | null;
  scope: PendingNotebookInvite["scope"];
  status: PendingNotebookInvite["status"];
  invited_by_actor_label: string;
  accepted_by_principal: string | null;
  token_hash: string | null;
  created_at: string;
  expires_at: string | null;
  accepted_at: string | null;
  revoked_at: string | null;
  revoked_by_actor_label: string | null;
}

export interface PendingNotebookInviteInput {
  id?: string;
  notebookId: string;
  email: string;
  providerHint?: string | null;
  scope: PendingNotebookInvite["scope"];
  actorLabel: string;
  expiresAt?: string | null;
  tokenHash?: string | null;
  timestamp?: string;
}

export async function upsertPrincipalProfile(
  env: Env,
  input: PrincipalProfileInput,
): Promise<PrincipalProfileRow | null> {
  if (!env.DB) {
    return null;
  }

  await ensureCatalogSchema(env);
  const timestamp = input.timestamp ?? new Date().toISOString();
  const provider = normalizeRequiredProvider(input.provider);
  const email = normalizeVerifiedProfileEmail(input.email ?? null, input.emailVerified ?? false);
  await env.DB.prepare(
    `INSERT INTO principal_profiles (
       principal,
       provider,
       provider_subject,
       email_normalized,
       email_verified,
       display_name,
       avatar_url,
       first_seen_at,
       last_seen_at,
       raw_claims_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(principal) DO UPDATE SET
       email_normalized = excluded.email_normalized,
       email_verified = excluded.email_verified,
       display_name = excluded.display_name,
       avatar_url = excluded.avatar_url,
       last_seen_at = excluded.last_seen_at,
       raw_claims_json = excluded.raw_claims_json`,
  )
    .bind(
      input.principal,
      provider,
      input.providerSubject ?? null,
      email,
      email ? 1 : 0,
      input.displayName?.trim() || null,
      input.avatarUrl ?? null,
      timestamp,
      timestamp,
      input.rawClaimsJson ?? null,
    )
    .run();

  return await getPrincipalProfile(env, input.principal);
}

export async function getPrincipalProfile(
  env: Env,
  principal: string,
): Promise<PrincipalProfileRow | null> {
  if (!env.DB) {
    return null;
  }

  await ensureCatalogSchema(env);
  return await env.DB.prepare(
    `SELECT principal,
            provider,
            provider_subject,
            email_normalized,
            email_verified,
            display_name,
            avatar_url,
            first_seen_at,
            last_seen_at,
            raw_claims_json
       FROM principal_profiles
       WHERE principal = ?`,
  )
    .bind(principal)
    .first<PrincipalProfileRow>();
}

export async function createPendingNotebookInvite(
  env: Env,
  input: PendingNotebookInviteInput,
): Promise<PendingNotebookInviteRow | null> {
  if (!env.DB) {
    return null;
  }

  await ensureCatalogSchema(env);
  const inviteId = input.id ?? crypto.randomUUID();
  const timestamp = input.timestamp ?? new Date().toISOString();
  const providerHint = normalizeProviderHint(input.providerHint ?? null);
  const scope = normalizeInviteScope(input.scope);
  const email = normalizeInviteEmail(input.email);
  const expiresAt = normalizeInviteExpiresAt(input.expiresAt ?? null);
  const existing = await getExistingPendingNotebookInvite(env, {
    notebookId: input.notebookId,
    email,
    providerHint,
    scope,
  });
  if (existing) {
    return existing;
  }

  try {
    await env.DB.prepare(
      `INSERT INTO notebook_invites (
       id,
       notebook_id,
       email_normalized,
       provider_hint,
       scope,
       status,
       invited_by_actor_label,
       token_hash,
       created_at,
       expires_at
     ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    )
      .bind(
        inviteId,
        input.notebookId,
        email,
        providerHint,
        scope,
        input.actorLabel,
        input.tokenHash ?? null,
        timestamp,
        expiresAt,
      )
      .run();
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
    const raced = await getExistingPendingNotebookInvite(env, {
      notebookId: input.notebookId,
      email,
      providerHint,
      scope,
    });
    if (raced) {
      return raced;
    }
    throw error;
  }

  return await getPendingNotebookInvite(env, inviteId);
}

export async function getPendingNotebookInvite(
  env: Env,
  inviteId: string,
): Promise<PendingNotebookInviteRow | null> {
  if (!env.DB) {
    return null;
  }

  await ensureCatalogSchema(env);
  return await env.DB.prepare(
    `SELECT id,
            notebook_id,
            email_normalized,
            provider_hint,
            scope,
            status,
            invited_by_actor_label,
            accepted_by_principal,
            token_hash,
            created_at,
            expires_at,
            accepted_at,
            revoked_at,
            revoked_by_actor_label
       FROM notebook_invites
       WHERE id = ?`,
  )
    .bind(inviteId)
    .first<PendingNotebookInviteRow>();
}

async function getExistingPendingNotebookInvite(
  env: Env,
  input: {
    notebookId: string;
    email: string;
    providerHint: string | null;
    scope: PendingNotebookInvite["scope"];
  },
): Promise<PendingNotebookInviteRow | null> {
  return await env
    .DB!.prepare(
      `SELECT id,
              notebook_id,
              email_normalized,
              provider_hint,
              scope,
              status,
              invited_by_actor_label,
              accepted_by_principal,
              token_hash,
              created_at,
              expires_at,
              accepted_at,
              revoked_at,
              revoked_by_actor_label
         FROM notebook_invites
        WHERE notebook_id = ?
          AND email_normalized = ?
          AND scope = ?
          AND status = 'pending'
          AND ((provider_hint IS NULL AND ? IS NULL) OR provider_hint = ?)
        ORDER BY created_at
        LIMIT 1`,
    )
    .bind(input.notebookId, input.email, input.scope, input.providerHint, input.providerHint)
    .first<PendingNotebookInviteRow>();
}

export async function getPendingNotebookInvitesForLogin(
  env: Env,
  login: Pick<AuthenticatedLoginProfile, "provider" | "email" | "emailVerified">,
  now = new Date().toISOString(),
): Promise<PendingNotebookInvite[]> {
  if (!env.DB || !login.emailVerified) {
    return [];
  }

  const email = normalizeMaybeInviteEmail(login.email);
  if (!email) {
    return [];
  }

  await ensureCatalogSchema(env);
  const provider = normalizeRequiredProvider(login.provider);
  const rows = await env.DB.prepare(
    `SELECT id,
            notebook_id,
            email_normalized,
            provider_hint,
            scope,
            status,
            invited_by_actor_label,
            accepted_by_principal,
            token_hash,
            created_at,
            expires_at,
            accepted_at,
            revoked_at,
            revoked_by_actor_label
       FROM notebook_invites
       WHERE email_normalized = ?
         AND status = 'pending'
         AND (provider_hint = ? OR provider_hint IS NULL)
         AND (expires_at IS NULL OR unixepoch(expires_at) > unixepoch(?))
       ORDER BY created_at`,
  )
    .bind(email, provider, now)
    .all<PendingNotebookInviteRow>();
  return (rows.results ?? []).map(pendingInviteFromRow);
}

export async function resolveNotebookInvitesForLogin(
  env: Env,
  login: AuthenticatedLoginProfile,
  now = new Date().toISOString(),
): Promise<InviteResolution> {
  // Trust boundary: callers must pass identity-provider verified claims.
  // Invite acceptance is derived from login.email plus login.emailVerified.
  await upsertPrincipalProfile(env, {
    principal: login.principal,
    provider: login.provider,
    email: login.email,
    emailVerified: login.emailVerified,
    displayName: login.displayName,
    timestamp: now,
  });

  const invites = await getPendingNotebookInvitesForLogin(env, login, now);
  const resolution = resolvePendingInvitesForLogin({ invites, login, now });
  if (!env.DB || resolution.aclGrants.length === 0) {
    return resolution;
  }

  const operations: {
    invite: PendingNotebookInvite;
    grant: InviteResolution["aclGrants"][number];
    insertAcl: D1PreparedStatement;
    acceptInvite: D1PreparedStatement;
  }[] = [];
  for (const grant of resolution.aclGrants) {
    const invite = resolution.acceptedInvites.find((candidate) => candidate.id === grant.inviteId);
    if (!invite) {
      continue;
    }
    operations.push({
      invite,
      grant,
      insertAcl: inviteAclInsert(env, grant, invite, now),
      acceptInvite: inviteAcceptedUpdate(env, grant, invite, now),
    });
  }
  if (operations.length === 0) {
    return resolution;
  }

  const results = await env.DB.batch(
    operations.flatMap((operation) => [operation.insertAcl, operation.acceptInvite]),
  );
  const acceptedInvites: PendingNotebookInvite[] = [];
  const aclGrants: InviteResolution["aclGrants"] = [];
  for (let index = 0; index < operations.length; index += 1) {
    const acceptInviteResult = results[index * 2 + 1];
    if (!acceptInviteResult || d1Changes(acceptInviteResult) === 0) {
      continue;
    }
    acceptedInvites.push({
      ...operations[index].invite,
      status: "accepted",
      acceptedByPrincipal: login.principal,
      acceptedAt: now,
    });
    aclGrants.push(operations[index].grant);
  }
  return { ...resolution, acceptedInvites, aclGrants };
}

function inviteAclInsert(
  env: Env,
  grant: InviteResolution["aclGrants"][number],
  invite: PendingNotebookInvite,
  timestamp: string,
): D1PreparedStatement {
  return env
    .DB!.prepare(
      `INSERT INTO notebook_acl (
       notebook_id,
       subject_kind,
       subject,
       scope,
       created_at,
       updated_at,
       created_by_actor_label
     )
     SELECT notebook_id, 'principal', ?, scope, ?, ?, ?
       FROM notebook_invites
      WHERE id = ?
        AND status = 'pending'
        AND email_normalized = ?
        AND (provider_hint = ? OR provider_hint IS NULL)
        AND (expires_at IS NULL OR unixepoch(expires_at) > unixepoch(?))
     ON CONFLICT(notebook_id, subject_kind, subject, scope) DO UPDATE SET
       updated_at = excluded.updated_at`,
    )
    .bind(
      grant.subject,
      timestamp,
      timestamp,
      grant.actorLabel,
      invite.id,
      normalizeInviteEmail(invite.email),
      normalizeProviderHint(invite.providerHint),
      timestamp,
    );
}

function inviteAcceptedUpdate(
  env: Env,
  grant: InviteResolution["aclGrants"][number],
  invite: PendingNotebookInvite,
  timestamp: string,
): D1PreparedStatement {
  return env
    .DB!.prepare(
      `UPDATE notebook_invites
          SET status = 'accepted',
              accepted_by_principal = ?,
              accepted_at = ?
        WHERE id = ?
          AND status = 'pending'
          AND email_normalized = ?
          AND (provider_hint = ? OR provider_hint IS NULL)
          AND (expires_at IS NULL OR unixepoch(expires_at) > unixepoch(?))`,
    )
    .bind(
      grant.subject,
      timestamp,
      invite.id,
      normalizeInviteEmail(invite.email),
      normalizeProviderHint(invite.providerHint),
      timestamp,
    );
}

function pendingInviteFromRow(row: PendingNotebookInviteRow): PendingNotebookInvite {
  return {
    id: row.id,
    notebookId: row.notebook_id,
    email: row.email_normalized,
    providerHint: row.provider_hint,
    scope: row.scope,
    status: row.status,
    createdByActorLabel: row.invited_by_actor_label,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedByPrincipal: row.accepted_by_principal,
    acceptedAt: row.accepted_at,
  };
}

function normalizeRequiredProvider(provider: string): string {
  const normalized = normalizeProviderHint(provider);
  if (!normalized) {
    throw new Error("login provider is invalid");
  }
  return normalized;
}

function normalizeVerifiedProfileEmail(email: string | null, verified: boolean): string | null {
  if (!verified) {
    return null;
  }
  return normalizeMaybeInviteEmail(email);
}

function normalizeMaybeInviteEmail(email: string | null): string | null {
  if (!email) {
    return null;
  }
  try {
    return normalizeInviteEmail(email);
  } catch {
    return null;
  }
}

function normalizeInviteScope(
  scope: PendingNotebookInvite["scope"],
): PendingNotebookInvite["scope"] {
  if (scope !== "viewer" && scope !== "editor") {
    throw new Error("invite scope must be viewer or editor");
  }
  return scope;
}

function normalizeInviteExpiresAt(expiresAt: string | null): string | null {
  if (!expiresAt) {
    return null;
  }
  if (!Number.isFinite(Date.parse(expiresAt))) {
    throw new Error("invite expiry is invalid");
  }
  return expiresAt;
}

function d1Changes(result: { meta: Record<string, unknown> }): number {
  const changes = result.meta.changes;
  return typeof changes === "number" ? changes : 0;
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique|constraint/i.test(message);
}
