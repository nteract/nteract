export interface NotebookShellAuthCapabilities {
  canSignIn: boolean;
  canUseAuthenticatedIdentity: boolean;
  needsAttention: boolean;
}

export interface NotebookShellCapabilities {
  canRead: boolean;
  canEditMarkdown: boolean;
  canEditCells: boolean;
  canExecute: boolean;
  canToggleCode: boolean;
  canViewPackages: boolean;
  canManagePackages: boolean;
  canManageSharing: boolean;
  auth: NotebookShellAuthCapabilities;
}

export const readOnlyNotebookShellCapabilities: NotebookShellCapabilities = {
  canRead: true,
  canEditMarkdown: false,
  canEditCells: false,
  canExecute: false,
  canToggleCode: false,
  canViewPackages: true,
  canManagePackages: false,
  canManageSharing: false,
  auth: {
    canSignIn: false,
    canUseAuthenticatedIdentity: false,
    needsAttention: false,
  },
};
