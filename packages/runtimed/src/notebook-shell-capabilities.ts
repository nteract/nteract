import type {
  NotebookEditAccessProjection,
  NotebookRoomAccessLevel,
  NotebookRoomEditAccessProjection,
} from "./notebook-edit-access";
import type { NotebookActorProjection } from "./notebook-actor-projection";
import { getBoundedCacheValue, setBoundedCacheValue, stableCacheKey } from "./projection-cache";

export type {
  NotebookActorOperator,
  NotebookActorPrincipal,
  NotebookActorProjection,
  NotebookActorSourceProvider,
} from "./notebook-actor-projection";

export type NotebookShellAccessLevel = NotebookRoomAccessLevel;

export type NotebookShellAccessSource = "cloud" | "local" | "fixture" | "unknown";

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

const SHELL_ACCESS_CACHE = new Map<string, NotebookShellAccessCapabilities>();
const SHELL_AUTH_CACHE = new Map<string, NotebookShellAuthCapabilities>();
const SHELL_RUNTIME_CACHE = new Map<string, NotebookShellRuntimeCapabilities>();
const SHELL_CAPABILITIES_CACHE = new Map<string, NotebookShellCapabilities>();
const SHELL_PART_CACHE_LIMIT = 256;
const SHELL_CAPABILITIES_CACHE_LIMIT = 512;

const READ_ONLY_INTERACTION: NotebookEditAccessProjection = Object.freeze({
  selectedMode: "view",
  activeMode: "view",
  state: "viewing",
  canRequestEdit: false,
  canEditMarkdown: false,
  canEditCells: false,
  canEditStructure: false,
});

const READ_ONLY_ACCESS: NotebookShellAccessCapabilities = Object.freeze({
  level: "viewer",
  source: "unknown",
  isPublic: false,
  actorLabel: null,
  identityLabel: null,
});

const READ_ONLY_AUTH: NotebookShellAuthCapabilities = Object.freeze({
  canSignIn: false,
  canUseAuthenticatedIdentity: false,
  needsAttention: false,
});

const READ_ONLY_RUNTIME: NotebookShellRuntimeCapabilities = Object.freeze({
  canWriteRuntimeState: false,
  connected: false,
  executionAvailable: false,
  source: "unknown",
  actorLabel: null,
  identityLabel: null,
});

export const readOnlyNotebookShellCapabilities: NotebookShellCapabilities = Object.freeze({
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
  interaction: READ_ONLY_INTERACTION,
  access: READ_ONLY_ACCESS,
  auth: READ_ONLY_AUTH,
  runtime: READ_ONLY_RUNTIME,
});

export function clearNotebookShellCapabilitiesCachesForTests(): void {
  SHELL_ACCESS_CACHE.clear();
  SHELL_AUTH_CACHE.clear();
  SHELL_RUNTIME_CACHE.clear();
  SHELL_CAPABILITIES_CACHE.clear();
}

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
  const accessCapabilities = stableNotebookShellAccessCapabilities(access);
  const authCapabilities = stableNotebookShellAuthCapabilities(auth);
  const canMutateFullDocument =
    interaction.canEditMarkdown && interaction.canEditCells && interaction.canEditStructure;
  const hasDocumentEditPermission = notebookShellHasDocumentEditPermission(
    interaction,
    accessCapabilities,
  );
  const executionAvailable = execution?.available ?? runtime?.executionAvailable ?? false;
  const runtimeCapabilities = stableNotebookShellRuntimeCapabilities({
    canWriteRuntimeState: runtime?.canWriteRuntimeState ?? false,
    connected: runtime?.connected ?? false,
    executionAvailable,
    source: runtime?.source ?? accessCapabilities.source,
    actorLabel: runtime?.actorLabel ?? null,
    identityLabel: runtime?.identityLabel ?? null,
    actor: runtime?.actor,
  });
  const canRead = accessCapabilities.level !== "none";
  const canExecute =
    executionAvailable &&
    (!execution?.requiresDocumentEditPermission || hasDocumentEditPermission) &&
    (!execution?.requiresDocumentMutationSupport || canMutateFullDocument);
  const canToggleCode = controls?.canToggleCode ?? true;
  const canViewPackages = packages?.canView ?? true;
  const canManagePackages =
    (packages?.canManage ?? false) &&
    (!packages?.manageRequiresDocumentMutationSupport || canMutateFullDocument);
  const canManageSharing = notebookShellCanManageSharing({
    access: accessCapabilities,
    auth: authCapabilities,
    sharing,
  });
  const cacheKey = stableCacheKey([
    canRead,
    interaction.canEditMarkdown,
    interaction.canEditCells,
    interaction.canEditStructure,
    interaction.canRequestEdit,
    canExecute,
    canToggleCode,
    canViewPackages,
    canManagePackages,
    canManageSharing,
    notebookShellInteractionCacheKey(interaction),
    notebookShellAccessCacheKey(accessCapabilities),
    notebookShellAuthCacheKey(authCapabilities),
    notebookShellRuntimeCacheKey(runtimeCapabilities),
  ]);
  const cached = getBoundedCacheValue(SHELL_CAPABILITIES_CACHE, cacheKey);
  if (cached) return cached;

  const capabilities = Object.freeze({
    canRead,
    canEditMarkdown: interaction.canEditMarkdown,
    canEditCells: interaction.canEditCells,
    canEditStructure: interaction.canEditStructure,
    canRequestEdit: interaction.canRequestEdit,
    canExecute,
    canToggleCode,
    canViewPackages,
    canManagePackages,
    canManageSharing,
    interaction,
    access: accessCapabilities,
    auth: authCapabilities,
    runtime: runtimeCapabilities,
  });
  setBoundedCacheValue(
    SHELL_CAPABILITIES_CACHE,
    cacheKey,
    capabilities,
    SHELL_CAPABILITIES_CACHE_LIMIT,
  );
  return capabilities;
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

function stableNotebookShellAccessCapabilities(
  access: NotebookShellAccessCapabilities,
): NotebookShellAccessCapabilities {
  const cacheKey = notebookShellAccessCacheKey(access);
  const cached = getBoundedCacheValue(SHELL_ACCESS_CACHE, cacheKey);
  if (cached) return cached;

  const stableAccess = Object.freeze({
    level: access.level,
    source: access.source,
    isPublic: access.isPublic,
    actorLabel: access.actorLabel,
    identityLabel: access.identityLabel,
    ...(access.actor === undefined ? {} : { actor: access.actor }),
  });
  setBoundedCacheValue(SHELL_ACCESS_CACHE, cacheKey, stableAccess, SHELL_PART_CACHE_LIMIT);
  return stableAccess;
}

function stableNotebookShellAuthCapabilities(
  auth: NotebookShellAuthCapabilities,
): NotebookShellAuthCapabilities {
  const cacheKey = notebookShellAuthCacheKey(auth);
  const cached = getBoundedCacheValue(SHELL_AUTH_CACHE, cacheKey);
  if (cached) return cached;

  const stableAuth = Object.freeze({
    canSignIn: auth.canSignIn,
    canUseAuthenticatedIdentity: auth.canUseAuthenticatedIdentity,
    needsAttention: auth.needsAttention,
  });
  setBoundedCacheValue(SHELL_AUTH_CACHE, cacheKey, stableAuth, SHELL_PART_CACHE_LIMIT);
  return stableAuth;
}

function stableNotebookShellRuntimeCapabilities(
  runtime: NotebookShellRuntimeCapabilities,
): NotebookShellRuntimeCapabilities {
  const cacheKey = notebookShellRuntimeCacheKey(runtime);
  const cached = getBoundedCacheValue(SHELL_RUNTIME_CACHE, cacheKey);
  if (cached) return cached;

  const stableRuntime = Object.freeze({
    canWriteRuntimeState: runtime.canWriteRuntimeState,
    connected: runtime.connected,
    executionAvailable: runtime.executionAvailable,
    source: runtime.source,
    actorLabel: runtime.actorLabel,
    identityLabel: runtime.identityLabel,
    ...(runtime.actor === undefined ? {} : { actor: runtime.actor }),
  });
  setBoundedCacheValue(SHELL_RUNTIME_CACHE, cacheKey, stableRuntime, SHELL_PART_CACHE_LIMIT);
  return stableRuntime;
}

function notebookShellInteractionCacheKey(
  interaction: NotebookEditAccessProjection | NotebookRoomEditAccessProjection,
): string {
  const roomFields =
    "accessLevel" in interaction
      ? [
          interaction.inputSelectedMode,
          interaction.accessLevel,
          interaction.requestedScope,
          interaction.hasDocumentEditPermission,
          interaction.selectedDocumentEditMode,
          interaction.requestedDocumentEditAccess,
          interaction.editAccessPending,
        ]
      : [];
  return stableCacheKey([
    interaction.selectedMode,
    interaction.activeMode,
    interaction.state,
    interaction.canRequestEdit,
    interaction.canEditMarkdown,
    interaction.canEditCells,
    interaction.canEditStructure,
    ...roomFields,
  ]);
}

function notebookShellAccessCacheKey(access: NotebookShellAccessCapabilities): string {
  return stableCacheKey([
    access.level,
    access.source,
    access.isPublic,
    access.actorLabel,
    access.identityLabel,
    notebookActorProjectionCacheKey(access.actor),
  ]);
}

function notebookShellAuthCacheKey(auth: NotebookShellAuthCapabilities): string {
  return stableCacheKey([auth.canSignIn, auth.canUseAuthenticatedIdentity, auth.needsAttention]);
}

function notebookShellRuntimeCacheKey(runtime: NotebookShellRuntimeCapabilities): string {
  return stableCacheKey([
    runtime.canWriteRuntimeState,
    runtime.connected,
    runtime.executionAvailable,
    runtime.source,
    runtime.actorLabel,
    runtime.identityLabel,
    notebookActorProjectionCacheKey(runtime.actor),
  ]);
}

function notebookActorProjectionCacheKey(
  actor: NotebookActorProjection | null | undefined,
): string {
  if (actor === undefined) return "undefined";
  if (actor === null) return "null";
  return stableCacheKey([
    actor.actorLabel,
    actor.principal.id,
    actor.principal.label,
    actor.principal.imageUrl ?? null,
    actor.principal.source?.provider ?? null,
    actor.principal.source?.namespace ?? null,
    actor.operator.id,
    actor.operator.kind,
    actor.operator.label,
    actor.scope ?? null,
    actor.status ?? null,
  ]);
}
