export type ConnectionScope = "viewer" | "editor" | "runtime_peer" | "owner";

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
  webSocketProtocol?: string;
}

export interface IdentityEnvironment {
  DEPLOYMENT_ENV?: string;
  NOTEBOOK_CLOUD_DEV_TOKEN?: string;
}

const ANONYMOUS_PRINCIPAL_PREFIX = "anonymous:";

export const TRUSTED_PRINCIPAL_HEADER = "x-nteract-principal";
export const TRUSTED_OPERATOR_HEADER = "x-nteract-operator";
export const TRUSTED_SCOPE_HEADER = "x-nteract-scope";
export const TRUSTED_WEBSOCKET_PROTOCOL_HEADER = "x-nteract-websocket-protocol";
export const DEV_AUTH_TOKEN_HEADER = "x-notebook-cloud-dev-token";
export const DEV_AUTH_TOKEN_PROTOCOL_PREFIX = "nteract-dev-token.";

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
    throw new AuthError("dev credentials require a local request or NOTEBOOK_CLOUD_DEV_TOKEN", 401);
  }

  const identity = authenticateDevRequest(request);
  return devCredential.webSocketProtocol
    ? { ...identity, webSocketProtocol: devCredential.webSocketProtocol }
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
  if (identity.webSocketProtocol) {
    headers.set(TRUSTED_WEBSOCKET_PROTOCOL_HEADER, identity.webSocketProtocol);
  } else {
    headers.delete(TRUSTED_WEBSOCKET_PROTOCOL_HEADER);
  }
  return new Request(request, { headers });
}

export function readTrustedIdentity(request: Request): AuthenticatedConnection {
  const principal = request.headers.get(TRUSTED_PRINCIPAL_HEADER);
  const operator = request.headers.get(TRUSTED_OPERATOR_HEADER);
  const scope = request.headers.get(TRUSTED_SCOPE_HEADER);
  const webSocketProtocol = request.headers.get(TRUSTED_WEBSOCKET_PROTOCOL_HEADER) ?? undefined;

  if (!principal || !operator || !scope) {
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
  switch (value) {
    case "viewer":
    case "editor":
    case "runtime_peer":
    case "owner":
      return value;
    default:
      throw new Error(`unknown connection scope: ${value}`);
  }
}

export function allowsNotebookWrite(scope: ConnectionScope): boolean {
  return scope === "editor" || scope === "owner";
}

export function allowsRuntimeStateWrite(scope: ConnectionScope): boolean {
  return scope === "editor" || scope === "runtime_peer" || scope === "owner";
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

function authenticateDevCredential(
  request: Request,
  env: IdentityEnvironment,
): { webSocketProtocol?: string } | undefined {
  if (isLocalDevRequest(request, env)) {
    return {};
  }

  return validDevTokenCredential(request, env);
}

function isLocalDevRequest(request: Request, env: IdentityEnvironment): boolean {
  if (env.DEPLOYMENT_ENV === "development") {
    return true;
  }

  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function validDevTokenCredential(
  request: Request,
  env: IdentityEnvironment,
): { webSocketProtocol?: string } | undefined {
  const expected = env.NOTEBOOK_CLOUD_DEV_TOKEN?.trim();
  if (!expected) {
    return undefined;
  }

  const headerToken = request.headers.get(DEV_AUTH_TOKEN_HEADER) ?? undefined;
  if (timingSafeStringEqual(headerToken, expected)) {
    return {};
  }

  const webSocketProtocol = tokenFromWebSocketProtocol(
    request.headers.get("sec-websocket-protocol"),
  );
  if (webSocketProtocol && timingSafeStringEqual(webSocketProtocol.token, expected)) {
    return { webSocketProtocol: webSocketProtocol.protocol };
  }

  return undefined;
}

function tokenFromWebSocketProtocol(
  value: string | null,
): { protocol: string; token: string } | undefined {
  if (!value) return undefined;

  for (const protocol of value.split(",")) {
    const trimmed = protocol.trim();
    if (!trimmed.startsWith(DEV_AUTH_TOKEN_PROTOCOL_PREFIX)) continue;
    const token = decodeBase64Url(trimmed.slice(DEV_AUTH_TOKEN_PROTOCOL_PREFIX.length));
    if (!token) continue;
    return { protocol: trimmed, token };
  }

  return undefined;
}

function decodeBase64Url(value: string): string | undefined {
  if (value.length === 0) return undefined;

  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
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
