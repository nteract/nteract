import {
  createNotebookShellCapabilities,
  type NotebookShellCapabilities,
} from "@/components/notebook-shell/capabilities";
import type { CloudPrototypeAuthState } from "./collaborator-auth";

export interface CloudNotebookShellCapabilityInput {
  authState: CloudPrototypeAuthState;
  connectionScope: string | null;
  connectionActorLabel?: string | null;
  hasCodeCells: boolean;
}

export function cloudNotebookShellCapabilities({
  authState,
  connectionScope,
  connectionActorLabel = null,
  hasCodeCells,
}: CloudNotebookShellCapabilityInput): NotebookShellCapabilities {
  const authenticated = authState.mode === "dev" || authState.mode === "oidc";
  const authNeedsAttention = authState.mode === "invalid" || authState.mode === "oidc_expired";
  const accessLevel = cloudConnectionAccessLevel(connectionScope);

  return createNotebookShellCapabilities({
    canMutateDocument: true,
    canRequestEdit: authState.mode === "oidc",
    canExecute: false,
    canToggleCode: hasCodeCells,
    canViewPackages: true,
    canManagePackages: false,
    canManageSharing: true,
    access: {
      level: accessLevel,
      source: "cloud",
      isPublic: !authenticated && accessLevel === "viewer",
      actorLabel: connectionActorLabel,
      identityLabel: authState.user,
    },
    auth: {
      canSignIn: authState.mode !== "oidc",
      canUseAuthenticatedIdentity: authenticated && !authNeedsAttention,
      needsAttention: authNeedsAttention,
    },
  });
}

function cloudConnectionAccessLevel(
  connectionScope: string | null,
): NotebookShellCapabilities["access"]["level"] {
  if (connectionScope === "owner" || connectionScope === "editor" || connectionScope === "viewer") {
    return connectionScope;
  }
  return "viewer";
}
