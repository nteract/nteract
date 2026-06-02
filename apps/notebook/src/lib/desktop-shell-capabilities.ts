import {
  notebookActorProjectionFromAccess,
  notebookActorProjectionFromRuntime,
} from "@/components/notebook/actor-projection";
import { createNotebookInteractionModeProjection } from "@/components/notebook/interaction-mode";
import type {
  NotebookShellAccessLevel,
  NotebookShellAccessSource,
  NotebookShellCapabilities,
} from "@/components/notebook/capabilities";

export interface DesktopNotebookShellCapabilityInput {
  canAcceptCellMutations: boolean;
  sessionReady: boolean;
  localActor: string | null;
  connectionScope: string | null;
}

export function desktopNotebookShellCapabilities({
  canAcceptCellMutations,
  sessionReady,
  localActor,
  connectionScope,
}: DesktopNotebookShellCapabilityInput): NotebookShellCapabilities {
  const accessLevel = desktopAccessLevelFromConnectionScope(connectionScope);
  const source = desktopAccessSourceFromActor(connectionScope, localActor);
  const isRuntimePeer = connectionScope === "runtime_peer";
  const hasDocumentEditPermission = accessLevel === "editor" || accessLevel === "owner";
  const canWriteDocument =
    canAcceptCellMutations && hasDocumentEditPermission;
  const canWriteRuntimeState =
    sessionReady && (isRuntimePeer || (source === "local" && canWriteDocument));
  const interaction = createNotebookInteractionModeProjection({
    selectedMode: hasDocumentEditPermission ? "edit" : "view",
    permission: {
      canEditMarkdown: hasDocumentEditPermission,
      canEditCells: hasDocumentEditPermission,
      canEditStructure: hasDocumentEditPermission,
    },
    hostSupport: {
      canEditMarkdown: canAcceptCellMutations,
      canEditCells: canAcceptCellMutations,
      canEditStructure: canAcceptCellMutations,
      canRequestEdit: false,
    },
  });
  const access = {
    level: accessLevel,
    source,
    isPublic: false,
    actorLabel: localActor,
    identityLabel: null,
  };
  const runtime = {
    canWriteRuntimeState,
    connected: sessionReady && (source === "local" || isRuntimePeer),
    // A ready daemon session is the local execution runtime. `canExecute` below
    // gates this further by document write authority.
    executionAvailable: sessionReady,
    source,
    actorLabel: canWriteRuntimeState ? localActor : null,
    identityLabel: null,
  };

  return {
    canRead: accessLevel !== "none",
    canEditMarkdown: canWriteDocument,
    canEditCells: canWriteDocument,
    canEditStructure: canWriteDocument,
    canRequestEdit: false,
    canExecute: sessionReady && canWriteDocument,
    canToggleCode: true,
    canViewPackages: true,
    canManagePackages: canWriteDocument,
    canManageSharing: accessLevel === "owner" && source === "cloud",
    interaction,
    access: {
      ...access,
      actor: notebookActorProjectionFromAccess(access),
    },
    auth: {
      canSignIn: false,
      canUseAuthenticatedIdentity: source === "cloud" && Boolean(localActor),
      needsAttention: false,
    },
    runtime: {
      ...runtime,
      actor: notebookActorProjectionFromRuntime(runtime),
    },
  };
}

function desktopAccessLevelFromConnectionScope(
  connectionScope: string | null,
): NotebookShellAccessLevel {
  if (connectionScope === "viewer" || connectionScope === "editor" || connectionScope === "owner") {
    return connectionScope;
  }
  if (connectionScope === "runtime_peer") {
    return "viewer";
  }
  return "owner";
}

function desktopAccessSourceFromActor(
  connectionScope: string | null,
  localActor: string | null,
): NotebookShellAccessSource {
  if (localActor?.startsWith("local:")) return "local";
  return connectionScope ? "cloud" : "local";
}
