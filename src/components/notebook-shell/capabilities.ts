export type NotebookShellAccessLevel = "none" | "viewer" | "editor" | "owner";

export type NotebookShellAccessSource = "cloud" | "local" | "fixture" | "unknown";

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
}

export interface NotebookShellAuthCapabilities {
  canSignIn: boolean;
  canUseAuthenticatedIdentity: boolean;
  needsAttention: boolean;
}

export interface NotebookShellCapabilities {
  canRead: boolean;
  canEditMarkdown: boolean;
  canEditCells: boolean;
  canRequestEdit: boolean;
  canExecute: boolean;
  canToggleCode: boolean;
  canViewPackages: boolean;
  canManagePackages: boolean;
  canManageSharing: boolean;
  access: NotebookShellAccessCapabilities;
  auth: NotebookShellAuthCapabilities;
}

export interface CreateNotebookShellCapabilitiesOptions {
  access: NotebookShellAccessCapabilities;
  auth: NotebookShellAuthCapabilities;
  /**
   * Whether this host can currently accept notebook document mutations.
   * Local read-only files and cloud viewer rooms can grant document access
   * while still rejecting writes.
   */
  canMutateDocument?: boolean;
  canRequestEdit?: boolean;
  canExecute?: boolean;
  canToggleCode?: boolean;
  canViewPackages?: boolean;
  canManagePackages?: boolean;
  canManageSharing?: boolean;
}

export function createNotebookShellCapabilities({
  access,
  auth,
  canMutateDocument = false,
  canRequestEdit = false,
  canExecute = false,
  canToggleCode = false,
  canViewPackages = false,
  canManagePackages = false,
  canManageSharing = false,
}: CreateNotebookShellCapabilitiesOptions): NotebookShellCapabilities {
  const canRead = access.level !== "none";
  const hasWriteAccess = access.level === "editor" || access.level === "owner";
  const canEditCells = canRead && hasWriteAccess && canMutateDocument;

  return {
    canRead,
    canEditMarkdown: canEditCells,
    canEditCells,
    canRequestEdit,
    canExecute: canEditCells && canExecute,
    canToggleCode: canRead && canToggleCode,
    canViewPackages: canRead && canViewPackages,
    canManagePackages: canEditCells && canManagePackages,
    canManageSharing: access.level === "owner" && canManageSharing,
    access,
    auth,
  };
}

export const readOnlyNotebookShellCapabilities: NotebookShellCapabilities = {
  canRead: true,
  canEditMarkdown: false,
  canEditCells: false,
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
};
