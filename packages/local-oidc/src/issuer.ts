// Dev-only OIDC issuer exposed as a web-standard fetch handler.
//
// Mints RS256 JSON Web Tokens for a configured dev user against an ephemeral
// signing key generated per issuer instance (per boot). No key material is
// persisted or hardcoded, so every process restart rotates the keys and every
// old token stops verifying.
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
   * Authorization code lifetime in seconds. Codes are one-time, in-memory
   * grants. Defaults to 60 seconds.
   */
  authorizationCodeTtlSeconds?: number;
  /** Dev users the authorize endpoint may grant. The first entry is default. */
  users?: LocalOidcUser | LocalOidcUser[];
  /**
   * Decides whether an authorize/token redirect_uri is accepted. Defaults to
   * loopback http(s) origins (localhost, *.localhost, 127.0.0.1, ::1) so the
   * dev issuer cannot redirect a code off the local machine.
   */
  allowRedirectUri?: (redirectUri: string) => boolean;
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

interface AuthorizationCodeEntry {
  user: LocalOidcUser;
  redirectUri: string;
  codeChallenge: string | null;
  expiresAt: number;
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

  // Authorization codes live in per-isolate memory; this is valid for single-
  // isolate wrangler dev, and this issuer is dev-only and never deployed.
  const authorizationCodes = new Map<string, AuthorizationCodeEntry>();

  // Key generation starts at construction; every method awaits this promise. One
  // issuer instance carries exactly one keypair for its whole lifetime.
  const keyPromise = generateSigningKey();

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
  ): Promise<LocalOidcTokenResponse> {
    const claims = profileClaims(user);
    // This dev issuer mints one profile-bearing RS256 token and reuses it as the
    // id_token; the refresh token carries the same claims with a longer ttl. The
    // `token_use` claim distinguishes the two so a refresh token cannot stand in
    // for an access token at a resource server, and an access token cannot be
    // replayed at the refresh grant. Both consumption paths enforce it.
    const accessToken = await sign({ ...claims, token_use: "access" }, accessTtl, key);
    const refreshToken = await sign({ ...claims, token_use: "refresh" }, refreshTtl, key);
    return {
      access_token: accessToken,
      id_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: accessTtl,
      scope: SCOPE,
    };
  }

  function handleAuthorize(url: URL): Response {
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
    location.searchParams.set("code", issueAuthorizationCode(user, redirectUri, codeChallenge));
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

    const key = await keyPromise;
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
      const entry = takeAuthorizationCode(code);
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
      return jsonResponse(await issueTokenSet(entry.user, key));
    }

    if (grantType === "refresh_token") {
      const refreshToken = stringField(form, "refresh_token");
      if (!refreshToken) {
        return errorResponse("invalid_request", "missing refresh_token", 400);
      }
      let user: LocalOidcUser;
      try {
        const { payload } = await jose.jwtVerify(refreshToken, key.verify, { issuer, audience });
        if (payload.token_use !== "refresh") {
          throw new Error("token is not a refresh token");
        }
        user = userFromClaims(payload);
      } catch {
        return errorResponse("invalid_grant", "refresh_token is invalid", 400);
      }
      return jsonResponse(await issueTokenSet(user, key));
    }

    return errorResponse("unsupported_grant_type", "unknown grant_type", 400);
  }

  async function handleUserinfo(request: Request): Promise<Response> {
    const token = bearerToken(request.headers.get("authorization"));
    if (!token) {
      return unauthorized("missing bearer token");
    }
    const key = await keyPromise;
    let payload: JWTPayload;
    try {
      ({ payload } = await jose.jwtVerify(token, key.verify, { issuer, audience }));
    } catch {
      return unauthorized("access token is invalid");
    }
    // userinfo takes an access token, not a refresh token. Reject a token that
    // declares itself a refresh token so the two roles stay distinct here too.
    if (payload.token_use === "refresh") {
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
    const key = await keyPromise;
    return { keys: [key.publicJwk] };
  }

  async function mintToken(claims: JWTPayload, opts?: { ttlSeconds?: number }): Promise<string> {
    const key = await keyPromise;
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

  function issueAuthorizationCode(
    user: LocalOidcUser,
    redirectUri: string,
    codeChallenge: string | null,
  ): string {
    const now = Date.now();
    pruneExpiredAuthorizationCodes(now);
    let code: string;
    do {
      code = randomAuthorizationCode();
    } while (authorizationCodes.has(code));
    authorizationCodes.set(code, {
      user,
      redirectUri,
      codeChallenge,
      expiresAt: now + authorizationCodeTtl * 1000,
    });
    return code;
  }

  function takeAuthorizationCode(code: string): AuthorizationCodeEntry | undefined {
    const entry = authorizationCodes.get(code);
    if (!entry) {
      return undefined;
    }
    authorizationCodes.delete(code);
    if (Date.now() >= entry.expiresAt) {
      return undefined;
    }
    return entry;
  }

  function pruneExpiredAuthorizationCodes(now: number): void {
    for (const [code, entry] of authorizationCodes) {
      if (now >= entry.expiresAt) {
        authorizationCodes.delete(code);
      }
    }
  }

  return { handle, mintToken, jwks };
}

async function generateSigningKey(): Promise<SigningKey> {
  const { publicKey, privateKey } = await jose.generateKeyPair(SIGNING_ALG, {
    extractable: true,
  });
  const exported = await jose.exportJWK(publicKey);
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
