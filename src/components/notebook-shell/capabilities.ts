export type NotebookShellAccessLevel = "none" | "viewer" | "editor" | "owner";

export type NotebookShellAccessSource = "cloud" | "local" | "fixture" | "unknown";

export type NotebookActorSourceProvider =
  | "anonymous"
  | "anaconda-api-key"
  | "dev"
  | "jupyterhub"
  | "local"
  | "oidc";

export interface NotebookActorPrincipal {
  id: string;
  label: string;
  imageUrl?: string | null;
  source?: {
    provider: NotebookActorSourceProvider;
    namespace: string;
  };
}

export interface NotebookActorOperator {
  id: string;
  kind: string;
  label: string;
}

export interface NotebookActorProjection {
  actorLabel: string;
  principal: NotebookActorPrincipal;
  operator: NotebookActorOperator;
  scope?: "viewer" | "editor" | "runtime_peer" | "owner";
  status?: "active" | "attention" | "idle" | "offline";
}

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

export interface NotebookShellAccessCapabilities {
  /**
   * The document-level access granted to the current identity. Hosts derive
   * this from ACLs, local file permissions, or fixture scenarios.
   */
  level: NotebookShellAccessLevel;
  source: NotebookShellAccessSource;
  isPublic: boolean;
  actorLabel: string | null;
  identityLabel: string | null;
  /**
   * Structured host-owned actor projection. Durable actor labels remain the
   * backend/CRDT attribution source; React falls back to parsing them only
   * while hosts are still adopting this source-shaped projection.
   */
  actor?: NotebookActorProjection | null;
}

export interface NotebookShellAuthCapabilities {
  canSignIn: boolean;
  canUseAuthenticatedIdentity: boolean;
  needsAttention: boolean;
}

export interface NotebookShellRuntimeCapabilities {
  /**
   * Runtime peers author execution lifecycle, output, and comm state. This is
   * intentionally separate from document access: runtime authorship does not
   * grant notebook editing, package management, or sharing controls.
   */
  canWriteRuntimeState: boolean;
  connected: boolean;
  source: NotebookShellAccessSource;
  actorLabel: string | null;
  identityLabel: string | null;
  actor?: NotebookActorProjection | null;
}

export interface NotebookShellCapabilities {
  canRead: boolean;
  canEditMarkdown: boolean;
  canEditCells: boolean;
  canEditStructure: boolean;
  canRequestEdit: boolean;
  canExecute: boolean;
  canToggleCode: boolean;
  canViewPackages: boolean;
  canManagePackages: boolean;
  canManageSharing: boolean;
  access: NotebookShellAccessCapabilities;
  auth: NotebookShellAuthCapabilities;
  runtime: NotebookShellRuntimeCapabilities;
}

export const readOnlyNotebookShellCapabilities: NotebookShellCapabilities = {
  canRead: true,
  canEditMarkdown: false,
  canEditCells: false,
  canEditStructure: false,
  canRequestEdit: false,
  canExecute: false,
  canToggleCode: false,
  canViewPackages: true,
  canManagePackages: false,
  canManageSharing: false,
  access: {
    level: "viewer",
    source: "unknown",
    isPublic: false,
    actorLabel: null,
    identityLabel: null,
  },
  auth: {
    canSignIn: false,
    canUseAuthenticatedIdentity: false,
    needsAttention: false,
  },
  runtime: {
    canWriteRuntimeState: false,
    connected: false,
    source: "unknown",
    actorLabel: null,
    identityLabel: null,
  },
};
