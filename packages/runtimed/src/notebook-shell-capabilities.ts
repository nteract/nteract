import type {
  NotebookEditAccessProjection,
  NotebookRoomAccessLevel,
  NotebookRoomEditAccessProjection,
} from "./notebook-edit-access";
import type { NotebookActorProjection } from "./notebook-actor-projection";
import { getBoundedCacheValue, setBoundedCacheValue, stableCacheKey } from "./projection-cache";
import type { WorkstationAttachmentState } from "./runtime-state";

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

export type NotebookShellRuntimeTargetKind =
  | "local_daemon"
  | "cloud_workstation"
  | "runtime_peer"
  | "fixture"
  | "unknown";

export type NotebookShellRuntimeTargetStatus =
  | "ready"
  | "attached"
  | "available"
  | "connecting"
  | "offline"
  | "attention";

export interface NotebookShellRuntimeTargetProjection {
  /**
   * Stable host-owned workstation identifier. This is intentionally not a
   * principal: principals describe who can act, while workstation IDs describe
   * where compute is expected to run.
   */
  id?: string | null;
  /**
   * Host-owned identity for one active compute session on this target. Hidden
   * from the default UI, but included in projection cache identity so replacing
   * a stale session cannot reuse the old target object.
   */
  runtimeSessionId?: string | null;
  kind: NotebookShellRuntimeTargetKind;
  status: NotebookShellRuntimeTargetStatus;
  label: string;
  statusLabel?: string | null;
  detail?: string | null;
  providerLabel?: string | null;
  /**
   * User-facing default environment or interpreter label for this target. This
   * is the workstation's default compute context, distinct from notebook
   * package declarations. `environmentLabel` remains accepted for older hosts.
   */
  defaultEnvironmentLabel?: string | null;
  environmentLabel?: string | null;
  /**
   * User-facing kernel lifecycle label for the active target, when the host
   * has authoritative RuntimeStateDoc lifecycle data.
   */
  kernelStatusLabel?: string | null;
  cpuCount?: number | null;
  memoryBytes?: number | null;
  resourceLabel?: string | null;
  /**
   * Room-observed runtime peer count for hosted workstation attachments. This
   * is presence/runtime state, not an ACL or workstation registry fact.
   */
  runtimePeerCount?: number | null;
  workingDirectoryLabel?: string | null;
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
  /**
   * Host-owned compute target projection. This is intentionally descriptive:
   * execution authority still comes from the host/room, and runtime-state
   * authorship still comes from runtime peers.
   */
  target?: NotebookShellRuntimeTargetProjection | null;
}

export interface ProjectNotebookRuntimeTargetFromWorkstationAttachmentOptions {
  /**
   * Workstation attachments usually describe a hosted workstation from a
   * browser's point of view. Runtime-peer and fixture callers can override the
   * kind when they intentionally project a different host surface.
   */
  kind?: NotebookShellRuntimeTargetKind;
  kernelStatusLabel?: string | null;
  runtimePeerCount?: number | null;
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

const LOCAL_READY_RUNTIME_TARGET: NotebookShellRuntimeTargetProjection = Object.freeze({
  id: "local-daemon",
  kind: "local_daemon",
  status: "ready",
  label: "This machine",
  statusLabel: "Ready",
  providerLabel: "Local",
  defaultEnvironmentLabel: "Notebook runtime",
  environmentLabel: "Notebook runtime",
});

const LOCAL_OFFLINE_RUNTIME_TARGET: NotebookShellRuntimeTargetProjection = Object.freeze({
  id: "local-daemon",
  kind: "local_daemon",
  status: "offline",
  label: "This machine",
  statusLabel: "Offline",
  providerLabel: "Local",
  defaultEnvironmentLabel: "Unavailable",
  environmentLabel: "Unavailable",
});

const CLOUD_READY_RUNTIME_PEER_TARGET: NotebookShellRuntimeTargetProjection = Object.freeze({
  id: "runtime-peer",
  kind: "runtime_peer",
  status: "ready",
  label: "Runtime peer",
  statusLabel: "Ready",
  providerLabel: "Cloud room",
  defaultEnvironmentLabel: "Runtime peer",
  environmentLabel: "Runtime peer",
});

const CLOUD_ATTACHED_RUNTIME_PEER_TARGET: NotebookShellRuntimeTargetProjection = Object.freeze({
  id: "runtime-peer",
  kind: "runtime_peer",
  status: "attached",
  label: "Runtime peer",
  statusLabel: "Attached",
  providerLabel: "Cloud room",
  defaultEnvironmentLabel: "Runtime peer",
  environmentLabel: "Runtime peer",
});

const CLOUD_NO_WORKSTATION_TARGET: NotebookShellRuntimeTargetProjection = Object.freeze({
  id: "workstation:none",
  kind: "cloud_workstation",
  status: "offline",
  label: "No compute session",
  statusLabel: "Offline",
  providerLabel: "Cloud room",
  defaultEnvironmentLabel: "Not running",
  environmentLabel: "Not running",
});

const FIXTURE_RUNTIME_TARGET: NotebookShellRuntimeTargetProjection = Object.freeze({
  id: "fixture-runtime",
  kind: "fixture",
  status: "ready",
  label: "Fixture runtime",
  statusLabel: "Ready",
  providerLabel: "Fixture",
  defaultEnvironmentLabel: "Fixture runtime",
  environmentLabel: "Fixture runtime",
});

const UNKNOWN_RUNTIME_TARGET: NotebookShellRuntimeTargetProjection = Object.freeze({
  id: "runtime:none",
  kind: "unknown",
  status: "offline",
  label: "No runtime target",
  statusLabel: "Offline",
  providerLabel: "Unknown",
  defaultEnvironmentLabel: "Not running",
  environmentLabel: "Not running",
});

export function resolveNotebookShellRuntimeTarget(
  runtime: NotebookShellRuntimeCapabilities,
): NotebookShellRuntimeTargetProjection {
  if (runtime.target) return runtime.target;
  if (runtime.source === "local") {
    return runtime.executionAvailable ? LOCAL_READY_RUNTIME_TARGET : LOCAL_OFFLINE_RUNTIME_TARGET;
  }
  if (runtime.source === "cloud") {
    if (runtime.executionAvailable) return CLOUD_READY_RUNTIME_PEER_TARGET;
    if (runtime.connected) return CLOUD_ATTACHED_RUNTIME_PEER_TARGET;
    return CLOUD_NO_WORKSTATION_TARGET;
  }
  if (runtime.source === "fixture" && runtime.executionAvailable) {
    return FIXTURE_RUNTIME_TARGET;
  }
  return UNKNOWN_RUNTIME_TARGET;
}

export function notebookShellWorkstationAttachmentCacheKey(
  attachment: WorkstationAttachmentState | null | undefined,
): string {
  if (attachment === undefined) return "undefined";
  if (attachment === null) return "null";
  return stableCacheKey([
    attachment.workstation_id,
    attachment.display_name,
    attachment.provider,
    attachment.default_environment_label,
    attachment.environment_policy,
    attachment.status,
    attachment.status_message ?? null,
    attachment.cpu_count ?? null,
    attachment.memory_bytes ?? null,
    attachment.working_directory ?? null,
    attachment.updated_at ?? null,
    attachment.runtime_session_id ?? null,
  ]);
}

export function projectNotebookRuntimeTargetFromWorkstationAttachment(
  attachment: WorkstationAttachmentState | null | undefined,
  options: ProjectNotebookRuntimeTargetFromWorkstationAttachmentOptions = {},
): NotebookShellRuntimeTargetProjection | null {
  if (!attachment) return null;

  const statusProjection = workstationAttachmentStatusProjection(attachment.status);
  const defaultEnvironmentLabel =
    trimToNull(attachment.default_environment_label) ??
    trimToNull(attachment.environment_policy) ??
    "Notebook runtime";
  const runtimePeerCount = normalizePositiveInteger(options.runtimePeerCount);

  return {
    id: trimToNull(attachment.workstation_id) ?? "attached-workstation",
    runtimeSessionId: trimToNull(attachment.runtime_session_id),
    kind: options.kind ?? "cloud_workstation",
    status: statusProjection.status,
    label: trimToNull(attachment.display_name) ?? "Attached workstation",
    statusLabel: statusProjection.statusLabel,
    detail: trimToNull(attachment.status_message) ?? statusProjection.detail,
    providerLabel: workstationAttachmentProviderLabel(attachment.provider),
    defaultEnvironmentLabel,
    environmentLabel: defaultEnvironmentLabel,
    kernelStatusLabel: options.kernelStatusLabel ?? null,
    cpuCount: normalizePositiveInteger(attachment.cpu_count),
    memoryBytes: normalizePositiveInteger(attachment.memory_bytes),
    runtimePeerCount,
    workingDirectoryLabel: trimToNull(attachment.working_directory),
  };
}

export function workstationAttachmentCanExecute(
  attachment: WorkstationAttachmentState | null | undefined,
): boolean {
  if (!attachment) return false;
  return attachment.status === "ready" || attachment.status === "busy";
}

export function workstationAttachmentIsConnected(
  attachment: WorkstationAttachmentState | null | undefined,
): boolean {
  if (!attachment) return false;
  return (
    attachment.status === "ready" ||
    attachment.status === "busy" ||
    attachment.status === "connecting"
  );
}

export function notebookShellRuntimeTargetSummary(
  capabilities: Pick<NotebookShellCapabilities, "runtime">,
): string {
  return resolveNotebookShellRuntimeTarget(capabilities.runtime).label;
}

export interface NotebookShellControlPolicy {
  canToggleCode: boolean;
}

export interface NotebookShellExecutionPolicy {
  available: boolean;
  canSubmit?: boolean;
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
const SHELL_RUNTIME_TARGET_CACHE = new Map<string, NotebookShellRuntimeTargetProjection>();
const SHELL_CAPABILITIES_CACHE = new Map<string, NotebookShellCapabilities>();
const SHELL_PART_CACHE_LIMIT = 256;
const SHELL_CAPABILITIES_CACHE_LIMIT = 512;

type ProjectionCacheFieldReaders<T extends object> = {
  readonly [K in keyof T]-?: (projection: T) => unknown;
};

function projectionCacheKey<T extends object>(
  projection: T,
  readers: ProjectionCacheFieldReaders<T>,
): string {
  return stableCacheKey(projectionCacheKeyParts(projection, readers));
}

function projectionCacheKeyParts<T extends object>(
  projection: T,
  readers: ProjectionCacheFieldReaders<T>,
): unknown[] {
  return (Object.values(readers) as Array<(projection: T) => unknown>).map((readField) =>
    readField(projection),
  );
}

function optionalProjectionCacheKey<T extends object>(
  projection: T | null | undefined,
  readers: ProjectionCacheFieldReaders<T>,
  absentValue: unknown,
): string {
  return stableCacheKey(
    (Object.values(readers) as Array<(projection: T) => unknown>).map((readField) =>
      projection === null || projection === undefined ? absentValue : readField(projection),
    ),
  );
}

const NOTEBOOK_EDIT_ACCESS_CACHE_FIELDS = {
  selectedMode: (interaction) => interaction.selectedMode,
  activeMode: (interaction) => interaction.activeMode,
  state: (interaction) => interaction.state,
  canRequestEdit: (interaction) => interaction.canRequestEdit,
  canEditMarkdown: (interaction) => interaction.canEditMarkdown,
  canEditCells: (interaction) => interaction.canEditCells,
  canEditStructure: (interaction) => interaction.canEditStructure,
} satisfies ProjectionCacheFieldReaders<NotebookEditAccessProjection>;
const NOTEBOOK_ROOM_EDIT_ACCESS_CACHE_FIELDS = {
  selectedMode: (interaction) => interaction.selectedMode,
  activeMode: (interaction) => interaction.activeMode,
  state: (interaction) => interaction.state,
  canRequestEdit: (interaction) => interaction.canRequestEdit,
  canEditMarkdown: (interaction) => interaction.canEditMarkdown,
  canEditCells: (interaction) => interaction.canEditCells,
  canEditStructure: (interaction) => interaction.canEditStructure,
  inputSelectedMode: (interaction) => interaction.inputSelectedMode,
  accessLevel: (interaction) => interaction.accessLevel,
  requestedScope: (interaction) => interaction.requestedScope,
  hasDocumentEditPermission: (interaction) => interaction.hasDocumentEditPermission,
  selectedDocumentEditMode: (interaction) => interaction.selectedDocumentEditMode,
  requestedDocumentEditAccess: (interaction) => interaction.requestedDocumentEditAccess,
  editAccessPending: (interaction) => interaction.editAccessPending,
} satisfies ProjectionCacheFieldReaders<NotebookRoomEditAccessProjection>;
const NOTEBOOK_SHELL_CAPABILITIES_CACHE_FIELDS = {
  canRead: (capabilities) => capabilities.canRead,
  canEditMarkdown: (capabilities) => capabilities.canEditMarkdown,
  canEditCells: (capabilities) => capabilities.canEditCells,
  canEditStructure: (capabilities) => capabilities.canEditStructure,
  canRequestEdit: (capabilities) => capabilities.canRequestEdit,
  canExecute: (capabilities) => capabilities.canExecute,
  canToggleCode: (capabilities) => capabilities.canToggleCode,
  canViewPackages: (capabilities) => capabilities.canViewPackages,
  canManagePackages: (capabilities) => capabilities.canManagePackages,
  canManageSharing: (capabilities) => capabilities.canManageSharing,
  interaction: (capabilities) => notebookShellOptionalInteractionCacheKey(capabilities.interaction),
  access: (capabilities) => notebookShellAccessCacheKey(capabilities.access),
  auth: (capabilities) => notebookShellAuthCacheKey(capabilities.auth),
  runtime: (capabilities) => notebookShellRuntimeCacheKey(capabilities.runtime),
} satisfies ProjectionCacheFieldReaders<NotebookShellCapabilities>;
const NOTEBOOK_SHELL_ACCESS_CACHE_FIELDS = {
  level: (access) => access.level,
  source: (access) => access.source,
  isPublic: (access) => access.isPublic,
  actorLabel: (access) => access.actorLabel,
  identityLabel: (access) => access.identityLabel,
  actor: (access) => notebookActorProjectionCacheKey(access.actor),
} satisfies ProjectionCacheFieldReaders<NotebookShellAccessCapabilities>;
const NOTEBOOK_SHELL_AUTH_CACHE_FIELDS = {
  canSignIn: (auth) => auth.canSignIn,
  canUseAuthenticatedIdentity: (auth) => auth.canUseAuthenticatedIdentity,
  needsAttention: (auth) => auth.needsAttention,
} satisfies ProjectionCacheFieldReaders<NotebookShellAuthCapabilities>;
const NOTEBOOK_SHELL_RUNTIME_CACHE_FIELDS = {
  canWriteRuntimeState: (runtime) => runtime.canWriteRuntimeState,
  connected: (runtime) => runtime.connected,
  executionAvailable: (runtime) => runtime.executionAvailable,
  source: (runtime) => runtime.source,
  actorLabel: (runtime) => runtime.actorLabel,
  identityLabel: (runtime) => runtime.identityLabel,
  actor: (runtime) => notebookActorProjectionCacheKey(runtime.actor),
  target: (runtime) =>
    notebookShellRuntimeTargetCacheKey(resolveNotebookShellRuntimeTarget(runtime)),
} satisfies ProjectionCacheFieldReaders<NotebookShellRuntimeCapabilities>;
const NOTEBOOK_SHELL_RUNTIME_TARGET_CACHE_FIELDS = {
  id: (target) => target.id ?? null,
  kind: (target) => target.kind,
  status: (target) => target.status,
  label: (target) => target.label,
  statusLabel: (target) => target.statusLabel ?? null,
  detail: (target) => target.detail ?? null,
  providerLabel: (target) => target.providerLabel ?? null,
  defaultEnvironmentLabel: (target) => target.defaultEnvironmentLabel ?? null,
  environmentLabel: (target) => target.environmentLabel ?? null,
  kernelStatusLabel: (target) => target.kernelStatusLabel ?? null,
  cpuCount: (target) => target.cpuCount ?? null,
  memoryBytes: (target) => target.memoryBytes ?? null,
  resourceLabel: (target) => target.resourceLabel ?? null,
  runtimePeerCount: (target) => target.runtimePeerCount ?? null,
  workingDirectoryLabel: (target) => target.workingDirectoryLabel ?? null,
  runtimeSessionId: (target) => target.runtimeSessionId ?? null,
} satisfies ProjectionCacheFieldReaders<NotebookShellRuntimeTargetProjection>;
const NOTEBOOK_ACTOR_PROJECTION_CACHE_FIELDS = {
  actorLabel: (actor) => actor.actorLabel,
  principal: (actor) => notebookActorPrincipalCacheKey(actor.principal),
  operator: (actor) => notebookActorOperatorCacheKey(actor.operator),
  scope: (actor) => actor.scope ?? null,
  status: (actor) => actor.status ?? null,
} satisfies ProjectionCacheFieldReaders<NotebookActorProjection>;
const NOTEBOOK_ACTOR_PRINCIPAL_CACHE_FIELDS = {
  id: (principal) => principal.id,
  label: (principal) => principal.label,
  imageUrl: (principal) => principal.imageUrl ?? null,
  source: (principal) => notebookActorPrincipalSourceCacheKey(principal.source),
} satisfies ProjectionCacheFieldReaders<NotebookActorProjection["principal"]>;
const NOTEBOOK_ACTOR_PRINCIPAL_SOURCE_CACHE_FIELDS = {
  provider: (source) => source.provider,
  namespace: (source) => source.namespace ?? null,
} satisfies ProjectionCacheFieldReaders<
  NonNullable<NotebookActorProjection["principal"]["source"]>
>;
const NOTEBOOK_ACTOR_OPERATOR_CACHE_FIELDS = {
  id: (operator) => operator.id,
  kind: (operator) => operator.kind,
  label: (operator) => operator.label,
} satisfies ProjectionCacheFieldReaders<NotebookActorProjection["operator"]>;

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
  target: UNKNOWN_RUNTIME_TARGET,
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
  SHELL_RUNTIME_TARGET_CACHE.clear();
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
    target: runtime?.target ?? null,
  });
  const canRead = accessCapabilities.level !== "none";
  const canExecute =
    executionAvailable &&
    (execution?.canSubmit ?? true) &&
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
  const projectedCapabilities: NotebookShellCapabilities = {
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
  };
  return stabilizeNotebookShellCapabilities(projectedCapabilities);
}

export function stabilizeNotebookShellCapabilities(
  capabilities: NotebookShellCapabilities,
): NotebookShellCapabilities {
  const projectedCapabilities: NotebookShellCapabilities = {
    canRead: capabilities.canRead,
    canEditMarkdown: capabilities.canEditMarkdown,
    canEditCells: capabilities.canEditCells,
    canEditStructure: capabilities.canEditStructure,
    canRequestEdit: capabilities.canRequestEdit,
    canExecute: capabilities.canExecute,
    canToggleCode: capabilities.canToggleCode,
    canViewPackages: capabilities.canViewPackages,
    canManagePackages: capabilities.canManagePackages,
    canManageSharing: capabilities.canManageSharing,
    interaction: capabilities.interaction,
    access: stableNotebookShellAccessCapabilities(capabilities.access),
    auth: stableNotebookShellAuthCapabilities(capabilities.auth),
    runtime: stableNotebookShellRuntimeCapabilities(capabilities.runtime),
  };
  const cacheKey = notebookShellCapabilitiesCacheKey(projectedCapabilities);
  const cached = getBoundedCacheValue(SHELL_CAPABILITIES_CACHE, cacheKey);
  if (cached) return cached;

  const stableCapabilities = Object.freeze(projectedCapabilities);
  setBoundedCacheValue(
    SHELL_CAPABILITIES_CACHE,
    cacheKey,
    stableCapabilities,
    SHELL_CAPABILITIES_CACHE_LIMIT,
  );
  return stableCapabilities;
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
    target: stableNotebookShellRuntimeTarget(resolveNotebookShellRuntimeTarget(runtime)),
  });
  setBoundedCacheValue(SHELL_RUNTIME_CACHE, cacheKey, stableRuntime, SHELL_PART_CACHE_LIMIT);
  return stableRuntime;
}

function stableNotebookShellRuntimeTarget(
  target: NotebookShellRuntimeTargetProjection | null | undefined,
): NotebookShellRuntimeTargetProjection | null {
  if (!target) return null;

  const cacheKey = notebookShellRuntimeTargetCacheKey(target);
  const cached = getBoundedCacheValue(SHELL_RUNTIME_TARGET_CACHE, cacheKey);
  if (cached) return cached;

  const stableTarget = Object.freeze({
    id: target.id ?? null,
    runtimeSessionId: target.runtimeSessionId ?? null,
    kind: target.kind,
    status: target.status,
    label: target.label,
    statusLabel: target.statusLabel ?? null,
    detail: target.detail ?? null,
    providerLabel: target.providerLabel ?? null,
    defaultEnvironmentLabel: target.defaultEnvironmentLabel ?? null,
    environmentLabel: target.environmentLabel ?? null,
    kernelStatusLabel: target.kernelStatusLabel ?? null,
    cpuCount: target.cpuCount ?? null,
    memoryBytes: target.memoryBytes ?? null,
    resourceLabel: target.resourceLabel ?? null,
    runtimePeerCount: target.runtimePeerCount ?? null,
    workingDirectoryLabel: target.workingDirectoryLabel ?? null,
  });
  setBoundedCacheValue(SHELL_RUNTIME_TARGET_CACHE, cacheKey, stableTarget, SHELL_PART_CACHE_LIMIT);
  return stableTarget;
}

function notebookShellCapabilitiesCacheKey(capabilities: NotebookShellCapabilities): string {
  return projectionCacheKey(capabilities, NOTEBOOK_SHELL_CAPABILITIES_CACHE_FIELDS);
}

function notebookShellInteractionCacheKey(
  interaction: NotebookEditAccessProjection | NotebookRoomEditAccessProjection,
): string {
  if ("accessLevel" in interaction) {
    return projectionCacheKey(interaction, NOTEBOOK_ROOM_EDIT_ACCESS_CACHE_FIELDS);
  }
  return projectionCacheKey(interaction, NOTEBOOK_EDIT_ACCESS_CACHE_FIELDS);
}

function notebookShellOptionalInteractionCacheKey(
  interaction: NotebookEditAccessProjection | NotebookRoomEditAccessProjection | null | undefined,
): string {
  if (interaction === undefined) return "undefined";
  if (interaction === null) return "null";
  return notebookShellInteractionCacheKey(interaction);
}

function notebookShellAccessCacheKey(access: NotebookShellAccessCapabilities): string {
  return projectionCacheKey(access, NOTEBOOK_SHELL_ACCESS_CACHE_FIELDS);
}

function notebookShellAuthCacheKey(auth: NotebookShellAuthCapabilities): string {
  return projectionCacheKey(auth, NOTEBOOK_SHELL_AUTH_CACHE_FIELDS);
}

function notebookShellRuntimeCacheKey(runtime: NotebookShellRuntimeCapabilities): string {
  return projectionCacheKey(runtime, NOTEBOOK_SHELL_RUNTIME_CACHE_FIELDS);
}

function notebookShellRuntimeTargetCacheKey(
  target: NotebookShellRuntimeTargetProjection | null | undefined,
): string {
  if (target === undefined) return "undefined";
  if (target === null) return "null";
  return projectionCacheKey(target, NOTEBOOK_SHELL_RUNTIME_TARGET_CACHE_FIELDS);
}

function notebookActorProjectionCacheKey(
  actor: NotebookActorProjection | null | undefined,
): string {
  if (actor === undefined) return "undefined";
  if (actor === null) return "null";
  return projectionCacheKey(actor, NOTEBOOK_ACTOR_PROJECTION_CACHE_FIELDS);
}

function notebookActorPrincipalCacheKey(actor: NotebookActorProjection["principal"]): string {
  return projectionCacheKey(actor, NOTEBOOK_ACTOR_PRINCIPAL_CACHE_FIELDS);
}

function notebookActorPrincipalSourceCacheKey(
  source: NotebookActorProjection["principal"]["source"],
): string {
  return optionalProjectionCacheKey(source, NOTEBOOK_ACTOR_PRINCIPAL_SOURCE_CACHE_FIELDS, null);
}

function notebookActorOperatorCacheKey(actor: NotebookActorProjection["operator"]): string {
  return projectionCacheKey(actor, NOTEBOOK_ACTOR_OPERATOR_CACHE_FIELDS);
}

function workstationAttachmentStatusProjection(status: string): {
  status: NotebookShellRuntimeTargetStatus;
  statusLabel: string;
  detail: string | null;
} {
  switch (status) {
    case "ready":
      return { status: "ready", statusLabel: "Ready", detail: null };
    case "busy":
      return { status: "attached", statusLabel: "Busy", detail: null };
    case "connecting":
      return {
        status: "connecting",
        statusLabel: "Connecting",
        detail: "The selected workstation is starting compute for this notebook.",
      };
    case "error":
      return {
        status: "attention",
        statusLabel: "Needs attention",
        detail: "The selected workstation could not start compute for this notebook.",
      };
    case "disconnected":
      return {
        status: "offline",
        statusLabel: "Offline",
        detail: "The selected workstation is not connected to this notebook.",
      };
    default:
      return { status: "attached", statusLabel: "Attached", detail: null };
  }
}

function workstationAttachmentProviderLabel(provider: string): string {
  switch (provider) {
    case "local_daemon":
      return "Local daemon";
    case "runtime_peer":
      return "Workstation";
    case "cloud_room":
      return "Cloud room";
    case "cloud_workstation":
      return "Cloud workstation";
    default:
      return trimToNull(provider) ?? "Workstation";
  }
}

function normalizePositiveInteger(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : null;
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
