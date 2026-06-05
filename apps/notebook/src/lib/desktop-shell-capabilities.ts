import {
  notebookActorProjectionFromAccess,
  notebookActorProjectionFromRuntime,
  notebookRoomAccessLevelCanEditDocument,
  notebookRoomAccessLevelFromConnectionScope,
  projectNotebookShellCapabilities,
  projectNotebookRoomEditAccess,
  type NotebookShellAccessLevel,
  type NotebookShellAccessSource,
  type NotebookShellCapabilities,
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
  const auth = {
    canSignIn: false,
    canUseAuthenticatedIdentity: source === "cloud" && Boolean(localActor),
    needsAttention: false,
  };
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
  return projectNotebookShellCapabilities({
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
    controls: {
      canToggleCode: true,
    },
    execution: {
      available: sessionReady,
      requiresDocumentEditPermission: true,
      requiresDocumentMutationSupport: true,
    },
    packages: {
      canView: true,
      canManage: true,
      manageRequiresDocumentMutationSupport: true,
    },
    sharing: {
      canManage: Boolean(hostCapabilities?.canManageSharing),
      requiredAccessLevels: ["owner"],
      requiredSources: ["cloud"],
    },
  });
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
