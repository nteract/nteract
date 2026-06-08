import {
  APP_SESSION_SYNC_TICKET_PROTOCOL_PREFIX,
  BEARER_AUTH_TOKEN_PROTOCOL_PREFIX,
  DEV_AUTH_TOKEN_HEADER,
  DEV_AUTH_TOKEN_PROTOCOL_PREFIX,
  NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
  isConnectionScope,
  type ConnectionScope,
} from "../src/auth-shared";
import {
  NOTEBOOK_CLOUD_OIDC_REQUEST_STORAGE_KEY,
  NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY,
  clearCloudOidcAuth,
  oidcDisplayName,
  readStoredOidcToken,
  type CloudOidcClaims,
} from "./oidc-auth";

export const NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY = "nteract:notebook-cloud:dev-token";
export const NOTEBOOK_CLOUD_USER_STORAGE_KEY = "nteract:notebook-cloud:user";
export const NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY = "nteract:notebook-cloud:scope";
export const NOTEBOOK_CLOUD_DEFAULT_SCOPE: ConnectionScope = "viewer";
export { NOTEBOOK_CLOUD_OIDC_REQUEST_STORAGE_KEY, NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY };

const NOTEBOOK_CLOUD_AUTH_STORAGE_KEYS = new Set<string>([
  NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY,
  NOTEBOOK_CLOUD_USER_STORAGE_KEY,
  NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY,
  NOTEBOOK_CLOUD_OIDC_REQUEST_STORAGE_KEY,
  NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY,
]);

export interface CloudSyncAuth {
  headers: Record<string, string>;
  protocols: string[];
  user: string | null;
  operator: string | null;
  requestedScope: ConnectionScope | null;
}

export interface CloudPrototypeAuthState {
  mode: "anonymous" | "dev" | "invalid" | "oidc" | "oidc_expired";
  token: string | null;
  user: string | null;
  oidcClaims: CloudOidcClaims | null;
  requestedScope: ConnectionScope | null;
  problem: string | null;
}

export interface CloudPrototypeAuthStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export interface CloudPrototypeAuthInput {
  token: string;
  user: string;
  scope: ConnectionScope;
}

export interface CloudSyncTicketAuthOptions {
  endpoint: string;
  requestedScope: ConnectionScope | null;
  sessionId: string;
  fetchImpl?: typeof fetch;
}

interface CloudSyncTicketResponse {
  ok: true;
  ticket: string;
  expires_in: number;
  scope: Exclude<ConnectionScope, "runtime_peer">;
}

export interface CloudPrototypeConnectionDiagnostics {
  actorLabel: string | null;
  connectionError: string | null;
  connectionScope: string | null;
}

export interface CloudPrototypeAuthDiagnosticRow {
  label: string;
  value: string;
  copyValue?: string;
  tone?: "default" | "warning" | "success";
}

export interface CloudPrototypeAuthDiagnostics {
  rows: CloudPrototypeAuthDiagnosticRow[];
  copyText: string;
}

export type CloudNotebookSignInAction = "idle" | "starting";

export interface CloudNotebookSignInCopy {
  label: string;
  title: string;
}

export function cloudPrototypeAuthFromWindow(): CloudPrototypeAuthState {
  if (typeof window === "undefined") {
    return anonymousAuthState();
  }
  try {
    if (!window.localStorage) {
      return anonymousAuthState();
    }
    return readCloudPrototypeAuth(window.localStorage);
  } catch {
    return anonymousAuthState();
  }
}

export function isCloudPrototypeAuthStorageKey(key: string | null): boolean {
  return key === null || NOTEBOOK_CLOUD_AUTH_STORAGE_KEYS.has(key);
}

export function readCloudPrototypeAuth(
  storage: Pick<CloudPrototypeAuthStorage, "getItem">,
): CloudPrototypeAuthState {
  const token = storage.getItem(NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY)?.trim() ?? "";
  const requestedScope = parseStoredScope(storage.getItem(NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY));
  const oidcSession = readStoredOidcToken(storage);
  if (!token) {
    if (oidcSession.token) {
      return {
        mode: "oidc",
        token: oidcSession.token.accessToken,
        user: oidcDisplayName(oidcSession.token.claims),
        oidcClaims: oidcSession.token.claims,
        requestedScope: requestedScope ?? NOTEBOOK_CLOUD_DEFAULT_SCOPE,
        problem: null,
      };
    }
    if (oidcSession.problem) {
      return {
        mode: "invalid",
        token: null,
        user: null,
        oidcClaims: null,
        requestedScope: requestedScope ?? NOTEBOOK_CLOUD_DEFAULT_SCOPE,
        problem: oidcSession.problem,
      };
    }
    if (oidcSession.expired) {
      return {
        mode: "oidc_expired",
        token: null,
        user: oidcSession.expiredClaims ? oidcDisplayName(oidcSession.expiredClaims) : null,
        oidcClaims: oidcSession.expiredClaims,
        requestedScope: NOTEBOOK_CLOUD_DEFAULT_SCOPE,
        problem: "Stored OIDC session is expired. Sign in again.",
      };
    }
    return anonymousAuthState();
  }

  const user = storage.getItem(NOTEBOOK_CLOUD_USER_STORAGE_KEY)?.trim() || "browser-editor";
  const problem = validatePrototypeToken(token);
  if (problem) {
    return {
      mode: "invalid",
      token,
      user,
      oidcClaims: null,
      requestedScope: requestedScope ?? NOTEBOOK_CLOUD_DEFAULT_SCOPE,
      problem,
    };
  }

  return {
    mode: "dev",
    token,
    user,
    oidcClaims: null,
    requestedScope: requestedScope ?? NOTEBOOK_CLOUD_DEFAULT_SCOPE,
    problem: null,
  };
}

export function cloudSyncAuthFromPrototypeAuthState(state: CloudPrototypeAuthState): CloudSyncAuth {
  if (state.mode === "oidc" && state.token) {
    return {
      headers: cloudHttpHeadersFromPrototypeAuthState(state),
      protocols: [
        `${BEARER_AUTH_TOKEN_PROTOCOL_PREFIX}${base64UrlEncode(state.token)}`,
        NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
      ],
      user: null,
      operator: null,
      requestedScope: state.requestedScope ?? NOTEBOOK_CLOUD_DEFAULT_SCOPE,
    };
  }
  if (state.mode !== "dev" || !state.token) {
    return { headers: {}, protocols: [], user: null, operator: null, requestedScope: null };
  }

  return {
    headers: cloudHttpHeadersFromPrototypeAuthState(state),
    protocols: [
      `${DEV_AUTH_TOKEN_PROTOCOL_PREFIX}${base64UrlEncode(state.token)}`,
      NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
    ],
    user: state.user ?? "browser-editor",
    operator: null,
    requestedScope: state.requestedScope ?? NOTEBOOK_CLOUD_DEFAULT_SCOPE,
  };
}

export async function cloudSyncAuthFromAppSessionTicket({
  endpoint,
  requestedScope,
  sessionId,
  fetchImpl = fetch,
}: CloudSyncTicketAuthOptions): Promise<CloudSyncAuth> {
  const operator = `browser:${encodeURIComponent(sessionId)}`;
  const scope = requestedScope ?? NOTEBOOK_CLOUD_DEFAULT_SCOPE;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ operator, scope }),
  });
  if (!response.ok) {
    throw new Error(`Unable to mint live room ticket: ${response.status}`);
  }

  const body = (await response.json()) as unknown;
  if (!isCloudSyncTicketResponse(body)) {
    throw new Error("Unable to mint live room ticket: response shape was invalid");
  }

  return {
    headers: {},
    protocols: [
      `${APP_SESSION_SYNC_TICKET_PROTOCOL_PREFIX}${base64UrlEncode(body.ticket)}`,
      NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
    ],
    user: null,
    operator,
    requestedScope: body.scope,
  };
}

export function cloudHttpHeadersFromPrototypeAuthState(
  state: CloudPrototypeAuthState,
): Record<string, string> {
  if (state.mode === "dev" && state.token) {
    return {
      [DEV_AUTH_TOKEN_HEADER]: state.token,
      "X-User": state.user ?? "browser-editor",
      "X-Scope": state.requestedScope ?? NOTEBOOK_CLOUD_DEFAULT_SCOPE,
    };
  }
  if (state.mode === "oidc" && state.token) {
    return {
      Authorization: `Bearer ${state.token}`,
      "X-Scope": state.requestedScope ?? NOTEBOOK_CLOUD_DEFAULT_SCOPE,
    };
  }
  return {};
}

export function fetchWithCloudPrototypeAuth(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  state: CloudPrototypeAuthState,
): Promise<Response> {
  return fetch(input, withCloudPrototypeAuthHeaders(init, state));
}

export function withCloudPrototypeAuthHeaders(
  init: RequestInit | undefined,
  state: CloudPrototypeAuthState,
): RequestInit {
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(
    cloudBrowserHttpHeadersFromPrototypeAuthState(state),
  )) {
    headers.set(name, value);
  }
  return {
    ...init,
    credentials: init?.credentials ?? "same-origin",
    headers,
  };
}

function cloudBrowserHttpHeadersFromPrototypeAuthState(
  state: CloudPrototypeAuthState,
): Record<string, string> {
  if (state.mode !== "dev") {
    return {};
  }
  return cloudHttpHeadersFromPrototypeAuthState(state);
}

export function storeCloudPrototypeDevAuth(
  storage: CloudPrototypeAuthStorage,
  input: CloudPrototypeAuthInput,
): void {
  clearCloudOidcAuth(storage);
  storage.setItem(NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY, input.token.trim());
  storage.setItem(NOTEBOOK_CLOUD_USER_STORAGE_KEY, input.user.trim() || "browser-editor");
  storage.setItem(NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY, input.scope);
}

export function storeCloudRequestedScope(
  storage: Pick<CloudPrototypeAuthStorage, "setItem">,
  scope: ConnectionScope,
): void {
  storage.setItem(NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY, scope);
}

export function prepareCloudOidcViewerLogin(
  storage: Pick<CloudPrototypeAuthStorage, "removeItem" | "setItem">,
): void {
  clearCloudOidcAuth(storage);
  storage.removeItem(NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY);
  storage.removeItem(NOTEBOOK_CLOUD_USER_STORAGE_KEY);
  storage.setItem(NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY, NOTEBOOK_CLOUD_DEFAULT_SCOPE);
}

export function clearCloudPrototypeDevAuth(
  storage: Pick<CloudPrototypeAuthStorage, "removeItem">,
): void {
  storage.removeItem(NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY);
  storage.removeItem(NOTEBOOK_CLOUD_USER_STORAGE_KEY);
  storage.removeItem(NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY);
  clearCloudOidcAuth(storage);
}

export function validatePrototypeToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) {
    return "Token is empty.";
  }
  if (trimmed === "<NOTEBOOK_CLOUD_DEV_TOKEN>" || trimmed === "NOTEBOOK_CLOUD_DEV_TOKEN") {
    return "Token is still the NOTEBOOK_CLOUD_DEV_TOKEN placeholder.";
  }
  if (/^<[^>]+>$/.test(trimmed)) {
    return "Token still looks like a placeholder value.";
  }
  return null;
}

export function prototypeAuthSummary(state: CloudPrototypeAuthState): string {
  if (state.mode === "dev") {
    return `${state.user ?? "browser-editor"} requesting ${
      state.requestedScope ?? NOTEBOOK_CLOUD_DEFAULT_SCOPE
    }`;
  }
  if (state.mode === "oidc") {
    return `${state.user ?? "OIDC session"} requesting ${
      state.requestedScope ?? NOTEBOOK_CLOUD_DEFAULT_SCOPE
    }`;
  }
  if (state.mode === "oidc_expired") {
    return `${state.user ?? "OIDC session"} needs sign-in renewal.`;
  }
  if (state.mode === "invalid") {
    return state.problem ?? "Stored collaborator token is invalid.";
  }
  return "Anonymous read-only viewer";
}

export function cloudNotebookSignInCopy(
  state: CloudPrototypeAuthState,
  action: CloudNotebookSignInAction,
  error: string | null = null,
): CloudNotebookSignInCopy {
  if (error) {
    return {
      label: "Sign-in failed",
      title: error,
    };
  }
  if (action === "starting") {
    return {
      label: "Signing in",
      title: "Starting Anaconda sign-in",
    };
  }
  if (state.mode === "oidc_expired") {
    return {
      label: "Sign in again",
      title: "Renew your Anaconda sign-in for this notebook",
    };
  }
  if (state.mode === "invalid") {
    return {
      label: "Sign in",
      title: "Replace the invalid stored auth state with Anaconda sign-in",
    };
  }
  return {
    label: "Sign in",
    title: "Sign in with Anaconda",
  };
}

export function prototypeAuthDiagnostics(
  state: CloudPrototypeAuthState,
  connection: CloudPrototypeConnectionDiagnostics,
): CloudPrototypeAuthDiagnostics {
  const rows: CloudPrototypeAuthDiagnosticRow[] = [];
  if (state.mode === "dev") {
    rows.push(
      {
        label: "Requested principal",
        value: devPrincipalLabel(state.user ?? "browser-editor"),
      },
      {
        label: "Requested scope",
        value: state.requestedScope ?? NOTEBOOK_CLOUD_DEFAULT_SCOPE,
      },
      {
        label: "Dev token",
        value: "Stored locally; sent as a WebSocket subprotocol, never in the URL.",
      },
    );
  } else if (state.mode === "oidc") {
    rows.push(
      {
        label: "Requested identity",
        value: state.user ?? "OIDC session",
      },
      {
        label: "Requested scope",
        value: state.requestedScope ?? NOTEBOOK_CLOUD_DEFAULT_SCOPE,
      },
      {
        label: "Credential",
        value:
          "OIDC bearer token cached for sign-in renewal; first-party APIs use an app-session cookie and sync-ticket WebSockets.",
      },
    );
    if (state.oidcClaims?.sub) {
      rows.push({
        label: "Provider subject",
        value: state.oidcClaims.sub,
      });
    }
  } else if (state.mode === "oidc_expired") {
    rows.push(
      {
        label: "Stored identity",
        value: state.user ?? "OIDC session",
        tone: "warning",
      },
      {
        label: "Sign-in",
        value: state.problem ?? "Stored OIDC session is expired. Sign in again.",
        tone: "warning",
      },
      {
        label: "Effective auth",
        value: "No expired bearer token is sent; public notebooks may still load as a viewer.",
        tone: "warning",
      },
    );
    if (state.oidcClaims?.sub) {
      rows.push({
        label: "Provider subject",
        value: state.oidcClaims.sub,
        tone: "warning",
      });
    }
  } else if (state.mode === "invalid") {
    rows.push(
      {
        label: "Stored identity",
        value: `${devPrincipalLabel(state.user ?? "browser-editor")} requesting ${
          state.requestedScope ?? NOTEBOOK_CLOUD_DEFAULT_SCOPE
        }`,
        tone: "warning",
      },
      {
        label: "Dev token",
        value: state.problem ?? "Stored token is invalid.",
        tone: "warning",
      },
      {
        label: "Effective auth",
        value: "Anonymous viewer until the token is replaced or reset.",
        tone: "warning",
      },
    );
  } else {
    rows.push(
      {
        label: "Effective auth",
        value: "Anonymous read-only viewer.",
      },
      {
        label: "Dev token",
        value: "Not stored.",
      },
    );
  }

  if (connection.connectionScope) {
    rows.push({
      label: "Connected scope",
      value: connection.connectionScope,
      tone: "success",
    });
  } else if (connection.connectionError) {
    rows.push({
      label: "Connected scope",
      value: "Offline",
      tone: "warning",
    });
  } else {
    rows.push({
      label: "Connected scope",
      value: "Connecting...",
    });
  }

  if (connection.actorLabel) {
    rows.push({
      label: "Room actor",
      value: connection.actorLabel,
      tone: "success",
    });
  }

  if (connection.connectionError) {
    rows.push({
      label: "Last connection error",
      value: cloudConnectionErrorSummary(connection.connectionError),
      copyValue: sanitizeCloudConnectionDiagnostic(connection.connectionError),
      tone: "warning",
    });
  }

  return {
    rows,
    copyText: rows.map((row) => `${row.label}: ${row.copyValue ?? row.value}`).join("\n"),
  };
}

function cloudConnectionErrorSummary(error: string): string {
  if (/\bfailed to connect\s+wss?:\/\//i.test(error)) {
    return "Unable to join the live notebook room.";
  }
  return sanitizeCloudConnectionDiagnostic(error);
}

function sanitizeCloudConnectionDiagnostic(error: string): string {
  return error.replace(/\bwss?:\/\/[^\s]+/gi, (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      return rawUrl.replace(/[?#].*$/, "");
    }
  });
}

function anonymousAuthState(): CloudPrototypeAuthState {
  return {
    mode: "anonymous",
    token: null,
    user: null,
    oidcClaims: null,
    requestedScope: null,
    problem: null,
  };
}

function parseStoredScope(value: string | null): ConnectionScope | null {
  return isConnectionScope(value) ? value : null;
}

function isCloudSyncTicketResponse(value: unknown): value is CloudSyncTicketResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const scope = candidate.scope;
  return (
    candidate.ok === true &&
    typeof candidate.ticket === "string" &&
    Number.isFinite(candidate.expires_in) &&
    typeof scope === "string" &&
    isConnectionScope(scope) &&
    scope !== "runtime_peer"
  );
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function devPrincipalLabel(user: string): string {
  return `user:dev:${encodeURIComponent(user.trim() || "browser-editor")}`;
}
