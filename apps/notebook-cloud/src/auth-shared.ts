// The scope union comes from the generated capability lattice
// (`packages/runtimed/src/scope-capabilities.ts`, generated from
// `nteract_identity::ConnectionScope`) so the Worker cannot drift from the
// daemon's Rust enforcement. Keep the runtime guard local so dashboard/auth
// code does not eagerly pull the notebook sync runtime into the app shell.
import type { ConnectionScope } from "runtimed";

export type { ConnectionScope };

const CONNECTION_SCOPES = [
  "viewer",
  "editor",
  "runtime_peer",
  "owner",
] as const satisfies readonly ConnectionScope[];
type MissingConnectionScope = Exclude<ConnectionScope, (typeof CONNECTION_SCOPES)[number]>;
const CONNECTION_SCOPES_EXHAUSTIVE: MissingConnectionScope extends never ? true : never = true;
void CONNECTION_SCOPES_EXHAUSTIVE;

export function isConnectionScope(value: string | null | undefined): value is ConnectionScope {
  return typeof value === "string" && CONNECTION_SCOPES.includes(value as ConnectionScope);
}

export const BEARER_AUTH_TOKEN_PROTOCOL_PREFIX = "nteract-bearer.";
export const DEV_AUTH_TOKEN_HEADER = "x-notebook-cloud-dev-token";
export const DEV_AUTH_TOKEN_PROTOCOL_PREFIX = "nteract-dev-token.";
export const NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL = "nteract.v4";
