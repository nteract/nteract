import type {
  NotebookShellAccessLevel,
  NotebookShellAccessSource,
  NotebookShellCapabilities,
} from "@/components/notebook-shell";

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
  const source = desktopAccessSourceFromConnectionScope(connectionScope);
  const isRuntimePeer = connectionScope === "runtime_peer";
  const canWriteDocument =
    canAcceptCellMutations && (accessLevel === "editor" || accessLevel === "owner");
  const canWriteRuntimeState =
    sessionReady && (isRuntimePeer || (source === "local" && canWriteDocument));

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
    access: {
      level: accessLevel,
      source,
      isPublic: false,
      actorLabel: localActor,
      identityLabel: localActor,
    },
    auth: {
      canSignIn: false,
      canUseAuthenticatedIdentity: Boolean(localActor),
      needsAttention: false,
    },
    runtime: {
      canWriteRuntimeState,
      connected: sessionReady && (source === "local" || isRuntimePeer),
      source,
      actorLabel: canWriteRuntimeState ? localActor : null,
      identityLabel: canWriteRuntimeState ? localActor : null,
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

function desktopAccessSourceFromConnectionScope(
  connectionScope: string | null,
): NotebookShellAccessSource {
  return connectionScope ? "cloud" : "local";
}
