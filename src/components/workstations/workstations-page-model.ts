import type {
  NotebookRegisteredWorkstationProjection,
  NotebookRegisteredWorkstationStatus,
} from "runtimed";
import type { RuntimeStatus } from "@/components/runtime/RuntimeStatusDot";

/**
 * View model for the workstations management page: what machines do I have,
 * and what's running on them. The in-notebook workstations panel answers the
 * complementary question (what compute is attached to this notebook), so the
 * two surfaces intentionally share the registry projection but not layout.
 */

/** Spine rendering collapses unknown into offline; attention keeps its own ink. */
export type WorkstationSpineStatus = "online" | "connecting" | "offline" | "attention";

export interface WorkstationHostedKernelView {
  id: string;
  notebookLabel: string;
  languageLabel: string;
  status: RuntimeStatus;
}

export interface WorkstationIdlePolicyView {
  enabled: boolean;
  minutes: number;
  minuteOptions: readonly number[];
}

export interface WorkstationSpecCellView {
  key: string;
  label: string;
  value: string;
  /** uv magenta is env-label ink only, never a page accent. */
  uvInk: boolean;
}

/**
 * Facts the workstation registry model does not carry yet. Hosts that have
 * them (today only design fixtures; later real host APIs) supply them per
 * workstation id. Sections for absent facts do not render.
 */
export interface WorkstationsPageHostFacts {
  kindLabel?: string | null;
  osLabel?: string | null;
  gpuLabel?: string | null;
  envManagerLabel?: string | null;
  kernels?: readonly WorkstationHostedKernelView[] | null;
  idlePolicy?: WorkstationIdlePolicyView | null;
}

export interface WorkstationsPageItemView {
  id: string;
  name: string;
  sourceLabel: string | null;
  status: NotebookRegisteredWorkstationStatus;
  spineStatus: WorkstationSpineStatus;
  statusLabel: string;
  statusMessage: string | null;
  rowSublineLabel: string;
  /** "kind · OS/arch" context ahead of the status label, when hosts know it. */
  detailContextLabel: string | null;
  kernelCountLabel: string | null;
  detailKernelCountLabel: string | null;
  hasLiveKernels: boolean;
  lastSeenLabel: string | null;
  specs: readonly WorkstationSpecCellView[];
  /** null means this host has no kernel inventory; the section does not render. */
  kernels: readonly WorkstationHostedKernelView[] | null;
  kernelsEmptyLabel: string;
  idlePolicy: WorkstationIdlePolicyView | null;
  canReconnect: boolean;
  canRestart: boolean;
  canDisconnect: boolean;
}

export interface WorkstationsPageView {
  items: readonly WorkstationsPageItemView[];
  summaryLabel: string;
}

export interface ProjectWorkstationsPageOptions {
  hostFacts?: ReadonlyMap<string, WorkstationsPageHostFacts>;
  nowMs?: number;
}

export function projectWorkstationsPage(
  workstations: readonly NotebookRegisteredWorkstationProjection[],
  { hostFacts, nowMs = Date.now() }: ProjectWorkstationsPageOptions = {},
): WorkstationsPageView {
  const items = workstations.map((workstation) =>
    projectWorkstationsPageItem(workstation, hostFacts?.get(workstation.id) ?? null, nowMs),
  );
  const onlineCount = items.filter((item) => item.spineStatus === "online").length;
  const summaryLabel = `${items.length} ${items.length === 1 ? "workstation" : "workstations"} · ${onlineCount} online`;
  return { items, summaryLabel };
}

function projectWorkstationsPageItem(
  workstation: NotebookRegisteredWorkstationProjection,
  facts: WorkstationsPageHostFacts | null,
  nowMs: number,
): WorkstationsPageItemView {
  const spineStatus = workstationSpineStatus(workstation.status);
  const statusLabel = workstationSpineStatusLabel(spineStatus);
  const kernels = facts?.kernels ?? null;
  const detailContextLabel =
    joinFactLabels([facts?.kindLabel ?? null, facts?.osLabel ?? null]) ?? null;
  const rowSublineLabel =
    joinFactLabels([
      facts?.kindLabel ?? null,
      spineStatus === "attention" ? (workstation.statusMessage ?? statusLabel) : statusLabel,
    ]) ?? statusLabel;

  return {
    id: workstation.id,
    name: workstation.displayName,
    sourceLabel: workstation.providerLabel,
    status: workstation.status,
    spineStatus,
    statusLabel,
    statusMessage: workstation.statusMessage,
    rowSublineLabel,
    detailContextLabel,
    kernelCountLabel: kernels ? workstationKernelCountLabel(kernels.length) : null,
    detailKernelCountLabel: kernels ? workstationSessionCountLabel(kernels.length) : null,
    hasLiveKernels: Boolean(
      kernels?.some((kernel) => kernel.status === "executing" || kernel.status === "ready"),
    ),
    lastSeenLabel: workstationLastSeenLabel(spineStatus, workstation.updatedAt, nowMs),
    specs: projectWorkstationSpecCells(workstation, facts),
    kernels,
    kernelsEmptyLabel: workstationKernelsEmptyLabel(spineStatus),
    idlePolicy: facts?.idlePolicy ?? null,
    canReconnect: spineStatus === "offline" || spineStatus === "attention",
    canRestart: spineStatus === "online",
    canDisconnect: spineStatus === "online",
  };
}

function projectWorkstationSpecCells(
  workstation: NotebookRegisteredWorkstationProjection,
  facts: WorkstationsPageHostFacts | null,
): readonly WorkstationSpecCellView[] {
  const cells: WorkstationSpecCellView[] = [];
  if (workstation.cpuCount) {
    cells.push(specCell("cpu", "vCPU", `${workstation.cpuCount}`));
  }
  const memoryValue = workstation.facts.find((fact) => fact.kind === "memory")?.value ?? null;
  if (memoryValue) {
    cells.push(specCell("memory", "Memory", memoryValue));
  }
  const gpuLabel = trimToNull(facts?.gpuLabel);
  if (gpuLabel) {
    cells.push(specCell("gpu", "GPU", gpuLabel));
  }
  const envManagerLabel = trimToNull(facts?.envManagerLabel);
  if (envManagerLabel) {
    cells.push(specCell("env-manager", "Env manager", envManagerLabel));
  } else if (workstation.defaultEnvironmentLabel) {
    cells.push(specCell("environment", "Environment", workstation.defaultEnvironmentLabel));
  }
  if (workstation.workingDirectoryLabel) {
    cells.push(
      specCell("working-directory", "Working directory", workstation.workingDirectoryLabel),
    );
  }
  return cells;
}

function specCell(key: string, label: string, value: string): WorkstationSpecCellView {
  return { key, label, value, uvInk: value.trim().toLowerCase() === "uv" };
}

export function workstationSpineStatus(
  status: NotebookRegisteredWorkstationStatus,
): WorkstationSpineStatus {
  switch (status) {
    case "online":
    case "connecting":
    case "attention":
      return status;
    default:
      return "offline";
  }
}

function workstationSpineStatusLabel(status: WorkstationSpineStatus): string {
  switch (status) {
    case "online":
      return "Online";
    case "connecting":
      return "Connecting…";
    case "attention":
      return "Needs attention";
    default:
      return "Offline";
  }
}

function workstationKernelCountLabel(count: number): string {
  if (count === 0) return "No compute";
  return count === 1 ? "1 kernel" : `${count} kernels`;
}

function workstationSessionCountLabel(count: number): string {
  if (count === 0) return "No compute sessions";
  return count === 1 ? "1 session" : `${count} sessions`;
}

function workstationKernelsEmptyLabel(status: WorkstationSpineStatus): string {
  if (status === "offline" || status === "attention") {
    return "This workstation is offline — no kernels hosted.";
  }
  if (status === "connecting") {
    return "Connecting to this workstation…";
  }
  return "No kernels running yet.";
}

function workstationLastSeenLabel(
  status: WorkstationSpineStatus,
  updatedAt: string | null,
  nowMs: number,
): string | null {
  if (status === "online") return "active now";
  if (status === "connecting") return "connecting…";
  if (!updatedAt) return null;
  const seenMs = Date.parse(updatedAt);
  if (!Number.isFinite(seenMs)) return null;
  const elapsedMs = nowMs - seenMs;
  if (elapsedMs < 60_000) return "just now";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return days === 1 ? "1 day ago" : `${days} days ago`;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(seenMs));
}

function joinFactLabels(parts: readonly (string | null)[]): string | null {
  const filtered = parts
    .map((part) => trimToNull(part))
    .filter((part): part is string => Boolean(part));
  return filtered.length > 0 ? filtered.join(" · ") : null;
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
