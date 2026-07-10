import {
  notebookShellWorkstationAcceleratorsCacheKey,
  notebookShellRuntimeTargetSummary,
  resolveNotebookShellRuntimeTarget,
  type NotebookShellAccessSource,
  type NotebookShellCapabilities,
  type NotebookShellRuntimeTargetKind,
} from "./notebook-shell-capabilities";
import { projectNotebookWorkstationAcceleratorSummary } from "./notebook-workstation-selection";
import { getBoundedCacheValue, setBoundedCacheValue, stableCacheKey } from "./projection-cache";

export type NotebookWorkstationPanelTone = "ready" | "available" | "offline";
export type NotebookWorkstationFactTone = "neutral" | "positive" | "attention";

export type NotebookWorkstationFactKind =
  | "provider"
  | "default_environment"
  | "kernel"
  | "cpu"
  | "memory"
  | "accelerator"
  | "resource"
  | "room_link"
  | "runtime_peers"
  | "working_directory"
  | "execution_state"
  | "remote_hint";

export interface NotebookWorkstationFactProjection {
  detail: string | null;
  kind: NotebookWorkstationFactKind;
  label: string;
  subtle: boolean;
  tone: NotebookWorkstationFactTone;
  value: string;
}

export interface NotebookWorkstationPanelProjection {
  defaultEnvironmentLabel: string;
  detail: string | null;
  facts: readonly NotebookWorkstationFactProjection[];
  providerLabel: string;
  source: NotebookShellAccessSource;
  statusLabel: string;
  summary: string;
  targetId: string | null;
  targetKind: NotebookShellRuntimeTargetKind;
  title: string;
  tone: NotebookWorkstationPanelTone;
}

const WORKSTATION_PANEL_CACHE = new Map<string, NotebookWorkstationPanelProjection>();
const WORKSTATION_PANEL_CACHE_LIMIT = 512;

export function projectNotebookWorkstationPanel(
  capabilities: NotebookShellCapabilities,
): NotebookWorkstationPanelProjection {
  const target = resolveNotebookShellRuntimeTarget(capabilities.runtime);
  const cacheKey = stableCacheKey([
    capabilities.access.level,
    capabilities.access.source,
    capabilities.auth.canUseAuthenticatedIdentity,
    capabilities.canExecute,
    capabilities.runtime.canWriteRuntimeState,
    capabilities.runtime.connected,
    capabilities.runtime.executionAvailable,
    capabilities.runtime.source,
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
    notebookShellWorkstationAcceleratorsCacheKey(target.accelerators),
    target.resourceLabel ?? null,
    target.runtimePeerCount ?? null,
    target.roomLink?.status ?? null,
    target.roomLink?.statusLabel ?? null,
    target.roomLink?.lastSeenAt ?? null,
    target.workingDirectoryLabel ?? null,
    target.runtimeSessionId ?? null,
  ]);
  const cached = getBoundedCacheValue(WORKSTATION_PANEL_CACHE, cacheKey);
  if (cached) return cached;

  const status = workstationStatus(capabilities, target);
  const providerLabel = target.providerLabel ?? workstationSourceLabel(capabilities.runtime.source);
  const defaultEnvironmentLabel =
    target.defaultEnvironmentLabel ??
    target.environmentLabel ??
    runtimeResourceLabel(capabilities, target.kind);
  const execution = runtimeCapability(capabilities);
  const hasCpuCount = typeof target.cpuCount === "number" && target.cpuCount > 0;
  const memoryLabel = formatMemoryBytes(target.memoryBytes);
  const facts: NotebookWorkstationFactProjection[] = [
    workstationFact("provider", "Provider", providerLabel),
    workstationFact("default_environment", "Default env", defaultEnvironmentLabel),
  ];

  if (target.kernelStatusLabel) {
    facts.push(workstationFact("kernel", "Kernel", target.kernelStatusLabel));
  }
  if (hasCpuCount) {
    facts.push(workstationFact("cpu", "CPUs", `${target.cpuCount}`));
  }
  if (memoryLabel) {
    facts.push(workstationFact("memory", "RAM", memoryLabel));
  }
  const acceleratorSummary = projectNotebookWorkstationAcceleratorSummary(
    target.accelerators,
    target.status === "offline",
  );
  if (acceleratorSummary) {
    facts.push(
      workstationFact(
        "accelerator",
        acceleratorSummary.label,
        acceleratorSummary.value,
        false,
        acceleratorSummary.tone,
        acceleratorSummary.detail,
      ),
    );
  }
  if (!hasCpuCount && !memoryLabel && target.resourceLabel) {
    facts.push(workstationFact("resource", "Resources", target.resourceLabel));
  }
  if (target.roomLink) {
    facts.push(roomLinkFact(target.roomLink));
  }
  if (typeof target.runtimePeerCount === "number" && target.runtimePeerCount > 0) {
    facts.push(workstationFact("runtime_peers", "Compute sessions", `${target.runtimePeerCount}`));
  }
  if (target.workingDirectoryLabel) {
    facts.push(workstationFact("working_directory", "Working dir", target.workingDirectoryLabel));
  }
  facts.push(workstationFact("execution_state", "State", execution.label, false, execution.tone));
  if (target.kind === "local_daemon") {
    facts.push(workstationFact("remote_hint", "Remote", "Coming soon", true));
  }

  const projection = Object.freeze({
    defaultEnvironmentLabel,
    detail: status.detail,
    facts: Object.freeze(facts),
    providerLabel,
    source: capabilities.runtime.source,
    statusLabel: status.statusLabel,
    summary: notebookShellRuntimeTargetSummary(capabilities),
    targetId: target.id ?? null,
    targetKind: target.kind,
    title: status.title,
    tone: status.tone,
  });
  setBoundedCacheValue(
    WORKSTATION_PANEL_CACHE,
    cacheKey,
    projection,
    WORKSTATION_PANEL_CACHE_LIMIT,
  );
  return projection;
}

export function clearNotebookWorkstationPanelProjectionCacheForTests(): void {
  WORKSTATION_PANEL_CACHE.clear();
}

function workstationStatus(
  capabilities: NotebookShellCapabilities,
  target: ReturnType<typeof resolveNotebookShellRuntimeTarget>,
): {
  title: string;
  detail: string | null;
  statusLabel: string;
  tone: NotebookWorkstationPanelTone;
} {
  if (capabilities.runtime.executionAvailable && capabilities.canExecute) {
    return {
      title: target.label,
      detail: null,
      statusLabel: target.statusLabel ?? "Ready",
      tone: "ready",
    };
  }
  if (capabilities.runtime.executionAvailable) {
    return {
      title: target.label,
      detail: null,
      statusLabel: target.statusLabel ?? "Limited",
      tone: "available",
    };
  }
  if (capabilities.runtime.connected) {
    return {
      title: target.label,
      detail: null,
      statusLabel: target.statusLabel ?? "Attached",
      tone: "available",
    };
  }

  const isPreviousCloudAttachment = previousCloudAttachmentTarget(target);
  const detail =
    target.detail ??
    (capabilities.runtime.source === "local"
      ? "The local daemon is not exposing an executable runtime."
      : "No compute session is connected to this notebook.");
  const previousAttachmentDetail = isPreviousCloudAttachment
    ? previousCloudAttachmentDetail({
        canManageCompute:
          capabilities.access.source === "cloud" &&
          capabilities.access.level === "owner" &&
          capabilities.auth.canUseAuthenticatedIdentity,
        detail,
        targetLabel: target.label,
      })
    : detail;

  return {
    title: isPreviousCloudAttachment
      ? "Previous compute session"
      : capabilities.runtime.source === "local"
        ? `${target.label} unavailable`
        : target.label,
    detail: previousAttachmentDetail,
    statusLabel: target.statusLabel ?? "Offline",
    tone: "offline",
  };
}

function previousCloudAttachmentTarget(
  target: ReturnType<typeof resolveNotebookShellRuntimeTarget>,
): boolean {
  return (
    target.kind === "cloud_workstation" &&
    target.id !== null &&
    target.id !== undefined &&
    target.id !== "workstation:none" &&
    (target.status === "attention" || target.status === "offline")
  );
}

function previousCloudAttachmentDetail({
  canManageCompute,
  detail,
  targetLabel,
}: {
  canManageCompute: boolean;
  detail: string;
  targetLabel: string;
}): string {
  if (!isRuntimePeerDisconnectDetail(detail)) {
    return `${targetLabel}: ${detail}`;
  }

  const action = canManageCompute
    ? "Start compute again from an available workstation."
    : "The owner can start compute again from an available workstation.";
  return `Compute from ${targetLabel} is no longer connected to this notebook. ${action}`;
}

function isRuntimePeerDisconnectDetail(detail: string): boolean {
  const normalized = detail.trim().toLowerCase();
  return (
    normalized.startsWith("runtime peer disconnected") ||
    normalized.startsWith("compute disconnected") ||
    normalized.includes("runtime peer left the room") ||
    normalized.startsWith("room link lost")
  );
}

function roomLinkFact(
  roomLink: NonNullable<ReturnType<typeof resolveNotebookShellRuntimeTarget>["roomLink"]>,
): NotebookWorkstationFactProjection {
  const suffix = roomLink.lastSeenAt ? ` - last seen ${roomLink.lastSeenAt}` : "";
  return workstationFact(
    "room_link",
    "Room link",
    `${roomLink.statusLabel}${suffix}`,
    false,
    roomLink.status === "connected" ? "positive" : "attention",
  );
}

function runtimeResourceLabel(
  capabilities: NotebookShellCapabilities,
  targetKind: NotebookShellRuntimeTargetKind,
): string {
  if (targetKind === "local_daemon") {
    return capabilities.runtime.executionAvailable ? "Notebook runtime" : "Unavailable";
  }
  if (targetKind === "runtime_peer") {
    return "Runtime peer";
  }
  if (capabilities.runtime.executionAvailable) {
    return "Current Python";
  }
  return "Not running";
}

function runtimeCapability(capabilities: NotebookShellCapabilities): {
  label: string;
  tone: NotebookWorkstationFactTone;
} {
  if (capabilities.runtime.executionAvailable && capabilities.canExecute) {
    return { label: "Can run", tone: "positive" };
  }
  if (capabilities.runtime.executionAvailable) {
    return { label: "View only", tone: "attention" };
  }
  if (capabilities.runtime.canWriteRuntimeState) {
    return { label: "Runtime state", tone: "positive" };
  }
  return { label: "Not runnable", tone: "attention" };
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

function workstationSourceLabel(source: NotebookShellAccessSource): string {
  switch (source) {
    case "local":
      return "Local";
    case "cloud":
      return "Cloud";
    case "fixture":
      return "Fixture";
    default:
      return "Unknown";
  }
}

function workstationFact(
  kind: NotebookWorkstationFactKind,
  label: string,
  value: string,
  subtle = false,
  tone: NotebookWorkstationFactTone = "neutral",
  detail: string | null = null,
): NotebookWorkstationFactProjection {
  return Object.freeze({ detail, kind, label, subtle, tone, value });
}
