export {
  CONNECTION_SCOPES,
  allowsAclMutation,
  allowsBlobUpload,
  allowsExecutionRequestSubmit,
  allowsNotebookWrite,
  allowsPublish,
  allowsRuntimeStateWrite,
  isConnectionScope,
  parseConnectionScope,
  type ConnectionScope,
} from "./scope-capabilities";
export {
  CURSOR_COLORS,
  colorForActorIdentity,
  contrastColorForActorIdentity,
  identityColorKey,
  peerColor,
  readableForegroundForColor,
} from "./notebook-actor-color";
export { normalizeInviteEmail } from "./invite-email";
export type {
  AuthenticatedConnection,
  AuthenticatedConnectionMetadata,
} from "./authenticated-connection";
