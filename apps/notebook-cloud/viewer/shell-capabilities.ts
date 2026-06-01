import {
  notebookActorProjectionFromAccess,
  notebookActorProjectionFromRuntime,
} from "@/components/notebook-shell/actor-projection";
import type { NotebookShellCapabilities } from "@/components/notebook-shell/capabilities";
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
  const accessLevel = cloudConnectionAccessLevel(connectionScope);
  const isRuntimePeer = connectionScope === "runtime_peer";
  const userSelectedViewMode = authState.requestedScope === "viewer";
  const activeEditLevel = userSelectedViewMode ? "viewer" : accessLevel;
  const canEditMarkdown = activeEditLevel === "editor" || activeEditLevel === "owner";
  const canEditCells = activeEditLevel === "owner";
  const canEditStructure = activeEditLevel === "owner";
  const authenticated = authState.mode === "dev" || authState.mode === "oidc";
  const authNeedsAttention = authState.mode === "invalid" || authState.mode === "oidc_expired";
  const auth = {
    canSignIn: authState.mode !== "oidc",
    canUseAuthenticatedIdentity: authenticated && !authNeedsAttention,
    needsAttention: authNeedsAttention,
  };
  const access = {
    level: accessLevel,
    source: "cloud" as const,
    isPublic: !authenticated && accessLevel === "viewer",
    actorLabel: connectionActorLabel,
    identityLabel: authState.user,
  };
  const runtime = {
    canWriteRuntimeState: isRuntimePeer,
    connected: isRuntimePeer,
    source: "cloud" as const,
    actorLabel: isRuntimePeer ? connectionActorLabel : null,
    identityLabel: isRuntimePeer ? authState.user : null,
  };

  return {
    canRead: true,
    canEditMarkdown,
    canEditCells,
    canEditStructure,
    canRequestEdit: authState.mode === "oidc",
    canExecute: false,
    canToggleCode: hasCodeCells,
    canViewPackages: true,
    canManagePackages: false,
    canManageSharing: connectionScope === "owner",
    access: {
      ...access,
      actor: notebookActorProjectionFromAccess(access, auth),
    },
    auth,
    runtime: {
      ...runtime,
      actor: notebookActorProjectionFromRuntime(runtime, auth),
    },
  };
}

function cloudConnectionAccessLevel(
  connectionScope: string | null,
): NotebookShellCapabilities["access"]["level"] {
  if (connectionScope === "owner" || connectionScope === "editor" || connectionScope === "viewer") {
    return connectionScope;
  }
  return "viewer";
}
