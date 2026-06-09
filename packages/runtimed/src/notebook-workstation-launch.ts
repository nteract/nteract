import type { NotebookShellCapabilities } from "./notebook-shell-capabilities";
import { getBoundedCacheValue, setBoundedCacheValue, stableCacheKey } from "./projection-cache";
import type {
  NotebookRegisteredWorkstationProjection,
  NotebookWorkstationSelectionProjection,
} from "./notebook-workstation-selection";

export type NotebookWorkstationLaunchReadinessState =
  | "ready"
  | "attaching"
  | "limited"
  | "needs_registration"
  | "needs_selection"
  | "needs_attachment"
  | "workstation_unavailable"
  | "unavailable";

export type NotebookWorkstationLaunchActionKind =
  | "none"
  | "setup_workstation"
  | "select_workstation"
  | "attach_workstation"
  | "open_workstations";

export interface NotebookWorkstationLaunchActionProjection {
  kind: NotebookWorkstationLaunchActionKind;
  label: string | null;
  title: string | null;
}

export interface NotebookWorkstationLaunchReadinessProjection {
  canRun: boolean;
  detail: string | null;
  primaryAction: NotebookWorkstationLaunchActionProjection;
  state: NotebookWorkstationLaunchReadinessState;
  statusLabel: string;
  targetLabel: string | null;
  workstationId: string | null;
}

export interface ProjectNotebookWorkstationLaunchReadinessOptions {
  capabilities: Pick<NotebookShellCapabilities, "canExecute" | "runtime">;
  selection?: NotebookWorkstationSelectionProjection | null;
}

const WORKSTATION_LAUNCH_CACHE = new Map<string, NotebookWorkstationLaunchReadinessProjection>();
const WORKSTATION_LAUNCH_ACTION_CACHE = new Map<
  string,
  NotebookWorkstationLaunchActionProjection
>();
const WORKSTATION_LAUNCH_CACHE_LIMIT = 256;
const WORKSTATION_LAUNCH_ACTION_CACHE_LIMIT = 64;

const NO_ACTION = launchAction("none", null, null);

export function projectNotebookWorkstationLaunchReadiness({
  capabilities,
  selection = null,
}: ProjectNotebookWorkstationLaunchReadinessOptions): NotebookWorkstationLaunchReadinessProjection {
  const runtimeTarget = capabilities.runtime.target ?? null;
  const activeTarget = selection?.activeTarget ?? runtimeTarget;
  const launchCandidate = selection?.launchCandidate ?? null;
  const cacheKey = stableCacheKey([
    capabilities.canExecute,
    capabilities.runtime.connected,
    capabilities.runtime.executionAvailable ?? false,
    runtimeTarget?.id ?? null,
    runtimeTarget?.kind ?? null,
    runtimeTarget?.status ?? null,
    runtimeTarget?.statusLabel ?? null,
    runtimeTarget?.label ?? null,
    runtimeTarget?.detail ?? null,
    activeTarget?.id ?? null,
    activeTarget?.kind ?? null,
    activeTarget?.status ?? null,
    activeTarget?.statusLabel ?? null,
    activeTarget?.label ?? null,
    activeTarget?.detail ?? null,
    selection?.state ?? null,
    selection?.canRegisterWorkstation ?? null,
    selection?.canSelectWorkstation ?? null,
    selection?.registeredWorkstations.length ?? null,
    workstationCandidateCacheKey(launchCandidate),
  ]);
  const cached = getBoundedCacheValue(WORKSTATION_LAUNCH_CACHE, cacheKey);
  if (cached) return cached;

  let projection: NotebookWorkstationLaunchReadinessProjection;
  const runtimeCanExecute = Boolean(capabilities.runtime.executionAvailable);
  if (runtimeCanExecute && capabilities.canExecute) {
    projection = launchProjection({
      canRun: true,
      detail: null,
      primaryAction: NO_ACTION,
      state: "ready",
      statusLabel: activeTarget?.statusLabel ?? "Ready",
      targetLabel: activeTarget?.label ?? null,
      workstationId: activeTarget?.id ?? selection?.activeWorkstationId ?? null,
    });
  } else if (runtimeCanExecute) {
    projection = launchProjection({
      canRun: false,
      detail: "Compute is attached, but this connection cannot run cells.",
      primaryAction: NO_ACTION,
      state: "limited",
      statusLabel: activeTarget?.statusLabel ?? "Limited",
      targetLabel: activeTarget?.label ?? null,
      workstationId: activeTarget?.id ?? selection?.activeWorkstationId ?? null,
    });
  } else if (activeTarget?.status === "connecting") {
    projection = launchProjection({
      canRun: false,
      detail: activeTarget.detail ?? "The selected workstation is attaching to this notebook.",
      primaryAction: launchAction("open_workstations", "Review compute", "Open workstations panel"),
      state: "attaching",
      statusLabel: activeTarget.statusLabel ?? "Attaching",
      targetLabel: activeTarget.label,
      workstationId: activeTarget.id ?? selection?.activeWorkstationId ?? null,
    });
  } else if (selection?.state === "needs_registration") {
    projection = launchProjection({
      canRun: false,
      detail: "Open the workstation panel to register compute before running this notebook.",
      primaryAction: launchAction("setup_workstation", "Set up compute", "Open workstations panel"),
      state: "needs_registration",
      statusLabel: "Setup needed",
      targetLabel: null,
      workstationId: null,
    });
  } else if (launchCandidate) {
    projection = launchProjectionForCandidate(launchCandidate);
  } else if (
    selection?.canSelectWorkstation &&
    selection.registeredWorkstations.length > 0 &&
    selection.state === "unselected"
  ) {
    projection = launchProjection({
      canRun: false,
      detail: "Choose a workstation before starting compute for this notebook.",
      primaryAction: launchAction(
        "select_workstation",
        "Choose compute",
        "Open workstations panel",
      ),
      state: "needs_selection",
      statusLabel: "Choose compute",
      targetLabel: null,
      workstationId: null,
    });
  } else {
    projection = launchProjection({
      canRun: false,
      detail:
        activeTarget?.detail ??
        (capabilities.runtime.connected
          ? "Compute is connected but not ready to run cells."
          : "No executable workstation is available for this notebook."),
      primaryAction: NO_ACTION,
      state: "unavailable",
      statusLabel: activeTarget?.statusLabel ?? "Unavailable",
      targetLabel: activeTarget?.label ?? null,
      workstationId: activeTarget?.id ?? selection?.activeWorkstationId ?? null,
    });
  }

  setBoundedCacheValue(
    WORKSTATION_LAUNCH_CACHE,
    cacheKey,
    projection,
    WORKSTATION_LAUNCH_CACHE_LIMIT,
  );
  return projection;
}

export function clearNotebookWorkstationLaunchReadinessProjectionCacheForTests(): void {
  WORKSTATION_LAUNCH_CACHE.clear();
  WORKSTATION_LAUNCH_ACTION_CACHE.clear();
}

function launchProjectionForCandidate(
  candidate: NotebookRegisteredWorkstationProjection,
): NotebookWorkstationLaunchReadinessProjection {
  if (candidate.status === "online") {
    if (!candidate.workingDirectoryLabel) {
      return unavailableCandidateProjection(
        candidate,
        "This workstation does not have a working directory configured for notebook execution.",
      );
    }
    if (!hasRunnableEnvironment(candidate)) {
      return unavailableCandidateProjection(
        candidate,
        "This workstation does not have a runnable default environment configured.",
      );
    }
    return launchProjection({
      canRun: false,
      detail: "This workstation is available and can start compute for this notebook.",
      primaryAction: launchAction(
        "attach_workstation",
        "Start compute",
        `Start compute on ${candidate.displayName}`,
      ),
      state: "needs_attachment",
      statusLabel: "Ready to start",
      targetLabel: candidate.displayName,
      workstationId: candidate.id,
    });
  }
  if (candidate.status === "connecting") {
    return launchProjection({
      canRun: false,
      detail: candidate.statusMessage ?? "This workstation is connecting.",
      primaryAction: launchAction("open_workstations", "Review compute", "Open workstations panel"),
      state: "attaching",
      statusLabel: "Connecting",
      targetLabel: candidate.displayName,
      workstationId: candidate.id,
    });
  }
  return unavailableCandidateProjection(
    candidate,
    candidate.statusMessage ?? "This workstation is not available to run cells.",
  );
}

function unavailableCandidateProjection(
  candidate: NotebookRegisteredWorkstationProjection,
  detail: string,
): NotebookWorkstationLaunchReadinessProjection {
  return launchProjection({
    canRun: false,
    detail,
    primaryAction: launchAction("open_workstations", "Review compute", "Open workstations panel"),
    state: "workstation_unavailable",
    statusLabel: candidate.statusLabel,
    targetLabel: candidate.displayName,
    workstationId: candidate.id,
  });
}

function hasRunnableEnvironment(candidate: NotebookRegisteredWorkstationProjection): boolean {
  if (candidate.defaultEnvironmentLabel) return true;
  return candidate.environments.some((environment) => environment.available);
}

function launchProjection(
  projection: NotebookWorkstationLaunchReadinessProjection,
): NotebookWorkstationLaunchReadinessProjection {
  return Object.freeze(projection);
}

function launchAction(
  kind: NotebookWorkstationLaunchActionKind,
  label: string | null,
  title: string | null,
): NotebookWorkstationLaunchActionProjection {
  const cacheKey = stableCacheKey([kind, label, title]);
  const cached = getBoundedCacheValue(WORKSTATION_LAUNCH_ACTION_CACHE, cacheKey);
  if (cached) return cached;
  const projection = Object.freeze({ kind, label, title });
  setBoundedCacheValue(
    WORKSTATION_LAUNCH_ACTION_CACHE,
    cacheKey,
    projection,
    WORKSTATION_LAUNCH_ACTION_CACHE_LIMIT,
  );
  return projection;
}

function workstationCandidateCacheKey(
  candidate: NotebookRegisteredWorkstationProjection | null,
): string {
  if (!candidate) return "null";
  return stableCacheKey([
    candidate.id,
    candidate.displayName,
    candidate.status,
    candidate.statusLabel,
    candidate.statusMessage,
    candidate.isDefault,
    candidate.isSelected,
    candidate.isAttached,
    candidate.defaultEnvironmentLabel,
    candidate.environmentPolicy,
    candidate.workingDirectoryLabel,
  ]);
}
