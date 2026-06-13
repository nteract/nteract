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
import { cloudFriendlyPeerLabel, cloudVisiblePeerLabel } from "./presence";

export interface CloudNotebookShellCapabilityInput {
  authState: CloudPrototypeAuthState;
  /**
   * Document access used for UI projection. During reconnect this can come
   * from the authenticated notebook catalog so owners do not see stale
   * request-access chrome. Actual mutation and execution authority still comes
   * from the live room `connectionScope` below.
   */
  accessConnectionScope?: string | null;
  connectionScope: string | null;
  connectionActorLabel?: string | null;
  connectionPeerLabel?: string | null;
  hasAppSession?: boolean;
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
   * uses this as runtime status only; execution controls still require hosted
   * execution request authority so runtime presence is not confused with the
   * right to create execution intent.
   */
  runtimeAvailable?: boolean;
  /**
   * Runtime peers currently visible through room presence. This is a
   * room-observed runtime fact, not workstation registry metadata.
   */
  runtimePeerCount?: number;
  /**
   * RuntimeStateDoc-derived kernel lifecycle label. This keeps the workstation
   * target honest during the peer-connected/kernel-launching gap.
   */
  kernelStatusLabel?: string | null;
  /**
   * Room-host-owned RuntimeStateDoc workstation attachment snapshot. When
   * present this is the durable notebook-visible source for the selected
   * compute target; live presence remains the fallback while older rooms have
   * not published it yet.
   */
  workstationAttachment?: WorkstationAttachmentState | null;
  /**
   * Host-provided room capabilities. Sharing is a room/host concern, not a
   * notebook-local affordance, so owner access alone is not enough to show it.
   */
  hostCapabilities?: {
    canManageSharing?: boolean;
  };
}

export function cloudNotebookShellCapabilities({
  accessConnectionScope,
  authState,
  connectionScope,
  connectionActorLabel = null,
  connectionPeerLabel = null,
  hasAppSession = false,
  hasCodeCells,
  selectedMode = "view",
  canAcceptCellMutations = true,
  editAccessRequestPending = false,
  runtimeAvailable = false,
  runtimePeerCount = runtimeAvailable ? 1 : 0,
  kernelStatusLabel = null,
  workstationAttachment = null,
  hostCapabilities,
}: CloudNotebookShellCapabilityInput): NotebookShellCapabilities {
  const documentAccessScope = accessConnectionScope ?? connectionScope;
  const interaction = projectCloudNotebookEditAccess({
    authState,
    connectionScope: documentAccessScope,
    hasAppSession,
    selectedMode,
    canAcceptCellMutations,
    editAccessRequestPending,
  });
  const accessLevel = interaction.accessLevel;
  const isRuntimePeer = connectionScope === "runtime_peer";
  const authenticated = hasAppSession || authState.mode === "dev" || authState.mode === "oidc";
  const authNeedsAttention =
    !hasAppSession && (authState.mode === "invalid" || authState.mode === "oidc_expired");
  const identityLabel = connectionPeerLabel?.trim()
    ? cloudVisiblePeerLabel(connectionPeerLabel, connectionActorLabel)
    : cloudIdentityDisplayLabel(authState, connectionActorLabel);
  const identityImageUrl = cloudIdentityImageUrl(authState);
  const attachmentConnected = workstationAttachmentIsConnected(workstationAttachment);
  const attachmentExecutionAvailable = workstationAttachmentCanExecute(workstationAttachment);
  const hasAttachmentSnapshot = workstationAttachment !== null;
  const effectiveRuntimeConnected = hasAttachmentSnapshot ? attachmentConnected : runtimeAvailable;
  const effectiveRuntimeAvailable = hasAttachmentSnapshot
    ? attachmentExecutionAvailable
    : runtimeAvailable;
  const auth = {
    canSignIn: !hasAppSession && authState.mode !== "oidc",
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
    connected: isRuntimePeer || effectiveRuntimeConnected,
    executionAvailable: effectiveRuntimeAvailable,
    source: "cloud" as const,
    actorLabel: isRuntimePeer ? connectionActorLabel : null,
    identityLabel: isRuntimePeer ? identityLabel : null,
    target: cloudRuntimeTarget({
      isRuntimePeer,
      runtimeAvailable: effectiveRuntimeAvailable,
      runtimePeerCount,
      kernelStatusLabel,
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
      canSubmit: connectionScope === "owner",
      requiresDocumentEditPermission: true,
      requiresDocumentMutationSupport: true,
    },
    packages: {
      canView: true,
      canManage: false,
    },
    sharing: {
      canManage: Boolean(hostCapabilities?.canManageSharing),
      requiresAuthenticatedIdentity: true,
      requiredAccessLevels: ["owner"],
    },
  });
}

function cloudRuntimeTarget({
  isRuntimePeer,
  runtimeAvailable,
  runtimePeerCount,
  kernelStatusLabel,
  workstationAttachment,
}: {
  isRuntimePeer: boolean;
  runtimeAvailable: boolean;
  runtimePeerCount: number;
  kernelStatusLabel: string | null;
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
      detail: "This connection can report runtime state for the room.",
      providerLabel: "Cloud room",
      defaultEnvironmentLabel: "Runtime peer",
      environmentLabel: "Runtime peer",
      runtimePeerCount: visibleRuntimePeerCount || 1,
    };
  }
  const attachmentTarget = projectNotebookRuntimeTargetFromWorkstationAttachment(
    workstationAttachment,
    { runtimePeerCount: visibleRuntimePeerCount, kernelStatusLabel },
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
      kernelStatusLabel,
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

function cloudIdentityDisplayLabel(
  authState: CloudPrototypeAuthState,
  actorLabel?: string | null,
): string | null {
  const claimName = authState.oidcClaims?.name?.trim();
  if (claimName) {
    return claimName;
  }
  const claimEmail = authState.oidcClaims?.email?.trim();
  if (claimEmail) {
    return cloudFriendlyPeerLabel({ actorLabel, email: claimEmail });
  }
  const user = authState.user?.trim();
  if (!user) {
    return null;
  }
  return looksLikeEmailAddress(user) ? cloudFriendlyPeerLabel({ actorLabel, email: user }) : user;
}

function cloudIdentityImageUrl(authState: CloudPrototypeAuthState): string | null {
  return authState.oidcClaims?.picture?.trim() || null;
}

function looksLikeEmailAddress(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}
