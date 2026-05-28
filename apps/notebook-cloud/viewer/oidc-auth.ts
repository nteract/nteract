export const NOTEBOOK_CLOUD_OIDC_REQUEST_STORAGE_KEY = "nteract:notebook-cloud:oidc-request";
export const NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY = "nteract:notebook-cloud:oidc-token";

export interface CloudOidcAuthConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scope?: string;
}

export interface CloudOidcRequestState {
  challenge: string;
  verifier: string;
  state: string;
  returnUrl: string;
}

export interface CloudOidcClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

export interface CloudOidcTokenState {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  claims: CloudOidcClaims;
}

export interface CloudOidcStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export interface CloudOidcEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

export interface CloudOidcTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
  refresh_token?: unknown;
}

const DEFAULT_OIDC_SCOPE = "openid email profile offline_access";
const EXPIRY_SKEW_SECONDS = 60;

export function normalizeOidcAuthConfig(
  input: Partial<CloudOidcAuthConfig> | null | undefined,
): CloudOidcAuthConfig | null {
  const issuer = input?.issuer?.trim();
  const clientId = input?.clientId?.trim();
  const redirectUri = input?.redirectUri?.trim();
  if (!issuer || !clientId || !redirectUri) {
    return null;
  }
  return {
    issuer,
    clientId,
    redirectUri,
    scope: input?.scope?.trim() || DEFAULT_OIDC_SCOPE,
  };
}

export function readStoredOidcToken(
  storage: Pick<CloudOidcStorage, "getItem">,
  nowSeconds = currentEpochSeconds(),
): {
  token: CloudOidcTokenState | null;
  problem: string | null;
  expired: boolean;
  expiredClaims: CloudOidcClaims | null;
} {
  const parsed = readStoredOidcTokenState(storage);
  if (!parsed.token) {
    return { ...parsed, expired: false, expiredClaims: null };
  }
  const { token } = parsed;
  if (token.expiresAt <= nowSeconds + EXPIRY_SKEW_SECONDS) {
    return { token: null, problem: null, expired: true, expiredClaims: token.claims };
  }

  return { token, problem: null, expired: false, expiredClaims: null };
}

export function storedOidcTokenNeedsRefresh(
  storage: Pick<CloudOidcStorage, "getItem">,
  nowSeconds = currentEpochSeconds(),
): boolean {
  const parsed = readStoredOidcTokenState(storage);
  return Boolean(
    parsed.token?.refreshToken && parsed.token.expiresAt <= nowSeconds + EXPIRY_SKEW_SECONDS,
  );
}

const refreshesByStorage = new WeakMap<
  CloudOidcStorage,
  Map<string, Promise<CloudOidcTokenState>>
>();

export function refreshStoredOidcToken(
  config: CloudOidcAuthConfig,
  input: {
    storage: CloudOidcStorage;
    fetchImpl?: typeof fetch;
    nowSeconds?: number;
  },
): Promise<CloudOidcTokenState> {
  const refreshKey = oidcRefreshKey(config);
  let storageRefreshes = refreshesByStorage.get(input.storage);
  if (!storageRefreshes) {
    storageRefreshes = new Map();
    refreshesByStorage.set(input.storage, storageRefreshes);
  }
  const existing = storageRefreshes.get(refreshKey);
  if (existing) {
    return existing;
  }

  const refresh = refreshStoredOidcTokenUncoalesced(config, input).finally(() => {
    storageRefreshes.delete(refreshKey);
  });
  storageRefreshes.set(refreshKey, refresh);
  return refresh;
}

async function refreshStoredOidcTokenUncoalesced(
  config: CloudOidcAuthConfig,
  input: {
    storage: CloudOidcStorage;
    fetchImpl?: typeof fetch;
    nowSeconds?: number;
  },
): Promise<CloudOidcTokenState> {
  const current = readStoredOidcTokenState(input.storage);
  if (!current.token) {
    throw new Error(current.problem ?? "Stored OIDC session is missing.");
  }
  if (!current.token.refreshToken) {
    throw new Error("Stored OIDC session cannot be refreshed.");
  }

  const endpoints = await discoverOidcEndpoints(config, input.fetchImpl);
  const response = await exchangeRefreshToken(
    config,
    endpoints,
    current.token.refreshToken,
    input.fetchImpl,
  );
  return storeOidcTokenResponse(
    input.storage,
    response,
    input.nowSeconds ?? currentEpochSeconds(),
    current.token,
  );
}

function oidcRefreshKey(config: CloudOidcAuthConfig): string {
  return [
    config.issuer,
    config.clientId,
    config.redirectUri,
    config.scope ?? DEFAULT_OIDC_SCOPE,
  ].join("\n");
}

function readStoredOidcTokenState(storage: Pick<CloudOidcStorage, "getItem">): {
  token: CloudOidcTokenState | null;
  problem: string | null;
} {
  const raw = storage.getItem(NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY);
  if (!raw) {
    return { token: null, problem: null };
  }
  let parsed: Partial<CloudOidcTokenState>;
  try {
    parsed = JSON.parse(raw) as Partial<CloudOidcTokenState>;
  } catch {
    return { token: null, problem: "Stored OIDC session is invalid." };
  }

  const accessToken = parsed.accessToken?.trim();
  const claims = normalizeClaims(parsed.claims);
  const expiresAt = Number(parsed.expiresAt);
  if (!accessToken || !claims || !Number.isFinite(expiresAt)) {
    return { token: null, problem: "Stored OIDC session is invalid." };
  }
  return {
    token: {
      accessToken,
      refreshToken: parsed.refreshToken?.trim() || null,
      expiresAt,
      claims,
    },
    problem: null,
  };
}

export function storeOidcTokenResponse(
  storage: CloudOidcStorage,
  response: CloudOidcTokenResponse,
  nowSeconds = currentEpochSeconds(),
  previousToken: CloudOidcTokenState | null = null,
): CloudOidcTokenState {
  const accessToken = typeof response.access_token === "string" ? response.access_token : "";
  if (!accessToken) {
    throw new Error("OIDC token response did not include an access token");
  }
  const claims = claimsFromTokenResponse(response, accessToken, previousToken);
  const expiresIn =
    typeof response.expires_in === "number" && Number.isFinite(response.expires_in)
      ? response.expires_in
      : 3600;
  const responseRefreshToken =
    typeof response.refresh_token === "string" && response.refresh_token.trim()
      ? response.refresh_token.trim()
      : null;
  const token: CloudOidcTokenState = {
    accessToken,
    refreshToken: responseRefreshToken ?? previousToken?.refreshToken ?? null,
    expiresAt: nowSeconds + expiresIn,
    claims,
  };

  storage.setItem(NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY, JSON.stringify(token));
  storage.removeItem(NOTEBOOK_CLOUD_OIDC_REQUEST_STORAGE_KEY);
  return token;
}

export function clearCloudOidcAuth(storage: Pick<CloudOidcStorage, "removeItem">): void {
  storage.removeItem(NOTEBOOK_CLOUD_OIDC_REQUEST_STORAGE_KEY);
  storage.removeItem(NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY);
}

export async function beginOidcLogin(
  config: CloudOidcAuthConfig,
  input: {
    currentUrl: string;
    storage: CloudOidcStorage;
    fetchImpl?: typeof fetch;
  },
): Promise<URL> {
  const requestState = await createOidcRequestState(input.currentUrl);
  const endpoints = await discoverOidcEndpoints(config, input.fetchImpl);
  input.storage.setItem(NOTEBOOK_CLOUD_OIDC_REQUEST_STORAGE_KEY, JSON.stringify(requestState));
  return buildOidcAuthorizationUrl(config, endpoints, requestState);
}

export async function completeOidcRedirect(
  config: CloudOidcAuthConfig,
  input: {
    callbackUrl: string;
    storage: CloudOidcStorage;
    fetchImpl?: typeof fetch;
  },
): Promise<{ returnUrl: string; token: CloudOidcTokenState }> {
  const callbackUrl = new URL(input.callbackUrl);
  const error = callbackUrl.searchParams.get("error");
  if (error) {
    const description = callbackUrl.searchParams.get("error_description");
    throw new Error(description ? `${error}: ${description}` : error);
  }

  const code = callbackUrl.searchParams.get("code")?.trim();
  const state = callbackUrl.searchParams.get("state")?.trim();
  if (!code || !state) {
    throw new Error("OIDC callback is missing code or state");
  }

  const requestState = readOidcRequestState(input.storage);
  if (!requestState) {
    throw new Error("OIDC callback is missing the stored PKCE request state");
  }
  if (state !== requestState.state) {
    throw new Error("OIDC callback state does not match the stored request");
  }

  const endpoints = await discoverOidcEndpoints(config, input.fetchImpl);
  const response = await exchangeAuthorizationCode(
    config,
    endpoints,
    code,
    requestState,
    input.fetchImpl,
  );
  const token = storeOidcTokenResponse(input.storage, response);
  return {
    returnUrl: safeSameOriginReturnUrl(requestState.returnUrl, callbackUrl.origin),
    token,
  };
}

export function buildOidcAuthorizationUrl(
  config: CloudOidcAuthConfig,
  endpoints: CloudOidcEndpoints,
  requestState: CloudOidcRequestState,
): URL {
  const url = new URL(endpoints.authorizationEndpoint);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("code_challenge", requestState.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scope ?? DEFAULT_OIDC_SCOPE);
  url.searchParams.set("state", requestState.state);
  return url;
}

export async function discoverOidcEndpoints(
  config: CloudOidcAuthConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<CloudOidcEndpoints> {
  const response = await fetchImpl(oidcDiscoveryUrl(config.issuer), {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`OIDC discovery failed: ${response.status}`);
  }
  const body = (await response.json()) as {
    authorization_endpoint?: unknown;
    token_endpoint?: unknown;
  };
  if (typeof body.authorization_endpoint !== "string" || typeof body.token_endpoint !== "string") {
    throw new Error("OIDC discovery response is missing authorization or token endpoints");
  }
  return {
    authorizationEndpoint: body.authorization_endpoint,
    tokenEndpoint: body.token_endpoint,
  };
}

export function oidcDiscoveryUrl(issuer: string): string {
  const url = new URL(issuer);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  url.search = "";
  url.hash = "";
  return url.href;
}

export function oidcDisplayName(claims: CloudOidcClaims): string {
  return claims.name?.trim() || claims.email?.trim() || claims.sub;
}

async function exchangeAuthorizationCode(
  config: CloudOidcAuthConfig,
  endpoints: CloudOidcEndpoints,
  code: string,
  requestState: CloudOidcRequestState,
  fetchImpl: typeof fetch = fetch,
): Promise<CloudOidcTokenResponse> {
  const form = new URLSearchParams();
  form.set("client_id", config.clientId);
  form.set("code", code);
  form.set("code_verifier", requestState.verifier);
  form.set("grant_type", "authorization_code");
  form.set("redirect_uri", config.redirectUri);

  const response = await fetchImpl(endpoints.tokenEndpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`OIDC token exchange failed: ${response.status}`);
  }
  return (await response.json()) as CloudOidcTokenResponse;
}

async function exchangeRefreshToken(
  config: CloudOidcAuthConfig,
  endpoints: CloudOidcEndpoints,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CloudOidcTokenResponse> {
  const form = new URLSearchParams();
  form.set("client_id", config.clientId);
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", refreshToken);
  if (config.scope) {
    form.set("scope", config.scope);
  }

  const response = await fetchImpl(endpoints.tokenEndpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`OIDC token refresh failed: ${response.status}`);
  }
  return (await response.json()) as CloudOidcTokenResponse;
}

function readOidcRequestState(
  storage: Pick<CloudOidcStorage, "getItem">,
): CloudOidcRequestState | null {
  const raw = storage.getItem(NOTEBOOK_CLOUD_OIDC_REQUEST_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CloudOidcRequestState>;
    if (!parsed.challenge || !parsed.verifier || !parsed.state || !parsed.returnUrl) {
      return null;
    }
    return {
      challenge: parsed.challenge,
      verifier: parsed.verifier,
      state: parsed.state,
      returnUrl: parsed.returnUrl,
    };
  } catch {
    return null;
  }
}

async function createOidcRequestState(currentUrl: string): Promise<CloudOidcRequestState> {
  const verifier = randomBase64Url(32);
  return {
    challenge: await sha256Base64Url(verifier),
    verifier,
    state: randomBase64Url(16),
    returnUrl: currentUrl,
  };
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64UrlEncodeBytes(new Uint8Array(digest));
}

function randomBase64Url(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return base64UrlEncodeBytes(bytes);
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function claimsFromTokenResponse(
  response: CloudOidcTokenResponse,
  accessToken: string,
  previousToken: CloudOidcTokenState | null = null,
): CloudOidcClaims {
  const claimsSource =
    typeof response.id_token === "string" && response.id_token ? response.id_token : accessToken;
  const claims = normalizeClaims(decodeJwtPayload(claimsSource));
  if (!claims) {
    throw new Error("OIDC token response did not include a usable subject claim");
  }
  if (previousToken && claims.sub !== previousToken.claims.sub) {
    throw new Error("OIDC token refresh returned a different subject");
  }
  if (previousToken && claimsSource === accessToken) {
    return {
      ...previousToken.claims,
      ...claims,
      sub: claims.sub,
    };
  }
  return claims;
}

function decodeJwtPayload(token: string): unknown {
  const parts = token.split(".");
  if (parts.length < 2) {
    throw new Error("OIDC token response was not a JWT");
  }
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1] ?? "")));
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function normalizeClaims(value: unknown): CloudOidcClaims | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const claims = value as Record<string, unknown>;
  const sub = typeof claims.sub === "string" ? claims.sub.trim() : "";
  if (!sub) {
    return null;
  }
  return {
    sub,
    ...(typeof claims.email === "string" ? { email: claims.email } : {}),
    ...(typeof claims.email_verified === "boolean"
      ? { email_verified: claims.email_verified }
      : {}),
    ...(typeof claims.name === "string" ? { name: claims.name } : {}),
    ...(typeof claims.picture === "string" ? { picture: claims.picture } : {}),
  };
}

function safeSameOriginReturnUrl(value: string, origin: string): string {
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin) {
      return "/";
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

function currentEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
