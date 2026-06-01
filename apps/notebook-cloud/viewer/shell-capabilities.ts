import {
  notebookActorProjectionFromAccess,
  notebookActorProjectionFromRuntime,
} from "@/components/notebook/actor-projection";
import type { NotebookShellCapabilities } from "@/components/notebook/capabilities";
import {
  createNotebookInteractionModeProjection,
  type NotebookInteractionMode,
} from "@/components/notebook/interaction-mode";
import type { CloudPrototypeAuthState } from "./collaborator-auth";

export interface CloudNotebookShellCapabilityInput {
  authState: CloudPrototypeAuthState;
  connectionScope: string | null;
  connectionActorLabel?: string | null;
  hasCodeCells: boolean;
  selectedMode?: NotebookInteractionMode;
}

export function cloudNotebookShellCapabilities({
  authState,
  connectionScope,
  connectionActorLabel = null,
  hasCodeCells,
  selectedMode = "view",
}: CloudNotebookShellCapabilityInput): NotebookShellCapabilities {
  const accessLevel = cloudConnectionAccessLevel(connectionScope);
  const isRuntimePeer = connectionScope === "runtime_peer";
  const authenticated = authState.mode === "dev" || authState.mode === "oidc";
  const authNeedsAttention = authState.mode === "invalid" || authState.mode === "oidc_expired";
  const identityLabel = cloudIdentityDisplayLabel(authState);
  const identityImageUrl = cloudIdentityImageUrl(authState);
  const interaction = createNotebookInteractionModeProjection({
    selectedMode,
    permission: {
      // Editors get full collaborative cell editing (markdown/code/raw source +
      // add/delete/move). This mirrors the room host's editor write surface; the
      // server still rejects notebook-level metadata edits from non-owners
      // (validate_editor_notebook_changes in runtimed-wasm).
      canEditMarkdown: accessLevel === "editor" || accessLevel === "owner",
      canEditCells: accessLevel === "editor" || accessLevel === "owner",
      canEditStructure: accessLevel === "editor" || accessLevel === "owner",
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
    identityLabel,
  };
  const runtime = {
    canWriteRuntimeState: isRuntimePeer,
    connected: isRuntimePeer,
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
    canExecute: false,
    canToggleCode: hasCodeCells,
    canViewPackages: true,
    canManagePackages: false,
    canManageSharing: connectionScope === "owner",
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

function cloudConnectionAccessLevel(
  connectionScope: string | null,
): NotebookShellCapabilities["access"]["level"] {
  if (connectionScope === "owner" || connectionScope === "editor" || connectionScope === "viewer") {
    return connectionScope;
  }
  return "viewer";
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
