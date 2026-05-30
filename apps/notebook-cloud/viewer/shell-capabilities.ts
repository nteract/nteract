import type { NotebookShellCapabilities } from "@/components/notebook-shell";
import type { CloudPrototypeAuthState } from "./collaborator-auth";

export interface CloudNotebookShellCapabilityInput {
  authState: CloudPrototypeAuthState;
  connectionScope: string | null;
  hasCodeCells: boolean;
}

export function cloudNotebookShellCapabilities({
  authState,
  connectionScope,
  hasCodeCells,
}: CloudNotebookShellCapabilityInput): NotebookShellCapabilities {
  const canEdit = connectionScope === "editor" || connectionScope === "owner";
  const authenticated = authState.mode === "dev" || authState.mode === "oidc";
  const authNeedsAttention = authState.mode === "invalid" || authState.mode === "oidc_expired";

  return {
    canRead: true,
    canEditMarkdown: canEdit,
    canEditCells: canEdit,
    canExecute: false,
    canToggleCode: hasCodeCells,
    canViewPackages: true,
    canManagePackages: false,
    canManageSharing: connectionScope === "owner",
    auth: {
      canSignIn: authState.mode !== "oidc",
      canUseAuthenticatedIdentity: authenticated && !authNeedsAttention,
      needsAttention: authNeedsAttention,
    },
  };
}
