export type ConnectionScope = "viewer" | "editor" | "runtime_peer" | "owner";

export const BEARER_AUTH_TOKEN_PROTOCOL_PREFIX = "nteract-bearer.";
export const DEV_AUTH_TOKEN_HEADER = "x-notebook-cloud-dev-token";
export const DEV_AUTH_TOKEN_PROTOCOL_PREFIX = "nteract-dev-token.";
export const NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL = "nteract.v4";

export function isConnectionScope(value: string | null | undefined): value is ConnectionScope {
  return value === "viewer" || value === "editor" || value === "runtime_peer" || value === "owner";
}
