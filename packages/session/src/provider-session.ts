import type { AuthenticatedConnection } from "@nteract/identity";
import { createServerAppSession, type AppSessionEnvironment } from "./app-session.ts";
import {
  SERVER_SESSION_ABSOLUTE_SECONDS,
  SERVER_SESSION_IDLE_SECONDS,
  oidcDatabase,
  randomSecret,
  sealServerSecret,
  serverSessionContext,
  serverSessionCookie,
  serverSessionId,
  type ServerSessionRow,
} from "./oidc-session-store.ts";
import type { SessionDatabase } from "./session-database.ts";
import { sessionKeyring } from "./session-keyring.ts";

/**
 * The provider ended the grant behind a session: its refresh token is spent,
 * revoked or unknown. The session is deleted and the browser signs in again.
 */
export class ServerSessionGrantRejected extends Error {}

/**
 * What a sign-in proved, and what renewing it needs. `expiresAt` (seconds) is
 * when the provider's proof lapses and the session must be refreshed. `bundle`
 * is sealed into the session row and handed back to the provider's `refresh`;
 * it is the only place a provider credential is stored.
 */
export interface ServerSessionGrant {
  identity: AuthenticatedConnection;
  expiresAt: number;
  bundle: Record<string, unknown>;
}

/**
 * A sign-in method that is not OIDC. The application runs the sign-in itself
 * and calls `createServerSession`; the session then lives in the same rows,
 * under the same cookie, lease and expiry rules as an OIDC session. A
 * deployment uses one method, so `refresh` must reject a bundle it didn't
 * issue. Rows don't record which method made them: after a deployment changes
 * its method, a session from the old one stays valid until its proof lapses,
 * unless its row is deleted.
 */
export interface ServerSessionProvider {
  /**
   * Exchanges a session's sealed bundle for a fresh grant. It runs under the
   * row's refresh lease, which keeps every other request from exchanging the
   * same bundle. Finish well inside the lease: once it lapses, a request that
   * sees it deletes the session, and a grant returned after that delete is
   * discarded. Throw `ServerSessionGrantRejected` when the provider ended the
   * grant, or `ServerOidcIdentityRejected` (apps/notebook-cloud
   * server-oidc.ts, the refresh driver) when the application refuses the
   * account; both delete the session. Any other error keeps the
   * row, and the same bundle is handed to `refresh` again after a backoff, so
   * a provider whose credential rotates must tolerate a repeat of an exchange
   * whose answer was lost. The grant must name the principal the session
   * already has; one that names another ends the session.
   */
  refresh(bundle: Record<string, unknown>): Promise<ServerSessionGrant>;
}

/** The environment a provider session is stored under. */
export interface ProviderSessionEnvironment extends AppSessionEnvironment {
  DB?: SessionDatabase;
}

export interface ProviderSessionOptions {
  /** Keep the verified address sealed for the signed-in person's own account menu. */
  retainAccountEmail?: boolean;
  /** Told about the sign-in, for an application's audit log. Never fails it. */
  onAuthEvent?: (event: { type: "sign_in"; principal: string }) => void;
}

/**
 * A provider's grant, checked before anything acts on the identity in it, and
 * returned with the bundle exactly as it will be sealed. A malformed grant
 * throws a plain error: at sign-in nothing is stored, and at renewal the row
 * keeps the bundle it has and the provider is asked again. `session` is the
 * row being renewed; a grant for another principal or namespace than the one
 * it holds is rejected, which ends the session.
 */
export function checkedProviderGrant(
  grant: ServerSessionGrant,
  now: number,
  session?: ServerSessionRow,
): ServerSessionGrant {
  const { principal, metadata } = grant.identity;
  const namespace = metadata?.principalNamespace;
  // The length bound is `revokeServerSessionsFor`'s: every stored session
  // must be one that sign-out-everywhere can name.
  if (
    typeof principal !== "string" ||
    !principal ||
    principal.length > 512 ||
    typeof namespace !== "string" ||
    !namespace
  )
    throw new Error("Server session grant names no usable principal");
  if (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= now)
    throw new Error("Server session grant is already expired");
  // Sealing stringifies the bundle, and renewal parses it back into a record.
  // A value that doesn't survive that would end the session at its next renewal.
  let bundle: unknown;
  try {
    bundle = JSON.parse(JSON.stringify(grant.bundle));
  } catch {
    bundle = undefined;
  }
  if (typeof bundle !== "object" || bundle === null || Array.isArray(bundle))
    throw new Error("Server session grant bundle is not a JSON record");
  if (session) {
    let held: { principal?: unknown; principalNamespace?: unknown } = {};
    try {
      held = JSON.parse(session.session_json);
    } catch {
      // An unreadable row holds no principal a grant could continue.
    }
    if (held.principal !== principal || held.principalNamespace !== namespace)
      throw new ServerSessionGrantRejected();
  }
  return { ...grant, bundle: bundle as Record<string, unknown> };
}

/** Stores a new session for `grant` and returns its `Set-Cookie` value. */
export async function insertServerSession(
  env: ProviderSessionEnvironment,
  db: SessionDatabase,
  context: string,
  now: number,
  grant: ServerSessionGrant,
  options: { retainAccountEmail?: boolean },
): Promise<string> {
  const sessionToken = randomSecret(),
    id = await serverSessionId(env, sessionToken);
  const session = await createServerAppSession(
    env,
    grant.identity,
    id,
    Math.min(grant.expiresAt, now + SERVER_SESSION_IDLE_SECONDS),
    now,
    options,
  );
  await db
    .prepare(
      `INSERT INTO oidc_server_sessions (id, context, session_json, sealed, access_expires_at, idle_expires_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      context,
      JSON.stringify(session),
      await sealServerSecret(env, grant.bundle, `session:${id}:${context}`),
      grant.expiresAt,
      now + SERVER_SESSION_IDLE_SECONDS,
      now + SERVER_SESSION_ABSOLUTE_SECONDS,
    )
    .run();
  return serverSessionCookie(sessionToken);
}

/**
 * The context of a session row in a deployment whose sign-in is a
 * `ServerSessionProvider`. It is the one `loadServerSession` expects, and it
 * refuses a deployment without the storage and keys a session needs.
 */
export function providerSessionContext(env: ProviderSessionEnvironment, request: Request): string {
  // A malformed keyring throws its own error here rather than reading as unset.
  if (!env.DB || !sessionKeyring(env)) throw new Error("Server sign-in is not configured");
  return serverSessionContext(
    env,
    new URL(env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN?.trim() || request.url).origin,
  );
}

/**
 * Starts a session for a sign-in the application completed with its own
 * `ServerSessionProvider`, and returns the `Set-Cookie` value that carries it.
 * The caller has already verified `grant.identity` with the provider and bound
 * the sign-in to this browser; nothing here checks either. Pass the same
 * provider to the refresh driver so the session can be renewed.
 */
export async function createServerSession(
  request: Request,
  env: ProviderSessionEnvironment,
  grant: ServerSessionGrant,
  options: ProviderSessionOptions = {},
): Promise<string> {
  const context = providerSessionContext(env, request);
  const now = Math.floor(Date.now() / 1000);
  const checked = checkedProviderGrant(grant, now);
  const cookie = await insertServerSession(
    env,
    await oidcDatabase(env),
    context,
    now,
    checked,
    options,
  );
  try {
    options.onAuthEvent?.({ type: "sign_in", principal: grant.identity.principal });
  } catch {
    // Audit delivery is best effort.
  }
  return cookie;
}
