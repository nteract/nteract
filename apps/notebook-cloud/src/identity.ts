import {
  BEARER_AUTH_TOKEN_PROTOCOL_PREFIX,
  DEV_AUTH_TOKEN_HEADER,
  DEV_AUTH_TOKEN_PROTOCOL_PREFIX,
  NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
  isConnectionScope,
  type ConnectionScope,
} from "./auth-shared.ts";

export {
  BEARER_AUTH_TOKEN_PROTOCOL_PREFIX,
  DEV_AUTH_TOKEN_HEADER,
  DEV_AUTH_TOKEN_PROTOCOL_PREFIX,
  NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
  type ConnectionScope,
} from "./auth-shared.ts";

export interface ActorLabel {
  value: string;
  principal: string;
  operator: string;
}

export interface AuthenticatedConnection {
  principal: string;
  operator: string;
  actorLabel: string;
  scope: ConnectionScope;
  metadata: AuthenticatedConnectionMetadata;
  webSocketProtocol?: string;
}

export interface IdentityEnvironment {
  DEPLOYMENT_ENV?: string;
  NOTEBOOK_CLOUD_DEV_TOKEN?: string;
  NOTEBOOK_CLOUD_ANACONDA_API_KEY_PRINCIPAL_NAMESPACE?: string;
  NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL?: string;
  NOTEBOOK_CLOUD_OIDC_AUDIENCE?: string;
  NOTEBOOK_CLOUD_OIDC_CLIENT_ID?: string;
  NOTEBOOK_CLOUD_OIDC_ISSUER?: string;
  NOTEBOOK_CLOUD_OIDC_JWKS_JSON?: string;
  NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE?: string;
}

export interface AuthenticatedConnectionMetadata {
  provider:
    | "anonymous"
    | "app-session"
    | "dev"
    | "oidc"
    | "anaconda-api-key"
    | "workstation-credential";
  transport:
    | "anonymous"
    | "app-session-cookie"
    | "loopback-dev"
    | "dev-token-header"
    | "dev-token-subprotocol"
    | "api-key-bearer"
    | "oidc-bearer"
    | "oidc-subprotocol"
    | "workstation-credential-header";
  principalNamespace: string;
  displayName?: string;
  email?: string;
  emailVerified?: boolean;
  workstationCredentialId?: string;
  workstationPairingCodeId?: string;
}

const ANONYMOUS_PRINCIPAL_PREFIX = "anonymous:";

export const TRUSTED_PRINCIPAL_HEADER = "x-nteract-principal";
export const TRUSTED_OPERATOR_HEADER = "x-nteract-operator";
export const TRUSTED_SCOPE_HEADER = "x-nteract-scope";
export const TRUSTED_WEBSOCKET_PROTOCOL_HEADER = "x-nteract-websocket-protocol";
export const TRUSTED_IDENTITY_PROVIDER_HEADER = "x-nteract-identity-provider";
export const TRUSTED_CREDENTIAL_TRANSPORT_HEADER = "x-nteract-credential-transport";
export const TRUSTED_PRINCIPAL_NAMESPACE_HEADER = "x-nteract-principal-namespace";
export const TRUSTED_DISPLAY_NAME_HEADER = "x-nteract-display-name";
export const TRUSTED_EMAIL_HEADER = "x-nteract-email";
const AUTH_PROVIDER_HEADER = "x-notebook-cloud-auth-provider";
const ANACONDA_API_KEY_AUTH_PROVIDER = "anaconda-api-key";

interface OidcCredential {
  token: string;
  transport: Extract<
    AuthenticatedConnectionMetadata["transport"],
    "oidc-bearer" | "oidc-subprotocol"
  >;
  webSocketProtocol?: string;
}

interface AnacondaApiKeyCredential {
  token: string;
  transport: Extract<AuthenticatedConnectionMetadata["transport"], "api-key-bearer">;
}

interface OidcConfig {
  audiences: string[];
  clientId: string;
  issuer: string;
  jwksJson?: string;
  principalNamespace: string;
}

interface AnacondaApiKeyConfig {
  userinfoUrl: string;
  principalNamespace: string;
}

interface AnacondaWhoamiResponse {
  passport?: {
    user_id?: string;
    profile?: {
      email?: string;
      first_name?: string;
      last_name?: string;
    };
    scopes?: unknown;
    source?: string;
  };
}

interface AnacondaApiKeyUserInfo {
  displayName?: string;
  email?: string;
  scopes: Set<string>;
  subject: string;
}

interface JsonWebKeySet {
  keys?: JsonWebKey[];
}

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface JwtPayload {
  aud?: string | string[];
  azp?: string;
  email?: string;
  email_verified?: boolean;
  exp?: number;
  family_name?: string;
  given_name?: string;
  iss?: string;
  name?: string;
  nbf?: number;
  preferred_username?: string;
  sub?: string;
  ver?: string;
}

const JWT_CLOCK_TOLERANCE_SECONDS = 60;
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const ANACONDA_API_KEY_CACHE_MAX_ENTRIES = 256;
const ANACONDA_API_KEY_CACHE_TTL_MS = 60 * 1000;
const OIDC_SUBJECT_MAX_LENGTH = 256;
const jwksCache = new Map<
  string,
  {
    expiresAt: number;
    ready: Promise<JsonWebKeySet>;
  }
>();
const anacondaApiKeyUserInfoCache = new Map<
  string,
  {
    expiresAt: number;
    ready: Promise<AnacondaApiKeyUserInfo>;
  }
>();

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export function authenticateRequest(
  request: Request,
  env: IdentityEnvironment = {},
): AuthenticatedConnection {
  if (!hasDevCredential(request)) {
    return authenticateAnonymousViewer(request);
  }

  const devCredential = authenticateDevCredential(request, env);
  if (!devCredential) {
    throw new AuthError(
      "dev credentials require a loopback request or NOTEBOOK_CLOUD_DEV_TOKEN",
      401,
    );
  }

  const identity = authenticateDevRequest(request);
  const authenticated = {
    ...identity,
    metadata: {
      ...identity.metadata,
      transport: devCredential.transport,
    },
  };
  return devCredential.webSocketProtocol
    ? { ...authenticated, webSocketProtocol: devCredential.webSocketProtocol }
    : authenticated;
}

export async function authenticateRequestWithProviders(
  request: Request,
  env: IdentityEnvironment = {},
): Promise<AuthenticatedConnection> {
  const anacondaApiKeyConfig = anacondaApiKeyConfigFromEnv(env);
  const oidcConfig = oidcConfigFromEnv(env);
  const oidcPartial = hasPartialOidcConfig(env);
  const anacondaApiKeyCredential = anacondaApiKeyCredentialFromRequest(request, {
    allowJwtShapeFallback: Boolean(anacondaApiKeyConfig) || (!oidcConfig && !oidcPartial),
  });
  const routeBearerToOidc = shouldRouteBearerToOidc(request, {
    anacondaApiKeyCredential,
    oidcConfig,
    oidcPartial,
  });
  const oidcCredential = anacondaApiKeyCredential
    ? undefined
    : oidcConfig || oidcPartial || hasOidcCredentialTransport(request)
      ? oidcCredentialFromRequest(request, { includeBearer: routeBearerToOidc })
      : undefined;
  if ([anacondaApiKeyCredential, oidcCredential].filter(Boolean).length > 1) {
    throw new AuthError("multiple identity credentials presented", 400);
  }
  if (anacondaApiKeyCredential && !anacondaApiKeyConfig) {
    throw new AuthError("Anaconda API key auth is not configured", 503);
  }
  if (oidcCredential && !oidcConfig) {
    throw new AuthError(
      oidcPartial ? "OIDC auth is not fully configured" : "OIDC auth is not configured",
      503,
    );
  }
  if (oidcCredential && oidcConfig) {
    if (hasDevIdentityCredential(request) || hasDevCredentialTransport(request)) {
      throw new AuthError("multiple identity credentials presented", 400);
    }
    return authenticateOidcRequest(request, env, oidcCredential);
  }
  if (anacondaApiKeyCredential && anacondaApiKeyConfig) {
    if (hasDevIdentityCredential(request) || hasDevCredentialTransport(request)) {
      throw new AuthError("multiple identity credentials presented", 400);
    }
    return authenticateAnacondaApiKeyRequest(request, env, anacondaApiKeyCredential);
  }

  return authenticateRequest(request, env);
}

export async function authenticateOidcRequest(
  request: Request,
  env: IdentityEnvironment,
  credential = oidcCredentialFromRequest(request),
): Promise<AuthenticatedConnection> {
  if (!credential) {
    throw new AuthError("missing OIDC token", 401);
  }

  const config = oidcConfigFromEnv(env);
  if (!config) {
    throw new AuthError("OIDC auth is not configured", 503);
  }

  const payload = await verifyOidcJwt(credential.token, config);
  const subject = payload.sub?.trim();
  if (!subject) {
    throw new AuthError("OIDC token is missing sub", 401);
  }
  if (subject.length > OIDC_SUBJECT_MAX_LENGTH) {
    throw new AuthError("OIDC token sub is too long", 401);
  }

  const url = new URL(request.url);
  const principal = `${config.principalNamespace}:${encodePrincipalComponent(subject)}`;
  const operator =
    headerOrQuery(request, url, "x-operator", "operator") ?? defaultBrowserOperator(request, url);
  const scope = parseScope(headerOrQuery(request, url, "x-scope", "scope") ?? "viewer");
  const profile = profileFromOidcPayload(payload);

  validatePrincipal(principal);
  validateOperator(operator);

  const identity = {
    principal,
    operator,
    actorLabel: `${principal}/${operator}`,
    scope,
    metadata: {
      provider: "oidc" as const,
      transport: credential.transport,
      principalNamespace: config.principalNamespace,
      ...(profile.displayName ? { displayName: profile.displayName } : {}),
      ...(profile.email ? { email: profile.email } : {}),
      ...(profile.email ? { emailVerified: payload.email_verified === true } : {}),
    },
  };
  return credential.webSocketProtocol
    ? { ...identity, webSocketProtocol: credential.webSocketProtocol }
    : identity;
}

function profileFromOidcPayload(payload: JwtPayload): {
  displayName?: string;
  email?: string;
} {
  const email = payload.email?.trim() || undefined;
  const displayName =
    payload.name?.trim() ||
    [payload.given_name, payload.family_name]
      .map((part) => part?.trim())
      .filter((part): part is string => Boolean(part))
      .join(" ") ||
    payload.preferred_username?.trim() ||
    email;

  return {
    ...(displayName ? { displayName } : {}),
    ...(email ? { email } : {}),
  };
}

export async function authenticateAnacondaApiKeyRequest(
  request: Request,
  env: IdentityEnvironment,
  credential?: AnacondaApiKeyCredential,
): Promise<AuthenticatedConnection> {
  credential ??= anacondaApiKeyCredentialFromRequest(request);
  if (!credential) {
    throw new AuthError("missing Anaconda API key", 401);
  }

  const config = anacondaApiKeyConfigFromEnv(env);
  if (!config) {
    throw new AuthError("Anaconda API key auth is not configured", 503);
  }

  const userInfo = await loadAnacondaApiKeyUserInfo(credential.token, config);
  const url = new URL(request.url);
  const operator = headerOrQuery(request, url, "x-operator", "operator") ?? defaultOperator();
  const scope = parseScope(headerOrQuery(request, url, "x-scope", "scope") ?? "viewer");
  if (!anacondaApiKeyAllowsScope(userInfo.scopes, scope)) {
    throw new AuthError("Anaconda API key scopes do not allow requested scope", 403);
  }

  const principal = `${config.principalNamespace}:${encodePrincipalComponent(userInfo.subject)}`;
  validatePrincipal(principal);
  validateOperator(operator);

  return {
    principal,
    operator,
    actorLabel: `${principal}/${operator}`,
    scope,
    metadata: {
      provider: "anaconda-api-key",
      transport: credential.transport,
      principalNamespace: config.principalNamespace,
      ...(userInfo.displayName ? { displayName: userInfo.displayName } : {}),
      ...(userInfo.email ? { email: userInfo.email } : {}),
      ...(userInfo.email ? { emailVerified: true } : {}),
    },
  };
}

async function loadAnacondaApiKeyUserInfo(
  token: string,
  config: AnacondaApiKeyConfig,
): Promise<AnacondaApiKeyUserInfo> {
  const now = Date.now();
  const cacheKey = `${config.userinfoUrl}:${token}`;
  const cached = anacondaApiKeyUserInfoCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    anacondaApiKeyUserInfoCache.delete(cacheKey);
    anacondaApiKeyUserInfoCache.set(cacheKey, cached);
    return cached.ready;
  }
  if (cached) {
    anacondaApiKeyUserInfoCache.delete(cacheKey);
  }

  const ready = fetchAnacondaApiKeyUserInfo(token, config).catch((error: unknown) => {
    anacondaApiKeyUserInfoCache.delete(cacheKey);
    throw error;
  });
  cacheAnacondaApiKeyUserInfo(cacheKey, {
    expiresAt: now + ANACONDA_API_KEY_CACHE_TTL_MS,
    ready,
  });
  return ready;
}

function cacheAnacondaApiKeyUserInfo(
  cacheKey: string,
  entry: {
    expiresAt: number;
    ready: Promise<AnacondaApiKeyUserInfo>;
  },
): void {
  const now = Date.now();
  for (const [key, cached] of anacondaApiKeyUserInfoCache) {
    if (cached.expiresAt <= now) {
      anacondaApiKeyUserInfoCache.delete(key);
    }
  }

  while (anacondaApiKeyUserInfoCache.size >= ANACONDA_API_KEY_CACHE_MAX_ENTRIES) {
    const oldestKey = anacondaApiKeyUserInfoCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    anacondaApiKeyUserInfoCache.delete(oldestKey);
  }

  anacondaApiKeyUserInfoCache.set(cacheKey, entry);
}

async function fetchAnacondaApiKeyUserInfo(
  token: string,
  config: AnacondaApiKeyConfig,
): Promise<AnacondaApiKeyUserInfo> {
  const response = await fetch(config.userinfoUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "nteract-notebook-cloud/1.0",
    },
  });
  if (!response.ok) {
    throw new AuthError("Anaconda API key validation failed", response.status === 403 ? 403 : 401);
  }

  let whoami: AnacondaWhoamiResponse;
  try {
    whoami = (await response.json()) as AnacondaWhoamiResponse;
  } catch {
    throw new AuthError("Anaconda API key userinfo response is invalid", 401);
  }

  const passport = whoami.passport;
  if (passport?.source !== "api_key") {
    throw new AuthError("Anaconda bearer token is not an API key", 401);
  }

  const subject = passport.user_id?.trim();
  if (!subject) {
    throw new AuthError("Anaconda API key userinfo is missing user_id", 401);
  }
  if (subject.length > OIDC_SUBJECT_MAX_LENGTH) {
    throw new AuthError("Anaconda API key user_id is too long", 401);
  }

  const scopes = anacondaApiKeyScopes(passport.scopes);
  const profile = passport.profile ?? {};
  const displayName =
    [profile.first_name, profile.last_name]
      .map((part) => part?.trim())
      .filter((part): part is string => Boolean(part))
      .join(" ") ||
    profile.email?.trim() ||
    undefined;
  const email = profile.email?.trim() || undefined;

  return {
    scopes,
    subject,
    ...(displayName ? { displayName } : {}),
    ...(email ? { email } : {}),
  };
}

export function authenticateDevRequest(request: Request): AuthenticatedConnection {
  const url = new URL(request.url);
  const principalHeader = headerOrQuery(request, url, "x-principal", "principal");
  const user = headerOrQuery(request, url, "x-user", "user") ?? "dev-anonymous";
  const operator = headerOrQuery(request, url, "x-operator", "operator") ?? defaultOperator();
  const scope = parseScope(headerOrQuery(request, url, "x-scope", "scope") ?? "viewer");
  const principal = principalHeader ?? principalForDevUser(user);

  validatePrincipal(principal);
  validateOperator(operator);

  return {
    principal,
    operator,
    actorLabel: `${principal}/${operator}`,
    scope,
    metadata: {
      provider: "dev",
      transport: "loopback-dev",
      principalNamespace: "user:dev",
      displayName: user,
    },
  };
}

export function authenticateAnonymousViewer(request: Request): AuthenticatedConnection {
  const url = new URL(request.url);
  const session =
    headerOrQuery(request, url, "x-viewer-session", "viewer_session") ??
    headerOrQuery(request, url, "x-session", "session") ??
    crypto.randomUUID();
  const encodedSession = encodePrincipalComponent(session.trim() || crypto.randomUUID());
  const principal = `${ANONYMOUS_PRINCIPAL_PREFIX}${encodedSession}`;
  const operator = `browser:${encodedSession}`;

  validatePrincipal(principal);
  validateOperator(operator);

  return {
    principal,
    operator,
    actorLabel: `${principal}/${operator}`,
    scope: "viewer",
    metadata: {
      provider: "anonymous",
      transport: "anonymous",
      principalNamespace: "anonymous",
      displayName: "Anonymous",
    },
  };
}

export function isAnonymousViewer(identity: AuthenticatedConnection): boolean {
  return identity.scope === "viewer" && identity.principal.startsWith(ANONYMOUS_PRINCIPAL_PREFIX);
}

export function stampTrustedIdentity(request: Request, identity: AuthenticatedConnection): Request {
  const headers = new Headers(request.headers);
  headers.set(TRUSTED_PRINCIPAL_HEADER, identity.principal);
  headers.set(TRUSTED_OPERATOR_HEADER, identity.operator);
  headers.set(TRUSTED_SCOPE_HEADER, identity.scope);
  headers.set(TRUSTED_IDENTITY_PROVIDER_HEADER, identity.metadata.provider);
  headers.set(TRUSTED_CREDENTIAL_TRANSPORT_HEADER, identity.metadata.transport);
  headers.set(TRUSTED_PRINCIPAL_NAMESPACE_HEADER, identity.metadata.principalNamespace);
  setOptionalTrustedHeader(headers, TRUSTED_DISPLAY_NAME_HEADER, identity.metadata.displayName);
  setOptionalTrustedHeader(headers, TRUSTED_EMAIL_HEADER, identity.metadata.email);
  if (identity.webSocketProtocol) {
    headers.set(TRUSTED_WEBSOCKET_PROTOCOL_HEADER, identity.webSocketProtocol);
    headers.set("Sec-WebSocket-Protocol", identity.webSocketProtocol);
  } else {
    headers.delete(TRUSTED_WEBSOCKET_PROTOCOL_HEADER);
    headers.delete("Sec-WebSocket-Protocol");
  }
  return new Request(request, { headers });
}

export function readTrustedIdentity(request: Request): AuthenticatedConnection {
  const principal = request.headers.get(TRUSTED_PRINCIPAL_HEADER);
  const operator = request.headers.get(TRUSTED_OPERATOR_HEADER);
  const scope = request.headers.get(TRUSTED_SCOPE_HEADER);
  const webSocketProtocol = request.headers.get(TRUSTED_WEBSOCKET_PROTOCOL_HEADER) ?? undefined;
  const provider = request.headers.get(TRUSTED_IDENTITY_PROVIDER_HEADER);
  const transport = request.headers.get(TRUSTED_CREDENTIAL_TRANSPORT_HEADER);
  const principalNamespace = request.headers.get(TRUSTED_PRINCIPAL_NAMESPACE_HEADER);
  const displayName = request.headers.get(TRUSTED_DISPLAY_NAME_HEADER) ?? undefined;
  const email = request.headers.get(TRUSTED_EMAIL_HEADER) ?? undefined;

  if (!principal || !operator || !scope || !provider || !transport || !principalNamespace) {
    throw new Error("missing trusted identity headers");
  }

  validatePrincipal(principal);
  validateOperator(operator);

  const parsedScope = parseScope(scope);
  const identity = {
    principal,
    operator,
    actorLabel: `${principal}/${operator}`,
    scope: parsedScope,
    metadata: parseTrustedMetadata(provider, transport, principalNamespace, displayName, email),
  };
  return webSocketProtocol ? { ...identity, webSocketProtocol } : identity;
}

export function principalForDevUser(user: string): string {
  const normalized = user.trim();
  if (normalized === "") {
    throw new Error("dev user cannot be empty");
  }

  return `user:dev:${encodePrincipalComponent(normalized)}`;
}

export function encodePrincipalComponent(value: string): string {
  return encodeURIComponent(value);
}

export function parseScope(value: string): ConnectionScope {
  if (isConnectionScope(value)) {
    return value;
  }
  throw new Error(`unknown connection scope: ${value}`);
}

// Capability predicates re-exported from the generated lattice
// (`packages/runtimed/src/scope-capabilities.ts`); the daemon enforces the
// same predicates from `nteract_identity::ConnectionScope`, so the hosted
// room and the daemon cannot drift (punchlist HCA-2 / BS-12).
export {
  allowsBlobUpload,
  allowsExecutionRequestSubmit,
  allowsNotebookWrite,
  allowsPublish,
} from "runtimed";

export function parseActorLabel(value: string): ActorLabel {
  const delimiter = value.indexOf("/");
  if (delimiter === -1) {
    throw new Error("actor label must be '<principal>/<operator>'");
  }

  const principal = value.slice(0, delimiter);
  const operator = value.slice(delimiter + 1);
  validatePrincipal(principal);
  validateOperator(operator);

  return {
    value,
    principal,
    operator,
  };
}

export function rewriteActorLabelPrincipal(
  presented: string | undefined,
  authenticated: AuthenticatedConnection,
): string {
  const operator = presented ? operatorFromActorLabelOrOperator(presented) : authenticated.operator;
  return `${authenticated.principal}/${operator}`;
}

export function operatorFromActorLabelOrOperator(value: string): string {
  const delimiter = value.indexOf("/");
  if (delimiter === -1) {
    validateOperator(value);
    return value;
  }

  return parseActorLabel(value).operator;
}

export function validatePrincipal(value: string): void {
  if (value.length === 0) {
    throw new Error("principal cannot be empty");
  }
  if (value.includes("/")) {
    throw new Error("principal cannot contain '/'");
  }
  if (value === "system") {
    return;
  }

  const delimiter = value.indexOf(":");
  if (delimiter === -1) {
    throw new Error("principal must be 'system' or '<scheme>:<id>'");
  }
  if (delimiter === 0) {
    throw new Error("principal scheme cannot be empty");
  }
  if (delimiter === value.length - 1) {
    throw new Error("principal id cannot be empty");
  }
}

export function validateOperator(value: string): void {
  if (value.length === 0) {
    throw new Error("operator cannot be empty");
  }
  if (value.includes("/")) {
    throw new Error("operator cannot contain '/'");
  }
  if (value.startsWith(":")) {
    throw new Error("operator kind cannot be empty");
  }
}

function headerOrQuery(
  request: Request,
  url: URL,
  headerName: string,
  queryName: string,
): string | undefined {
  return request.headers.get(headerName) ?? url.searchParams.get(queryName) ?? undefined;
}

function setOptionalTrustedHeader(headers: Headers, name: string, value: string | undefined): void {
  const headerValue = sanitizeTrustedMetadataHeader(value);
  if (headerValue) {
    headers.set(name, headerValue);
  } else {
    headers.delete(name);
  }
}

function sanitizeTrustedMetadataHeader(value: string | undefined): string | undefined {
  let sanitized = "";
  for (const char of value ?? "") {
    const code = char.charCodeAt(0);
    if (code === 0 || code === 10 || code === 13) {
      if (!sanitized.endsWith(" ")) {
        sanitized += " ";
      }
      continue;
    }
    sanitized += char;
  }
  sanitized = sanitized.trim();
  if (!sanitized) {
    return undefined;
  }
  return sanitized.slice(0, 512);
}

function parseTrustedMetadata(
  provider: string,
  transport: string,
  principalNamespace: string,
  displayName: string | undefined,
  email: string | undefined,
): AuthenticatedConnectionMetadata {
  if (!isMetadataProvider(provider)) {
    throw new Error(`unknown trusted identity provider: ${provider}`);
  }
  if (!isMetadataTransport(transport)) {
    throw new Error(`unknown trusted credential transport: ${transport}`);
  }

  return {
    provider,
    transport,
    principalNamespace,
    ...(displayName ? { displayName } : {}),
    ...(email ? { email } : {}),
  };
}

function isMetadataProvider(value: string): value is AuthenticatedConnectionMetadata["provider"] {
  return (
    value === "anonymous" ||
    value === "app-session" ||
    value === "dev" ||
    value === "oidc" ||
    value === "anaconda-api-key" ||
    value === "workstation-credential"
  );
}

function isMetadataTransport(value: string): value is AuthenticatedConnectionMetadata["transport"] {
  return (
    value === "anonymous" ||
    value === "app-session-cookie" ||
    value === "loopback-dev" ||
    value === "dev-token-header" ||
    value === "dev-token-subprotocol" ||
    value === "api-key-bearer" ||
    value === "oidc-bearer" ||
    value === "oidc-subprotocol" ||
    value === "workstation-credential-header"
  );
}

function hasDevCredential(request: Request): boolean {
  const url = new URL(request.url);
  return [
    ["x-principal", "principal"],
    ["x-user", "user"],
    ["x-operator", "operator"],
  ].some(
    ([headerName, queryName]) => request.headers.has(headerName) || url.searchParams.has(queryName),
  );
}

function hasDevIdentityCredential(request: Request): boolean {
  const url = new URL(request.url);
  return [
    ["x-principal", "principal"],
    ["x-user", "user"],
  ].some(
    ([headerName, queryName]) => request.headers.has(headerName) || url.searchParams.has(queryName),
  );
}

function hasDevCredentialTransport(request: Request): boolean {
  return (
    request.headers.has(DEV_AUTH_TOKEN_HEADER) ||
    hasWebSocketCredentialProtocol(
      request.headers.get("sec-websocket-protocol"),
      DEV_AUTH_TOKEN_PROTOCOL_PREFIX,
    )
  );
}

function authenticateDevCredential(
  request: Request,
  env: IdentityEnvironment,
):
  | {
      transport: Extract<
        AuthenticatedConnectionMetadata["transport"],
        "loopback-dev" | "dev-token-header" | "dev-token-subprotocol"
      >;
      webSocketProtocol?: string;
    }
  | undefined {
  if (isLocalDevRequest(request)) {
    const webSocketProtocol = tokenFromWebSocketProtocol(
      request.headers.get("sec-websocket-protocol"),
    );
    return webSocketProtocol
      ? { transport: "loopback-dev", webSocketProtocol: webSocketProtocol.webSocketProtocol }
      : { transport: "loopback-dev" };
  }

  return validDevTokenCredential(request, env);
}

function isLocalDevRequest(request: Request): boolean {
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function validDevTokenCredential(
  request: Request,
  env: IdentityEnvironment,
):
  | {
      transport: Extract<
        AuthenticatedConnectionMetadata["transport"],
        "dev-token-header" | "dev-token-subprotocol"
      >;
      webSocketProtocol?: string;
    }
  | undefined {
  const expected = env.NOTEBOOK_CLOUD_DEV_TOKEN?.trim();
  if (!expected) {
    return undefined;
  }

  const headerToken = request.headers.get(DEV_AUTH_TOKEN_HEADER) ?? undefined;
  if (timingSafeStringEqual(headerToken, expected)) {
    return { transport: "dev-token-header" };
  }

  const webSocketProtocol = tokenFromWebSocketProtocol(
    request.headers.get("sec-websocket-protocol"),
  );
  if (webSocketProtocol && timingSafeStringEqual(webSocketProtocol.token, expected)) {
    return {
      transport: "dev-token-subprotocol",
      webSocketProtocol: webSocketProtocol.webSocketProtocol,
    };
  }

  return undefined;
}

function oidcCredentialFromRequest(
  request: Request,
  options: { includeBearer?: boolean } = {},
): OidcCredential | undefined {
  const includeBearer = options.includeBearer ?? true;
  const candidates: OidcCredential[] = [];
  if (includeBearer) {
    const bearerToken = bearerTokenFromAuthorization(request.headers.get("authorization"));
    if (bearerToken) {
      candidates.push({ token: bearerToken, transport: "oidc-bearer" });
    }
  }

  const webSocketProtocol = tokenFromWebSocketProtocol(
    request.headers.get("sec-websocket-protocol"),
    BEARER_AUTH_TOKEN_PROTOCOL_PREFIX,
  );
  if (webSocketProtocol) {
    candidates.push({
      token: webSocketProtocol.token,
      transport: "oidc-subprotocol",
      webSocketProtocol: webSocketProtocol.webSocketProtocol,
    });
  }

  if (candidates.length > 1) {
    throw new AuthError("multiple identity credentials presented", 400);
  }

  return candidates[0];
}

function anacondaApiKeyCredentialFromRequest(
  request: Request,
  options: { allowJwtShapeFallback?: boolean } = {},
): AnacondaApiKeyCredential | undefined {
  const bearerToken = bearerTokenFromAuthorization(request.headers.get("authorization"));
  if (!bearerToken) {
    return undefined;
  }

  const explicitProvider =
    request.headers.get(AUTH_PROVIDER_HEADER)?.trim().toLowerCase() ===
    ANACONDA_API_KEY_AUTH_PROVIDER;
  if (!explicitProvider && !(options.allowJwtShapeFallback && isAnacondaApiKeyToken(bearerToken))) {
    return undefined;
  }
  return { token: bearerToken, transport: "api-key-bearer" };
}

function hasOidcCredentialTransport(request: Request): boolean {
  return hasWebSocketCredentialProtocol(
    request.headers.get("sec-websocket-protocol"),
    BEARER_AUTH_TOKEN_PROTOCOL_PREFIX,
  );
}

function shouldRouteBearerToOidc(
  request: Request,
  config: {
    anacondaApiKeyCredential: AnacondaApiKeyCredential | undefined;
    oidcConfig: OidcConfig | undefined;
    oidcPartial: boolean;
  },
): boolean {
  const bearerToken = bearerTokenFromAuthorization(request.headers.get("authorization"));
  if (!bearerToken) {
    return false;
  }
  if (config.anacondaApiKeyCredential) {
    return false;
  }
  return Boolean(config.oidcConfig || config.oidcPartial);
}

function anacondaApiKeyConfigFromEnv(env: IdentityEnvironment): AnacondaApiKeyConfig | undefined {
  const rawUserinfoUrl = env.NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL?.trim();
  if (!rawUserinfoUrl) {
    return undefined;
  }
  return {
    userinfoUrl: normalizeHttpsUrl(rawUserinfoUrl, "Anaconda API key userinfo URL"),
    principalNamespace: normalizePrincipalNamespace(
      env.NOTEBOOK_CLOUD_ANACONDA_API_KEY_PRINCIPAL_NAMESPACE ??
        env.NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE ??
        "user:anaconda",
    ),
  };
}

function hasPartialOidcConfig(env: IdentityEnvironment): boolean {
  const issuer = env.NOTEBOOK_CLOUD_OIDC_ISSUER?.trim();
  const clientId = env.NOTEBOOK_CLOUD_OIDC_CLIENT_ID?.trim();
  const audience = env.NOTEBOOK_CLOUD_OIDC_AUDIENCE?.trim();
  const jwksJson = env.NOTEBOOK_CLOUD_OIDC_JWKS_JSON?.trim();
  if (!issuer && !clientId && !audience && !jwksJson) {
    return false;
  }
  return !issuer || !clientId;
}

function oidcConfigFromEnv(env: IdentityEnvironment): OidcConfig | undefined {
  const rawIssuer = env.NOTEBOOK_CLOUD_OIDC_ISSUER?.trim();
  const clientId = env.NOTEBOOK_CLOUD_OIDC_CLIENT_ID?.trim();
  if (!rawIssuer || !clientId) {
    return undefined;
  }

  return {
    audiences: oidcAudiencesFromEnv(env.NOTEBOOK_CLOUD_OIDC_AUDIENCE, clientId),
    clientId,
    issuer: normalizeOidcIssuer(rawIssuer),
    jwksJson: env.NOTEBOOK_CLOUD_OIDC_JWKS_JSON,
    principalNamespace: normalizePrincipalNamespace(env.NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE),
  };
}

function oidcAudiencesFromEnv(value: string | undefined, clientId: string): string[] {
  const audiences =
    value
      ?.split(",")
      .map((audience) => audience.trim())
      .filter(Boolean) ?? [];
  return audiences.length > 0 ? [...new Set(audiences)] : [clientId];
}

function normalizeOidcIssuer(value: string): string {
  return normalizeHttpsUrl(value, "OIDC issuer");
}

function normalizeHttpsUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthError(`${label} must be a valid URL`, 503);
  }
  if (url.protocol !== "https:") {
    throw new AuthError(`${label} must use https`, 503);
  }
  url.hash = "";
  url.search = "";
  return url.href.replace(/\/+$/, "");
}

function normalizePrincipalNamespace(value: string | undefined): string {
  const namespace = value?.trim().replace(/:+$/, "") || "user:oidc";
  validatePrincipal(`${namespace}:subject`);
  return namespace;
}

async function verifyOidcJwt(token: string, config: OidcConfig): Promise<JwtPayload> {
  const { header, payload, signingInput, signature } = decodeJwt(token, "OIDC");
  if (header.alg !== "RS256") {
    throw new AuthError("OIDC token must use RS256", 401);
  }

  const keys = selectJwks(await loadOidcJwks(config), header, "OIDC");
  const verified = await verifyWithAnySigningKey(keys, signingInput, signature);
  if (!verified) {
    throw new AuthError("OIDC token signature is invalid", 401);
  }

  validateOidcJwtClaims(payload, config);
  return payload;
}

function decodeJwt(
  token: string,
  label: "OIDC",
): {
  header: JwtHeader;
  payload: JwtPayload;
  signingInput: string;
  signature: Uint8Array;
} {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AuthError(`${label} token must be a JWT`, 401);
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new AuthError(`${label} token must be a JWT`, 401);
  }

  return {
    header: decodeBase64UrlJson<JwtHeader>(encodedHeader, label),
    payload: decodeBase64UrlJson<JwtPayload>(encodedPayload, label),
    signingInput: `${encodedHeader}.${encodedPayload}`,
    signature: decodeBase64UrlBytes(encodedSignature),
  };
}

async function loadOidcJwks(config: OidcConfig): Promise<JsonWebKeySet> {
  if (config.jwksJson?.trim()) {
    return parseJwks(config.jwksJson, "OIDC");
  }

  return loadRemoteJwks(`${config.issuer}/.well-known/jwks.json`, "OIDC");
}

async function loadRemoteJwks(url: string, label: "OIDC"): Promise<JsonWebKeySet> {
  const cached = jwksCache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.ready;
  }

  const ready = fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "nteract-notebook-cloud/1.0",
    },
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new AuthError(`${label} JWKS fetch failed: ${response.status}`, 503);
      }
      return parseJwks(await response.text(), label);
    })
    .catch((error: unknown) => {
      jwksCache.delete(url);
      throw error;
    });
  jwksCache.set(url, {
    expiresAt: Date.now() + JWKS_CACHE_TTL_MS,
    ready,
  });
  return ready;
}

function parseJwks(value: string, label: "OIDC"): JsonWebKeySet {
  try {
    const parsed = JSON.parse(value) as JsonWebKeySet;
    if (!Array.isArray(parsed.keys)) {
      throw new Error("JWKS keys must be an array");
    }
    return parsed;
  } catch (error) {
    throw new AuthError(`${label} JWKS is invalid: ${String(error)}`, 503);
  }
}

function selectJwks(jwks: JsonWebKeySet, header: JwtHeader, label: "OIDC"): JsonWebKey[] {
  const keys = jwks.keys ?? [];
  const candidates = keys.filter((key) => {
    if (key.kty !== "RSA") return false;
    if (key.alg && key.alg !== "RS256") return false;
    if (key.use && key.use !== "sig") return false;
    if (key.key_ops && !key.key_ops.includes("verify")) return false;
    if (header.kid && (key as JsonWebKey & { kid?: string }).kid !== header.kid) return false;
    return true;
  });

  if (candidates.length === 0) {
    throw new AuthError(`${label} signing key was not found`, 401);
  }
  return candidates;
}

async function verifyWithAnySigningKey(
  keys: JsonWebKey[],
  signingInput: string,
  signature: Uint8Array,
): Promise<boolean> {
  for (const key of keys) {
    try {
      const cryptoKey = await crypto.subtle.importKey(
        "jwk",
        key,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      if (
        await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          cryptoKey,
          signature,
          new TextEncoder().encode(signingInput),
        )
      ) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

function validateOidcJwtClaims(payload: JwtPayload, config: OidcConfig): void {
  if (payload.iss !== config.issuer) {
    throw new AuthError("OIDC token issuer is invalid", 401);
  }

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!config.audiences.some((audience) => audiences.includes(audience))) {
    throw new AuthError("OIDC token audience is invalid", 401);
  }
  if (audiences.length > 1 && payload.azp !== config.clientId) {
    throw new AuthError("OIDC token authorized party is invalid", 401);
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now - JWT_CLOCK_TOLERANCE_SECONDS) {
    throw new AuthError("OIDC token is expired", 401);
  }
  if (typeof payload.nbf === "number" && payload.nbf > now + JWT_CLOCK_TOLERANCE_SECONDS) {
    throw new AuthError("OIDC token is not valid yet", 401);
  }
}

function isAnacondaApiKeyToken(token: string): boolean {
  const payload = unverifiedJwtPayload(token);
  if (payload?.ver !== "api:1") {
    return false;
  }

  return !("iss" in payload || "aud" in payload || "azp" in payload);
}

function unverifiedJwtPayload(token: string): JwtPayload | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    return undefined;
  }
  try {
    const decoded = decodeBase64Url(parts[1]);
    if (!decoded) {
      return undefined;
    }
    return JSON.parse(decoded) as JwtPayload;
  } catch {
    return undefined;
  }
}

function anacondaApiKeyScopes(value: unknown): Set<string> {
  return new Set(
    Array.isArray(value) ? value.filter((scope): scope is string => typeof scope === "string") : [],
  );
}

function anacondaApiKeyAllowsScope(scopes: Set<string>, scope: ConnectionScope): boolean {
  if (scope === "viewer") {
    return scopes.has("cloud:read") || scopes.has("cloud:write");
  }
  return scopes.has("cloud:write");
}

function bearerTokenFromAuthorization(value: string | null): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function tokenFromWebSocketProtocol(
  value: string | null,
  prefix = DEV_AUTH_TOKEN_PROTOCOL_PREFIX,
): { token: string; webSocketProtocol?: string } | undefined {
  if (!value) return undefined;

  const webSocketProtocol = applicationWebSocketProtocolFromHeader(value);
  let credential: { token: string; webSocketProtocol?: string } | undefined;
  for (const protocol of value.split(",")) {
    const trimmed = protocol.trim();
    if (!trimmed.startsWith(prefix)) continue;
    const token = decodeBase64Url(trimmed.slice(prefix.length));
    if (!token) continue;
    if (credential) {
      throw new AuthError("multiple WebSocket credential subprotocols presented", 400);
    }
    credential = webSocketProtocol ? { token, webSocketProtocol } : { token };
  }

  return credential;
}

function hasWebSocketCredentialProtocol(value: string | null, prefix: string): boolean {
  if (!value) return false;
  return value.split(",").some((protocol) => protocol.trim().startsWith(prefix));
}

function applicationWebSocketProtocolFromHeader(value: string): string | undefined {
  return value.split(",").some((protocol) => protocol.trim() === NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL)
    ? NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL
    : undefined;
}

function decodeBase64Url(value: string): string | undefined {
  if (value.length === 0) return undefined;

  try {
    const bytes = decodeBase64UrlBytes(value);
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

function decodeBase64UrlJson<T>(value: string, label: "OIDC"): T {
  const decoded = decodeBase64Url(value);
  if (!decoded) {
    throw new AuthError(`${label} token contains invalid base64url JSON`, 401);
  }
  try {
    return JSON.parse(decoded) as T;
  } catch (error) {
    throw new AuthError(`${label} token contains invalid JSON: ${String(error)}`, 401);
  }
}

function decodeBase64UrlBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function defaultOperator(): string {
  return `desktop:${crypto.randomUUID()}`;
}

function defaultBrowserOperator(request: Request, url: URL): string {
  const session =
    headerOrQuery(request, url, "x-viewer-session", "viewer_session") ??
    headerOrQuery(request, url, "x-session", "session") ??
    crypto.randomUUID();
  return `browser:${encodePrincipalComponent(session.trim() || crypto.randomUUID())}`;
}

function timingSafeStringEqual(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) {
    return false;
  }

  const encoder = new TextEncoder();
  const presentedBytes = encoder.encode(presented);
  const expectedBytes = encoder.encode(expected);
  let diff = presentedBytes.length ^ expectedBytes.length;

  for (let index = 0; index < expectedBytes.length; index += 1) {
    diff |= (presentedBytes[index] ?? 0) ^ expectedBytes[index];
  }

  return diff === 0;
}
