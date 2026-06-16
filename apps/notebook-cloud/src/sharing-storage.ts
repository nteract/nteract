import type { D1PreparedStatement, Env } from "./cloudflare-types.ts";
import { validatePrincipal } from "./identity.ts";
import {
  canonicalizeNotebookAclForPrincipalStatements,
  copyNotebookAclForPrincipalStatement,
  ensureCatalogSchema,
  type PrincipalAccountLinkRow,
} from "./storage.ts";
import {
  normalizeInviteEmail,
  normalizeProviderHint,
  resolvePendingInvitesForLogin,
  type AuthenticatedLoginProfile,
  type InviteResolution,
  type PendingNotebookInvite,
} from "./sharing.ts";

const PRINCIPAL_PROFILE_LOOKUP_BATCH_SIZE = 50;

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
  principalNamespace?: string | null;
  providerSubject?: string | null;
  email?: string | null;
  emailVerified?: boolean;
  displayName?: string | null;
  avatarUrl?: string | null;
  rawClaimsJson?: string | null;
  timestamp?: string;
}

export interface PrincipalAccountResolution {
  canonicalPrincipal: string | null;
  profile: PrincipalProfileRow | null;
  transportProfile: PrincipalProfileRow | null;
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

export type ListedPendingNotebookInviteRow = Omit<PendingNotebookInviteRow, "token_hash">;

export interface PendingMarkdownDocumentInviteRow {
  id: string;
  document_id: string;
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

export type ListedPendingMarkdownDocumentInviteRow = Omit<
  PendingMarkdownDocumentInviteRow,
  "token_hash"
>;

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

export interface PendingMarkdownDocumentInviteInput {
  id?: string;
  documentId: string;
  email: string;
  providerHint?: string | null;
  scope: PendingNotebookInvite["scope"];
  actorLabel: string;
  expiresAt?: string | null;
  tokenHash?: string | null;
  timestamp?: string;
}

const NOTEBOOK_INVITE_LIST_LIMIT = 200;
const MARKDOWN_DOCUMENT_INVITE_LIST_LIMIT = 200;

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
       provider_subject = COALESCE(principal_profiles.provider_subject, excluded.provider_subject),
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
      input.emailVerified && email ? 1 : 0,
      input.displayName?.trim() || null,
      input.avatarUrl ?? null,
      timestamp,
      timestamp,
      input.rawClaimsJson ?? null,
    )
    .run();

  return await getPrincipalProfile(env, input.principal);
}

export async function upsertPrincipalProfileWithAccount(
  env: Env,
  input: PrincipalProfileInput,
): Promise<PrincipalAccountResolution> {
  const transportProfile = await upsertPrincipalProfile(env, input);
  const canonicalPrincipal = await canonicalAccountPrincipalForProfile(input);
  if (!env.DB || !canonicalPrincipal) {
    return { canonicalPrincipal: null, profile: transportProfile, transportProfile };
  }

  const timestamp = input.timestamp ?? new Date().toISOString();
  const accountNamespace = normalizeAccountNamespace(input);
  const canonicalProfile = await upsertPrincipalProfile(env, {
    principal: canonicalPrincipal,
    provider: accountNamespace,
    providerSubject: null,
    email: input.email ?? null,
    emailVerified: true,
    displayName: input.displayName ?? null,
    avatarUrl: input.avatarUrl ?? null,
    rawClaimsJson: input.rawClaimsJson ?? null,
    timestamp,
  });
  await upsertPrincipalAccountLink(env, {
    transportPrincipal: input.principal,
    canonicalPrincipal,
    provider: accountNamespace,
    email: normalizeMaybeInviteEmail(input.email ?? null),
    timestamp,
  });
  const relatedProfiles = await getVerifiedProfilesForCanonicalAccount(
    env,
    accountNamespace,
    input,
  );
  for (const relatedProfile of relatedProfiles) {
    await upsertPrincipalAccountLink(env, {
      transportPrincipal: relatedProfile.principal,
      canonicalPrincipal,
      provider: accountNamespace,
      email: relatedProfile.email_normalized,
      timestamp,
    });
  }

  return {
    canonicalPrincipal,
    profile: canonicalProfile ?? transportProfile,
    transportProfile,
  };
}

async function getVerifiedProfilesForCanonicalAccount(
  env: Env,
  accountNamespace: string,
  input: Pick<PrincipalProfileInput, "principal" | "email">,
): Promise<PrincipalProfileRow[]> {
  if (!env.DB) {
    return [];
  }
  const email = normalizeMaybeInviteEmail(input.email ?? null);
  if (!email) {
    return [];
  }

  await ensureCatalogSchema(env);
  const rows = await env.DB.prepare(
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
      WHERE email_normalized = ?
        AND email_verified = 1`,
  )
    .bind(email)
    .all<PrincipalProfileRow>();
  return (rows.results ?? []).filter(
    (profile) =>
      profile.principal !== input.principal &&
      !profile.principal.startsWith("account:") &&
      principalNamespaceFromPrincipal(profile.principal) === accountNamespace,
  );
}

export async function canonicalAccountPrincipalForProfile(
  input: Pick<PrincipalProfileInput, "principalNamespace" | "provider" | "email" | "emailVerified">,
): Promise<string | null> {
  if (!input.emailVerified) {
    return null;
  }
  const email = normalizeMaybeInviteEmail(input.email ?? null);
  if (!email) {
    return null;
  }
  const accountNamespace = normalizeAccountNamespace(input);
  const digest = await sha256Hex(`${accountNamespace}\n${email}`);
  const principal = `account:${encodeURIComponent(accountNamespace)}:email:${digest}`;
  validatePrincipal(principal);
  return principal;
}

async function upsertPrincipalAccountLink(
  env: Env,
  input: {
    transportPrincipal: string;
    canonicalPrincipal: string;
    provider: string;
    email: string | null;
    timestamp: string;
  },
): Promise<PrincipalAccountLinkRow | null> {
  if (!env.DB) {
    return null;
  }

  await ensureCatalogSchema(env);
  const existing = await getPrincipalAccountLink(env, input.transportPrincipal);
  const statements: D1PreparedStatement[] = [];
  if (existing && existing.canonical_principal !== input.canonicalPrincipal) {
    const oldCanonicalHasOtherTransports = await canonicalPrincipalHasOtherTransportLinks(env, {
      canonicalPrincipal: existing.canonical_principal,
      exceptTransportPrincipal: input.transportPrincipal,
    });
    if (oldCanonicalHasOtherTransports) {
      statements.push(
        copyNotebookAclForPrincipalStatement(env, {
          sourcePrincipal: existing.canonical_principal,
          targetPrincipal: input.canonicalPrincipal,
          timestamp: input.timestamp,
        }),
      );
    } else {
      statements.push(
        ...canonicalizeNotebookAclForPrincipalStatements(env, {
          transportPrincipal: existing.canonical_principal,
          canonicalPrincipal: input.canonicalPrincipal,
          timestamp: input.timestamp,
        }),
      );
    }
  }
  statements.push(
    ...canonicalizeNotebookAclForPrincipalStatements(env, {
      transportPrincipal: input.transportPrincipal,
      canonicalPrincipal: input.canonicalPrincipal,
      timestamp: input.timestamp,
    }),
    principalAccountLinkUpsertStatement(env, input),
  );

  await env.DB.batch(statements);

  return await getPrincipalAccountLink(env, input.transportPrincipal);
}

function principalAccountLinkUpsertStatement(
  env: Env,
  input: {
    transportPrincipal: string;
    canonicalPrincipal: string;
    provider: string;
    email: string | null;
    timestamp: string;
  },
): D1PreparedStatement {
  return env
    .DB!.prepare(
      `INSERT INTO principal_account_links (
       transport_principal,
       canonical_principal,
       provider,
       email_normalized,
       first_seen_at,
       last_seen_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(transport_principal) DO UPDATE SET
       canonical_principal = excluded.canonical_principal,
       provider = excluded.provider,
       email_normalized = excluded.email_normalized,
       last_seen_at = excluded.last_seen_at`,
    )
    .bind(
      input.transportPrincipal,
      input.canonicalPrincipal,
      input.provider,
      input.email,
      input.timestamp,
      input.timestamp,
    );
}

async function getPrincipalAccountLink(
  env: Env,
  transportPrincipal: string,
): Promise<PrincipalAccountLinkRow | null> {
  return await env
    .DB!.prepare(
      `SELECT transport_principal,
            canonical_principal,
            provider,
            email_normalized,
            first_seen_at,
            last_seen_at
       FROM principal_account_links
      WHERE transport_principal = ?`,
    )
    .bind(transportPrincipal)
    .first<PrincipalAccountLinkRow>();
}

async function canonicalPrincipalHasOtherTransportLinks(
  env: Env,
  input: {
    canonicalPrincipal: string;
    exceptTransportPrincipal: string;
  },
): Promise<boolean> {
  const row = await env
    .DB!.prepare(
      `SELECT transport_principal
         FROM principal_account_links
        WHERE canonical_principal = ?
          AND transport_principal != ?
        LIMIT 1`,
    )
    .bind(input.canonicalPrincipal, input.exceptTransportPrincipal)
    .first<Pick<PrincipalAccountLinkRow, "transport_principal">>();
  return Boolean(row);
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

export async function getPrincipalProfiles(
  env: Env,
  principals: string[],
): Promise<PrincipalProfileRow[]> {
  if (!env.DB) {
    return [];
  }

  const uniquePrincipals = Array.from(new Set(principals.filter((principal) => principal)));
  if (uniquePrincipals.length === 0) {
    return [];
  }

  await ensureCatalogSchema(env);
  const profiles: PrincipalProfileRow[] = [];
  for (
    let index = 0;
    index < uniquePrincipals.length;
    index += PRINCIPAL_PROFILE_LOOKUP_BATCH_SIZE
  ) {
    const batch = uniquePrincipals.slice(index, index + PRINCIPAL_PROFILE_LOOKUP_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(", ");
    const rows = await env.DB.prepare(
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
         WHERE principal IN (${placeholders})`,
    )
      .bind(...batch)
      .all<PrincipalProfileRow>();
    profiles.push(...(rows.results ?? []));
  }
  return profiles;
}

export async function getPrincipalProfilesForVerifiedEmail(
  env: Env,
  email: string,
): Promise<PrincipalProfileRow[]> {
  if (!env.DB) {
    return [];
  }

  const normalizedEmail = normalizeInviteEmail(email);
  await ensureCatalogSchema(env);
  const rows = await env.DB.prepare(
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
      WHERE email_normalized = ?
        AND email_verified = 1
      ORDER BY last_seen_at DESC`,
  )
    .bind(normalizedEmail)
    .all<PrincipalProfileRow>();
  return rows.results ?? [];
}

export async function getPreferredPrincipalProfileForVerifiedEmail(
  env: Env,
  email: string,
): Promise<PrincipalProfileRow | null> {
  const profiles = await getPrincipalProfilesForVerifiedEmail(env, email);
  return (
    profiles.find((profile) => profile.principal.startsWith("account:")) ?? profiles[0] ?? null
  );
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

export async function listNotebookInvites(
  env: Env,
  notebookId: string,
): Promise<ListedPendingNotebookInviteRow[]> {
  if (!env.DB) {
    return [];
  }

  await ensureCatalogSchema(env);
  const rows = await env.DB.prepare(
    `SELECT id,
            notebook_id,
            email_normalized,
            provider_hint,
            scope,
            status,
            invited_by_actor_label,
            accepted_by_principal,
            created_at,
            expires_at,
            accepted_at,
            revoked_at,
            revoked_by_actor_label
       FROM notebook_invites
       WHERE notebook_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
  )
    .bind(notebookId, NOTEBOOK_INVITE_LIST_LIMIT)
    .all<ListedPendingNotebookInviteRow>();
  return rows.results ?? [];
}

export async function revokePendingNotebookInvite(
  env: Env,
  input: {
    notebookId: string;
    inviteId: string;
    actorLabel: string;
    timestamp?: string;
  },
): Promise<boolean> {
  if (!env.DB) {
    return false;
  }

  await ensureCatalogSchema(env);
  const timestamp = input.timestamp ?? new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE notebook_invites
        SET status = 'revoked',
            revoked_at = ?,
            revoked_by_actor_label = ?
      WHERE notebook_id = ?
        AND id = ?
        AND status = 'pending'`,
  )
    .bind(timestamp, input.actorLabel, input.notebookId, input.inviteId)
    .run();
  return d1Changes(result) > 0;
}

export async function createPendingMarkdownDocumentInvite(
  env: Env,
  input: PendingMarkdownDocumentInviteInput,
): Promise<PendingMarkdownDocumentInviteRow | null> {
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
  const existing = await getExistingPendingMarkdownDocumentInvite(env, {
    documentId: input.documentId,
    email,
    providerHint,
    scope,
  });
  if (existing) {
    return existing;
  }

  try {
    await env.DB.prepare(
      `INSERT INTO markdown_document_invites (
       id,
       document_id,
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
        input.documentId,
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
    const raced = await getExistingPendingMarkdownDocumentInvite(env, {
      documentId: input.documentId,
      email,
      providerHint,
      scope,
    });
    if (raced) {
      return raced;
    }
    throw error;
  }

  return await getPendingMarkdownDocumentInvite(env, inviteId);
}

export async function getPendingMarkdownDocumentInvite(
  env: Env,
  inviteId: string,
): Promise<PendingMarkdownDocumentInviteRow | null> {
  if (!env.DB) {
    return null;
  }

  await ensureCatalogSchema(env);
  return await env.DB.prepare(
    `SELECT id,
            document_id,
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
       FROM markdown_document_invites
       WHERE id = ?`,
  )
    .bind(inviteId)
    .first<PendingMarkdownDocumentInviteRow>();
}

export async function listMarkdownDocumentInvites(
  env: Env,
  documentId: string,
): Promise<ListedPendingMarkdownDocumentInviteRow[]> {
  if (!env.DB) {
    return [];
  }

  await ensureCatalogSchema(env);
  const rows = await env.DB.prepare(
    `SELECT id,
            document_id,
            email_normalized,
            provider_hint,
            scope,
            status,
            invited_by_actor_label,
            accepted_by_principal,
            created_at,
            expires_at,
            accepted_at,
            revoked_at,
            revoked_by_actor_label
       FROM markdown_document_invites
       WHERE document_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
  )
    .bind(documentId, MARKDOWN_DOCUMENT_INVITE_LIST_LIMIT)
    .all<ListedPendingMarkdownDocumentInviteRow>();
  return rows.results ?? [];
}

export async function revokePendingMarkdownDocumentInvite(
  env: Env,
  input: {
    documentId: string;
    inviteId: string;
    actorLabel: string;
    timestamp?: string;
  },
): Promise<boolean> {
  if (!env.DB) {
    return false;
  }

  await ensureCatalogSchema(env);
  const timestamp = input.timestamp ?? new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE markdown_document_invites
        SET status = 'revoked',
            revoked_at = ?,
            revoked_by_actor_label = ?
      WHERE document_id = ?
        AND id = ?
        AND status = 'pending'`,
  )
    .bind(timestamp, input.actorLabel, input.documentId, input.inviteId)
    .run();
  return d1Changes(result) > 0;
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

async function getExistingPendingMarkdownDocumentInvite(
  env: Env,
  input: {
    documentId: string;
    email: string;
    providerHint: string | null;
    scope: PendingNotebookInvite["scope"];
  },
): Promise<PendingMarkdownDocumentInviteRow | null> {
  return await env
    .DB!.prepare(
      `SELECT id,
              document_id,
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
         FROM markdown_document_invites
        WHERE document_id = ?
          AND email_normalized = ?
          AND scope = ?
          AND status = 'pending'
          AND ((provider_hint IS NULL AND ? IS NULL) OR provider_hint = ?)
        ORDER BY created_at
        LIMIT 1`,
    )
    .bind(input.documentId, input.email, input.scope, input.providerHint, input.providerHint)
    .first<PendingMarkdownDocumentInviteRow>();
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

export async function getPendingMarkdownDocumentInvitesForLogin(
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
            document_id,
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
       FROM markdown_document_invites
       WHERE email_normalized = ?
         AND status = 'pending'
         AND (provider_hint = ? OR provider_hint IS NULL)
         AND (expires_at IS NULL OR unixepoch(expires_at) > unixepoch(?))
       ORDER BY created_at`,
  )
    .bind(email, provider, now)
    .all<PendingMarkdownDocumentInviteRow>();
  return (rows.results ?? []).map(pendingMarkdownDocumentInviteFromRow);
}

export async function resolveNotebookInvitesForLogin(
  env: Env,
  login: AuthenticatedLoginProfile,
  now = new Date().toISOString(),
): Promise<InviteResolution> {
  // Trust boundary: callers must pass identity-provider verified claims.
  // Invite acceptance is derived from login.email plus login.emailVerified.
  const account = await upsertPrincipalProfileWithAccount(env, {
    principal: login.principal,
    provider: login.provider,
    principalNamespace: login.principalNamespace,
    email: login.email,
    emailVerified: login.emailVerified,
    displayName: login.displayName,
    timestamp: now,
  });

  const invites = await getPendingNotebookInvitesForLogin(env, login, now);
  const resolution = resolvePendingInvitesForLogin({
    invites,
    login,
    aclSubject: account.canonicalPrincipal ?? login.principal,
    now,
  });
  const resolutionWithProfile = {
    ...resolution,
    profile: profileFromRow(account.profile) ?? resolution.profile,
  };
  if (!env.DB || resolution.aclGrants.length === 0) {
    return resolutionWithProfile;
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
    return resolutionWithProfile;
  }

  const results = await env.DB.batch(
    operations.flatMap((operation) => [operation.acceptInvite, operation.insertAcl]),
  );
  const acceptedInvites: PendingNotebookInvite[] = [];
  const aclGrants: InviteResolution["aclGrants"] = [];
  for (let index = 0; index < operations.length; index += 1) {
    const acceptInviteResult = results[index * 2];
    const insertAclResult = results[index * 2 + 1];
    if (
      !acceptInviteResult ||
      !insertAclResult ||
      d1Changes(acceptInviteResult) === 0 ||
      d1Changes(insertAclResult) === 0
    ) {
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
  return { ...resolutionWithProfile, acceptedInvites, aclGrants };
}

export async function resolveMarkdownDocumentInvitesForLogin(
  env: Env,
  login: AuthenticatedLoginProfile,
  now = new Date().toISOString(),
): Promise<InviteResolution> {
  // Trust boundary: callers must pass identity-provider verified claims.
  // Invite acceptance is derived from login.email plus login.emailVerified.
  const account = await upsertPrincipalProfileWithAccount(env, {
    principal: login.principal,
    provider: login.provider,
    principalNamespace: login.principalNamespace,
    email: login.email,
    emailVerified: login.emailVerified,
    displayName: login.displayName,
    timestamp: now,
  });

  const invites = await getPendingMarkdownDocumentInvitesForLogin(env, login, now);
  const resolution = resolvePendingInvitesForLogin({
    invites,
    login,
    aclSubject: account.canonicalPrincipal ?? login.principal,
    now,
  });
  const resolutionWithProfile = {
    ...resolution,
    profile: profileFromRow(account.profile) ?? resolution.profile,
  };
  if (!env.DB || resolution.aclGrants.length === 0) {
    return resolutionWithProfile;
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
      insertAcl: markdownInviteAclInsert(env, grant, invite, now),
      acceptInvite: markdownInviteAcceptedUpdate(env, grant, invite, now),
    });
  }
  if (operations.length === 0) {
    return resolutionWithProfile;
  }

  const results = await env.DB.batch(
    operations.flatMap((operation) => [operation.acceptInvite, operation.insertAcl]),
  );
  const acceptedInvites: PendingNotebookInvite[] = [];
  const aclGrants: InviteResolution["aclGrants"] = [];
  for (let index = 0; index < operations.length; index += 1) {
    const acceptInviteResult = results[index * 2];
    const insertAclResult = results[index * 2 + 1];
    if (
      !acceptInviteResult ||
      !insertAclResult ||
      d1Changes(acceptInviteResult) === 0 ||
      d1Changes(insertAclResult) === 0
    ) {
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
  return { ...resolutionWithProfile, acceptedInvites, aclGrants };
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
        AND status = 'accepted'
        AND accepted_by_principal = ?
        AND accepted_at = ?
        AND email_normalized = ?
        AND (provider_hint = ? OR provider_hint IS NULL)
        AND (expires_at IS NULL OR unixepoch(expires_at) > unixepoch(?))
        AND EXISTS (
          SELECT 1 FROM notebooks WHERE notebooks.id = notebook_invites.notebook_id
        )
     ON CONFLICT(notebook_id, subject_kind, subject, scope) DO UPDATE SET
       updated_at = excluded.updated_at`,
    )
    .bind(
      grant.subject,
      timestamp,
      timestamp,
      grant.actorLabel,
      invite.id,
      grant.acceptedByPrincipal,
      timestamp,
      normalizeInviteEmail(invite.email),
      normalizeProviderHint(invite.providerHint),
      timestamp,
    );
}

function markdownInviteAclInsert(
  env: Env,
  grant: InviteResolution["aclGrants"][number],
  invite: PendingNotebookInvite,
  timestamp: string,
): D1PreparedStatement {
  return env
    .DB!.prepare(
      `INSERT INTO markdown_document_acl (
       document_id,
       subject_kind,
       subject,
       scope,
       created_at,
       updated_at,
       created_by_actor_label
     )
     SELECT document_id, 'principal', ?, scope, ?, ?, ?
       FROM markdown_document_invites
      WHERE id = ?
        AND status = 'accepted'
        AND accepted_by_principal = ?
        AND accepted_at = ?
        AND email_normalized = ?
        AND (provider_hint = ? OR provider_hint IS NULL)
        AND (expires_at IS NULL OR unixepoch(expires_at) > unixepoch(?))
        AND EXISTS (
          SELECT 1 FROM markdown_documents WHERE markdown_documents.id = markdown_document_invites.document_id
        )
     ON CONFLICT(document_id, subject_kind, subject, scope) DO UPDATE SET
       updated_at = excluded.updated_at`,
    )
    .bind(
      grant.subject,
      timestamp,
      timestamp,
      grant.actorLabel,
      invite.id,
      grant.acceptedByPrincipal,
      timestamp,
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
          AND (expires_at IS NULL OR unixepoch(expires_at) > unixepoch(?))
          AND EXISTS (
            SELECT 1 FROM notebooks WHERE notebooks.id = notebook_invites.notebook_id
          )`,
    )
    .bind(
      grant.acceptedByPrincipal,
      timestamp,
      invite.id,
      normalizeInviteEmail(invite.email),
      normalizeProviderHint(invite.providerHint),
      timestamp,
    );
}

function markdownInviteAcceptedUpdate(
  env: Env,
  grant: InviteResolution["aclGrants"][number],
  invite: PendingNotebookInvite,
  timestamp: string,
): D1PreparedStatement {
  return env
    .DB!.prepare(
      `UPDATE markdown_document_invites
          SET status = 'accepted',
              accepted_by_principal = ?,
              accepted_at = ?
        WHERE id = ?
          AND status = 'pending'
          AND email_normalized = ?
          AND (provider_hint = ? OR provider_hint IS NULL)
          AND (expires_at IS NULL OR unixepoch(expires_at) > unixepoch(?))
          AND EXISTS (
            SELECT 1 FROM markdown_documents WHERE markdown_documents.id = markdown_document_invites.document_id
          )`,
    )
    .bind(
      grant.acceptedByPrincipal,
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

function pendingMarkdownDocumentInviteFromRow(
  row: PendingMarkdownDocumentInviteRow,
): PendingNotebookInvite {
  return {
    id: row.id,
    notebookId: row.document_id,
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

function profileFromRow(row: PrincipalProfileRow | null): InviteResolution["profile"] | null {
  if (!row) {
    return null;
  }
  return {
    principal: row.principal,
    provider: row.provider,
    email: row.email_normalized,
    displayName: row.display_name,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

function normalizeAccountNamespace(
  input: Pick<PrincipalProfileInput, "principalNamespace" | "provider">,
): string {
  return normalizeRequiredProvider(input.principalNamespace ?? input.provider);
}

function principalNamespaceFromPrincipal(principal: string): string | null {
  const [scheme, provider] = principal.split(":", 3);
  if (!scheme || !provider) {
    return null;
  }
  return `${scheme}:${provider}`.toLowerCase();
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint failed/i.test(message);
}
