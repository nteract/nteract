import {
  notebookActorProjectionFromAccess,
  notebookActorProjectionFromRuntime,
} from "@/components/notebook/actor-projection";
import type {
  NotebookShellAccessLevel,
  NotebookShellAccessSource,
  NotebookShellCapabilities,
} from "@/components/notebook/capabilities";
import {
  notebookRoomAccessLevelCanEditDocument,
  notebookRoomAccessLevelFromConnectionScope,
  projectNotebookRoomEditAccess,
} from "runtimed";

export interface DesktopNotebookShellCapabilityInput {
  canAcceptCellMutations: boolean;
  sessionReady: boolean;
  localActor: string | null;
  connectionScope: string | null;
  hostCapabilities?: {
    canManageSharing?: boolean;
  };
}

export function desktopNotebookShellCapabilities({
  canAcceptCellMutations,
  sessionReady,
  localActor,
  connectionScope,
  hostCapabilities,
}: DesktopNotebookShellCapabilityInput): NotebookShellCapabilities {
  const accessLevel = desktopAccessLevelFromConnectionScope(connectionScope);
  const source = desktopAccessSourceFromActor(connectionScope, localActor);
  const isRuntimePeer = connectionScope === "runtime_peer";
  const hasDocumentEditPermission = notebookRoomAccessLevelCanEditDocument(accessLevel);
  const interaction = projectNotebookRoomEditAccess({
    accessLevel,
    requestedScope: accessLevel === "none" ? null : accessLevel,
    selectedMode: hasDocumentEditPermission ? "edit" : "view",
    canAcceptDocumentMutations: canAcceptCellMutations,
    canRequestEdit: false,
  });
  const canWriteDocument =
    interaction.canEditMarkdown && interaction.canEditCells && interaction.canEditStructure;
  const canWriteRuntimeState =
    sessionReady && (isRuntimePeer || (source === "local" && canWriteDocument));
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
    canManageSharing:
      Boolean(hostCapabilities?.canManageSharing) && accessLevel === "owner" && source === "cloud",
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
  if (connectionScope === null) {
    return "owner";
  }
  return notebookRoomAccessLevelFromConnectionScope(connectionScope, "none");
}

function desktopAccessSourceFromActor(
  connectionScope: string | null,
  localActor: string | null,
): NotebookShellAccessSource {
  if (localActor?.startsWith("local:")) return "local";
  return connectionScope ? "cloud" : "local";
}
