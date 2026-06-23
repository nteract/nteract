import type { WorkstationAttachmentState } from "./runtime-state";
import { getBoundedCacheValue, setBoundedCacheValue, stableCacheKey } from "./projection-cache";

export type NotebookComputeSessionStatus = "starting" | "active" | "stale" | "error";

export interface NotebookComputeSessionSummary {
  environment_label: string | null;
  last_runtime_seen_at: string | null;
  notebook_id: string;
  owner_principal: string;
  queue_depth: number;
  runtime_peer_count: number;
  runtime_session_id: string | null;
  status: NotebookComputeSessionStatus;
  status_message: string | null;
  updated_at: string;
  working_directory: string | null;
  workstation_display_name: string;
  workstation_id: string;
}

export interface ProjectNotebookComputeSessionSummaryOptions {
  attachment: WorkstationAttachmentState | null;
  notebookId: string;
  ownerPrincipal: string;
  queueDepth?: number | null;
  runtimePeerCount?: number | null;
  updatedAt?: string | null;
}

export interface NotebookComputeSessionFactProjection {
  label: string;
  status: NotebookComputeSessionStatus;
  tone: "active" | "starting" | "stale" | "error";
}

const COMPUTE_SESSION_SUMMARY_CACHE = new Map<string, NotebookComputeSessionSummary | null>();
const COMPUTE_SESSION_FACT_CACHE = new Map<string, NotebookComputeSessionFactProjection | null>();
const COMPUTE_SESSION_CACHE_LIMIT = 192;

export function projectNotebookComputeSessionSummary({
  attachment,
  notebookId,
  ownerPrincipal,
  queueDepth,
  runtimePeerCount,
  updatedAt,
}: ProjectNotebookComputeSessionSummaryOptions): NotebookComputeSessionSummary | null {
  const normalizedRuntimePeerCount = normalizeNonNegativeInteger(runtimePeerCount);
  const normalizedQueueDepth = normalizeNonNegativeInteger(queueDepth);
  const cacheKey = stableCacheKey([
    notebookId,
    ownerPrincipal,
    attachment,
    normalizedQueueDepth,
    normalizedRuntimePeerCount,
    updatedAt,
  ]);
  const cached = getBoundedCacheValue(COMPUTE_SESSION_SUMMARY_CACHE, cacheKey);
  if (cached !== undefined) return cached;

  if (!attachment) {
    setBoundedCacheValue(
      COMPUTE_SESSION_SUMMARY_CACHE,
      cacheKey,
      null,
      COMPUTE_SESSION_CACHE_LIMIT,
    );
    return null;
  }

  const workstationId = attachment.workstation_id.trim();
  if (!workstationId) {
    setBoundedCacheValue(
      COMPUTE_SESSION_SUMMARY_CACHE,
      cacheKey,
      null,
      COMPUTE_SESSION_CACHE_LIMIT,
    );
    return null;
  }

  const status = computeSessionStatus(attachment.status, normalizedRuntimePeerCount);
  const attachmentUpdatedAt = boundedString(attachment.updated_at) ?? null;
  const summary = Object.freeze({
    environment_label: boundedString(attachment.default_environment_label) ?? null,
    last_runtime_seen_at:
      normalizedRuntimePeerCount > 0 ? (updatedAt ?? attachmentUpdatedAt) : null,
    notebook_id: notebookId,
    owner_principal: ownerPrincipal,
    queue_depth: normalizedQueueDepth,
    runtime_peer_count: normalizedRuntimePeerCount,
    runtime_session_id: boundedString(attachment.runtime_session_id) ?? null,
    status,
    status_message: boundedString(attachment.status_message) ?? null,
    updated_at: updatedAt ?? attachmentUpdatedAt ?? new Date(0).toISOString(),
    working_directory: boundedString(attachment.working_directory) ?? null,
    workstation_display_name: boundedString(attachment.display_name) ?? "Attached workstation",
    workstation_id: workstationId,
  } satisfies NotebookComputeSessionSummary);

  setBoundedCacheValue(
    COMPUTE_SESSION_SUMMARY_CACHE,
    cacheKey,
    summary,
    COMPUTE_SESSION_CACHE_LIMIT,
  );
  return summary;
}

export function projectNotebookComputeSessionFact(
  summary: NotebookComputeSessionSummary | null | undefined,
): NotebookComputeSessionFactProjection | null {
  if (!summary) return null;
  const cacheKey = stableCacheKey([
    summary.status,
    summary.workstation_display_name,
    summary.queue_depth,
    summary.runtime_peer_count,
  ]);
  const cached = getBoundedCacheValue(COMPUTE_SESSION_FACT_CACHE, cacheKey);
  if (cached !== undefined) return cached;

  const label = notebookComputeSessionLabel(summary);
  const projection = Object.freeze({
    label,
    status: summary.status,
    tone: summary.status,
  } satisfies NotebookComputeSessionFactProjection);
  setBoundedCacheValue(
    COMPUTE_SESSION_FACT_CACHE,
    cacheKey,
    projection,
    COMPUTE_SESSION_CACHE_LIMIT,
  );
  return projection;
}

export function isNotebookComputeSessionSummary(
  value: unknown,
): value is NotebookComputeSessionSummary {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<NotebookComputeSessionSummary>;
  const queueDepth = candidate.queue_depth;
  const runtimePeerCount = candidate.runtime_peer_count;
  return (
    typeof candidate.notebook_id === "string" &&
    typeof candidate.owner_principal === "string" &&
    isNotebookComputeSessionStatus(candidate.status) &&
    typeof candidate.workstation_id === "string" &&
    typeof candidate.workstation_display_name === "string" &&
    (candidate.environment_label === null || typeof candidate.environment_label === "string") &&
    (candidate.working_directory === null || typeof candidate.working_directory === "string") &&
    (candidate.runtime_session_id === null || typeof candidate.runtime_session_id === "string") &&
    (candidate.status_message === null || typeof candidate.status_message === "string") &&
    (candidate.last_runtime_seen_at === null ||
      typeof candidate.last_runtime_seen_at === "string") &&
    typeof candidate.updated_at === "string" &&
    typeof queueDepth === "number" &&
    Number.isInteger(queueDepth) &&
    queueDepth >= 0 &&
    typeof runtimePeerCount === "number" &&
    Number.isInteger(runtimePeerCount) &&
    runtimePeerCount >= 0
  );
}

export function clearNotebookComputeSessionProjectionCacheForTests(): void {
  COMPUTE_SESSION_SUMMARY_CACHE.clear();
  COMPUTE_SESSION_FACT_CACHE.clear();
}

function computeSessionStatus(
  workstationStatus: string | null | undefined,
  runtimePeerCount: number,
): NotebookComputeSessionStatus {
  const normalized = workstationStatus?.trim().toLowerCase() ?? "";
  if (normalized === "error" || normalized === "failed" || normalized === "attention") {
    return "error";
  }
  if (runtimePeerCount > 0) {
    return "active";
  }
  if (normalized === "connecting" || normalized === "pending" || normalized === "accepted") {
    return "starting";
  }
  return "stale";
}

function notebookComputeSessionLabel(summary: NotebookComputeSessionSummary): string {
  const workstation = summary.workstation_display_name || "workstation";
  switch (summary.status) {
    case "active":
      return summary.queue_depth > 0
        ? `${workstation} running, ${summary.queue_depth} queued`
        : `${workstation} active`;
    case "starting":
      return `${workstation} starting`;
    case "stale":
      return `${workstation} stale`;
    case "error":
      return `${workstation} needs attention`;
  }
}

export function isNotebookComputeSessionStatus(
  value: unknown,
): value is NotebookComputeSessionStatus {
  return value === "starting" || value === "active" || value === "stale" || value === "error";
}

function boundedString(value: unknown, maxLength = 256): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function normalizeNonNegativeInteger(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}
