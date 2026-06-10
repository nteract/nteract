// The scope union and its guard come from the generated capability lattice
// (`packages/runtimed/src/scope-capabilities.ts`, generated from
// `nteract_identity::ConnectionScope`) so the Worker cannot drift from the
// daemon's Rust enforcement.
export { isConnectionScope, type ConnectionScope } from "runtimed";

export const BEARER_AUTH_TOKEN_PROTOCOL_PREFIX = "nteract-bearer.";
export const DEV_AUTH_TOKEN_HEADER = "x-notebook-cloud-dev-token";
export const DEV_AUTH_TOKEN_PROTOCOL_PREFIX = "nteract-dev-token.";
export const NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL = "nteract.v4";
