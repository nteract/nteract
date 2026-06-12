// Workstation pairing codes and workstation credentials.
//
// A signed-in owner mints a short-lived, single-use pairing code from the
// workstation panel. The remote agent redeems it — the code is the entire
// credential for the redeem call — and receives a long-lived workstation
// credential token bound to the owner's canonical principal. The token is the
// least-privilege bearer for the workstation surface: registration/heartbeat,
// attach-job polling, and runtime_peer room dials. Both secrets are stored
// hashed; cleartext exists only in the mint and redeem responses.
//
// Contract: docs/adr/hosted-credential-transport.md, Decision 9.

import type { Env } from "./cloudflare-types.ts";
import { ensureCatalogSchema } from "./storage.ts";
import {
  AuthError,
  parseScope,
  validateOperator,
  type AuthenticatedConnection,
  type ConnectionScope,
} from "./identity.ts";

export const WORKSTATION_CREDENTIAL_TOKEN_PREFIX = "nwc_";
export const WORKSTATION_PAIRING_CODE_TTL_MS = 10 * 60_000;
const WORKSTATION_CREDENTIAL_LAST_USED_REFRESH_MS = 5 * 60_000;
const DEFAULT_WORKSTATION_OPERATOR = "workstation:agent";

// Crockford-adjacent alphabet: no 0/1/I/L/O/U, so codes survive being read
// aloud or retyped. 12 characters ≈ 59 bits — enough that a live 10-minute
// code cannot be guessed, which matters because first registration
// auto-selects the owner's default workstation target.
const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const PAIRING_CODE_LENGTH = 12;
const PAIRING_CODE_GROUP = 4;

export interface WorkstationPairingCodeRow {
  id: string;
  code_hash: string;
  owner_principal: string;
  principal_namespace: string;
  created_by_actor_label: string;
  created_at: string;
  expires_at: string;
  redeemed_at: string | null;
  redeemed_by_credential_id: string | null;
  workstation_id: string | null;
}

export interface WorkstationCredentialRow {
  id: string;
  token_hash: string;
  owner_principal: string;
  principal_namespace: string;
  pairing_code_id: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export type WorkstationPairingStatus = "pending" | "redeemed" | "registered" | "expired";

export function generatePairingCode(): string {
  const bytes = new Uint8Array(PAIRING_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = "";
  for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
    if (index > 0 && index % PAIRING_CODE_GROUP === 0) {
      code += "-";
    }
    // Rejection-free modulo bias is acceptable here: 256 % 30 spreads the
    // bias across the alphabet at well under one bit of the 59-bit budget.
    code += PAIRING_CODE_ALPHABET[bytes[index]! % PAIRING_CODE_ALPHABET.length]!;
  }
  return code;
}

export function normalizePairingCode(input: string): string {
  return input.replace(/[\s-]+/g, "").toUpperCase();
}

export function generateWorkstationCredentialToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const base64url = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `${WORKSTATION_CREDENTIAL_TOKEN_PREFIX}${base64url}`;
}

export async function hashWorkstationSecret(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface MintedWorkstationPairingCode {
  id: string;
  code: string;
  expires_at: string;
}

export async function createWorkstationPairingCode(
  env: Env,
  input: {
    ownerPrincipal: string;
    principalNamespace: string;
    actorLabel: string;
  },
): Promise<MintedWorkstationPairingCode | null> {
  if (!env.DB) {
    return null;
  }
  await ensureCatalogSchema(env);

  const id = crypto.randomUUID();
  const code = generatePairingCode();
  const codeHash = await hashWorkstationSecret(normalizePairingCode(code));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + WORKSTATION_PAIRING_CODE_TTL_MS).toISOString();
  await env.DB.prepare(
    `INSERT INTO workstation_pairing_codes (
       id,
       code_hash,
       owner_principal,
       principal_namespace,
       created_by_actor_label,
       created_at,
       expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      codeHash,
      input.ownerPrincipal,
      input.principalNamespace,
      input.actorLabel,
      now.toISOString(),
      expiresAt,
    )
    .run();
  return { id, code, expires_at: expiresAt };
}

export async function getWorkstationPairingCodeForOwner(
  env: Env,
  ownerPrincipal: string,
  pairingId: string,
): Promise<WorkstationPairingCodeRow | null> {
  if (!env.DB) {
    return null;
  }
  await ensureCatalogSchema(env);
  const row = await env.DB.prepare(
    `SELECT id,
            code_hash,
            owner_principal,
            principal_namespace,
            created_by_actor_label,
            created_at,
            expires_at,
            redeemed_at,
            workstation_id
       FROM workstation_pairing_codes
      WHERE id = ?
        AND owner_principal = ?`,
  )
    .bind(pairingId, ownerPrincipal)
    .first<WorkstationPairingCodeRow>();
  return row ?? null;
}

export function workstationPairingStatus(
  row: WorkstationPairingCodeRow,
  now: number,
): WorkstationPairingStatus {
  if (row.workstation_id) {
    return "registered";
  }
  if (row.redeemed_at) {
    return "redeemed";
  }
  if (Date.parse(row.expires_at) <= now) {
    return "expired";
  }
  return "pending";
}

export interface RedeemedWorkstationCredential {
  token: string;
  credential_id: string;
  pairing_code_id: string;
  owner_principal: string;
}

/**
 * Atomically consume a pairing code and mint the workstation credential.
 * Returns null when the code is unknown, expired, or already redeemed —
 * callers must not distinguish those cases in the response.
 */
export async function redeemWorkstationPairingCode(
  env: Env,
  code: string,
): Promise<RedeemedWorkstationCredential | null> {
  if (!env.DB) {
    return null;
  }
  await ensureCatalogSchema(env);

  const codeHash = await hashWorkstationSecret(normalizePairingCode(code));
  const token = generateWorkstationCredentialToken();
  const credentialId = crypto.randomUUID();
  const tokenHash = await hashWorkstationSecret(token);
  const now = new Date().toISOString();
  // One transaction: consume and mint commit together, so a transient
  // failure can never burn a code without producing its credential. The
  // INSERT joins on redeemed_by_credential_id — unique per request — rather
  // than the redeem timestamp, so a concurrent loser (whose UPDATE matched
  // nothing) cannot mint against the winner's same-millisecond consume.
  const [consumed] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE workstation_pairing_codes
          SET redeemed_at = ?,
              redeemed_by_credential_id = ?
        WHERE code_hash = ?
          AND redeemed_at IS NULL
          AND expires_at > ?
        RETURNING id, owner_principal, principal_namespace`,
    ).bind(now, credentialId, codeHash, now),
    env.DB.prepare(
      `INSERT INTO workstation_credentials (
         id,
         token_hash,
         owner_principal,
         principal_namespace,
         pairing_code_id,
         created_at
       )
       SELECT ?, ?, owner_principal, principal_namespace, id, ?
         FROM workstation_pairing_codes
        WHERE redeemed_by_credential_id = ?`,
    ).bind(credentialId, tokenHash, now, credentialId),
  ]);
  const pairing = (
    consumed?.results as
      | Array<Pick<WorkstationPairingCodeRow, "id" | "owner_principal" | "principal_namespace">>
      | undefined
  )?.[0];
  if (!pairing) {
    return null;
  }
  return {
    token,
    credential_id: credentialId,
    pairing_code_id: pairing.id,
    owner_principal: pairing.owner_principal,
  };
}

export interface WorkstationCredentialSummary {
  id: string;
  pairing_code_id: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export async function listWorkstationCredentialsForOwner(
  env: Env,
  ownerPrincipal: string,
): Promise<WorkstationCredentialSummary[]> {
  if (!env.DB) {
    return [];
  }
  await ensureCatalogSchema(env);
  const rows = await env.DB.prepare(
    `SELECT id,
            pairing_code_id,
            created_at,
            last_used_at,
            revoked_at
       FROM workstation_credentials
      WHERE owner_principal = ?
      ORDER BY created_at DESC`,
  )
    .bind(ownerPrincipal)
    .all<WorkstationCredentialSummary>();
  return rows.results ?? [];
}

export async function revokeWorkstationCredential(
  env: Env,
  ownerPrincipal: string,
  credentialId: string,
): Promise<boolean> {
  if (!env.DB) {
    return false;
  }
  await ensureCatalogSchema(env);
  const result = await env.DB.prepare(
    `UPDATE workstation_credentials
        SET revoked_at = ?
      WHERE id = ?
        AND owner_principal = ?
        AND revoked_at IS NULL`,
  )
    .bind(new Date().toISOString(), credentialId, ownerPrincipal)
    .run();
  return d1Changes(result) > 0;
}

function d1Changes(result: { meta: Record<string, unknown> }): number {
  const changes = result.meta?.["changes"];
  return typeof changes === "number" ? changes : 0;
}

export async function resolveWorkstationCredential(
  env: Env,
  token: string,
): Promise<WorkstationCredentialRow | null> {
  if (!env.DB) {
    return null;
  }
  await ensureCatalogSchema(env);
  const tokenHash = await hashWorkstationSecret(token);
  const row = await env.DB.prepare(
    `SELECT id,
            token_hash,
            owner_principal,
            principal_namespace,
            pairing_code_id,
            created_at,
            last_used_at,
            revoked_at
       FROM workstation_credentials
      WHERE token_hash = ?`,
  )
    .bind(tokenHash)
    .first<WorkstationCredentialRow>();
  if (!row || row.revoked_at) {
    return null;
  }

  const now = Date.now();
  const lastUsed = row.last_used_at ? Date.parse(row.last_used_at) : 0;
  // Heartbeats and job polls arrive every few seconds; refreshing
  // last_used_at on every request would double the surface's write volume
  // for a column that only needs operator-facing freshness.
  if (now - lastUsed > WORKSTATION_CREDENTIAL_LAST_USED_REFRESH_MS) {
    await env.DB.prepare(`UPDATE workstation_credentials SET last_used_at = ? WHERE id = ?`)
      .bind(new Date(now).toISOString(), row.id)
      .run();
  }
  return row;
}

/**
 * Record which workstation a pairing produced, so the panel dialog can move
 * from "redeemed" to "registered: <name>". First registration wins; later
 * heartbeats through the same credential are no-ops here.
 */
export async function linkWorkstationToPairing(
  env: Env,
  pairingCodeId: string,
  workstationId: string,
): Promise<void> {
  if (!env.DB) {
    return;
  }
  await env.DB.prepare(
    `UPDATE workstation_pairing_codes
        SET workstation_id = ?
      WHERE id = ?
        AND workstation_id IS NULL`,
  )
    .bind(workstationId, pairingCodeId)
    .run();
}

export function workstationCredentialTokenFromRequest(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) {
    return null;
  }
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  if (!token || !token.startsWith(WORKSTATION_CREDENTIAL_TOKEN_PREFIX)) {
    return null;
  }
  return token;
}

const WORKSTATION_CREDENTIAL_SCOPES: ReadonlySet<ConnectionScope> = new Set([
  "viewer",
  "runtime_peer",
]);

export async function authenticateWorkstationCredentialRequest(
  env: Env,
  request: Request,
  token: string,
): Promise<AuthenticatedConnection> {
  const credential = await resolveWorkstationCredential(env, token);
  if (!credential) {
    throw new AuthError("workstation credential is not recognized", 401);
  }

  const url = new URL(request.url);
  const scopeValue = request.headers.get("x-scope") ?? url.searchParams.get("scope") ?? "viewer";
  const scope = parseScope(scopeValue);
  if (!WORKSTATION_CREDENTIAL_SCOPES.has(scope)) {
    throw new AuthError(`workstation credentials cannot request ${scope} scope`, 403);
  }

  const operator =
    request.headers.get("x-operator") ??
    url.searchParams.get("operator") ??
    DEFAULT_WORKSTATION_OPERATOR;
  validateOperator(operator);

  return {
    principal: credential.owner_principal,
    operator,
    actorLabel: `${credential.owner_principal}/${operator}`,
    scope,
    metadata: {
      provider: "workstation-credential",
      transport: "workstation-credential-header",
      principalNamespace: credential.principal_namespace,
      workstationCredentialId: credential.id,
      ...(credential.pairing_code_id
        ? { workstationPairingCodeId: credential.pairing_code_id }
        : {}),
    },
  };
}
