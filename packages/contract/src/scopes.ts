// Connection scopes a notebook server grants and checks. The lattice is
// defined once, in @nteract/identity; this entry point names it as part of the
// contract.
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
} from "@nteract/identity";
