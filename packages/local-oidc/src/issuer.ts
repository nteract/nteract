// Dev-only OIDC issuer exposed as a web-standard fetch handler.
//
// Mints RS256 JSON Web Tokens for a configured dev user. Authorization codes and
// the signing key live in a `LocalOidcStore`. The default store is in memory
// and owned by one issuer instance (one boot): no key material is persisted or
// hardcoded, so every process restart rotates the keys and every old token
// stops verifying. A host that runs several isolates behind one issuer URL
// passes a shared store so a code issued in one isolate redeems in another and
// every isolate signs with the same key.
//
// This is a development identity source. The authorize endpoint auto-grants the
// configured dev user with no login challenge, so any caller that reaches it
// walks away with a valid token. Never mount it without an explicit dev gate; a
// production host must route auth to a real IdP instead.
//
// Web-standard only: Request, Response, URL, and WebCrypto (through jose). No
// Cloudflare, Node, or DOM-document APIs, so one handler runs the same under
// Workers, Deno, Bun, or a Node fetch server.

import * as jose from "jose";
import type { JSONWebKeySet, JWK, JWTPayload } from "jose";

/** A dev identity the issuer can grant. */
export interface LocalOidcUser {
  /** Stable subject identifier. Defaults to the email when omitted. */
  sub?: string;
  email: string;
  givenName?: string;
  familyName?: string;
  /** Display name. Defaults to "givenName familyName" when omitted. */
  name?: string;
}

export interface LocalOidcOptions {
  /**
   * Absolute issuer URL, including any mount path. The handler owns every path
   * under it, and the token `iss` claim equals this value with trailing slashes
   * removed. A consumer that verifies against a real IdP verifier (for example
   * an https-only cloud verifier) must pass the same URL it configures there.
   */
  issuerUrl: string;
  /** OAuth client id the authorize and token endpoints accept. */
  clientId?: string;
  /** Token `aud`. Defaults to the client id. */
  audience?: string | string[];
  /**
   * Access token lifetime in seconds. Set it low to force renewal within
   * seconds during dev.
   */
  defaultTokenTtlSeconds?: number;
  /** Refresh token lifetime in seconds. */
  refreshTokenTtlSeconds?: number;
  /**
   * Authorization code lifetime in seconds. Codes are one-time grants.
   * Defaults to 60 seconds.
   */
  authorizationCodeTtlSeconds?: number;
  /**
   * Where authorization codes and the signing key live. Defaults to a store in
   * this instance's memory. Pass a shared store when more than one issuer
   * instance (for example several Worker isolates) serves the same issuer URL.
   */
  store?: LocalOidcStore;
  /** Dev users the authorize endpoint may grant. The first entry is default. */
  users?: LocalOidcUser | LocalOidcUser[];
  /**
   * Decides whether an authorize/token redirect_uri is accepted. Defaults to
   * loopback http(s) origins (localhost, *.localhost, 127.0.0.1, ::1) so the
   * dev issuer cannot redirect a code off the local machine.
   */
  allowRedirectUri?: (redirectUri: string) => boolean;
}

/** What an authorization code grants, as stored until it is redeemed. */
export interface LocalOidcAuthorizationCode {
  user: LocalOidcUser;
  redirectUri: string;
  codeChallenge: string | null;
  nonce: string | null;
  /** Expiry as epoch milliseconds. The issuer rejects a code at or past it. */
  expiresAt: number;
}

/**
 * Shared state for issuer instances that serve one issuer URL. Every value is
 * JSON-serializable, so a store can keep it in a database row.
 */
export interface LocalOidcStore {
  /** Save a newly issued code. The store may drop expired codes here. */
  putAuthorizationCode(code: string, entry: LocalOidcAuthorizationCode): Promise<void>;
  /**
   * Remove a code and return what it granted, or undefined when it is unknown.
   * Remove and read must be one atomic step: of any number of concurrent calls
   * for one code, at most one returns the entry.
   */
  takeAuthorizationCode(code: string): Promise<LocalOidcAuthorizationCode | undefined>;
  /**
   * Return the private signing JWK every instance on this store uses. When the
   * store has none yet, call `generate` and keep the first key saved, so
   * instances that race here all receive the same key.
   */
  signingKey(generate: () => Promise<JWK>): Promise<JWK>;
}

/** OAuth token response returned by the token endpoint. */
export interface LocalOidcTokenResponse {
  access_token: string;
  id_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
}

export interface LocalOidcIssuer {
  /**
   * Handle a request. Returns a Response for any path under the issuer mount, or
   * null when the request is outside it so a host router can fall through.
   */
  handle(request: Request): Promise<Response | null>;
  /**
   * Sign an arbitrary claims set. `iss` and `aud` default to the issuer config
   * but the caller may override them; `iat` and `exp` are always stamped from
   * the ttl so the caller cannot mint a non-expiring token.
   */
  mintToken(claims: JWTPayload, opts?: { ttlSeconds?: number }): Promise<string>;
  /** Public JWKS for verifying issued tokens. */
  jwks(): Promise<JSONWebKeySet>;
}

const DEFAULT_CLIENT_ID = "local-oidc-client";
const DEFAULT_ACCESS_TTL_SECONDS = 3600;
const DEFAULT_REFRESH_TTL_SECONDS = 86_400;
const DEFAULT_AUTHORIZATION_CODE_TTL_SECONDS = 60;
const SIGNING_ALG = "RS256";
const SCOPE = "openid profile email";

const DEFAULT_DEV_USER: LocalOidcUser = {
  email: "dev@localhost",
  givenName: "Local",
  familyName: "Developer",
};

interface SigningKey {
  privateKey: jose.CryptoKey;
  publicJwk: JWK;
  kid: string;
  verify: ReturnType<typeof jose.createLocalJWKSet>;
}

/**
 * A store in this process's memory. Codes and the key are visible only to
 * issuer instances that share this object, and vanish with the process.
 */
export function createMemoryLocalOidcStore(): LocalOidcStore {
  const codes = new Map<string, LocalOidcAuthorizationCode>();
  // Only a settled key is kept, never a pending generation: a caller never
  // awaits another caller's work, so one that hangs or fails holds no one else.
  // Concurrent first callers each generate, and the first key saved wins.
  let key: JWK | undefined;
  return {
    async putAuthorizationCode(code, entry) {
      const now = Date.now();
      for (const [existing, stored] of codes) {
        if (now >= stored.expiresAt) {
          codes.delete(existing);
        }
      }
      codes.set(code, entry);
    },
    async takeAuthorizationCode(code) {
      const entry = codes.get(code);
      codes.delete(code);
      return entry;
    },
    async signingKey(generate) {
      if (key) {
        return key;
      }
      const generated = await generate();
      key ??= generated;
      return key;
    },
  };
}

export function createLocalOidcIssuer(options: LocalOidcOptions): LocalOidcIssuer {
  const issuer = normalizeIssuerUrl(options.issuerUrl);
  const basePath = new URL(issuer).pathname.replace(/\/+$/, "");
  const clientId = options.clientId ?? DEFAULT_CLIENT_ID;
  const audience = options.audience ?? clientId;
  const accessTtl = options.defaultTokenTtlSeconds ?? DEFAULT_ACCESS_TTL_SECONDS;
  const refreshTtl = options.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TTL_SECONDS;
  const authorizationCodeTtl =
    options.authorizationCodeTtlSeconds ?? DEFAULT_AUTHORIZATION_CODE_TTL_SECONDS;
  const users = resolveUsers(options.users);
  const allowRedirectUri = options.allowRedirectUri ?? isLoopbackRedirectUri;

  const store = options.store ?? createMemoryLocalOidcStore();

  // The store decides which key this instance signs with. Only a settled key is
  // cached here, never a pending load: concurrent first requests each run their
  // own load, and a store hands every caller the same key.
  let settledKey: SigningKey | undefined;
  async function signingKey(): Promise<SigningKey> {
    if (settledKey) {
      return settledKey;
    }
    const loaded = await signingKeyFromJwk(await store.signingKey(generatePrivateJwk));
    settledKey ??= loaded;
    return settledKey;
  }

  async function sign(payload: JWTPayload, ttlSeconds: number, key: SigningKey): Promise<string> {
    const now = nowSeconds();
    const full: JWTPayload = {
      iss: issuer,
      aud: audience,
      ...payload,
      iat: now,
      exp: now + ttlSeconds,
    };
    return new jose.SignJWT(full)
      .setProtectedHeader({ alg: SIGNING_ALG, kid: key.kid, typ: "JWT" })
      .sign(key.privateKey);
  }

  async function issueTokenSet(
    user: LocalOidcUser,
    key: SigningKey,
    nonce: string | null = null,
  ): Promise<LocalOidcTokenResponse> {
    const claims = profileClaims(user);
    // Access tokens target the resource audience; ID tokens target this client
    // and bind the authorization request's nonce. Refresh retains that binding.
    const accessToken = await sign({ ...claims, token_use: "access" }, accessTtl, key);
    const nonceClaim = nonce === null ? {} : { nonce };
    const idToken = await sign(
      { ...claims, ...nonceClaim, aud: clientId, token_use: "id" },
      accessTtl,
      key,
    );
    const refreshToken = await sign(
      { ...claims, ...nonceClaim, token_use: "refresh" },
      refreshTtl,
      key,
    );
    return {
      access_token: accessToken,
      id_token: idToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: accessTtl,
      scope: SCOPE,
    };
  }

  async function handleAuthorize(url: URL): Promise<Response> {
    const params = url.searchParams;
    if (params.get("response_type") !== "code") {
      return errorResponse(
        "unsupported_response_type",
        "only response_type=code is supported",
        400,
      );
    }
    if (params.get("client_id") !== clientId) {
      return errorResponse("invalid_client", "unknown client_id", 400);
    }
    const redirectUri = params.get("redirect_uri");
    if (!redirectUri) {
      return errorResponse("invalid_request", "missing redirect_uri", 400);
    }
    if (!allowRedirectUri(redirectUri)) {
      return errorResponse("invalid_request", "redirect_uri is not allowed", 400);
    }
    const codeChallenge = params.get("code_challenge");
    if (codeChallenge !== null) {
      if (codeChallenge.length === 0) {
        return errorResponse("invalid_request", "code_challenge is empty", 400);
      }
      if (params.get("code_challenge_method") !== "S256") {
        return errorResponse("invalid_request", "only S256 PKCE is supported", 400);
      }
    } else if (params.has("code_challenge_method")) {
      return errorResponse("invalid_request", "code_challenge_method requires code_challenge", 400);
    }

    // Auto-grant: no login challenge, just hand back a code for the dev user.
    const user = selectUser(users, params.get("login_hint"));
    const location = new URL(redirectUri);
    location.searchParams.set(
      "code",
      await issueAuthorizationCode(user, redirectUri, codeChallenge, params.get("nonce")),
    );
    const state = params.get("state");
    if (state !== null) {
      location.searchParams.set("state", state);
    }
    return redirectResponse(location.toString());
  }

  async function handleToken(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return errorResponse("invalid_request", "token endpoint requires POST", 405);
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return errorResponse("invalid_request", "token request must be form-encoded", 400);
    }

    const requestedClientId = stringField(form, "client_id");
    if (requestedClientId !== undefined && requestedClientId !== clientId) {
      return errorResponse("invalid_client", "unknown client_id", 400);
    }

    const key = await signingKey();
    const grantType = stringField(form, "grant_type");

    if (grantType === "authorization_code") {
      if (!requestedClientId) {
        return errorResponse("invalid_client", "missing client_id", 400);
      }
      const code = stringField(form, "code");
      if (!code) {
        return errorResponse("invalid_request", "missing code", 400);
      }
      const redirectUri = stringField(form, "redirect_uri");
      const entry = await takeAuthorizationCode(code);
      if (!entry) {
        return errorResponse("invalid_grant", "authorization code is invalid", 400);
      }
      if (!redirectUri || redirectUri !== entry.redirectUri) {
        return errorResponse(
          "invalid_grant",
          "redirect_uri does not match authorization code",
          400,
        );
      }
      if (entry.codeChallenge !== null) {
        const verifier = stringField(form, "code_verifier");
        if (!verifier) {
          return errorResponse("invalid_grant", "missing code_verifier", 400);
        }
        if ((await s256CodeChallenge(verifier)) !== entry.codeChallenge) {
          return errorResponse("invalid_grant", "code_verifier does not match", 400);
        }
      }
      return jsonResponse(await issueTokenSet(entry.user, key, entry.nonce));
    }

    if (grantType === "refresh_token") {
      const refreshToken = stringField(form, "refresh_token");
      if (!refreshToken) {
        return errorResponse("invalid_request", "missing refresh_token", 400);
      }
      let user: LocalOidcUser;
      let nonce: string | null = null;
      try {
        const { payload } = await jose.jwtVerify(refreshToken, key.verify, { issuer, audience });
        if (payload.token_use !== "refresh") {
          throw new Error("token is not a refresh token");
        }
        user = userFromClaims(payload);
        nonce = typeof payload.nonce === "string" ? payload.nonce : null;
      } catch {
        return errorResponse("invalid_grant", "refresh_token is invalid", 400);
      }
      return jsonResponse(await issueTokenSet(user, key, nonce));
    }

    return errorResponse("unsupported_grant_type", "unknown grant_type", 400);
  }

  async function handleUserinfo(request: Request): Promise<Response> {
    const token = bearerToken(request.headers.get("authorization"));
    if (!token) {
      return unauthorized("missing bearer token");
    }
    const key = await signingKey();
    let payload: JWTPayload;
    try {
      ({ payload } = await jose.jwtVerify(token, key.verify, { issuer, audience }));
    } catch {
      return unauthorized("access token is invalid");
    }
    // userinfo accepts access tokens, never ID or refresh tokens.
    if (payload.token_use === "refresh" || payload.token_use === "id") {
      return unauthorized("access token is invalid");
    }
    return jsonResponse(userinfoClaims(payload));
  }

  function handleEndSession(url: URL): Response {
    // The issuer is stateless (every authorize auto-grants), so end-session has
    // no session to clear; it only honors an allowed post-logout redirect.
    const redirect = url.searchParams.get("post_logout_redirect_uri");
    if (redirect && allowRedirectUri(redirect)) {
      const location = new URL(redirect);
      const state = url.searchParams.get("state");
      if (state !== null) {
        location.searchParams.set("state", state);
      }
      return redirectResponse(location.toString());
    }
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  function discoveryDocument(): Record<string, unknown> {
    return {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/userinfo`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      end_session_endpoint: `${issuer}/logout`,
      scopes_supported: ["openid", "profile", "email"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: [SIGNING_ALG],
      token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
      code_challenge_methods_supported: ["S256"],
    };
  }

  function relativePath(pathname: string): string | null {
    if (basePath === "") {
      return pathname;
    }
    if (pathname === basePath) {
      return "/";
    }
    if (pathname.startsWith(`${basePath}/`)) {
      return pathname.slice(basePath.length);
    }
    return null;
  }

  async function jwks(): Promise<JSONWebKeySet> {
    const key = await signingKey();
    return { keys: [key.publicJwk] };
  }

  async function mintToken(claims: JWTPayload, opts?: { ttlSeconds?: number }): Promise<string> {
    const key = await signingKey();
    return sign(claims, opts?.ttlSeconds ?? accessTtl, key);
  }

  async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const rel = relativePath(url.pathname);
    if (rel === null) {
      return null;
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    switch (rel) {
      case "/.well-known/openid-configuration":
        return jsonResponse(discoveryDocument());
      case "/.well-known/jwks.json":
        return jsonResponse(await jwks());
      case "/authorize":
        return handleAuthorize(url);
      case "/token":
        return handleToken(request);
      case "/userinfo":
        return handleUserinfo(request);
      case "/logout":
        return handleEndSession(url);
      default:
        return errorResponse("not_found", "unknown issuer endpoint", 404);
    }
  }

  async function issueAuthorizationCode(
    user: LocalOidcUser,
    redirectUri: string,
    codeChallenge: string | null,
    nonce: string | null,
  ): Promise<string> {
    // 256 random bits: a collision with a live code is not a practical concern.
    const code = randomAuthorizationCode();
    await store.putAuthorizationCode(code, {
      user,
      redirectUri,
      codeChallenge,
      nonce,
      expiresAt: Date.now() + authorizationCodeTtl * 1000,
    });
    return code;
  }

  async function takeAuthorizationCode(
    code: string,
  ): Promise<LocalOidcAuthorizationCode | undefined> {
    const entry = await store.takeAuthorizationCode(code);
    if (!entry || Date.now() >= entry.expiresAt) {
      return undefined;
    }
    return entry;
  }

  return { handle, mintToken, jwks };
}

async function generatePrivateJwk(): Promise<JWK> {
  const { privateKey } = await jose.generateKeyPair(SIGNING_ALG, { extractable: true });
  return jose.exportJWK(privateKey);
}

async function signingKeyFromJwk(privateJwk: JWK): Promise<SigningKey> {
  const privateKey = await jose.importJWK(privateJwk, SIGNING_ALG);
  if (privateKey instanceof Uint8Array || privateKey.type !== "private") {
    throw new Error("local OIDC signing key must be a private RSA JWK");
  }
  // The public JWK keeps only the RSA public members, never d/p/q/dp/dq/qi.
  const { kty, n, e } = privateJwk;
  const exported: JWK = { kty, n, e };
  const kid = await jose.calculateJwkThumbprint(exported);
  const publicJwk: JWK = { ...exported, kid, use: "sig", alg: SIGNING_ALG };
  return {
    privateKey,
    publicJwk,
    kid,
    verify: jose.createLocalJWKSet({ keys: [publicJwk] }),
  };
}

function normalizeIssuerUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.href.replace(/\/+$/, "");
}

function resolveUsers(input: LocalOidcOptions["users"]): LocalOidcUser[] {
  const list = input === undefined ? [] : Array.isArray(input) ? input : [input];
  return (list.length > 0 ? list : [DEFAULT_DEV_USER]).map(normalizeUser);
}

function normalizeUser(user: LocalOidcUser): LocalOidcUser {
  const fullName = [user.givenName, user.familyName].filter(Boolean).join(" ");
  const name = user.name ?? (fullName.length > 0 ? fullName : undefined);
  return { ...user, sub: user.sub ?? user.email, name };
}

function selectUser(users: LocalOidcUser[], loginHint: string | null): LocalOidcUser {
  if (loginHint) {
    const match = users.find((user) => user.email.toLowerCase() === loginHint.toLowerCase());
    if (match) {
      return match;
    }
  }
  return users[0];
}

function profileClaims(user: LocalOidcUser): JWTPayload {
  const claims: JWTPayload = { sub: user.sub, email: user.email, email_verified: true };
  if (user.givenName) {
    claims.given_name = user.givenName;
  }
  if (user.familyName) {
    claims.family_name = user.familyName;
  }
  if (user.name) {
    claims.name = user.name;
  }
  return claims;
}

function userinfoClaims(payload: JWTPayload): JWTPayload {
  const claims: JWTPayload = { sub: payload.sub };
  for (const field of ["email", "email_verified", "given_name", "family_name", "name"] as const) {
    if (payload[field] !== undefined) {
      claims[field] = payload[field];
    }
  }
  return claims;
}

function userFromClaims(payload: JWTPayload): LocalOidcUser {
  const email = typeof payload.email === "string" ? payload.email : undefined;
  if (!email) {
    throw new Error("token is missing an email claim");
  }
  return normalizeUser({
    email,
    sub: typeof payload.sub === "string" ? payload.sub : undefined,
    givenName: typeof payload.given_name === "string" ? payload.given_name : undefined,
    familyName: typeof payload.family_name === "string" ? payload.family_name : undefined,
    name: typeof payload.name === "string" ? payload.name : undefined,
  });
}

function randomAuthorizationCode(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return jose.base64url.encode(bytes);
}

async function s256CodeChallenge(verifier: string): Promise<string> {
  const bytes = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return jose.base64url.encode(new Uint8Array(digest));
}

function stringField(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function bearerToken(header: string | null): string | undefined {
  if (!header) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : undefined;
}

function isLoopbackRedirectUri(redirectUri: string): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  );
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}

function errorResponse(error: string, description: string, status: number): Response {
  return jsonResponse({ error, error_description: description }, status);
}

function unauthorized(description: string): Response {
  return new Response(JSON.stringify({ error: "invalid_token", error_description: description }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": "Bearer",
      ...corsHeaders(),
    },
  });
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { location, ...corsHeaders() } });
}
