import {
  notebookShellWorkstationAcceleratorsCacheKey,
  projectNotebookRuntimeTargetFromWorkstationAttachment,
  type NotebookShellRuntimeTargetProjection,
} from "./notebook-shell-capabilities";
import { getBoundedCacheValue, setBoundedCacheValue, stableCacheKey } from "./projection-cache";
import type { WorkstationAcceleratorState, WorkstationAttachmentState } from "./runtime-state";

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
  /** Missing/null is unknown (older agent); [] means detection found none. */
  accelerators?: readonly WorkstationAcceleratorState[] | null;
  cpuCount?: number | null;
  defaultEnvironmentLabel?: string | null;
  displayName: string;
  environmentPolicy?: NotebookWorkstationEnvironmentPolicy | string | null;
  environments?: readonly NotebookRegisteredWorkstationEnvironment[] | null;
  id: string;
  installedBuild?: string | null;
  channel?: string | null;
  latestBuild?: string | null;
  isOutdated?: boolean | null;
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

export type NotebookRegisteredWorkstationFactKind =
  | "default_environment"
  | "cpu"
  | "memory"
  | "accelerator"
  | "working_directory";

export type NotebookRegisteredWorkstationFactTone = "neutral" | "positive" | "attention";

export interface NotebookRegisteredWorkstationFactProjection {
  detail: string | null;
  kind: NotebookRegisteredWorkstationFactKind;
  label: string;
  tone: NotebookRegisteredWorkstationFactTone;
  value: string;
}

export interface NotebookWorkstationAcceleratorSummary {
  detail: string | null;
  label: string;
  tone: NotebookRegisteredWorkstationFactTone;
  value: string;
}

export interface NotebookRegisteredWorkstationProjection {
  accelerators: readonly WorkstationAcceleratorState[] | null;
  canAttach: boolean;
  cpuCount: number | null;
  defaultEnvironmentLabel: string | null;
  displayName: string;
  environmentPolicy: NotebookWorkstationEnvironmentPolicy | string | null;
  environments: readonly NotebookWorkstationEnvironmentProjection[];
  facts: readonly NotebookRegisteredWorkstationFactProjection[];
  id: string;
  idLabel: string;
  installedBuild: string | null;
  channel: string | null;
  latestBuild: string | null;
  isOutdated: boolean;
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
const WORKSTATION_ACCELERATOR_LIST_CACHE = new Map<
  string,
  readonly WorkstationAcceleratorState[]
>();
const WORKSTATION_SELECTION_CACHE_LIMIT = 256;
const WORKSTATION_ENTRY_CACHE_LIMIT = 512;
const WORKSTATION_ENVIRONMENT_CACHE_LIMIT = 1024;
const WORKSTATION_ACCELERATOR_LIST_CACHE_LIMIT = 512;
const EMPTY_ACCELERATORS = Object.freeze([]) as readonly WorkstationAcceleratorState[];

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
  const activeWorkstationId = trimToNull(activeAttachment?.workstation_id);
  const normalizedEntries = normalizeRegisteredWorkstations(registeredWorkstations);
  const activeTarget = projectAttachmentTargetWithRegisteredWorkstationStatus({
    activeAttachment,
    activeWorkstationId,
    registeredWorkstations: normalizedEntries,
  });
  const attachedWorkstationId = activeTargetCountsAsAttached(activeTarget)
    ? activeWorkstationId
    : null;
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
      activeWorkstationId: attachedWorkstationId,
      defaultWorkstationId: defaultId,
      selectedWorkstationId: selectedId,
    }),
  );
  const selectedWorkstation = entries.find((entry) => entry.id === selectedId) ?? null;
  const defaultWorkstation = entries.find((entry) => entry.id === defaultId) ?? null;
  const launchCandidate = selectedWorkstation ?? defaultWorkstation;
  const state: NotebookWorkstationSelectionState = attachedWorkstationId
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
  WORKSTATION_ACCELERATOR_LIST_CACHE.clear();
}

function activeTargetCountsAsAttached(
  target: NotebookShellRuntimeTargetProjection | null,
): boolean {
  if (!target) return false;
  return (
    target.status === "ready" || target.status === "attached" || target.status === "connecting"
  );
}

function projectAttachmentTargetWithRegisteredWorkstationStatus({
  activeAttachment,
  activeWorkstationId,
  registeredWorkstations,
}: {
  activeAttachment: WorkstationAttachmentState | null;
  activeWorkstationId: string | null;
  registeredWorkstations: readonly NotebookRegisteredWorkstation[];
}): NotebookShellRuntimeTargetProjection | null {
  const target = projectNotebookRuntimeTargetFromWorkstationAttachment(activeAttachment);
  if (!target || !activeWorkstationId) return target;
  const registeredWorkstation =
    registeredWorkstations.find((workstation) => workstation.id === activeWorkstationId) ?? null;
  const registeredStatus = normalizeWorkstationStatus(registeredWorkstation?.status);
  if (registeredStatus !== "offline" && registeredStatus !== "attention") {
    return target;
  }

  return Object.freeze({
    ...target,
    status: registeredStatus,
    statusLabel: workstationStatusLabel(registeredStatus),
    detail:
      trimToNull(registeredWorkstation?.statusMessage) ??
      `The compute session from ${target.label} is stale because the workstation is ${registeredStatus}.`,
  });
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
  const accelerators = normalizeWorkstationAccelerators(workstation.accelerators);
  const environments = normalizeWorkstationEnvironments(workstation.environments);
  const cpuCount = normalizePositiveInteger(workstation.cpuCount);
  const defaultEnvironmentLabel = trimToNull(workstation.defaultEnvironmentLabel);
  const installedBuild = trimToNull(workstation.installedBuild);
  const channel = trimToNull(workstation.channel);
  const latestBuild = trimToNull(workstation.latestBuild);
  const isOutdated =
    Boolean(workstation.isOutdated) && Boolean(installedBuild) && Boolean(latestBuild);
  const memoryBytes = normalizePositiveInteger(workstation.memoryBytes);
  const workingDirectoryLabel = trimToNull(workstation.workingDirectory);
  const facts = projectRegisteredWorkstationFacts({
    accelerators,
    cpuCount,
    defaultEnvironmentLabel,
    environments,
    memoryBytes,
    status,
    workingDirectoryLabel,
  });
  const cacheKey = stableCacheKey([
    registeredWorkstationCacheKey(workstation),
    activeWorkstationId,
    defaultWorkstationId,
    selectedWorkstationId,
  ]);
  const cached = getBoundedCacheValue(WORKSTATION_ENTRY_CACHE, cacheKey);
  if (cached) return cached;

  const projection = Object.freeze({
    accelerators,
    canAttach:
      status === "online" &&
      Boolean(workingDirectoryLabel) &&
      (Boolean(defaultEnvironmentLabel) ||
        environments.some((environment) => environment.available)),
    cpuCount,
    defaultEnvironmentLabel,
    displayName: trimToNull(workstation.displayName) ?? workstation.id,
    environmentPolicy: trimToNull(workstation.environmentPolicy),
    environments: Object.freeze(environments),
    facts: Object.freeze(facts),
    id: workstation.id,
    idLabel: `id ${workstation.id}`,
    installedBuild,
    channel,
    latestBuild,
    isOutdated,
    isAttached: activeWorkstationId === workstation.id,
    isDefault: defaultWorkstationId === workstation.id,
    isSelected: selectedWorkstationId === workstation.id,
    memoryBytes,
    provider: trimToNull(workstation.provider),
    providerLabel: trimToNull(workstation.providerLabel) ?? providerLabel(workstation.provider),
    status,
    statusLabel: workstationStatusLabel(status),
    statusMessage: trimToNull(workstation.statusMessage),
    updatedAt: trimToNull(workstation.updatedAt),
    workingDirectoryLabel,
  });
  setBoundedCacheValue(
    WORKSTATION_ENTRY_CACHE,
    cacheKey,
    projection,
    WORKSTATION_ENTRY_CACHE_LIMIT,
  );
  return projection;
}

function projectRegisteredWorkstationFacts({
  accelerators,
  cpuCount,
  defaultEnvironmentLabel,
  environments,
  memoryBytes,
  status,
  workingDirectoryLabel,
}: {
  accelerators: readonly WorkstationAcceleratorState[] | null;
  cpuCount: number | null;
  defaultEnvironmentLabel: string | null;
  environments: readonly NotebookWorkstationEnvironmentProjection[];
  memoryBytes: number | null;
  status: NotebookRegisteredWorkstationStatus;
  workingDirectoryLabel: string | null;
}): readonly NotebookRegisteredWorkstationFactProjection[] {
  const facts: NotebookRegisteredWorkstationFactProjection[] = [];
  const environmentLabel =
    defaultEnvironmentLabel ??
    environments.find((environment) => environment.isDefault)?.label ??
    environments.find((environment) => environment.available)?.label ??
    null;
  if (environmentLabel) {
    facts.push(registeredWorkstationFact("default_environment", "Env", environmentLabel));
  }
  if (cpuCount) {
    facts.push(registeredWorkstationFact("cpu", "CPUs", `${cpuCount}`));
  }
  const memoryLabel = formatMemoryBytes(memoryBytes);
  if (memoryLabel) {
    facts.push(registeredWorkstationFact("memory", "RAM", memoryLabel));
  }
  const acceleratorSummary = projectNotebookWorkstationAcceleratorSummary(
    accelerators,
    status === "offline",
  );
  if (acceleratorSummary) {
    facts.push(
      registeredWorkstationFact(
        "accelerator",
        acceleratorSummary.label,
        acceleratorSummary.value,
        acceleratorSummary.tone,
        acceleratorSummary.detail,
      ),
    );
  }
  if (workingDirectoryLabel) {
    facts.push(registeredWorkstationFact("working_directory", "CWD", workingDirectoryLabel));
  }
  return Object.freeze(facts);
}

function registeredWorkstationFact(
  kind: NotebookRegisteredWorkstationFactKind,
  label: string,
  value: string,
  tone: NotebookRegisteredWorkstationFactTone = "neutral",
  detail: string | null = null,
): NotebookRegisteredWorkstationFactProjection {
  return Object.freeze({ detail, kind, label, tone, value });
}

export function projectNotebookWorkstationAcceleratorSummary(
  accelerators: readonly WorkstationAcceleratorState[] | null | undefined,
  hardwareOffline: boolean,
): NotebookWorkstationAcceleratorSummary | null {
  if (!accelerators || accelerators.length === 0) return null;

  const kinds = new Set(accelerators.map((accelerator) => acceleratorKindLabel(accelerator.kind)));
  const singleKind = kinds.size === 1 ? [...kinds][0]! : null;
  const useGenericLabel = !singleKind || singleKind.length > 6;
  const label = useGenericLabel ? "Accel" : singleKind;
  const includeKindInValue = useGenericLabel;
  const value = accelerators
    .map((accelerator) => acceleratorValue(accelerator, includeKindInValue))
    .join("; ");
  const attentionAccelerators = accelerators.filter(
    (accelerator) => accelerator.readiness !== "ready",
  );
  const detail = acceleratorDiagnostic(attentionAccelerators);
  const tone: NotebookRegisteredWorkstationFactTone = hardwareOffline
    ? "neutral"
    : attentionAccelerators.length > 0
      ? "attention"
      : "positive";
  return Object.freeze({ detail, label, tone, value });
}

function acceleratorValue(accelerator: WorkstationAcceleratorState, includeKind: boolean): string {
  const kindLabel = acceleratorKindLabel(accelerator.kind);
  const vendor = trimToNull(accelerator.vendor);
  const model = trimToNull(accelerator.model);
  const normalizedVendor = vendor?.toLowerCase();
  const normalizedModel = model?.toLowerCase();
  const modelIncludesVendor = Boolean(
    normalizedVendor &&
    normalizedModel &&
    (normalizedModel === normalizedVendor ||
      normalizedModel.startsWith(`${normalizedVendor} `) ||
      normalizedModel.startsWith(`${normalizedVendor}-`)),
  );
  const deviceLabel = model
    ? vendor && !modelIncludesVendor
      ? `${vendor} ${model}`
      : model
    : vendor;
  const namedDevice = deviceLabel || kindLabel;
  const memoryLabel = formatMemoryBytes(accelerator.memory_bytes_per_device);
  const memorySuffix = memoryLabel
    ? ` · ${memoryLabel}${accelerator.count > 1 ? " each" : ""}`
    : "";
  const kindPrefix = includeKind ? `${kindLabel} ` : "";
  return `${kindPrefix}${accelerator.count}× ${namedDevice}${memorySuffix}`;
}

function acceleratorDiagnostic(
  accelerators: readonly WorkstationAcceleratorState[],
): string | null {
  if (accelerators.length === 0) return null;
  return accelerators
    .map((accelerator) => {
      const diagnostic = trimToNull(accelerator.diagnostic);
      if (diagnostic) return diagnostic;
      const kindLabel = acceleratorKindLabel(accelerator.kind);
      return accelerator.readiness === "not_ready"
        ? `${kindLabel} detected, but this workstation runtime cannot use it.`
        : `${kindLabel} detected, but runtime usability has not been verified.`;
    })
    .join(" ");
}

function acceleratorKindLabel(kind: string): string {
  const normalized = trimToNull(kind)?.toUpperCase();
  return normalized ?? "Accelerator";
}

function normalizeWorkstationAccelerators(
  accelerators: readonly WorkstationAcceleratorState[] | null | undefined,
): readonly WorkstationAcceleratorState[] | null {
  if (accelerators === null || accelerators === undefined) return null;
  if (accelerators.length === 0) return EMPTY_ACCELERATORS;
  const cacheKey = notebookShellWorkstationAcceleratorsCacheKey(accelerators);
  const cached = getBoundedCacheValue(WORKSTATION_ACCELERATOR_LIST_CACHE, cacheKey);
  if (cached) return cached;
  const normalized = Object.freeze(
    accelerators.map((accelerator) =>
      Object.freeze({
        kind: trimToNull(accelerator.kind) ?? "accelerator",
        vendor: trimToNull(accelerator.vendor),
        model: trimToNull(accelerator.model),
        count: normalizePositiveInteger(accelerator.count) ?? 1,
        memory_bytes_per_device: normalizePositiveInteger(accelerator.memory_bytes_per_device),
        readiness:
          accelerator.readiness === "ready" || accelerator.readiness === "not_ready"
            ? accelerator.readiness
            : "unknown",
        diagnostic: trimToNull(accelerator.diagnostic),
      }),
    ),
  );
  setBoundedCacheValue(
    WORKSTATION_ACCELERATOR_LIST_CACHE,
    cacheKey,
    normalized,
    WORKSTATION_ACCELERATOR_LIST_CACHE_LIMIT,
  );
  return normalized;
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
    workstation.installedBuild ?? null,
    workstation.channel ?? null,
    workstation.latestBuild ?? null,
    workstation.isOutdated === true,
    workstation.status ?? null,
    workstation.statusMessage ?? null,
    workstation.cpuCount ?? null,
    workstation.memoryBytes ?? null,
    notebookShellWorkstationAcceleratorsCacheKey(workstation.accelerators),
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
    target.attachmentIdle ?? false,
    target.label,
    target.statusLabel ?? null,
    target.detail ?? null,
    target.providerLabel ?? null,
    target.defaultEnvironmentLabel ?? null,
    target.environmentLabel ?? null,
    target.kernelStatusLabel ?? null,
    target.cpuCount ?? null,
    target.memoryBytes ?? null,
    notebookShellWorkstationAcceleratorsCacheKey(target.accelerators),
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
  if (normalized === "runtime_peer") return "Workstation";
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

function formatMemoryBytes(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const gib = value / 1024 ** 3;
  if (gib >= 1) {
    return `${formatNumber(gib)} GiB`;
  }
  const mib = value / 1024 ** 2;
  if (mib >= 1) {
    return `${formatNumber(mib)} MiB`;
  }
  return `${Math.round(value / 1024)} KiB`;
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return `${value}`;
  }
  return value >= 10 ? value.toFixed(1) : value.toFixed(2);
}
