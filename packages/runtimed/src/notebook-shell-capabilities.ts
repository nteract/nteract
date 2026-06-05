import type {
  NotebookEditAccessProjection,
  NotebookRoomAccessLevel,
  NotebookRoomEditAccessProjection,
} from "./notebook-edit-access";

export type NotebookShellAccessLevel = NotebookRoomAccessLevel;

export type NotebookShellAccessSource = "cloud" | "local" | "fixture" | "unknown";

export type NotebookActorSourceProvider =
  | "anonymous"
  | "anaconda"
  | "dev"
  | "jupyterhub"
  | "local"
  | "outerbounds"
  | "oidc";

export interface NotebookActorPrincipal {
  id: string;
  label: string;
  imageUrl?: string | null;
  source?: {
    provider: NotebookActorSourceProvider;
    namespace: string;
  };
}

export interface NotebookActorOperator {
  id: string;
  kind: string;
  label: string;
}

export interface NotebookActorProjection {
  actorLabel: string;
  principal: NotebookActorPrincipal;
  operator: NotebookActorOperator;
  scope?: "viewer" | "editor" | "runtime_peer" | "owner";
  status?: "active" | "attention" | "idle" | "offline";
}

export interface NotebookShellAccessCapabilities {
  /**
   * The document-level access granted to the current identity. Hosts derive
   * this from ACLs, local file permissions, or fixture scenarios.
   */
  level: NotebookShellAccessLevel;
  source: NotebookShellAccessSource;
  isPublic: boolean;
  actorLabel: string | null;
  identityLabel: string | null;
  /**
   * Structured host-owned actor projection. Durable actor labels remain the
   * backend/CRDT attribution source; React falls back to parsing them only
   * while hosts are still adopting this source-shaped projection.
   */
  actor?: NotebookActorProjection | null;
}

export interface NotebookShellAuthCapabilities {
  canSignIn: boolean;
  canUseAuthenticatedIdentity: boolean;
  needsAttention: boolean;
}

export interface NotebookShellRuntimeCapabilities {
  /**
   * Runtime peers author execution lifecycle, output, and comm state. This is
   * intentionally separate from document access: runtime authorship does not
   * grant notebook editing, package management, or sharing controls.
   */
  canWriteRuntimeState: boolean;
  connected: boolean;
  /**
   * Whether an execution runtime (kernel provider) is available to run cells.
   * This is the host-neutral signal behind `canExecute`: run/restart/interrupt
   * stay hidden when no runtime can execute, regardless of edit permission. A
   * host with no kernel provider (the hosted prototype today) reports false; a
   * local daemon with a ready session, or a future attached cloud runtime,
   * reports true. Optional so fixtures need not set it.
   */
  executionAvailable?: boolean;
  source: NotebookShellAccessSource;
  actorLabel: string | null;
  identityLabel: string | null;
  actor?: NotebookActorProjection | null;
}

export interface NotebookShellCapabilities {
  canRead: boolean;
  canEditMarkdown: boolean;
  canEditCells: boolean;
  canEditStructure: boolean;
  canRequestEdit: boolean;
  canExecute: boolean;
  canToggleCode: boolean;
  canViewPackages: boolean;
  canManagePackages: boolean;
  canManageSharing: boolean;
  interaction?: NotebookEditAccessProjection | null;
  access: NotebookShellAccessCapabilities;
  auth: NotebookShellAuthCapabilities;
  runtime: NotebookShellRuntimeCapabilities;
}

export interface NotebookShellControlPolicy {
  canToggleCode: boolean;
}

export interface NotebookShellExecutionPolicy {
  available: boolean;
  requiresDocumentEditPermission?: boolean;
  requiresDocumentMutationSupport?: boolean;
}

export interface NotebookShellPackagePolicy {
  canView: boolean;
  canManage: boolean;
  manageRequiresDocumentMutationSupport?: boolean;
}

export interface NotebookShellSharingPolicy {
  canManage: boolean;
  requiresAuthenticatedIdentity?: boolean;
  requiredAccessLevels?: readonly NotebookShellAccessLevel[];
  requiredSources?: readonly NotebookShellAccessSource[];
}

export interface ProjectNotebookShellCapabilitiesOptions {
  interaction: NotebookEditAccessProjection | NotebookRoomEditAccessProjection;
  access: NotebookShellAccessCapabilities;
  auth?: NotebookShellAuthCapabilities;
  runtime?: Partial<NotebookShellRuntimeCapabilities>;
  controls?: Partial<NotebookShellControlPolicy>;
  execution?: NotebookShellExecutionPolicy;
  packages?: Partial<NotebookShellPackagePolicy>;
  sharing?: NotebookShellSharingPolicy;
}

export const readOnlyNotebookShellCapabilities: NotebookShellCapabilities = {
  canRead: true,
  canEditMarkdown: false,
  canEditCells: false,
  canEditStructure: false,
  canRequestEdit: false,
  canExecute: false,
  canToggleCode: false,
  canViewPackages: true,
  canManagePackages: false,
  canManageSharing: false,
  interaction: {
    selectedMode: "view",
    activeMode: "view",
    state: "viewing",
    canRequestEdit: false,
    canEditMarkdown: false,
    canEditCells: false,
    canEditStructure: false,
  },
  access: {
    level: "viewer",
    source: "unknown",
    isPublic: false,
    actorLabel: null,
    identityLabel: null,
  },
  auth: {
    canSignIn: false,
    canUseAuthenticatedIdentity: false,
    needsAttention: false,
  },
  runtime: {
    canWriteRuntimeState: false,
    connected: false,
    executionAvailable: false,
    source: "unknown",
    actorLabel: null,
    identityLabel: null,
  },
};

export function projectNotebookShellCapabilities({
  access,
  auth = readOnlyNotebookShellCapabilities.auth,
  controls,
  execution,
  interaction,
  packages,
  runtime,
  sharing,
}: ProjectNotebookShellCapabilitiesOptions): NotebookShellCapabilities {
  const canMutateFullDocument =
    interaction.canEditMarkdown && interaction.canEditCells && interaction.canEditStructure;
  const hasDocumentEditPermission = notebookShellHasDocumentEditPermission(interaction, access);
  const executionAvailable = execution?.available ?? runtime?.executionAvailable ?? false;
  const runtimeCapabilities: NotebookShellRuntimeCapabilities = {
    canWriteRuntimeState: runtime?.canWriteRuntimeState ?? false,
    connected: runtime?.connected ?? false,
    executionAvailable,
    source: runtime?.source ?? access.source,
    actorLabel: runtime?.actorLabel ?? null,
    identityLabel: runtime?.identityLabel ?? null,
    actor: runtime?.actor,
  };

  return {
    canRead: access.level !== "none",
    canEditMarkdown: interaction.canEditMarkdown,
    canEditCells: interaction.canEditCells,
    canEditStructure: interaction.canEditStructure,
    canRequestEdit: interaction.canRequestEdit,
    canExecute:
      executionAvailable &&
      (!execution?.requiresDocumentEditPermission || hasDocumentEditPermission) &&
      (!execution?.requiresDocumentMutationSupport || canMutateFullDocument),
    canToggleCode: controls?.canToggleCode ?? true,
    canViewPackages: packages?.canView ?? true,
    canManagePackages:
      (packages?.canManage ?? false) &&
      (!packages?.manageRequiresDocumentMutationSupport || canMutateFullDocument),
    canManageSharing: notebookShellCanManageSharing({ access, auth, sharing }),
    interaction,
    access,
    auth,
    runtime: runtimeCapabilities,
  };
}

function notebookShellHasDocumentEditPermission(
  interaction: NotebookEditAccessProjection | NotebookRoomEditAccessProjection,
  access: NotebookShellAccessCapabilities,
): boolean {
  if ("hasDocumentEditPermission" in interaction) {
    return interaction.hasDocumentEditPermission;
  }
  return access.level === "editor" || access.level === "owner";
}

function notebookShellCanManageSharing({
  access,
  auth,
  sharing,
}: {
  access: NotebookShellAccessCapabilities;
  auth: NotebookShellAuthCapabilities;
  sharing: NotebookShellSharingPolicy | undefined;
}): boolean {
  if (!sharing?.canManage) return false;
  if (sharing.requiresAuthenticatedIdentity && !auth.canUseAuthenticatedIdentity) return false;
  if (sharing.requiredAccessLevels && !sharing.requiredAccessLevels.includes(access.level)) {
    return false;
  }
  if (sharing.requiredSources && !sharing.requiredSources.includes(access.source)) {
    return false;
  }
  return true;
}
