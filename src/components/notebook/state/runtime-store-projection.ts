import { useSyncExternalStore } from "react";
import type { ExecutionViewChangeset } from "runtimed";
import {
  isOutputManifest,
  resolveManifest,
  resolveManifestSync,
  type BlobResolverInput,
  type OutputManifest,
} from "@/components/isolated/output-manifest";
import {
  deleteExecutions,
  markExecutionsRuntimeOwned,
  resetNotebookExecutions,
  setCellExecutionPointer,
  setExecution,
  setNotebookQueueProjection,
  type ExecutionSnapshot,
} from "./execution-store";
import { deleteOutputs, resetNotebookOutputs, setOutput } from "./output-store";
import type { NotebookStoreOutput } from "./cell-store";

export interface ApplyExecutionViewChangesetOptions {
  onExecutionSnapshot?: (executionId: string, snapshot: ExecutionSnapshot) => void;
}

type ProjectionLogFn = (message?: unknown, ...optionalParams: unknown[]) => void;

export interface ApplyOutputChangesetOptions {
  /**
   * Host-provided resolver for callers that already own blob access.
   *
   * Desktop callers can omit this and wrap the shared applier with local blob
   * resolver discovery. Cloud passes its authenticated HTTP resolver so output
   * projection stays host-neutral.
   */
  blobResolver?: BlobResolverInput | null;
  refreshBlobResolver?: () => Promise<BlobResolverInput | null>;
  retryDelaysMs?: readonly number[];
  logger?: {
    debug?: ProjectionLogFn;
    warn?: ProjectionLogFn;
  };
  onOutputApplied?: (outputId: string) => void;
}

// Failed manifest resolutions are owned by the shared runtime/output
// projection, not by a host shell. Desktop and cloud both render the same
// failure signal from this store.
const failedOutputIds = new Set<string>();
const failureSubscribers = new Set<() => void>();
let failureSnapshot: readonly string[] = [];

function notifyFailureSubscribers(): void {
  failureSnapshot = [...failedOutputIds];
  for (const cb of failureSubscribers) {
    try {
      cb();
    } catch {
      // Subscriber errors must not break the dispatch loop.
    }
  }
}

const OUTPUT_RETRY_DELAYS_MS: readonly number[] = [250, 1000];

// `applyOutputChangeset` calls are not serialized everywhere. Resetting a
// notebook must invalidate suspended retries, so writes require both the
// current reset epoch and the per-output generation stamped by the changeset.
const outputGenerations = new Map<string, number>();
let nextOutputGeneration = 0;
let outputProjectionEpoch = 0;

function stampOutputGeneration(outputId: string): number {
  const generation = ++nextOutputGeneration;
  outputGenerations.set(outputId, generation);
  return generation;
}

function outputGenerationIsCurrent(outputId: string, generation: number, epoch: number): boolean {
  return outputProjectionEpoch === epoch && outputGenerations.get(outputId) === generation;
}

function resetOutputProjectionState(): void {
  outputProjectionEpoch = (outputProjectionEpoch + 1) | 0;
  outputGenerations.clear();
  if (failedOutputIds.size === 0) return;
  failedOutputIds.clear();
  notifyFailureSubscribers();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function recordOutputProjectionFailure(outputId: string): void {
  if (failedOutputIds.has(outputId)) return;
  failedOutputIds.add(outputId);
  notifyFailureSubscribers();
}

export function clearOutputProjectionFailure(outputId: string): void {
  if (!failedOutputIds.delete(outputId)) return;
  notifyFailureSubscribers();
}

export function clearOutputProjectionFailures(outputIds: Iterable<string>): void {
  let changed = false;
  for (const outputId of outputIds) {
    changed = failedOutputIds.delete(outputId) || changed;
  }
  if (changed) notifyFailureSubscribers();
}

/** Output ids whose projection failed after retries (stale in the store). */
export function getOutputProjectionFailures(): readonly string[] {
  return failureSnapshot;
}

/** Subscribe to projection-failure changes. Returns an unsubscribe fn. */
export function subscribeOutputProjectionFailures(cb: () => void): () => void {
  failureSubscribers.add(cb);
  return () => {
    failureSubscribers.delete(cb);
  };
}

/**
 * Subscribe to the projection-failure list. NotebookView renders the
 * "N outputs failed to load" banner from this; both hosts project through
 * the shared runtime/output stores.
 */
export function useOutputProjectionFailures(): readonly string[] {
  return useSyncExternalStore(
    subscribeOutputProjectionFailures,
    getOutputProjectionFailures,
    getOutputProjectionFailures,
  );
}

export function resolveOutputProjectionSync(
  raw: unknown,
  blobResolver: BlobResolverInput | null,
): NotebookStoreOutput | null {
  if (isOutputManifest(raw)) {
    if (blobResolver === null) return null;
    return resolveManifestSync(raw as OutputManifest, blobResolver);
  }
  // Plain JupyterOutput object — no refs, no resolution needed.
  if (typeof raw === "object" && raw !== null && "output_type" in raw) {
    return raw as NotebookStoreOutput;
  }
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as NotebookStoreOutput;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Apply the per-output changeset emitted by WASM.
 *
 * `changed` carries `(output_id, narrowed_manifest)` pairs. Hosts provide blob
 * access and optional observability hooks; the store write, failure signal, and
 * async stale-write suppression are shared across desktop and cloud.
 */
export async function applyOutputChangeset(
  changed: Array<[string, unknown]>,
  removedIds: string[],
  options: ApplyOutputChangesetOptions = {},
): Promise<void> {
  if (removedIds.length > 0) {
    deleteOutputs(removedIds);
    for (const outputId of removedIds) {
      stampOutputGeneration(outputId);
    }
    clearOutputProjectionFailures(removedIds);
  }
  if (changed.length === 0) return;

  const epoch = outputProjectionEpoch;
  const generations = new Map<string, number>();
  for (const [outputId] of changed) {
    generations.set(outputId, stampOutputGeneration(outputId));
  }
  const writeIsCurrent = (outputId: string) =>
    outputGenerationIsCurrent(outputId, generations.get(outputId) ?? -1, epoch);

  let blobResolver = options.blobResolver ?? null;
  if (blobResolver === null && changed.some(([, raw]) => isOutputManifest(raw))) {
    blobResolver = options.refreshBlobResolver ? await options.refreshBlobResolver() : null;
  }

  const retryDelays = options.retryDelaysMs ?? OUTPUT_RETRY_DELAYS_MS;
  for (const [outputId, raw] of changed) {
    if (!writeIsCurrent(outputId)) continue;
    const sync = resolveOutputProjectionSync(raw, blobResolver);
    if (sync) {
      setOutput(outputId, sync);
      clearOutputProjectionFailure(outputId);
      options.onOutputApplied?.(outputId);
      continue;
    }
    if (blobResolver === null) {
      options.logger?.warn?.(
        `[outputs-store] blob resolver unavailable; deferring output ${outputId}`,
      );
      recordOutputProjectionFailure(outputId);
      continue;
    }
    if (!isOutputManifest(raw)) continue;
    let resolvedOk = false;
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        const resolved = await resolveManifest(raw, blobResolver);
        if (!writeIsCurrent(outputId)) {
          resolvedOk = true;
          break;
        }
        setOutput(outputId, resolved);
        clearOutputProjectionFailure(outputId);
        options.onOutputApplied?.(outputId);
        resolvedOk = true;
        break;
      } catch (err) {
        if (attempt < retryDelays.length) {
          options.logger?.debug?.(
            `[outputs-store] resolve attempt ${attempt + 1} failed for ${outputId}; retrying`,
          );
          await sleep(retryDelays[attempt]);
          if (!writeIsCurrent(outputId)) {
            resolvedOk = true;
            break;
          }
        } else {
          options.logger?.warn?.(
            `[outputs-store] Failed to resolve output ${outputId} after ${attempt + 1} attempts:`,
            err,
          );
        }
      }
    }
    if (!resolvedOk && writeIsCurrent(outputId)) {
      recordOutputProjectionFailure(outputId);
    }
  }
}

/**
 * Apply the cross-document execution materialized-view changeset emitted by
 * WASM.
 *
 * Rust owns the diff between NotebookDoc cell pointers and RuntimeStateDoc
 * execution entries. The React stores are intentionally thin subscription
 * containers; they no longer rescan RuntimeStateDoc snapshots or ask the
 * handle to refresh every cell pointer after each sync tick.
 */
export function applyExecutionViewChangeset(
  changeset: ExecutionViewChangeset | null | undefined,
  options: ApplyExecutionViewChangesetOptions = {},
): void {
  if (!changeset) return;

  for (const [executionId, snapshot] of changeset.execution_upserts ?? []) {
    markExecutionsRuntimeOwned([executionId]);
    setExecution(executionId, snapshot);
    options.onExecutionSnapshot?.(executionId, snapshot);
  }

  const removedExecutionIds = changeset.removed_execution_ids ?? [];
  if (removedExecutionIds.length > 0) {
    deleteExecutions(removedExecutionIds);
  }

  for (const [cellId, executionId] of changeset.cell_pointer_changes ?? []) {
    setCellExecutionPointer(cellId, executionId);
  }

  if (changeset.queue?.notebook) {
    setNotebookQueueProjection({
      executing_cell_id: changeset.queue.notebook.executing_cell_id ?? null,
      queued_cell_ids: changeset.queue.notebook.queued_cell_ids,
    });
  }
}

export function resetRuntimeStoresProjection(): void {
  resetNotebookExecutions();
  resetNotebookOutputs();
  resetOutputProjectionState();
}
