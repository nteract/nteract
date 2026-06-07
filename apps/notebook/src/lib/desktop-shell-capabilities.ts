import {
  notebookActorProjectionFromAccess,
  notebookActorProjectionFromRuntime,
  notebookRoomAccessLevelCanEditDocument,
  notebookRoomAccessLevelFromConnectionScope,
  projectNotebookShellCapabilities,
  projectNotebookRoomEditAccess,
  splitNotebookActorPrincipalOperator,
  type NotebookShellAccessLevel,
  type NotebookShellAccessSource,
  type NotebookShellCapabilities,
  type NotebookShellRuntimeTargetProjection,
} from "runtimed";
import { getStatusKeyLabel, type RuntimeStatusKey } from "./kernel-status";

export interface DesktopNotebookShellCapabilityInput {
  canAcceptCellMutations: boolean;
  sessionReady: boolean;
  localActor: string | null;
  connectionScope: string | null;
  kernelStatusKey?: RuntimeStatusKey | null;
  kernelErrorReason?: string | null;
  hostCapabilities?: {
    canManageSharing?: boolean;
  };
}

export function desktopNotebookShellCapabilities({
  canAcceptCellMutations,
  sessionReady,
  localActor,
  connectionScope,
  kernelStatusKey = null,
  kernelErrorReason = null,
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
    actorLabel: desktopRuntimeActorLabel({
      canWriteRuntimeState,
      isRuntimePeer,
      localActor,
      source,
    }),
    identityLabel: null,
    target: desktopRuntimeTarget({
      isRuntimePeer,
      kernelStatusLabel: kernelStatusKey
        ? getStatusKeyLabel(kernelStatusKey, kernelErrorReason)
        : null,
      sessionReady,
      source,
    }),
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

function desktopRuntimeTarget({
  isRuntimePeer,
  kernelStatusLabel,
  sessionReady,
  source,
}: {
  isRuntimePeer: boolean;
  kernelStatusLabel: string | null;
  sessionReady: boolean;
  source: NotebookShellAccessSource;
}): NotebookShellRuntimeTargetProjection | null {
  if (isRuntimePeer) {
    return {
      id: "runtime-peer",
      kind: "runtime_peer",
      status: sessionReady ? "attached" : "offline",
      label: "Runtime peer",
      statusLabel: sessionReady ? "Attached" : "Offline",
      detail: sessionReady
        ? "This connection can author runtime state for the room."
        : "This runtime peer is not connected.",
      providerLabel: "Cloud room",
      defaultEnvironmentLabel: "Runtime peer",
      environmentLabel: "Runtime peer",
      kernelStatusLabel,
    };
  }
  if (source !== "local") {
    return null;
  }
  return {
    id: "local-daemon",
    kind: "local_daemon",
    status: sessionReady ? "ready" : "offline",
    label: "This machine",
    statusLabel: sessionReady ? "Ready" : "Offline",
    detail: sessionReady
      ? "The local daemon is available for this notebook."
      : "The local daemon is not exposing an executable runtime.",
    providerLabel: "Local daemon",
    defaultEnvironmentLabel: "Notebook runtime",
    environmentLabel: "Notebook runtime",
    kernelStatusLabel,
    cpuCount: localCpuCount(),
  };
}

function localCpuCount(): number | null {
  const count = globalThis.navigator?.hardwareConcurrency;
  return typeof count === "number" && Number.isFinite(count) && count > 0 ? count : null;
}

function desktopRuntimeActorLabel({
  canWriteRuntimeState,
  isRuntimePeer,
  localActor,
  source,
}: {
  canWriteRuntimeState: boolean;
  isRuntimePeer: boolean;
  localActor: string | null;
  source: NotebookShellAccessSource;
}): string | null {
  if (!canWriteRuntimeState || !localActor) {
    return null;
  }
  if (isRuntimePeer || source !== "local") {
    return localActor;
  }

  const [principal] = splitNotebookActorPrincipalOperator(localActor);
  return `${principal}/runtime:local`;
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
