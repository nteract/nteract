import {
  notebookActorProjectionFromAccess,
  notebookActorProjectionFromRuntime,
} from "@/components/notebook-shell/actor-projection";
import type { NotebookShellCapabilities } from "@/components/notebook-shell/capabilities";
import { createNotebookInteractionModeProjection } from "@/components/notebook-shell/interaction-mode";
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
  const authenticated = authState.mode === "dev" || authState.mode === "oidc";
  const authNeedsAttention = authState.mode === "invalid" || authState.mode === "oidc_expired";
  const interaction = createNotebookInteractionModeProjection({
    selectedMode:
      authState.requestedScope === "editor" || authState.requestedScope === "owner"
        ? "edit"
        : "view",
    permission: {
      canEditMarkdown: accessLevel === "editor" || accessLevel === "owner",
      canEditCells: accessLevel === "owner",
      canEditStructure: accessLevel === "owner",
    },
    hostSupport: {
      canEditMarkdown: true,
      canEditCells: true,
      canEditStructure: true,
      canRequestEdit: authState.mode === "oidc",
    },
  });
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
    canEditMarkdown: interaction.canEditMarkdown,
    canEditCells: interaction.canEditCells,
    canEditStructure: interaction.canEditStructure,
    canRequestEdit: interaction.canRequestEdit,
    canExecute: false,
    canToggleCode: hasCodeCells,
    canViewPackages: true,
    canManagePackages: false,
    canManageSharing: connectionScope === "owner",
    interaction,
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
