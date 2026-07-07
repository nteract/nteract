import { KERNEL_ERROR_REASON, type RuntimeLifecycle, type RuntimeState } from "./runtime-state";
import {
  KERNEL_STATUS,
  RUNTIME_STATUS,
  runtimeStatusKey,
  statusKeyToLegacyStatus,
  type RuntimeStatusKey,
} from "./derived-state";
import type { NotebookShellCapabilities } from "./notebook-shell-capabilities";
import { getBoundedCacheValue, setBoundedCacheValue, stableCacheKey } from "./projection-cache";

export type NotebookCommandRuntimeState =
  | "not_started"
  | "starting"
  | "idle"
  | "busy"
  | "error"
  | "shutdown"
  | "unknown";

export interface NotebookCommandRuntimeStatusProjection {
  ariaLabel: string;
  label: string;
  state: NotebookCommandRuntimeState;
  statusKey: RuntimeStatusKey;
  title: string;
}

export interface NotebookCommandRuntimeActionAvailability {
  interruptRuntime?: boolean;
  restartAndRunAll?: boolean;
  restartRuntime?: boolean;
  runAllCells?: boolean;
  startRuntime?: boolean;
}

export interface NotebookCommandRuntimeActionsProjection {
  hasRuntimeStatus: boolean;
  isRuntimeRunning: boolean;
  showAnyRuntimeAction: boolean;
  showInterrupt: boolean;
  showRestart: boolean;
  showRestartAndRunAll: boolean;
  showRunAll: boolean;
  showRuntimeStart: boolean;
}

export interface ProjectNotebookCommandRuntimeStatusOptions {
  statusKey: RuntimeStatusKey;
  errorReason?: string | null;
  forceError?: boolean;
}

export interface ProjectNotebookCommandRuntimeActionsOptions {
  actions?: NotebookCommandRuntimeActionAvailability;
  capabilities: Pick<NotebookShellCapabilities, "canExecute">;
  runtimeStatus?: Pick<NotebookCommandRuntimeStatusProjection, "state"> | null;
}

export interface ProjectNotebookCommandRuntimeStatusFromRuntimeStateOptions {
  /**
   * Some hosted rooms can prove execution availability through the room/control
   * plane before the runtime peer has projected an authoritative kernel
   * lifecycle. In that case a scaffolded `NotStarted` RuntimeStateDoc snapshot
   * is stale display data, not the runnable state.
   */
  executionAvailable?: boolean;
}

const COMMAND_RUNTIME_STATUS_CACHE = new Map<string, NotebookCommandRuntimeStatusProjection>();
const COMMAND_RUNTIME_ACTIONS_CACHE = new Map<string, NotebookCommandRuntimeActionsProjection>();
const COMMAND_RUNTIME_STATUS_CACHE_LIMIT = 128;
const COMMAND_RUNTIME_ACTIONS_CACHE_LIMIT = 128;

const ERROR_REASON_LABELS: Record<string, string> = {
  [KERNEL_ERROR_REASON.ENVIRONMENT_PREPARE_FAILED]: "environment setup failed",
  [KERNEL_ERROR_REASON.MISSING_IPYKERNEL]: "ipykernel missing",
  [KERNEL_ERROR_REASON.DEPENDENCY_CACHE_MISSING_IPYKERNEL]: "ipykernel missing",
  [KERNEL_ERROR_REASON.IPYKERNEL_SITE_PACKAGES_MISMATCH]: "Python environment mismatch",
  [KERNEL_ERROR_REASON.CONDA_ENV_YML_MISSING]: "Conda environment missing",
  [KERNEL_ERROR_REASON.CONDA_ENV_BUILD_FAILED]: "Conda environment build failed",
};

/**
 * User-facing label for each expanded [`RuntimeStatusKey`].
 *
 * Keyed by the flat runtime vocabulary so every lifecycle variant
 * (including each starting sub-phase and all three `Running(_)` cases)
 * gets a dedicated label. Exhaustive `Record` — adding a variant to
 * `RuntimeLifecycle` fails typecheck here until a label is added.
 */
export const RUNTIME_STATUS_LABELS: Record<RuntimeStatusKey, string> = {
  [RUNTIME_STATUS.NOT_STARTED]: "initializing",
  [RUNTIME_STATUS.AWAITING_TRUST]: "awaiting approval",
  [RUNTIME_STATUS.AWAITING_ENV_BUILD]: "awaiting environment build",
  [RUNTIME_STATUS.RESOLVING]: "resolving environment",
  [RUNTIME_STATUS.PREPARING_ENV]: "preparing environment",
  [RUNTIME_STATUS.LAUNCHING]: "launching kernel",
  [RUNTIME_STATUS.CONNECTING]: "connecting to kernel",
  [RUNTIME_STATUS.RUNNING_IDLE]: "idle",
  [RUNTIME_STATUS.RUNNING_BUSY]: "busy",
  [RUNTIME_STATUS.RUNNING_UNKNOWN]: "available",
  [RUNTIME_STATUS.ERROR]: "error",
  [RUNTIME_STATUS.SHUTDOWN]: "shutdown",
};

export function getStatusKeyLabel(key: RuntimeStatusKey, errorReason: string | null): string {
  if (key === RUNTIME_STATUS.ERROR && errorReason && errorReason.length > 0) {
    return `error: ${ERROR_REASON_LABELS[errorReason] ?? "kernel failed"}`;
  }
  return RUNTIME_STATUS_LABELS[key];
}

export function getLifecycleLabel(lifecycle: RuntimeLifecycle, errorReason: string | null): string {
  return getStatusKeyLabel(runtimeStatusKey(lifecycle), errorReason);
}

export function notebookCommandRuntimeStateForStatusKey(
  statusKey: RuntimeStatusKey,
  forceError = false,
): NotebookCommandRuntimeState {
  if (forceError) {
    return "error";
  }

  switch (statusKeyToLegacyStatus(statusKey)) {
    case KERNEL_STATUS.NOT_STARTED:
    case KERNEL_STATUS.AWAITING_TRUST:
    case KERNEL_STATUS.AWAITING_ENV_BUILD:
      return "not_started";
    case KERNEL_STATUS.STARTING:
      return "starting";
    case KERNEL_STATUS.IDLE:
      return "idle";
    case KERNEL_STATUS.BUSY:
      return "busy";
    case KERNEL_STATUS.ERROR:
      return "error";
    case KERNEL_STATUS.SHUTDOWN:
      return "shutdown";
  }
}

export function projectNotebookCommandRuntimeStatus({
  statusKey,
  errorReason = null,
  forceError = false,
}: ProjectNotebookCommandRuntimeStatusOptions): NotebookCommandRuntimeStatusProjection {
  const normalizedErrorReason = errorReason && errorReason.length > 0 ? errorReason : null;
  const cacheKey = stableCacheKey([statusKey, normalizedErrorReason, forceError]);
  const cached = getBoundedCacheValue(COMMAND_RUNTIME_STATUS_CACHE, cacheKey);
  if (cached) return cached;

  const label = getStatusKeyLabel(statusKey, normalizedErrorReason);
  const projection = Object.freeze({
    ariaLabel: `Kernel: ${label}`,
    label,
    state: notebookCommandRuntimeStateForStatusKey(statusKey, forceError),
    statusKey,
    title: label,
  });
  setBoundedCacheValue(
    COMMAND_RUNTIME_STATUS_CACHE,
    cacheKey,
    projection,
    COMMAND_RUNTIME_STATUS_CACHE_LIMIT,
  );
  return projection;
}

export function projectNotebookCommandRuntimeStatusFromRuntimeState(
  runtimeState: RuntimeState,
  options: ProjectNotebookCommandRuntimeStatusFromRuntimeStateOptions = {},
): NotebookCommandRuntimeStatusProjection {
  const statusKey = runtimeStatusKey(runtimeState.kernel.lifecycle);
  const effectiveStatusKey =
    options.executionAvailable && statusKey === RUNTIME_STATUS.NOT_STARTED
      ? RUNTIME_STATUS.RUNNING_UNKNOWN
      : statusKey;
  return projectNotebookCommandRuntimeStatus({
    statusKey: effectiveStatusKey,
    errorReason: runtimeState.kernel.error_reason,
  });
}

export function projectNotebookCommandRuntimeActions({
  actions,
  capabilities,
  runtimeStatus = null,
}: ProjectNotebookCommandRuntimeActionsOptions): NotebookCommandRuntimeActionsProjection {
  const runtimeState = runtimeStatus?.state ?? null;
  const actionAvailability = {
    interruptRuntime: actions?.interruptRuntime ?? false,
    restartAndRunAll: actions?.restartAndRunAll ?? false,
    restartRuntime: actions?.restartRuntime ?? false,
    runAllCells: actions?.runAllCells ?? false,
    startRuntime: actions?.startRuntime ?? false,
  };
  const cacheKey = stableCacheKey([
    capabilities.canExecute,
    runtimeState,
    actionAvailability.interruptRuntime,
    actionAvailability.restartAndRunAll,
    actionAvailability.restartRuntime,
    actionAvailability.runAllCells,
    actionAvailability.startRuntime,
  ]);
  const cached = getBoundedCacheValue(COMMAND_RUNTIME_ACTIONS_CACHE, cacheKey);
  if (cached) return cached;

  const hasRuntimeStatus = runtimeState !== null;
  const isRuntimeRunning =
    runtimeState === "idle" || runtimeState === "busy" || runtimeState === "starting";
  const canUseRuntimeAction = hasRuntimeStatus && capabilities.canExecute;
  const showRuntimeStart =
    canUseRuntimeAction && !isRuntimeRunning && actionAvailability.startRuntime;
  const showRunAll = canUseRuntimeAction && actionAvailability.runAllCells;
  const showRestart = canUseRuntimeAction && actionAvailability.restartRuntime;
  const showRestartAndRunAll = canUseRuntimeAction && actionAvailability.restartAndRunAll;
  const showInterrupt =
    canUseRuntimeAction && isRuntimeRunning && actionAvailability.interruptRuntime;
  const projection = Object.freeze({
    hasRuntimeStatus,
    isRuntimeRunning,
    showAnyRuntimeAction:
      showRuntimeStart || showRunAll || showRestart || showRestartAndRunAll || showInterrupt,
    showInterrupt,
    showRestart,
    showRestartAndRunAll,
    showRunAll,
    showRuntimeStart,
  });

  setBoundedCacheValue(
    COMMAND_RUNTIME_ACTIONS_CACHE,
    cacheKey,
    projection,
    COMMAND_RUNTIME_ACTIONS_CACHE_LIMIT,
  );
  return projection;
}

export function clearNotebookCommandRuntimeStatusCacheForTests(): void {
  COMMAND_RUNTIME_STATUS_CACHE.clear();
  COMMAND_RUNTIME_ACTIONS_CACHE.clear();
}
