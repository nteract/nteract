import {
  DEV_AUTH_TOKEN_PROTOCOL_PREFIX,
  isConnectionScope,
  type ConnectionScope,
} from "../src/auth-shared";

export const NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY = "nteract:notebook-cloud:dev-token";
export const NOTEBOOK_CLOUD_USER_STORAGE_KEY = "nteract:notebook-cloud:user";
export const NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY = "nteract:notebook-cloud:scope";

export interface CloudSyncAuth {
  protocols: string[];
  user: string | null;
  operator: string | null;
  requestedScope: ConnectionScope | null;
}

export interface CloudPrototypeAuthState {
  mode: "anonymous" | "dev" | "invalid";
  token: string | null;
  user: string | null;
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

export interface CloudPrototypeConnectionDiagnostics {
  actorLabel: string | null;
  connectionError: string | null;
  connectionScope: string | null;
}

export interface CloudPrototypeAuthDiagnosticRow {
  label: string;
  value: string;
  tone?: "default" | "warning" | "success";
}

export interface CloudPrototypeAuthDiagnostics {
  rows: CloudPrototypeAuthDiagnosticRow[];
  copyText: string;
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

export function readCloudPrototypeAuth(
  storage: Pick<CloudPrototypeAuthStorage, "getItem">,
): CloudPrototypeAuthState {
  const token = storage.getItem(NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY)?.trim() ?? "";
  if (!token) {
    return anonymousAuthState();
  }

  const requestedScope = parseStoredScope(storage.getItem(NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY));
  const user = storage.getItem(NOTEBOOK_CLOUD_USER_STORAGE_KEY)?.trim() || "browser-editor";
  const problem = validatePrototypeToken(token);
  if (problem) {
    return {
      mode: "invalid",
      token,
      user,
      requestedScope: requestedScope ?? "editor",
      problem,
    };
  }

  return {
    mode: "dev",
    token,
    user,
    requestedScope: requestedScope ?? "editor",
    problem: null,
  };
}

export function cloudSyncAuthFromPrototypeAuthState(state: CloudPrototypeAuthState): CloudSyncAuth {
  if (state.mode !== "dev" || !state.token) {
    return { protocols: [], user: null, operator: null, requestedScope: null };
  }

  return {
    protocols: [`${DEV_AUTH_TOKEN_PROTOCOL_PREFIX}${base64UrlEncode(state.token)}`],
    user: state.user ?? "browser-editor",
    operator: null,
    requestedScope: state.requestedScope ?? "editor",
  };
}

export function storeCloudPrototypeDevAuth(
  storage: CloudPrototypeAuthStorage,
  input: CloudPrototypeAuthInput,
): void {
  storage.setItem(NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY, input.token.trim());
  storage.setItem(NOTEBOOK_CLOUD_USER_STORAGE_KEY, input.user.trim() || "browser-editor");
  storage.setItem(NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY, input.scope);
}

export function clearCloudPrototypeDevAuth(
  storage: Pick<CloudPrototypeAuthStorage, "removeItem">,
): void {
  storage.removeItem(NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY);
  storage.removeItem(NOTEBOOK_CLOUD_USER_STORAGE_KEY);
  storage.removeItem(NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY);
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
    return `${state.user ?? "browser-editor"} requesting ${state.requestedScope ?? "editor"}`;
  }
  if (state.mode === "invalid") {
    return `${state.problem ?? "Stored collaborator token is invalid"} Connected anonymously.`;
  }
  return "Anonymous read-only viewer";
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
        value: state.requestedScope ?? "editor",
      },
      {
        label: "Dev token",
        value: "Stored locally; sent as a WebSocket subprotocol, never in the URL.",
      },
    );
  } else if (state.mode === "invalid") {
    rows.push(
      {
        label: "Stored identity",
        value: `${devPrincipalLabel(state.user ?? "browser-editor")} requesting ${
          state.requestedScope ?? "editor"
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
      value: connection.connectionError,
      tone: "warning",
    });
  }

  return {
    rows,
    copyText: rows.map((row) => `${row.label}: ${row.value}`).join("\n"),
  };
}

function anonymousAuthState(): CloudPrototypeAuthState {
  return {
    mode: "anonymous",
    token: null,
    user: null,
    requestedScope: null,
    problem: null,
  };
}

function parseStoredScope(value: string | null): ConnectionScope | null {
  return isConnectionScope(value) ? value : null;
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
