import type { Env } from "./cloudflare-types.ts";
import { createServerAppSession, type CloudAppSession } from "./app-session.ts";
import {
  authenticateOidcRequest,
  encodePrincipalComponent,
  verifyOidcIdToken,
  type AuthenticatedConnection,
} from "./identity.ts";
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
  SERVER_SESSION_COOKIE,
  SERVER_SESSION_IDLE_SECONDS,
  SERVER_SESSION_ABSOLUTE_SECONDS,
  type ServerSessionRow,
} from "./oidc-session-store.ts";

const LOGIN_COOKIE = "__Host-nteract_cloud_oidc_login";
const LOGIN_SECONDS = 600;
const REFRESH_WINDOW_SECONDS = 60;

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
class ProviderUnavailable extends Error {}
class InvalidGrant extends Error {}

function configFor(env: Env, request: Request): Config {
  const issuer = env.NOTEBOOK_CLOUD_OIDC_ISSUER?.trim();
  const clientId = env.NOTEBOOK_CLOUD_OIDC_CLIENT_ID?.trim();
  if (
    !issuer ||
    !clientId ||
    !env.DB ||
    (env.NOTEBOOK_CLOUD_APP_SESSION_SECRET?.length ?? 0) < 32
  ) {
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
  if (!response.ok) throw new ProviderUnavailable();
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
    return await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new ProviderUnavailable();
  }
}

function privateResponse(
  body: BodyInit | null,
  status: number,
  headers: HeadersInit = {},
): Response {
  const response = new Response(body, { status, headers });
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
  try {
    const config = configFor(env, request);
    const origin = request.headers.get("Origin");
    if (
      (origin && origin !== config.origin) ||
      request.headers.get("Sec-Fetch-Site") === "cross-site"
    ) {
      return privateResponse("Start sign-in from this notebook site.", 403);
    }
    const metadata = await providerMetadata(config);
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
  } catch {
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
  if (response.status === 429 || response.status >= 500) throw new ProviderUnavailable();
  const value = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    if (
      value?.error === "invalid_grant" ||
      (typeof value?.error === "object" &&
        value.error !== null &&
        "code" in value.error &&
        value.error.code === "invalid_grant")
    )
      throw new InvalidGrant();
    throw new ProviderUnavailable();
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
): Promise<Response> {
  if (request.method !== "GET") return privateResponse(null, 405);
  let response: Response;
  try {
    const config = configFor(env, request);
    const params = new URL(request.url).searchParams;
    const state = params.get("state"),
      code = params.get("code"),
      binding = cookieValue(request, LOGIN_COOKIE);
    if (
      !state ||
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      !binding ||
      !code ||
      params.has("error") ||
      params.getAll("state").length !== 1 ||
      params.getAll("code").length !== 1
    )
      throw new Error("Invalid callback");
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
    if (!row) throw new Error("Expired or mismatched callback");
    const transaction = await openServerSecret<LoginTransaction>(
      env,
      row.sealed,
      `login:${stateHash}:${config.context}`,
    );
    const metadata = await providerMetadata(config);
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
    const verified = await validatedIdentity(env, config, tokens, transaction.nonce);
    await syncProfile(verified.identity);
    const sessionToken = randomSecret(),
      id = await serverSessionId(env, sessionToken);
    const session = await createServerAppSession(
      env,
      verified.identity,
      id,
      Math.min(verified.expiresAt, now + SERVER_SESSION_IDLE_SECONDS),
      now,
    );
    const bundle: TokenBundle = {
      refreshToken: tokens.refresh_token,
      nonce: transaction.nonce,
      subject: verified.subject,
    };
    await db
      .prepare(
        `INSERT INTO oidc_server_sessions (id, context, session_json, sealed, access_expires_at, idle_expires_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        config.context,
        JSON.stringify(session),
        await sealServerSecret(env, bundle, `session:${id}:${config.context}`),
        verified.expiresAt,
        now + SERVER_SESSION_IDLE_SECONDS,
        now + SERVER_SESSION_ABSOLUTE_SECONDS,
      )
      .run();
    response = privateResponse(null, 303, {
      Location: safeReturnTo(transaction.returnTo, config.origin),
      "Set-Cookie": serverSessionCookie(sessionToken),
    });
  } catch {
    response = privateResponse(
      "Sign-in could not be completed. Return to the notebook site and try signing in again.",
      400,
    );
  }
  response.headers.append("Set-Cookie", loginCookie("", 0));
  return response;
}

export async function serverOidcSessionStatus(
  request: Request,
  env: Env,
  syncProfile: (identity: AuthenticatedConnection) => Promise<void>,
): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  try {
    let row = await loadServerSession(env, request, now);
    if (row && row.access_expires_at <= now + REFRESH_WINDOW_SECONDS)
      row = await refreshSession(request, env, row, syncProfile);
    const current = Math.floor(Date.now() / 1000);
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
  } catch {
    return privateResponse(
      JSON.stringify({ error: "Sign-in renewal is temporarily unavailable" }),
      503,
      { "Content-Type": "application/json", "Retry-After": "15" },
    );
  }
}

async function refreshSession(
  request: Request,
  env: Env,
  initial: ServerSessionRow,
  syncProfile: (identity: AuthenticatedConnection) => Promise<void>,
): Promise<ServerSessionRow | null> {
  const config = configFor(env, request),
    db = await oidcDatabase(env);
  const now = Math.floor(Date.now() / 1000);
  if (initial.retry_after > now) throw new ProviderUnavailable();
  if (initial.lease && initial.lease_until <= now) {
    // A crashed owner may have consumed a rotating refresh token. Do not let
    // another process reuse it, or let a late owner resurrect the session.
    await db
      .prepare("DELETE FROM oidc_server_sessions WHERE id = ? AND generation = ? AND lease = ?")
      .bind(initial.id, initial.generation, initial.lease)
      .run();
    return null;
  }
  const bundle = await openServerSecret<TokenBundle>(
    env,
    initial.sealed,
    `session:${initial.id}:${config.context}`,
  );
  if (!bundle.refreshToken) return initial.access_expires_at > now ? initial : null;
  const lease = randomSecret();
  const claimed = await db
    .prepare(`UPDATE oidc_server_sessions SET lease = ?, lease_until = ?
    WHERE id = ? AND generation = ? AND lease_until <= ? AND retry_after <= ? AND idle_expires_at > ? AND absolute_expires_at > ?`)
    .bind(lease, now + 120, initial.id, initial.generation, now, now, now, now)
    .run();
  if (claimed.meta.changes !== 1) {
    // Another node may own a rotating refresh token. Never exchange it twice.
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const row = await loadServerSession(env, request, Math.floor(Date.now() / 1000));
      if (!row || row.generation !== initial.generation) return row;
      if (row.retry_after > Math.floor(Date.now() / 1000)) throw new ProviderUnavailable();
    }
    throw new ProviderUnavailable();
  }
  try {
    const metadata = await providerMetadata(config);
    const tokens = await exchangeToken(
      env,
      config,
      metadata.token_endpoint,
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: bundle.refreshToken }),
    );
    const verified = await validatedIdentity(env, config, tokens, bundle.nonce, bundle.subject);
    await syncProfile(verified.identity);
    const refreshedAt = Math.floor(Date.now() / 1000);
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
        await sealServerSecret(
          env,
          { ...bundle, refreshToken: tokens.refresh_token ?? bundle.refreshToken },
          `session:${initial.id}:${config.context}`,
        ),
        verified.expiresAt,
        idleExpiry,
      ],
    );
    return saved ? loadServerSession(env, request, refreshedAt) : null;
  } catch (error) {
    if (error instanceof InvalidGrant) {
      await db
        .prepare("DELETE FROM oidc_server_sessions WHERE id = ? AND generation = ? AND lease = ?")
        .bind(initial.id, initial.generation, lease)
        .run();
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

export async function deleteServerOidcSession(request: Request, env: Env): Promise<Response> {
  await revokeServerSession(env, request);
  return privateResponse(JSON.stringify({ ok: true }), 200, {
    "Content-Type": "application/json",
    "Set-Cookie": serverSessionCookie("", 0),
  });
}
