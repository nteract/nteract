import {
  notebookActorProjectionFromAccess,
  notebookActorProjectionFromRuntime,
  notebookActorProjectionWithPrincipalImage,
  projectNotebookRuntimeTargetFromWorkstationAttachment,
  projectNotebookShellCapabilities,
  workstationAttachmentCanExecute,
  workstationAttachmentIsConnected,
  type NotebookEditMode,
  type NotebookShellCapabilities,
  type NotebookShellRuntimeTargetProjection,
  type WorkstationAttachmentState,
} from "runtimed";
import type { CloudPrototypeAuthState } from "./collaborator-auth";
import { projectCloudNotebookEditAccess } from "./edit-access";

export interface CloudNotebookShellCapabilityInput {
  authState: CloudPrototypeAuthState;
  connectionScope: string | null;
  connectionActorLabel?: string | null;
  hasCodeCells: boolean;
  selectedMode?: NotebookEditMode;
  /**
   * Whether the hosted live room is connected and the NotebookDoc materialized
   * enough to accept local cell/source mutations. Access can grant editing
   * before the local host is ready to safely write.
   */
  canAcceptCellMutations?: boolean;
  /**
   * Whether the host is reconnecting with a requested document edit scope.
   * While pending, the shared edit-mode control stays visually in view mode
   * even though the requested room scope remains editor/owner.
   */
  editAccessRequestPending?: boolean;
  /**
   * Whether an execution runtime is attached to the room. The hosted prototype
   * uses this as runtime status only; execution controls also require
   * canSubmitExecutionRequests so runtime presence is not confused with
   * execution authority.
   */
  runtimeAvailable?: boolean;
  /**
   * Runtime peers currently visible through room presence. This is a
   * room-observed runtime fact, not workstation registry metadata.
   */
  runtimePeerCount?: number;
  /**
   * Room-host-owned RuntimeStateDoc workstation attachment snapshot. When
   * present this is the durable notebook-visible source for the selected
   * compute target; live presence remains the fallback while older rooms have
   * not published it yet.
   */
  workstationAttachment?: WorkstationAttachmentState | null;
  /**
   * Whether this browser connection may create execution intent in the hosted
   * room. This is a capability, not an interaction mode: owners and editors can
   * submit execution requests when compute is attached, while future
   * execute-scope policy can replace this without changing the shared shell
   * projection.
   */
  canSubmitExecutionRequests?: boolean;
  /**
   * Host-provided room capabilities. Sharing is a room/host concern, not a
   * notebook-local affordance, so owner access alone is not enough to show it.
   */
  hostCapabilities?: {
    canManageSharing?: boolean;
  };
}

export function cloudNotebookShellCapabilities({
  authState,
  connectionScope,
  connectionActorLabel = null,
  hasCodeCells,
  selectedMode = "view",
  canAcceptCellMutations = true,
  editAccessRequestPending = false,
  runtimeAvailable = false,
  runtimePeerCount = runtimeAvailable ? 1 : 0,
  workstationAttachment = null,
  canSubmitExecutionRequests = connectionScope === "owner" || connectionScope === "editor",
  hostCapabilities,
}: CloudNotebookShellCapabilityInput): NotebookShellCapabilities {
  const interaction = projectCloudNotebookEditAccess({
    authState,
    connectionScope,
    selectedMode,
    canAcceptCellMutations,
    editAccessRequestPending,
  });
  const accessLevel = interaction.accessLevel;
  const isRuntimePeer = connectionScope === "runtime_peer";
  const authenticated = authState.mode === "dev" || authState.mode === "oidc";
  const authNeedsAttention = authState.mode === "invalid" || authState.mode === "oidc_expired";
  const identityLabel = cloudIdentityDisplayLabel(authState);
  const identityImageUrl = cloudIdentityImageUrl(authState);
  const attachmentConnected = workstationAttachmentIsConnected(workstationAttachment);
  const attachmentExecutionAvailable = workstationAttachmentCanExecute(workstationAttachment);
  const effectiveRuntimeAvailable = runtimeAvailable || attachmentExecutionAvailable;
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
    identityLabel,
  };
  const runtime = {
    canWriteRuntimeState: isRuntimePeer,
    connected: isRuntimePeer || runtimeAvailable || attachmentConnected,
    executionAvailable: effectiveRuntimeAvailable,
    source: "cloud" as const,
    actorLabel: isRuntimePeer ? connectionActorLabel : null,
    identityLabel: isRuntimePeer ? identityLabel : null,
    target: cloudRuntimeTarget({
      isRuntimePeer,
      runtimeAvailable: effectiveRuntimeAvailable,
      runtimePeerCount,
      workstationAttachment,
    }),
  };
  const accessActor = notebookActorProjectionWithPrincipalImage(
    notebookActorProjectionFromAccess(access, auth),
    identityImageUrl,
  );
  const runtimeActor = notebookActorProjectionWithPrincipalImage(
    notebookActorProjectionFromRuntime(runtime, auth),
    identityImageUrl,
  );

  return projectNotebookShellCapabilities({
    interaction,
    access: {
      ...access,
      actor: accessActor,
    },
    auth,
    runtime: {
      ...runtime,
      actor: runtimeActor,
    },
    controls: {
      canToggleCode: hasCodeCells,
    },
    execution: {
      available: effectiveRuntimeAvailable,
      canSubmit: canSubmitExecutionRequests,
      requiresDocumentEditPermission: true,
    },
    packages: {
      canView: true,
      canManage: false,
    },
    sharing: {
      canManage: Boolean(hostCapabilities?.canManageSharing),
      requiresAuthenticatedIdentity: true,
    },
  });
}

function cloudRuntimeTarget({
  isRuntimePeer,
  runtimeAvailable,
  runtimePeerCount,
  workstationAttachment,
}: {
  isRuntimePeer: boolean;
  runtimeAvailable: boolean;
  runtimePeerCount: number;
  workstationAttachment: WorkstationAttachmentState | null;
}): NotebookShellRuntimeTargetProjection {
  const visibleRuntimePeerCount = Math.max(0, Math.floor(runtimePeerCount));
  if (isRuntimePeer) {
    return {
      id: "runtime-peer",
      kind: "runtime_peer",
      status: "attached",
      label: "Runtime peer",
      statusLabel: "Attached",
      detail: "This connection can author runtime state for the room.",
      providerLabel: "Cloud room",
      defaultEnvironmentLabel: "Runtime peer",
      environmentLabel: "Runtime peer",
      runtimePeerCount: visibleRuntimePeerCount || 1,
    };
  }
  const attachmentTarget = projectNotebookRuntimeTargetFromWorkstationAttachment(
    workstationAttachment,
    { runtimePeerCount: visibleRuntimePeerCount },
  );
  if (attachmentTarget) {
    return attachmentTarget;
  }
  if (runtimeAvailable) {
    return {
      id: "attached-workstation",
      kind: "cloud_workstation",
      status: "ready",
      label: "Attached workstation",
      statusLabel: "Ready",
      detail: "A runtime peer is attached to this room.",
      providerLabel: "Cloud room",
      defaultEnvironmentLabel: "Current Python",
      environmentLabel: "Current Python",
      runtimePeerCount: visibleRuntimePeerCount || 1,
    };
  }
  return {
    id: "workstation:none",
    kind: "cloud_workstation",
    status: "offline",
    label: "No workstation attached",
    statusLabel: "Offline",
    detail: "Attach a user-owned workstation to run cells in this room.",
    providerLabel: "Cloud room",
    defaultEnvironmentLabel: "Not attached",
    environmentLabel: "Not attached",
  };
}

function cloudIdentityDisplayLabel(authState: CloudPrototypeAuthState): string | null {
  const claimName = authState.oidcClaims?.name?.trim();
  if (claimName) {
    return claimName;
  }
  const claimEmail = compactEmailLabel(authState.oidcClaims?.email);
  if (claimEmail) {
    return claimEmail;
  }
  return compactEmailLabel(authState.user) ?? authState.user;
}

function cloudIdentityImageUrl(authState: CloudPrototypeAuthState): string | null {
  return authState.oidcClaims?.picture?.trim() || null;
}

function compactEmailLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const match = /^([^@\s]+)@([^@\s]+\.[^@\s]+)$/.exec(trimmed);
  return match?.[1] ?? null;
}
