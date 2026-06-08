import {
  projectNotebookRuntimeTargetFromWorkstationAttachment,
  type NotebookShellRuntimeTargetProjection,
} from "./notebook-shell-capabilities";
import { getBoundedCacheValue, setBoundedCacheValue, stableCacheKey } from "./projection-cache";
import type { WorkstationAttachmentState } from "./runtime-state";

export type NotebookRegisteredWorkstationStatus =
  | "online"
  | "offline"
  | "connecting"
  | "attention"
  | "unknown";

export type NotebookWorkstationEnvironmentPolicy =
  | "current_python"
  | "kernelspec"
  | "managed_project"
  | "unknown";

export interface NotebookRegisteredWorkstationEnvironment {
  available?: boolean | null;
  detail?: string | null;
  health?: string | null;
  id: string;
  isDefault?: boolean | null;
  label: string;
  policy?: NotebookWorkstationEnvironmentPolicy | string | null;
}

export interface NotebookRegisteredWorkstation {
  cpuCount?: number | null;
  defaultEnvironmentLabel?: string | null;
  displayName: string;
  environmentPolicy?: NotebookWorkstationEnvironmentPolicy | string | null;
  environments?: readonly NotebookRegisteredWorkstationEnvironment[] | null;
  id: string;
  memoryBytes?: number | null;
  provider?: string | null;
  providerLabel?: string | null;
  status?: NotebookRegisteredWorkstationStatus | null;
  statusMessage?: string | null;
  updatedAt?: string | null;
  workingDirectory?: string | null;
}

export interface NotebookWorkstationEnvironmentProjection {
  available: boolean;
  detail: string | null;
  health: string | null;
  id: string;
  isDefault: boolean;
  label: string;
  policy: NotebookWorkstationEnvironmentPolicy | string;
}

export interface NotebookRegisteredWorkstationProjection {
  cpuCount: number | null;
  defaultEnvironmentLabel: string | null;
  displayName: string;
  environmentPolicy: NotebookWorkstationEnvironmentPolicy | string | null;
  environments: readonly NotebookWorkstationEnvironmentProjection[];
  id: string;
  isAttached: boolean;
  isDefault: boolean;
  isSelected: boolean;
  memoryBytes: number | null;
  provider: string | null;
  providerLabel: string | null;
  status: NotebookRegisteredWorkstationStatus;
  statusLabel: string;
  statusMessage: string | null;
  updatedAt: string | null;
  workingDirectoryLabel: string | null;
}

export type NotebookWorkstationSelectionState =
  | "attached"
  | "selected"
  | "default"
  | "needs_registration"
  | "unselected";

export interface NotebookWorkstationSelectionProjection {
  activeTarget: NotebookShellRuntimeTargetProjection | null;
  activeWorkstationId: string | null;
  canRegisterWorkstation: boolean;
  canSelectWorkstation: boolean;
  canSetDefaultWorkstation: boolean;
  defaultWorkstation: NotebookRegisteredWorkstationProjection | null;
  defaultWorkstationId: string | null;
  launchCandidate: NotebookRegisteredWorkstationProjection | null;
  registeredWorkstations: readonly NotebookRegisteredWorkstationProjection[];
  selectedWorkstation: NotebookRegisteredWorkstationProjection | null;
  selectedWorkstationId: string | null;
  state: NotebookWorkstationSelectionState;
}

export interface ProjectNotebookWorkstationSelectionOptions {
  activeAttachment?: WorkstationAttachmentState | null;
  canRegisterWorkstation?: boolean;
  canSelectWorkstation?: boolean;
  canSetDefaultWorkstation?: boolean;
  defaultWorkstationId?: string | null;
  registeredWorkstations?: readonly NotebookRegisteredWorkstation[] | null;
  selectedWorkstationId?: string | null;
}

const WORKSTATION_SELECTION_CACHE = new Map<string, NotebookWorkstationSelectionProjection>();
const WORKSTATION_ENTRY_CACHE = new Map<string, NotebookRegisteredWorkstationProjection>();
const WORKSTATION_ENVIRONMENT_CACHE = new Map<string, NotebookWorkstationEnvironmentProjection>();
const WORKSTATION_SELECTION_CACHE_LIMIT = 256;
const WORKSTATION_ENTRY_CACHE_LIMIT = 512;
const WORKSTATION_ENVIRONMENT_CACHE_LIMIT = 1024;

export function projectNotebookWorkstationSelection({
  activeAttachment = null,
  canRegisterWorkstation = false,
  canSelectWorkstation = false,
  canSetDefaultWorkstation = false,
  defaultWorkstationId = null,
  registeredWorkstations = [],
  selectedWorkstationId = null,
}: ProjectNotebookWorkstationSelectionOptions): NotebookWorkstationSelectionProjection {
  const selectedId = trimToNull(selectedWorkstationId);
  const defaultId = trimToNull(defaultWorkstationId);
  const activeTarget = projectNotebookRuntimeTargetFromWorkstationAttachment(activeAttachment);
  const activeWorkstationId = trimToNull(activeAttachment?.workstation_id);
  const normalizedEntries = normalizeRegisteredWorkstations(registeredWorkstations);
  const cacheKey = stableCacheKey([
    activeWorkstationId,
    activeTargetCacheKey(activeTarget),
    canRegisterWorkstation,
    canSelectWorkstation,
    canSetDefaultWorkstation,
    selectedId,
    defaultId,
    ...normalizedEntries.map((entry) => registeredWorkstationCacheKey(entry)),
  ]);
  const cached = getBoundedCacheValue(WORKSTATION_SELECTION_CACHE, cacheKey);
  if (cached) return cached;

  const entries = normalizedEntries.map((entry) =>
    projectRegisteredWorkstation(entry, {
      activeWorkstationId,
      defaultWorkstationId: defaultId,
      selectedWorkstationId: selectedId,
    }),
  );
  const selectedWorkstation = entries.find((entry) => entry.id === selectedId) ?? null;
  const defaultWorkstation = entries.find((entry) => entry.id === defaultId) ?? null;
  const launchCandidate = selectedWorkstation ?? defaultWorkstation;
  const state: NotebookWorkstationSelectionState = activeTarget
    ? "attached"
    : selectedWorkstation
      ? "selected"
      : defaultWorkstation
        ? "default"
        : canSelectWorkstation && canRegisterWorkstation && entries.length === 0
          ? "needs_registration"
          : "unselected";

  const projection = Object.freeze({
    activeTarget,
    activeWorkstationId,
    canRegisterWorkstation,
    canSelectWorkstation,
    canSetDefaultWorkstation,
    defaultWorkstation,
    defaultWorkstationId: defaultId,
    launchCandidate,
    registeredWorkstations: Object.freeze(entries),
    selectedWorkstation,
    selectedWorkstationId: selectedId,
    state,
  });
  setBoundedCacheValue(
    WORKSTATION_SELECTION_CACHE,
    cacheKey,
    projection,
    WORKSTATION_SELECTION_CACHE_LIMIT,
  );
  return projection;
}

export function clearNotebookWorkstationSelectionProjectionCacheForTests(): void {
  WORKSTATION_SELECTION_CACHE.clear();
  WORKSTATION_ENTRY_CACHE.clear();
  WORKSTATION_ENVIRONMENT_CACHE.clear();
}

function projectRegisteredWorkstation(
  workstation: NotebookRegisteredWorkstation,
  {
    activeWorkstationId,
    defaultWorkstationId,
    selectedWorkstationId,
  }: {
    activeWorkstationId: string | null;
    defaultWorkstationId: string | null;
    selectedWorkstationId: string | null;
  },
): NotebookRegisteredWorkstationProjection {
  const status = normalizeWorkstationStatus(workstation.status);
  const environments = normalizeWorkstationEnvironments(workstation.environments);
  const cacheKey = stableCacheKey([
    registeredWorkstationCacheKey(workstation),
    activeWorkstationId,
    defaultWorkstationId,
    selectedWorkstationId,
  ]);
  const cached = getBoundedCacheValue(WORKSTATION_ENTRY_CACHE, cacheKey);
  if (cached) return cached;

  const projection = Object.freeze({
    cpuCount: normalizePositiveInteger(workstation.cpuCount),
    defaultEnvironmentLabel: trimToNull(workstation.defaultEnvironmentLabel),
    displayName: trimToNull(workstation.displayName) ?? workstation.id,
    environmentPolicy: trimToNull(workstation.environmentPolicy),
    environments: Object.freeze(environments),
    id: workstation.id,
    isAttached: activeWorkstationId === workstation.id,
    isDefault: defaultWorkstationId === workstation.id,
    isSelected: selectedWorkstationId === workstation.id,
    memoryBytes: normalizePositiveInteger(workstation.memoryBytes),
    provider: trimToNull(workstation.provider),
    providerLabel: trimToNull(workstation.providerLabel) ?? providerLabel(workstation.provider),
    status,
    statusLabel: workstationStatusLabel(status),
    statusMessage: trimToNull(workstation.statusMessage),
    updatedAt: trimToNull(workstation.updatedAt),
    workingDirectoryLabel: trimToNull(workstation.workingDirectory),
  });
  setBoundedCacheValue(
    WORKSTATION_ENTRY_CACHE,
    cacheKey,
    projection,
    WORKSTATION_ENTRY_CACHE_LIMIT,
  );
  return projection;
}

function normalizeRegisteredWorkstations(
  workstations: readonly NotebookRegisteredWorkstation[] | null | undefined,
): NotebookRegisteredWorkstation[] {
  if (!workstations) return [];
  const seen = new Set<string>();
  const normalized: NotebookRegisteredWorkstation[] = [];
  for (const workstation of workstations) {
    const id = trimToNull(workstation.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push({ ...workstation, id });
  }
  return normalized;
}

function normalizeWorkstationEnvironments(
  environments: readonly NotebookRegisteredWorkstationEnvironment[] | null | undefined,
): readonly NotebookWorkstationEnvironmentProjection[] {
  if (!environments) return Object.freeze([]);
  const seen = new Set<string>();
  const normalized: NotebookWorkstationEnvironmentProjection[] = [];
  for (const environment of environments) {
    const id = trimToNull(environment.id);
    const label = trimToNull(environment.label);
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    normalized.push(projectWorkstationEnvironment({ ...environment, id, label }));
  }
  return normalized;
}

function projectWorkstationEnvironment(
  environment: NotebookRegisteredWorkstationEnvironment & { id: string; label: string },
): NotebookWorkstationEnvironmentProjection {
  const policy = trimToNull(environment.policy) ?? "unknown";
  const cacheKey = stableCacheKey([
    environment.id,
    environment.label,
    policy,
    environment.available ?? null,
    environment.detail ?? null,
    environment.health ?? null,
    environment.isDefault ?? null,
  ]);
  const cached = getBoundedCacheValue(WORKSTATION_ENVIRONMENT_CACHE, cacheKey);
  if (cached) return cached;

  const projection = Object.freeze({
    available: environment.available ?? true,
    detail: trimToNull(environment.detail),
    health: trimToNull(environment.health),
    id: environment.id,
    isDefault: environment.isDefault ?? false,
    label: environment.label,
    policy,
  });
  setBoundedCacheValue(
    WORKSTATION_ENVIRONMENT_CACHE,
    cacheKey,
    projection,
    WORKSTATION_ENVIRONMENT_CACHE_LIMIT,
  );
  return projection;
}

function registeredWorkstationCacheKey(workstation: NotebookRegisteredWorkstation): string {
  return stableCacheKey([
    workstation.id,
    workstation.displayName,
    workstation.provider ?? null,
    workstation.providerLabel ?? null,
    workstation.defaultEnvironmentLabel ?? null,
    workstation.environmentPolicy ?? null,
    workstation.status ?? null,
    workstation.statusMessage ?? null,
    workstation.cpuCount ?? null,
    workstation.memoryBytes ?? null,
    workstation.workingDirectory ?? null,
    workstation.updatedAt ?? null,
    ...(workstation.environments ?? []).map((environment) =>
      stableCacheKey([
        environment.id,
        environment.label,
        environment.policy ?? null,
        environment.available ?? null,
        environment.detail ?? null,
        environment.health ?? null,
        environment.isDefault ?? null,
      ]),
    ),
  ]);
}

function activeTargetCacheKey(target: NotebookShellRuntimeTargetProjection | null): string {
  if (!target) return "null";
  return stableCacheKey([
    target.id ?? null,
    target.kind,
    target.status,
    target.label,
    target.statusLabel ?? null,
    target.detail ?? null,
    target.providerLabel ?? null,
    target.defaultEnvironmentLabel ?? null,
    target.environmentLabel ?? null,
    target.kernelStatusLabel ?? null,
    target.cpuCount ?? null,
    target.memoryBytes ?? null,
    target.resourceLabel ?? null,
    target.runtimePeerCount ?? null,
    target.workingDirectoryLabel ?? null,
  ]);
}

function normalizeWorkstationStatus(
  status: NotebookRegisteredWorkstationStatus | null | undefined,
): NotebookRegisteredWorkstationStatus {
  switch (status) {
    case "online":
    case "offline":
    case "connecting":
    case "attention":
      return status;
    default:
      return "unknown";
  }
}

function workstationStatusLabel(status: NotebookRegisteredWorkstationStatus): string {
  switch (status) {
    case "online":
      return "Online";
    case "offline":
      return "Offline";
    case "connecting":
      return "Connecting";
    case "attention":
      return "Needs attention";
    default:
      return "Unknown";
  }
}

function providerLabel(provider: string | null | undefined): string | null {
  const normalized = trimToNull(provider);
  if (!normalized) return null;
  if (normalized === "local_daemon") return "Local daemon";
  if (normalized === "runtime_peer") return "Runtime peer";
  return normalized
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizePositiveInteger(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}
