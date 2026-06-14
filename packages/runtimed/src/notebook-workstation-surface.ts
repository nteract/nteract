import type { NotebookShellCapabilities } from "./notebook-shell-capabilities";
import { getBoundedCacheValue, setBoundedCacheValue, stableCacheKey } from "./projection-cache";
import type { WorkstationAttachmentState } from "./runtime-state";
import {
  projectNotebookWorkstationLaunchReadiness,
  type NotebookWorkstationLaunchActionKind,
  type NotebookWorkstationLaunchReadinessProjection,
} from "./notebook-workstation-launch";
import {
  projectNotebookWorkstationSelection,
  type NotebookRegisteredWorkstation,
  type NotebookWorkstationSelectionProjection,
} from "./notebook-workstation-selection";

export interface NotebookWorkstationSurfaceMutationProjection {
  kind: "idle" | "default" | "attach";
  message: string | null;
  workstationId: string | null;
}

export interface NotebookWorkstationToolbarActionProjection {
  disabled: boolean;
  kind: Exclude<NotebookWorkstationLaunchActionKind, "none">;
  label: string;
  pending: boolean;
  title: string;
  workstationId: string | null;
}

export interface NotebookWorkstationSurfaceProjection {
  busyWorkstationId: string | null;
  canStartSelectedWorkstation: boolean;
  launchReadiness: NotebookWorkstationLaunchReadinessProjection;
  panelStatusMessage: string | null;
  selection: NotebookWorkstationSelectionProjection;
  toolbarAction: NotebookWorkstationToolbarActionProjection | null;
}

export interface ProjectNotebookWorkstationSurfaceOptions {
  activeAttachment?: WorkstationAttachmentState | null;
  capabilities: Pick<NotebookShellCapabilities, "canExecute" | "runtime">;
  canRegisterWorkstation?: boolean;
  canSelectWorkstation?: boolean;
  canSetDefaultWorkstation?: boolean;
  canStartWorkstation?: boolean;
  defaultWorkstationId?: string | null;
  loadingMessage?: string | null;
  mutation?: Partial<NotebookWorkstationSurfaceMutationProjection> | null;
  registeredWorkstations?: readonly NotebookRegisteredWorkstation[] | null;
  registryError?: string | null;
  selectedWorkstationId?: string | null;
}

const WORKSTATION_SURFACE_CACHE = new Map<string, NotebookWorkstationSurfaceProjection>();
const WORKSTATION_SURFACE_ACTION_CACHE = new Map<
  string,
  NotebookWorkstationToolbarActionProjection
>();
const WORKSTATION_SURFACE_CACHE_LIMIT = 256;
const WORKSTATION_SURFACE_ACTION_CACHE_LIMIT = 128;

export function projectNotebookWorkstationSurface({
  activeAttachment = null,
  capabilities,
  canRegisterWorkstation = false,
  canSelectWorkstation = false,
  canSetDefaultWorkstation = false,
  canStartWorkstation = false,
  defaultWorkstationId = null,
  loadingMessage = null,
  mutation = null,
  registeredWorkstations = [],
  registryError = null,
  selectedWorkstationId = null,
}: ProjectNotebookWorkstationSurfaceOptions): NotebookWorkstationSurfaceProjection {
  const normalizedMutation = normalizeMutation(mutation);
  const selection = projectNotebookWorkstationSelection({
    activeAttachment,
    canRegisterWorkstation,
    canSelectWorkstation,
    canSetDefaultWorkstation,
    defaultWorkstationId,
    registeredWorkstations,
    selectedWorkstationId,
  });
  const launchReadiness = projectNotebookWorkstationLaunchReadiness({
    capabilities,
    selection,
  });
  const cacheKey = stableCacheKey([
    selection,
    launchReadiness,
    canStartWorkstation,
    loadingMessage,
    registryError,
    normalizedMutation.kind,
    normalizedMutation.message,
    normalizedMutation.workstationId,
  ]);
  const cached = getBoundedCacheValue(WORKSTATION_SURFACE_CACHE, cacheKey);
  if (cached) return cached;

  const toolbarAction = projectToolbarAction(
    launchReadiness,
    normalizedMutation,
    canStartWorkstation,
  );
  const panelStatusMessage =
    normalizedMutation.message ??
    loadingMessage ??
    registryError ??
    (launchReadiness.state === "workstation_unavailable" ? launchReadiness.detail : null);
  const projection = Object.freeze({
    busyWorkstationId: normalizedMutation.workstationId,
    canStartSelectedWorkstation:
      canStartWorkstation &&
      normalizedMutation.kind !== "attach" &&
      Boolean(launchReadiness.workstationId),
    launchReadiness,
    panelStatusMessage,
    selection,
    toolbarAction,
  });

  setBoundedCacheValue(
    WORKSTATION_SURFACE_CACHE,
    cacheKey,
    projection,
    WORKSTATION_SURFACE_CACHE_LIMIT,
  );
  return projection;
}

export function clearNotebookWorkstationSurfaceProjectionCacheForTests(): void {
  WORKSTATION_SURFACE_CACHE.clear();
  WORKSTATION_SURFACE_ACTION_CACHE.clear();
}

function normalizeMutation(
  mutation: Partial<NotebookWorkstationSurfaceMutationProjection> | null,
): NotebookWorkstationSurfaceMutationProjection {
  return {
    kind: mutation?.kind ?? "idle",
    message: trimToNull(mutation?.message),
    workstationId: trimToNull(mutation?.workstationId),
  };
}

function projectToolbarAction(
  launchReadiness: NotebookWorkstationLaunchReadinessProjection,
  mutation: NotebookWorkstationSurfaceMutationProjection,
  canStartWorkstation: boolean,
): NotebookWorkstationToolbarActionProjection | null {
  if (mutation.kind === "attach" && mutation.workstationId) {
    const pendingTarget =
      launchReadiness.workstationId === mutation.workstationId ? launchReadiness.targetLabel : null;
    return toolbarAction({
      disabled: true,
      kind: "attach_workstation",
      label: "Starting",
      pending: true,
      title: pendingTarget
        ? `Starting compute on ${pendingTarget}`
        : "Starting compute on the selected workstation",
      workstationId: mutation.workstationId,
    });
  }

  const primaryAction = launchReadiness.primaryAction;
  if (primaryAction.kind === "none" || !primaryAction.label || !primaryAction.title) {
    return null;
  }
  if (primaryAction.kind === "attach_workstation" && !canStartWorkstation) {
    return null;
  }
  return toolbarAction({
    disabled: false,
    kind: primaryAction.kind,
    label: primaryAction.label,
    pending: false,
    title: primaryAction.title,
    workstationId: launchReadiness.workstationId,
  });
}

function toolbarAction(
  projection: NotebookWorkstationToolbarActionProjection,
): NotebookWorkstationToolbarActionProjection {
  const cacheKey = stableCacheKey([
    projection.disabled,
    projection.kind,
    projection.label,
    projection.pending,
    projection.title,
    projection.workstationId,
  ]);
  const cached = getBoundedCacheValue(WORKSTATION_SURFACE_ACTION_CACHE, cacheKey);
  if (cached) return cached;
  const frozen = Object.freeze(projection);
  setBoundedCacheValue(
    WORKSTATION_SURFACE_ACTION_CACHE,
    cacheKey,
    frozen,
    WORKSTATION_SURFACE_ACTION_CACHE_LIMIT,
  );
  return frozen;
}

function trimToNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
