export {
  projectNotebookShellCapabilities,
  readOnlyNotebookShellCapabilities,
  type NotebookActorOperator,
  type NotebookActorPrincipal,
  type NotebookActorProjection,
  type NotebookActorSourceProvider,
  type NotebookShellAccessCapabilities,
  type NotebookShellAccessLevel,
  type NotebookShellAccessSource,
  type NotebookShellAuthCapabilities,
  type NotebookShellCapabilities,
  type NotebookShellControlPolicy,
  type NotebookShellExecutionPolicy,
  type NotebookShellPackagePolicy,
  type NotebookShellRuntimeCapabilities,
  type NotebookShellSharingPolicy,
  type ProjectNotebookShellCapabilitiesOptions,
} from "runtimed";

export type NotebookActorKind =
  | "agent"
  | "human"
  | "local"
  | "public"
  | "runtime"
  | "system"
  | "unknown";

export interface NotebookActorIdentity {
  id: string;
  label: string;
  detail: string | null;
  kind: NotebookActorKind;
  imageUrl?: string | null;
  status?: "active" | "attention" | "idle" | "offline";
  principalLabel?: string | null;
  operatorLabel?: string | null;
}
