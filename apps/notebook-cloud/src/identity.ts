import {
  ACCESS_AUTH_TOKEN_PROTOCOL_PREFIX,
  DEV_AUTH_TOKEN_PROTOCOL_PREFIX,
  NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
  isConnectionScope,
  type ConnectionScope,
} from "./auth-shared.ts";

export {
  ACCESS_AUTH_TOKEN_PROTOCOL_PREFIX,
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
  NOTEBOOK_CLOUD_ACCESS_AUD?: string;
  NOTEBOOK_CLOUD_ACCESS_JWKS_JSON?: string;
  NOTEBOOK_CLOUD_ACCESS_TEAM_DOMAIN?: string;
}

export interface AuthenticatedConnectionMetadata {
  provider: "anonymous" | "dev" | "cloudflare-access";
  transport:
    | "anonymous"
    | "loopback-dev"
    | "dev-token-header"
    | "dev-token-subprotocol"
    | "access-assertion"
    | "access-bearer"
    | "access-cookie"
    | "access-cookie-assertion"
    | "access-subprotocol";
  principalNamespace: string;
  displayName?: string;
  email?: string;
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
export const CLOUDFLARE_ACCESS_JWT_HEADER = "cf-access-jwt-assertion";
export const DEV_AUTH_TOKEN_HEADER = "x-notebook-cloud-dev-token";

interface AccessCredential {
  token: string;
  transport: AuthenticatedConnectionMetadata["transport"];
  webSocketProtocol?: string;
}

interface AccessConfig {
  audience: string;
  issuer: string;
  jwksJson?: string;
}

interface JsonWebKeySet {
  keys?: JsonWebKey[];
}

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface AccessJwtPayload {
  aud?: string | string[];
  email?: string;
  exp?: number;
  iss?: string;
  name?: string;
  nbf?: number;
  sub?: string;
}

const ACCESS_CLOCK_TOLERANCE_SECONDS = 60;
const ACCESS_JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const accessJwksCache = new Map<
  string,
  {
    expiresAt: number;
    ready: Promise<JsonWebKeySet>;
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
  const accessCredential = accessCredentialFromRequest(request);
  if (accessCredential && accessConfigFromEnv(env)) {
    if (hasDevIdentityCredential(request) || hasDevCredentialTransport(request)) {
      throw new AuthError("multiple identity credentials presented", 400);
    }
    return authenticateCloudflareAccessRequest(request, env, accessCredential);
  }

  return authenticateRequest(request, env);
}

export async function authenticateCloudflareAccessRequest(
  request: Request,
  env: IdentityEnvironment,
  credential = accessCredentialFromRequest(request),
): Promise<AuthenticatedConnection> {
  if (!credential) {
    throw new AuthError("missing Cloudflare Access token", 401);
  }

  const config = accessConfigFromEnv(env);
  if (!config) {
    throw new AuthError("Cloudflare Access auth is not configured", 503);
  }

  const payload = await verifyCloudflareAccessJwt(credential.token, config);
  const subject = payload.sub?.trim();
  if (!subject) {
    throw new AuthError("Cloudflare Access token is missing sub", 401);
  }

  const url = new URL(request.url);
  const principal = `user:cloudflare-access:${encodePrincipalComponent(subject)}`;
  const operator = headerOrQuery(request, url, "x-operator", "operator") ?? defaultOperator();
  const scope = parseScope(headerOrQuery(request, url, "x-scope", "scope") ?? "viewer");

  validatePrincipal(principal);
  validateOperator(operator);

  const identity = {
    principal,
    operator,
    actorLabel: `${principal}/${operator}`,
    scope,
    metadata: {
      provider: "cloudflare-access" as const,
      transport: credential.transport,
      principalNamespace: "user:cloudflare-access",
      ...(payload.name?.trim() || payload.email?.trim()
        ? { displayName: payload.name?.trim() || payload.email?.trim() || undefined }
        : {}),
      ...(payload.email?.trim() ? { email: payload.email.trim() } : {}),
    },
  };
  return credential.webSocketProtocol
    ? { ...identity, webSocketProtocol: credential.webSocketProtocol }
    : identity;
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

export function allowsNotebookWrite(scope: ConnectionScope): boolean {
  return scope === "editor" || scope === "owner";
}

export function allowsRuntimeStateWrite(scope: ConnectionScope): boolean {
  return scope === "editor" || scope === "runtime_peer" || scope === "owner";
}

export function allowsBlobUpload(scope: ConnectionScope): boolean {
  return allowsRuntimeStateWrite(scope);
}

export function allowsPublish(scope: ConnectionScope): boolean {
  return scope === "owner";
}

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
  return value === "anonymous" || value === "dev" || value === "cloudflare-access";
}

function isMetadataTransport(value: string): value is AuthenticatedConnectionMetadata["transport"] {
  return (
    value === "anonymous" ||
    value === "loopback-dev" ||
    value === "dev-token-header" ||
    value === "dev-token-subprotocol" ||
    value === "access-assertion" ||
    value === "access-bearer" ||
    value === "access-cookie" ||
    value === "access-cookie-assertion" ||
    value === "access-subprotocol"
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

function accessCredentialFromRequest(request: Request): AccessCredential | undefined {
  const candidates: AccessCredential[] = [];
  const assertionToken = request.headers.get(CLOUDFLARE_ACCESS_JWT_HEADER)?.trim() || undefined;
  if (assertionToken) {
    candidates.push({
      token: assertionToken,
      transport: cookieValue(request.headers.get("cookie"), "CF_Authorization")
        ? "access-cookie-assertion"
        : "access-assertion",
    });
  }

  const accessToken = request.headers.get("cf-access-token")?.trim() || undefined;
  if (accessToken) {
    candidates.push({ token: accessToken });
  }

  const bearerToken = bearerTokenFromAuthorization(request.headers.get("authorization"));
  if (bearerToken) {
    candidates.push({ token: bearerToken, transport: "access-bearer" });
  }

  const cookieToken = cookieValue(request.headers.get("cookie"), "CF_Authorization");
  if (cookieToken && !assertionToken) {
    candidates.push({ token: cookieToken, transport: "access-cookie" });
  }

  const webSocketProtocol = tokenFromWebSocketProtocol(
    request.headers.get("sec-websocket-protocol"),
    ACCESS_AUTH_TOKEN_PROTOCOL_PREFIX,
  );
  if (webSocketProtocol) {
    candidates.push({
      token: webSocketProtocol.token,
      transport: "access-subprotocol",
      webSocketProtocol: webSocketProtocol.webSocketProtocol,
    });
  }

  if (candidates.length > 1) {
    throw new AuthError("multiple identity credentials presented", 400);
  }

  return candidates[0];
}

function accessConfigFromEnv(env: IdentityEnvironment): AccessConfig | undefined {
  const audience = env.NOTEBOOK_CLOUD_ACCESS_AUD?.trim();
  const rawTeamDomain = env.NOTEBOOK_CLOUD_ACCESS_TEAM_DOMAIN?.trim();
  if (!audience || !rawTeamDomain) {
    return undefined;
  }

  return {
    audience,
    issuer: normalizeAccessIssuer(rawTeamDomain),
    jwksJson: env.NOTEBOOK_CLOUD_ACCESS_JWKS_JSON,
  };
}

function normalizeAccessIssuer(value: string): string {
  if (value.startsWith("https://")) {
    return value.replace(/\/+$/, "");
  }
  const host = value.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${host}`;
}

async function verifyCloudflareAccessJwt(
  token: string,
  config: AccessConfig,
): Promise<AccessJwtPayload> {
  const { header, payload, signingInput, signature } = decodeJwt(token);
  if (header.alg !== "RS256") {
    throw new AuthError("Cloudflare Access token must use RS256", 401);
  }

  const keys = selectAccessJwks(await loadAccessJwks(config), header);
  const verified = await verifyWithAnyAccessKey(keys, signingInput, signature);
  if (!verified) {
    throw new AuthError("Cloudflare Access token signature is invalid", 401);
  }

  validateAccessJwtClaims(payload, config);
  return payload;
}

function decodeJwt(token: string): {
  header: JwtHeader;
  payload: AccessJwtPayload;
  signingInput: string;
  signature: Uint8Array;
} {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new AuthError("Cloudflare Access token must be a JWT", 401);
  }

  return {
    header: decodeBase64UrlJson<JwtHeader>(encodedHeader),
    payload: decodeBase64UrlJson<AccessJwtPayload>(encodedPayload),
    signingInput: `${encodedHeader}.${encodedPayload}`,
    signature: decodeBase64UrlBytes(encodedSignature),
  };
}

async function loadAccessJwks(config: AccessConfig): Promise<JsonWebKeySet> {
  if (config.jwksJson?.trim()) {
    return parseJwks(config.jwksJson);
  }

  const url = `${config.issuer}/cdn-cgi/access/certs`;
  const cached = accessJwksCache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.ready;
  }

  const ready = fetch(url)
    .then(async (response) => {
      if (!response.ok) {
        throw new AuthError(`Cloudflare Access JWKS fetch failed: ${response.status}`, 503);
      }
      return parseJwks(await response.text());
    })
    .catch((error: unknown) => {
      accessJwksCache.delete(url);
      throw error;
    });
  accessJwksCache.set(url, {
    expiresAt: Date.now() + ACCESS_JWKS_CACHE_TTL_MS,
    ready,
  });
  return ready;
}

function parseJwks(value: string): JsonWebKeySet {
  try {
    const parsed = JSON.parse(value) as JsonWebKeySet;
    if (!Array.isArray(parsed.keys)) {
      throw new Error("JWKS keys must be an array");
    }
    return parsed;
  } catch (error) {
    throw new AuthError(`Cloudflare Access JWKS is invalid: ${String(error)}`, 503);
  }
}

function selectAccessJwks(jwks: JsonWebKeySet, header: JwtHeader): JsonWebKey[] {
  const keys = jwks.keys ?? [];
  const candidates = keys.filter((key) => {
    if (key.kty !== "RSA") return false;
    if (key.alg && key.alg !== "RS256") return false;
    if (header.kid && (key as JsonWebKey & { kid?: string }).kid !== header.kid) return false;
    return true;
  });

  if (candidates.length === 0) {
    throw new AuthError("Cloudflare Access signing key was not found", 401);
  }
  return candidates;
}

async function verifyWithAnyAccessKey(
  keys: JsonWebKey[],
  signingInput: string,
  signature: Uint8Array,
): Promise<boolean> {
  for (const key of keys) {
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
  }
  return false;
}

function validateAccessJwtClaims(payload: AccessJwtPayload, config: AccessConfig): void {
  if (payload.iss !== config.issuer) {
    throw new AuthError("Cloudflare Access token issuer is invalid", 401);
  }

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(config.audience)) {
    throw new AuthError("Cloudflare Access token audience is invalid", 401);
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now - ACCESS_CLOCK_TOLERANCE_SECONDS) {
    throw new AuthError("Cloudflare Access token is expired", 401);
  }
  if (typeof payload.nbf === "number" && payload.nbf > now + ACCESS_CLOCK_TOLERANCE_SECONDS) {
    throw new AuthError("Cloudflare Access token is not valid yet", 401);
  }
}

function bearerTokenFromAuthorization(value: string | null): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function cookieValue(value: string | null, name: string): string | undefined {
  if (!value) return undefined;
  for (const part of value.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) {
      return rawValue.join("=") || undefined;
    }
  }
  return undefined;
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

function decodeBase64UrlJson<T>(value: string): T {
  const decoded = decodeBase64Url(value);
  if (!decoded) {
    throw new AuthError("Cloudflare Access token contains invalid base64url JSON", 401);
  }
  try {
    return JSON.parse(decoded) as T;
  } catch (error) {
    throw new AuthError(`Cloudflare Access token contains invalid JSON: ${String(error)}`, 401);
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
