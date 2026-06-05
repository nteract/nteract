import {
  notebookActorProjectionFromAccess,
  notebookActorProjectionFromRuntime,
} from "@/components/notebook/actor-projection";
import type { NotebookShellCapabilities } from "@/components/notebook/capabilities";
import type { NotebookEditMode } from "runtimed";
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
   * has no kernel provider yet, so this defaults false and run controls stay
   * hidden. Flip it on once a runtime peer can execute the room's cells.
   */
  runtimeAvailable?: boolean;
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
  // Executing a cell needs both an attached runtime and document write
  // authority. The room has no kernel provider yet, so runtimeAvailable
  // defaults false and run controls stay hidden.
  const canExecute = runtimeAvailable && interaction.hasDocumentEditPermission;
  const runtime = {
    canWriteRuntimeState: isRuntimePeer,
    connected: isRuntimePeer,
    executionAvailable: runtimeAvailable,
    source: "cloud" as const,
    actorLabel: isRuntimePeer ? connectionActorLabel : null,
    identityLabel: isRuntimePeer ? identityLabel : null,
  };
  const accessActor = withCloudIdentityImage(notebookActorProjectionFromAccess(access, auth), {
    imageUrl: identityImageUrl,
  });
  const runtimeActor = withCloudIdentityImage(notebookActorProjectionFromRuntime(runtime, auth), {
    imageUrl: identityImageUrl,
  });

  return {
    canRead: true,
    canEditMarkdown: interaction.canEditMarkdown,
    canEditCells: interaction.canEditCells,
    canEditStructure: interaction.canEditStructure,
    canRequestEdit: interaction.canRequestEdit,
    canExecute,
    canToggleCode: hasCodeCells,
    canViewPackages: true,
    canManagePackages: false,
    canManageSharing:
      Boolean(hostCapabilities?.canManageSharing) && auth.canUseAuthenticatedIdentity,
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

function withCloudIdentityImage<
  T extends ReturnType<typeof notebookActorProjectionFromAccess> | null,
>(actor: T, { imageUrl }: { imageUrl: string | null }): T {
  if (!actor || !imageUrl) {
    return actor;
  }
  return {
    ...actor,
    principal: {
      ...actor.principal,
      imageUrl,
    },
  };
}
