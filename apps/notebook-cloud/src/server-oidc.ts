import type { D1Database, Env as NotebookEnvironment } from "./cloudflare-types.ts";
import {
  appSessionAccountKey,
  APP_SESSION_ACCOUNT_KEY_HEADER,
  createServerAppSession,
  type CloudAppSession,
} from "./app-session.ts";
import { readCanonicalPrincipalForSession } from "./storage.ts";
import {
  AuthError,
  authenticateOidcRequest,
  encodePrincipalComponent,
  verifyOidcIdToken,
  type AuthenticatedConnection,
} from "./identity.ts";
import { OidcUserInfoError } from "./oidc-userinfo.ts";
import {
  cookieValue,
  conditionalSessionUpdate,
  loadServerSession,
  oidcDatabase,
  openServerSecret,
  randomSecret,
  revokeServerSession,
  sealServerSecret,
  secretHash,
  serverSessionContext,
  serverSessionId,
  serverSessionCookie,
  touchServerSession,
  SERVER_SESSION_COOKIE,
  SERVER_SESSION_IDLE_SECONDS,
  SERVER_SESSION_ABSOLUTE_SECONDS,
  type ServerSessionRow,
} from "./oidc-session-store.ts";
import { cloudLog } from "./observability.ts";
import { SessionKeyringError, sessionKeyring } from "./session-keyring.ts";

// Server login also serves small celld applications without notebook rooms.
export type ServerOidcEnvironment = Omit<NotebookEnvironment, "NOTEBOOK_ROOMS">;
type Env = ServerOidcEnvironment;

const LOGIN_COOKIE = "__Host-nteract_cloud_oidc_login";
const LOGIN_SECONDS = 600;
// The browser checks once a minute. Leave another minute for scheduling/network
// delay rather than waiting until a request is already about to lose authority.
const REFRESH_WINDOW_SECONDS = 120;
// How long one request owns a session's renewal before another may take over.
const REFRESH_LEASE_SECONDS = 120;

interface Config {
  issuer: string;
  clientId: string;
  origin: string;
  callback: string;
  context: string;
  authMethod: "none" | "client_secret_basic" | "client_secret_post";
}
interface LoginTransaction {
  verifier: string;
  nonce: string;
  returnTo: string;
}
interface TokenBundle {
  refreshToken?: string;
  nonce: string;
  subject: string;
}
interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  token_type: string;
}
interface ProviderMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
}
class ProviderUnavailable extends Error {
  constructor(readonly status?: number) {
    super("Provider unavailable");
  }
}
/**
 * The provider ended the grant behind a session: its refresh token is spent,
 * revoked or unknown. The session is deleted and the browser signs in again.
 */
export class ServerSessionGrantRejected extends Error {}

/**
 * Why a callback was refused before any provider exchange. These codes are the
 * only callback detail that reaches logs; the browser sees a generic page.
 *
 * - `provider_error`: the provider returned `error=` instead of a code.
 * - `callback_malformed`: state or code is missing, repeated or badly formed.
 * - `login_binding_missing`: this browser has no login cookie, so sign-in began
 *   in another browser context (an in-app browser, another profile) or the
 *   cookie expired.
 * - `login_transaction_missing`: no live transaction matches this state, cookie
 *   and origin. It expired, was already used, or a later sign-in replaced it.
 */
type CallbackRejection =
  | "provider_error"
  | "callback_malformed"
  | "login_binding_missing"
  | "login_transaction_missing";
class CallbackRejected extends Error {
  constructor(readonly reason: CallbackRejection) {
    super("Sign-in callback rejected");
  }
}

export interface ServerOidcCallbackFailure {
  status: 400 | 403;
  /** The application refused this account. Signing in again with it will fail. */
  accountRejected: boolean;
}

export interface ServerOidcCallbackOptions {
  /**
   * Same-origin path for a browser that already holds a session when a stale or
   * repeated callback arrives. Defaults to `/`.
   */
  homePath?: string;
  /** Renders the browser-facing failure. It gets no failure detail, only its class. */
  failurePage?: (failure: ServerOidcCallbackFailure) => Response;
  /** Receives sign-in outcomes for an application's audit log. */
  onAuthEvent?: ServerOidcAuthEventListener;
}

/**
 * Sign-in and session outcomes for an application's audit log. Fields are a
 * principal and coded enums only: no tokens, state, cookies, emails or provider
 * detail.
 *
 * - `sign_in`: a callback created a session.
 * - `sign_in_failed`: a callback was refused. `reason` is a coded cause when
 *   one is known (the same code `auth.server_callback.failed` logs), and
 *   `outcome` says whether the browser was sent home because it already had a
 *   session (`already_signed_in`) or shown the failure page (`failure_page`).
 * - `session_expired`: a session in use ended because the provider refused
 *   its refresh (`refresh_rejected`), refused the account
 *   (`identity_rejected`), a refresh owner crashed (`lease_abandoned`), or
 *   its sealed refresh token no longer opens (`seal_unreadable`): a key it
 *   names was retired, or a build without the keyring meets a `kid.` seal.
 */
export type ServerOidcAuthEvent =
  | { type: "sign_in"; principal: string }
  | {
      type: "sign_in_failed";
      phase: string;
      kind: string;
      reason?: string;
      outcome: "already_signed_in" | "failure_page";
    }
  | {
      type: "session_expired";
      principal?: string;
      reason: "refresh_rejected" | "identity_rejected" | "lease_abandoned" | "seal_unreadable";
    };
export type ServerOidcAuthEventListener = (event: ServerOidcAuthEvent) => void;

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
   * row's refresh lease, which keeps other requests from exchanging the same
   * bundle for `REFRESH_LEASE_SECONDS`; finish well inside that, because a
   * request can take the row over once the lease lapses. Throw
   * `ServerSessionGrantRejected` when the provider ended the grant, or
   * `ServerOidcIdentityRejected` when the application refuses the account;
   * both delete the session. Any other error keeps the row, and the same
   * bundle is handed to `refresh` again after a backoff, so a provider whose
   * credential rotates must tolerate a repeat of an exchange whose answer was
   * lost. The grant must name the principal the session already has; one that
   * names another ends the session.
   */
  refresh(bundle: Record<string, unknown>): Promise<ServerSessionGrant>;
}

export interface ServerOidcSessionOptions {
  /** Receives session expiry outcomes for an application's audit log. */
  onAuthEvent?: ServerOidcAuthEventListener;
  /** Renews sessions with this provider in place of the OIDC token endpoint. */
  provider?: ServerSessionProvider;
}

/** A listener never fails or changes the sign-in flow. */
function notifyAuthEvent(
  listener: ServerOidcAuthEventListener | undefined,
  event: ServerOidcAuthEvent,
): void {
  if (!listener) return;
  try {
    listener(event);
  } catch {
    // Audit delivery is best effort.
  }
}

function sessionPrincipal(row: ServerSessionRow): string | undefined {
  try {
    const principal = (JSON.parse(row.session_json) as { principal?: unknown }).principal;
    return typeof principal === "string" ? principal : undefined;
  } catch {
    return undefined;
  }
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/**
 * A self-contained HTML sign-in failure page. Browsers render it in place; a
 * `text/plain` error on a top-level navigation is offered as a download by
 * iOS Safari.
 */
export function serverOidcCallbackFailurePage(
  failure: ServerOidcCallbackFailure,
  links: { siteName?: string; homePath?: string; loginPath?: string } = {},
): Response {
  const siteName = links.siteName ?? "the notebook site";
  const message = failure.accountRejected
    ? "This account cannot access this application. Sign in with an allowed account."
    : "Sign-in could not be completed. Start again from this browser.";
  return privateResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign-in failed</title></head><body><main><h1>Sign-in failed</h1><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(links.loginPath ?? "/api/auth/oidc/login")}">Sign in again</a></p><p><a href="${escapeHtml(links.homePath ?? "/")}">Return to ${escapeHtml(siteName)}</a></p></main></body></html>`,
    failure.status,
    {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  );
}

/** An application's explicit access rejection, not a retryable profile-write failure. */
export class ServerOidcIdentityRejected extends AuthError {
  constructor() {
    super("This account cannot access this application", 403);
  }
}

// Match only complete, source-owned messages. Prefix matching or logging an
// exception itself could expose a token, provider response, or identity claim.
const VALIDATION_FAILURE_REASONS = new Map<string, string>([
  ["Missing ID token", "id_token_missing"],
  ["OIDC subject mismatch", "token_subject_mismatch"],
  ["OIDC ID token issuer is invalid", "id_token_issuer_invalid"],
  ["OIDC ID token token use is invalid", "id_token_use_invalid"],
  ["OIDC ID token audience is invalid", "id_token_audience_invalid"],
  ["OIDC ID token authorized party is invalid", "id_token_authorized_party_invalid"],
  ["OIDC ID token subject is invalid", "id_token_subject_invalid"],
  ["OIDC ID token issued-at time is invalid", "id_token_issued_at_invalid"],
  ["OIDC ID token expiry is invalid", "id_token_expiry_invalid"],
  ["OIDC ID token not-before time is invalid", "id_token_not_before_invalid"],
  ["OIDC ID token expected nonce is invalid", "id_token_expected_nonce_invalid"],
  ["OIDC ID token nonce is invalid", "id_token_nonce_invalid"],
  ["OIDC token must use RS256", "token_algorithm_invalid"],
  ["OIDC token signature is invalid", "token_signature_invalid"],
  ["OIDC signing key was not found", "token_signing_key_missing"],
  ["OIDC token must be a JWT", "token_format_invalid"],
  ["OIDC token contains invalid base64url JSON", "token_encoding_invalid"],
  ["OIDC token issuer is invalid", "access_token_issuer_invalid"],
  ["OIDC token is not an access token", "access_token_use_invalid"],
  ["OIDC token audience is invalid", "access_token_audience_invalid"],
  ["OIDC token authorized party is invalid", "access_token_authorized_party_invalid"],
  ["OIDC token client is invalid", "access_token_client_invalid"],
  ["OIDC token is expired", "access_token_expired"],
  ["OIDC token is not valid yet", "access_token_not_before_invalid"],
  ["OIDC token is missing sub", "access_token_subject_missing"],
  ["OIDC token sub is too long", "access_token_subject_invalid"],
  ["missing OIDC token", "access_token_missing"],
  ["OIDC auth is not configured", "oidc_not_configured"],
  ["OIDC discovery document is invalid", "discovery_document_invalid"],
  ["OIDC discovery issuer is invalid", "discovery_issuer_invalid"],
  ["OIDC discovery issuer mismatch", "discovery_issuer_invalid"],
  ["OIDC discovery timed out", "discovery_timeout"],
  ["OIDC JWKS fetch timed out", "jwks_timeout"],
  ["OIDC discovery JWKS URL is invalid", "jwks_url_invalid"],
  ["OIDC discovery JWKS URL must use https without credentials or fragments", "jwks_url_untrusted"],
  ["OIDC UserInfo endpoint or trusted origin is invalid", "userinfo_endpoint_invalid"],
  ["OIDC UserInfo endpoint must use its trusted https origin", "userinfo_endpoint_untrusted"],
  ["OIDC access token is expired", "userinfo_access_token_expired"],
  ["OIDC UserInfo request failed", "userinfo_request_failed"],
  ["OIDC UserInfo request timed out", "userinfo_request_timeout"],
  ["OIDC UserInfo response must be JSON", "userinfo_content_type_invalid"],
  ["OIDC UserInfo response is empty", "userinfo_response_empty"],
  ["OIDC UserInfo response is too large", "userinfo_response_too_large"],
  ["OIDC UserInfo response is invalid", "userinfo_response_invalid"],
  ["OIDC UserInfo subject is invalid", "userinfo_subject_invalid"],
  ["OIDC UserInfo profile claim is invalid", "userinfo_profile_invalid"],
  ["OIDC UserInfo email verification claim is invalid", "userinfo_email_verification_invalid"],
  ["OIDC UserInfo email is invalid", "userinfo_email_invalid"],
  ["OIDC UserInfo picture is invalid", "userinfo_picture_invalid"],
]);

function logFailure(
  event: string,
  phase: string,
  error: unknown,
): { kind: string; reason?: string } {
  // Provider bodies, exception messages, URLs, subjects and tokens never enter logs.
  const reason =
    error instanceof CallbackRejected
      ? error.reason
      : error instanceof Error
        ? (VALIDATION_FAILURE_REASONS.get(error.message) ??
          (error instanceof AuthError
            ? "oidc_auth_validation_failed"
            : error instanceof OidcUserInfoError
              ? "oidc_userinfo_validation_failed"
              : undefined))
        : undefined;
  const kind =
    error instanceof CallbackRejected
      ? "callback_rejected"
      : error instanceof ServerSessionGrantRejected
        ? "grant_rejected"
        : error instanceof ProviderUnavailable
          ? "provider_unavailable"
          : "validation_or_storage";
  cloudLog("warn", event, {
    phase,
    kind,
    ...(reason ? { reason } : {}),
    ...(error instanceof ProviderUnavailable && error.status
      ? { provider_status: error.status }
      : {}),
  });
  return { kind, ...(reason ? { reason } : {}) };
}

function configFor(env: Env, request: Request): Config {
  const issuer = env.NOTEBOOK_CLOUD_OIDC_ISSUER?.trim();
  const clientId = env.NOTEBOOK_CLOUD_OIDC_CLIENT_ID?.trim();
  // A malformed keyring throws its own error here rather than reading as unset.
  if (!issuer || !clientId || !env.DB || !sessionKeyring(env)) {
    throw new Error("Server sign-in is not configured");
  }
  const origin = new URL(env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN?.trim() || request.url).origin;
  const callback = env.NOTEBOOK_CLOUD_OIDC_REDIRECT_URI?.trim() || `${origin}/oidc`;
  const parsedCallback = new URL(callback);
  if (
    parsedCallback.origin !== origin ||
    parsedCallback.pathname !== "/oidc" ||
    parsedCallback.search ||
    parsedCallback.hash
  ) {
    throw new Error("Server sign-in callback must use this deployment's /oidc route");
  }
  for (const url of [new URL(issuer), new URL(origin)]) {
    const local =
      env.NOTEBOOK_CLOUD_LOCAL_OIDC === "true" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("Server sign-in requires trusted HTTPS URLs");
    }
  }
  const authMethod =
    env.NOTEBOOK_CLOUD_OIDC_TOKEN_AUTH_METHOD ||
    (env.NOTEBOOK_CLOUD_OIDC_CLIENT_SECRET ? "client_secret_basic" : "none");
  if (
    !["none", "client_secret_basic", "client_secret_post"].includes(authMethod) ||
    (authMethod !== "none" && !env.NOTEBOOK_CLOUD_OIDC_CLIENT_SECRET)
  )
    throw new Error("Invalid token authentication configuration");
  return {
    issuer,
    clientId,
    origin,
    callback,
    context: serverSessionContext(env, origin),
    authMethod: authMethod as Config["authMethod"],
  };
}

async function providerMetadata(config: Config): Promise<ProviderMetadata> {
  const response = await providerFetch(
    `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
  );
  if (!response.ok) throw new ProviderUnavailable(response.status);
  const metadata = (await response.json()) as Record<string, unknown>;
  if (metadata.issuer !== config.issuer) throw new Error("OIDC discovery issuer mismatch");
  const endpoint = (key: string): string => {
    if (typeof metadata[key] !== "string") throw new Error("Missing OIDC endpoint");
    const url = new URL(metadata[key]);
    // Credentials only go to the operator-configured issuer origin. A provider
    // using another token origin needs an explicit future allowlist, not a redirect.
    if (url.origin !== new URL(config.issuer).origin || url.username || url.password || url.hash)
      throw new Error("Untrusted OIDC endpoint");
    return url.href;
  };
  return {
    authorization_endpoint: endpoint("authorization_endpoint"),
    token_endpoint: endpoint("token_endpoint"),
  };
}

async function providerFetch(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("User-Agent", "nteract-notebook-cloud/1.0");
    // Inspect redirects without following them. Authorization codes, verifiers,
    // refresh tokens and client secrets must stay at the configured endpoint.
    const response = await fetch(url, {
      ...init,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => {});
      throw new ProviderUnavailable(response.status);
    }
    return response;
  } catch (error) {
    if (error instanceof ProviderUnavailable) throw error;
    throw new ProviderUnavailable();
  }
}

function privateResponse(
  body: BodyInit | null,
  status: number,
  headers: HeadersInit = {},
): Response {
  const responseHeaders = new Headers(headers);
  if (typeof body === "string" && !responseHeaders.has("Content-Type"))
    responseHeaders.set("Content-Type", "text/plain; charset=utf-8");
  const response = new Response(body, { status, headers: responseHeaders });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}
function loginCookie(token: string, maxAge = LOGIN_SECONDS): string {
  return `${LOGIN_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
function safeReturnTo(value: string | null, origin: string): string {
  if (!value?.startsWith("/") || value.startsWith("//") || /[\\\r\n]/.test(value)) return "/";
  const url = new URL(value, origin);
  if (url.origin !== origin || url.pathname === "/oidc" || url.pathname.startsWith("/api/auth/"))
    return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}

export async function beginServerOidcLogin(request: Request, env: Env): Promise<Response> {
  let phase = "configuration";
  try {
    const config = configFor(env, request);
    const origin = request.headers.get("Origin");
    if (
      (origin && origin !== config.origin) ||
      request.headers.get("Sec-Fetch-Site") === "cross-site"
    ) {
      return privateResponse("Start sign-in from this notebook site.", 403);
    }
    phase = "discovery";
    const metadata = await providerMetadata(config);
    phase = "login_transaction";
    const db = await oidcDatabase(env);
    const now = Math.floor(Date.now() / 1000);
    const state = randomSecret(),
      binding = randomSecret();
    const transaction: LoginTransaction = {
      verifier: randomSecret(),
      nonce: randomSecret(),
      returnTo: safeReturnTo(new URL(request.url).searchParams.get("return_to"), config.origin),
    };
    const stateHash = await secretHash(state);
    await db.batch([
      db.prepare("DELETE FROM oidc_login_transactions WHERE expires_at <= ?").bind(now),
      db
        .prepare(
          "DELETE FROM oidc_server_sessions WHERE idle_expires_at <= ? OR absolute_expires_at <= ?",
        )
        .bind(now, now),
      db
        .prepare(
          `INSERT INTO oidc_login_transactions (state_hash, binding_hash, context, sealed, expires_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          stateHash,
          await secretHash(binding),
          config.context,
          await sealServerSecret(env, transaction, `login:${stateHash}:${config.context}`),
          now + LOGIN_SECONDS,
        ),
    ]);
    const url = new URL(metadata.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.callback,
      response_type: "code",
      scope: "openid email profile offline_access",
      state,
      nonce: transaction.nonce,
      code_challenge_method: "S256",
      code_challenge: await secretHash(transaction.verifier),
    }).toString();
    return privateResponse(null, 302, { Location: url.href, "Set-Cookie": loginCookie(binding) });
  } catch (error) {
    logFailure("auth.server_login.failed", phase, error);
    return privateResponse("Sign-in is temporarily unavailable. Please try again.", 503);
  }
}

async function exchangeToken(
  env: Env,
  config: Config,
  endpoint: string,
  params: URLSearchParams,
): Promise<TokenResponse> {
  const headers = new Headers({
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  });
  params.set("client_id", config.clientId);
  if (config.authMethod === "client_secret_basic") {
    const formEncode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
    headers.set(
      "Authorization",
      `Basic ${btoa(`${formEncode(config.clientId)}:${formEncode(env.NOTEBOOK_CLOUD_OIDC_CLIENT_SECRET!)}`)}`,
    );
  } else if (config.authMethod === "client_secret_post") {
    params.set("client_secret", env.NOTEBOOK_CLOUD_OIDC_CLIENT_SECRET!);
  }
  const response = await providerFetch(endpoint, { method: "POST", headers, body: params });
  if (response.status === 429 || response.status >= 500)
    throw new ProviderUnavailable(response.status);
  const value = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const code =
      typeof value?.error === "object" && value.error !== null && "code" in value.error
        ? value.error.code
        : value?.error;
    // Anaconda's production Auth Service uses auth_required for an unknown or
    // expired refresh session. Other client/configuration errors remain retryable.
    if (
      code === "invalid_grant" ||
      (response.status === 403 &&
        code === "auth_required" &&
        params.get("grant_type") === "refresh_token")
    )
      throw new ServerSessionGrantRejected();
    throw new ProviderUnavailable(response.status);
  }
  if (
    !value ||
    typeof value.access_token !== "string" ||
    value.token_type?.toString().toLowerCase() !== "bearer" ||
    typeof value.expires_in !== "number" ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0 ||
    (value.refresh_token !== undefined && typeof value.refresh_token !== "string") ||
    (value.id_token !== undefined && typeof value.id_token !== "string")
  )
    throw new Error("Invalid token response");
  return value as unknown as TokenResponse;
}

async function validatedIdentity(
  env: Env,
  config: Config,
  tokens: TokenResponse,
  nonce: string,
  subject?: string,
): Promise<{ identity: AuthenticatedConnection; subject: string; expiresAt: number }> {
  if (!subject && !tokens.id_token) throw new Error("Missing ID token");
  const claims = tokens.id_token
    ? await verifyOidcIdToken(env, tokens.id_token, {
        nonce,
        ...(subject ? { subject, allowMissingNonce: true } : {}),
      })
    : null;
  const expectedSubject = claims?.sub ?? subject!;
  const identity = await authenticateOidcRequest(
    new Request(`${config.origin}/api/auth/session`, {
      headers: { Authorization: `Bearer ${tokens.access_token}`, "x-operator": "server-oidc" },
    }),
    env,
  );
  if (
    identity.principal !==
    `${identity.metadata.principalNamespace}:${encodePrincipalComponent(expectedSubject)}`
  )
    throw new Error("OIDC subject mismatch");
  // The access JWT was fully verified above; its expiry also bounds our session.
  const payload = JSON.parse(
    atob(tokens.access_token.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/")),
  );
  const expiresAt = Math.min(payload.exp, Math.floor(Date.now() / 1000) + tokens.expires_in);
  return { identity, subject: expectedSubject, expiresAt };
}

export async function completeServerOidcLogin(
  request: Request,
  env: Env,
  syncProfile: (identity: AuthenticatedConnection) => Promise<void>,
  options: ServerOidcCallbackOptions = {},
): Promise<Response> {
  if (request.method !== "GET") return privateResponse(null, 405);
  let response: Response;
  let phase = "configuration";
  let origin: string | undefined;
  try {
    const config = configFor(env, request);
    origin = config.origin;
    phase = "callback_transaction";
    const params = new URL(request.url).searchParams;
    const state = params.get("state"),
      code = params.get("code"),
      binding = cookieValue(request, LOGIN_COOKIE);
    if (params.has("error")) throw new CallbackRejected("provider_error");
    if (
      !state ||
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      !code ||
      params.getAll("state").length !== 1 ||
      params.getAll("code").length !== 1
    )
      throw new CallbackRejected("callback_malformed");
    if (!binding) throw new CallbackRejected("login_binding_missing");
    const db = await oidcDatabase(env);
    const stateHash = await secretHash(state),
      now = Math.floor(Date.now() / 1000);
    // DELETE RETURNING makes the transaction single-use across processes/nodes.
    const row = await db
      .prepare(
        `DELETE FROM oidc_login_transactions WHERE state_hash = ? AND binding_hash = ? AND context = ? AND expires_at > ? RETURNING sealed`,
      )
      .bind(stateHash, await secretHash(binding), config.context, now)
      .first<{ sealed: string }>();
    if (!row) throw new CallbackRejected("login_transaction_missing");
    const transaction = await openServerSecret<LoginTransaction>(
      env,
      row.sealed,
      `login:${stateHash}:${config.context}`,
    );
    phase = "discovery";
    const metadata = await providerMetadata(config);
    phase = "token_exchange";
    const tokens = await exchangeToken(
      env,
      config,
      metadata.token_endpoint,
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.callback,
        code_verifier: transaction.verifier,
      }),
    );
    phase = "identity_validation";
    const verified = await validatedIdentity(env, config, tokens, transaction.nonce);
    phase = "session_storage";
    await syncProfile(verified.identity);
    const bundle: TokenBundle = {
      refreshToken: tokens.refresh_token,
      nonce: transaction.nonce,
      subject: verified.subject,
    };
    const cookie = await insertServerSession(env, db, config.context, now, {
      identity: verified.identity,
      expiresAt: verified.expiresAt,
      bundle: { ...bundle },
    });
    response = privateResponse(null, 303, {
      Location: safeReturnTo(transaction.returnTo, config.origin),
      "Set-Cookie": cookie,
    });
    notifyAuthEvent(options.onAuthEvent, {
      type: "sign_in",
      principal: verified.identity.principal,
    });
  } catch (error) {
    const failure = logFailure("auth.server_callback.failed", phase, error);
    const home =
      origin && error instanceof CallbackRejected
        ? await signedInRedirect(request, env, origin, options.homePath)
        : null;
    notifyAuthEvent(options.onAuthEvent, {
      type: "sign_in_failed",
      phase,
      ...failure,
      outcome: home ? "already_signed_in" : "failure_page",
    });
    response =
      home ??
      (options.failurePage ?? serverOidcCallbackFailurePage)(
        error instanceof ServerOidcIdentityRejected
          ? { status: 403, accountRejected: true }
          : { status: 400, accountRejected: false },
      );
  }
  response.headers.append("Set-Cookie", loginCookie("", 0));
  return response;
}

/**
 * A provider's grant, checked before anything acts on the identity in it, and
 * returned with the bundle exactly as it will be sealed. A malformed grant
 * throws a plain error: at sign-in nothing is stored, and at renewal the row
 * keeps the bundle it has and the provider is asked again. `session` is the
 * row being renewed; a grant for another principal or namespace than the one
 * it holds is rejected, which ends the session.
 */
function checkedProviderGrant(
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
async function insertServerSession(
  env: Env,
  db: Awaited<ReturnType<typeof oidcDatabase>>,
  context: string,
  now: number,
  grant: ServerSessionGrant,
): Promise<string> {
  const sessionToken = randomSecret(),
    id = await serverSessionId(env, sessionToken);
  const session = await createServerAppSession(
    env,
    grant.identity,
    id,
    Math.min(grant.expiresAt, now + SERVER_SESSION_IDLE_SECONDS),
    now,
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
 * refuses a deployment without the storage and keys a session needs, as
 * `configFor` does for OIDC.
 */
function providerSessionContext(env: Env, request: Request): string {
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
 * provider to `serverOidcSessionStatus` so the session can be renewed.
 */
export async function createServerSession(
  request: Request,
  env: Env,
  grant: ServerSessionGrant,
  options: ServerOidcSessionOptions = {},
): Promise<string> {
  const context = providerSessionContext(env, request);
  const now = Math.floor(Date.now() / 1000);
  const checked = checkedProviderGrant(grant, now);
  const cookie = await insertServerSession(env, await oidcDatabase(env), context, now, checked);
  notifyAuthEvent(options.onAuthEvent, { type: "sign_in", principal: grant.identity.principal });
  return cookie;
}

/**
 * A browser can deliver a callback after its sign-in already finished: a
 * repeated redirect, a restored tab, or a second tab. If it already holds a
 * live session here, the refused callback changes nothing, so send it home
 * instead of reporting a failure for a sign-in that worked.
 */
async function signedInRedirect(
  request: Request,
  env: Env,
  origin: string,
  homePath = "/",
): Promise<Response | null> {
  try {
    if (!(await loadServerSession(env, request, Math.floor(Date.now() / 1000)))) return null;
  } catch {
    return null;
  }
  return privateResponse(null, 303, { Location: safeReturnTo(homePath, origin) });
}

export async function serverOidcSessionStatus(
  request: Request,
  env: Env,
  syncProfile: (identity: AuthenticatedConnection) => Promise<void>,
  options: ServerOidcSessionOptions = {},
): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  try {
    let row = await loadServerSession(env, request, now);
    if (row && row.access_expires_at <= now + REFRESH_WINDOW_SECONDS)
      row = await refreshSession(request, env, row, syncProfile, options);
    const current = Math.floor(Date.now() / 1000);
    if (row) row = await touchServerSession(env, request, row, current);
    const session: CloudAppSession | null =
      row && row.access_expires_at > current ? JSON.parse(row.session_json) : null;
    const response = privateResponse(
      JSON.stringify({
        ok: true,
        session: session
          ? {
              provider: session.provider,
              expires_at: session.expiresAt,
              cache_key: session.cacheKey,
              ...(request.headers.get(APP_SESSION_ACCOUNT_KEY_HEADER) === "1"
                ? {
                    account_key: await appSessionAccountKey(
                      env,
                      session,
                      (await readCanonicalPrincipalForSession(env, session.principal)) ??
                        session.principal,
                    ),
                  }
                : {}),
              ...(session.displayName ? { display_name: session.displayName } : {}),
            }
          : null,
      }),
      200,
      { "Content-Type": "application/json" },
    );
    if (row && session)
      response.headers.append(
        "Set-Cookie",
        serverSessionCookie(
          cookieValue(request, SERVER_SESSION_COOKIE)!,
          Math.max(0, row.idle_expires_at - current),
        ),
      );
    else response.headers.append("Set-Cookie", serverSessionCookie("", 0));
    return response;
  } catch (error) {
    if (error instanceof ServerOidcIdentityRejected)
      return privateResponse(JSON.stringify({ error: error.message }), 403, {
        "Content-Type": "application/json",
        "Set-Cookie": serverSessionCookie("", 0),
      });
    logFailure("auth.server_session.failed", "session_renewal", error);
    return privateResponse(
      JSON.stringify({ error: "Sign-in renewal is temporarily unavailable" }),
      503,
      { "Content-Type": "application/json", "Retry-After": "15" },
    );
  }
}

/** Exchanges an OIDC session's refresh token and re-validates who it names. */
async function refreshOidcGrant(
  env: Env,
  config: Config,
  bundle: TokenBundle,
): Promise<ServerSessionGrant> {
  const metadata = await providerMetadata(config);
  const tokens = await exchangeToken(
    env,
    config,
    metadata.token_endpoint,
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: bundle.refreshToken! }),
  );
  const verified = await validatedIdentity(env, config, tokens, bundle.nonce, bundle.subject);
  return {
    identity: verified.identity,
    expiresAt: verified.expiresAt,
    bundle: { ...bundle, refreshToken: tokens.refresh_token ?? bundle.refreshToken },
  };
}

async function refreshSession(
  request: Request,
  env: Env,
  initial: ServerSessionRow,
  syncProfile: (identity: AuthenticatedConnection) => Promise<void>,
  options: ServerOidcSessionOptions = {},
): Promise<ServerSessionRow | null> {
  const provider = options.provider;
  const config = provider ? null : configFor(env, request);
  const context = config?.context ?? providerSessionContext(env, request);
  const db = await oidcDatabase(env);
  const now = Math.floor(Date.now() / 1000);
  if (initial.retry_after > now) throw new ProviderUnavailable();
  if (initial.lease && initial.lease_until <= now) {
    // A crashed owner may have consumed a rotating refresh token. Do not let
    // another process reuse it, or let a late owner resurrect the session.
    return endAbandonedSession(db, initial, initial.lease, options);
  }
  let bundle: Record<string, unknown>;
  try {
    bundle = await openServerSecret<Record<string, unknown>>(
      env,
      initial.sealed,
      `session:${initial.id}:${context}`,
    );
  } catch (error) {
    // No key here opens it, so no later request can either: end the session
    // like any other expiry instead of failing every renewal. A malformed
    // keyring is a configuration fault and still fails the request.
    if (error instanceof SessionKeyringError) throw error;
    logFailure("auth.server_session.expired", "refresh", error);
    const removed = await db
      .prepare("DELETE FROM oidc_server_sessions WHERE id = ? AND generation = ?")
      .bind(initial.id, initial.generation)
      .run();
    if (removed.meta?.changes === 1)
      notifyAuthEvent(options.onAuthEvent, {
        type: "session_expired",
        principal: sessionPrincipal(initial),
        reason: "seal_unreadable",
      });
    return null;
  }
  // An OIDC provider may issue no refresh token; that session ends with its
  // access proof. A `ServerSessionProvider` decides from its own bundle.
  if (config && !bundle.refreshToken) return initial.access_expires_at > now ? initial : null;
  const lease = randomSecret();
  // Only an unleased row can be claimed. Every release clears `lease` or
  // deletes the row, so a row that still names one has an owner that may have
  // spent the refresh token, however long ago its `lease_until` passed.
  const claimed = await db
    .prepare(`UPDATE oidc_server_sessions SET lease = ?, lease_until = ?
    WHERE id = ? AND generation = ? AND lease IS NULL AND lease_until <= ? AND retry_after <= ? AND idle_expires_at > ? AND absolute_expires_at > ?`)
    .bind(lease, now + REFRESH_LEASE_SECONDS, initial.id, initial.generation, now, now, now, now)
    .run();
  if (claimed.meta.changes !== 1) {
    // Another node may own a rotating refresh token. Never exchange it twice.
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const row = await loadServerSession(env, request, Math.floor(Date.now() / 1000));
      if (!row || row.generation !== initial.generation) return row;
      const current = Math.floor(Date.now() / 1000);
      if (row.retry_after > current) throw new ProviderUnavailable();
      // The owner's lease lapsed before this request's claim or during this
      // wait. The row is as abandoned as one a new request would find.
      if (row.lease && row.lease_until <= current)
        return endAbandonedSession(db, row, row.lease, options);
    }
    throw new ProviderUnavailable();
  }
  try {
    // A provider's grant is checked before the profile callback sees its
    // identity. OIDC proves the same continuity in `validatedIdentity`.
    const verified = config
      ? await refreshOidcGrant(env, config, bundle as unknown as TokenBundle)
      : checkedProviderGrant(
          await provider!.refresh(bundle),
          Math.floor(Date.now() / 1000),
          initial,
        );
    await syncProfile(verified.identity);
    const refreshedAt = Math.floor(Date.now() / 1000);
    // The profile callback may have outlasted a short provider proof.
    if (!config && verified.expiresAt <= refreshedAt)
      throw new Error("Server session grant is already expired");
    const idleExpiry = Math.min(
      refreshedAt + SERVER_SESSION_IDLE_SECONDS,
      initial.absolute_expires_at,
    );
    const session = await createServerAppSession(
      env,
      verified.identity,
      initial.id,
      Math.min(verified.expiresAt, idleExpiry),
      refreshedAt,
    );
    const saved = await conditionalSessionUpdate(
      db,
      initial,
      lease,
      "session_json = ?, sealed = ?, access_expires_at = ?, idle_expires_at = ?, generation = generation + 1, lease = NULL, lease_until = 0, retry_after = 0",
      [
        JSON.stringify(session),
        await sealServerSecret(env, verified.bundle, `session:${initial.id}:${context}`),
        verified.expiresAt,
        idleExpiry,
      ],
    );
    return saved ? loadServerSession(env, request, refreshedAt) : null;
  } catch (error) {
    if (
      error instanceof ServerSessionGrantRejected ||
      error instanceof ServerOidcIdentityRejected
    ) {
      logFailure("auth.server_session.expired", "refresh", error);
      await db
        .prepare("DELETE FROM oidc_server_sessions WHERE id = ? AND generation = ? AND lease = ?")
        .bind(initial.id, initial.generation, lease)
        .run();
      notifyAuthEvent(options.onAuthEvent, {
        type: "session_expired",
        principal: sessionPrincipal(initial),
        reason:
          error instanceof ServerSessionGrantRejected ? "refresh_rejected" : "identity_rejected",
      });
      if (error instanceof ServerOidcIdentityRejected) throw error;
      return null;
    }
    await conditionalSessionUpdate(
      db,
      initial,
      lease,
      "lease = NULL, lease_until = 0, retry_after = ?",
      [Math.floor(Date.now() / 1000) + 15],
    );
    throw new ProviderUnavailable();
  }
}

/**
 * Ends a session whose refresh lease lapsed with its owner still named on the
 * row. The delete is fenced on that lease, so of the requests that find the
 * row abandoned, one removes it and reports `lease_abandoned`.
 */
async function endAbandonedSession(
  db: D1Database,
  row: ServerSessionRow,
  lease: string,
  options: ServerOidcSessionOptions,
): Promise<null> {
  const removed = await db
    .prepare("DELETE FROM oidc_server_sessions WHERE id = ? AND generation = ? AND lease = ?")
    .bind(row.id, row.generation, lease)
    .run();
  if (removed.meta?.changes === 1)
    notifyAuthEvent(options.onAuthEvent, {
      type: "session_expired",
      principal: sessionPrincipal(row),
      reason: "lease_abandoned",
    });
  return null;
}

export async function deleteServerOidcSession(request: Request, env: Env): Promise<Response> {
  await revokeServerSession(env, request);
  return privateResponse(JSON.stringify({ ok: true }), 200, {
    "Content-Type": "application/json",
    "Set-Cookie": serverSessionCookie("", 0),
  });
}
