/**
 * Projection glue between the SyncEngine and the per-execution / per-output
 * React stores.
 *
 * Splitting this out of `useAutomergeNotebook` keeps the hook focused on
 * React wiring and avoids pulling the outputs store's imports into the
 * materialization pipeline.
 *
 * `output_id` is a daemon-side invariant — `create_manifest` always
 * stamps one (and `outputs_to_manifest_refs` stamps a fallback on the
 * error path). Every output that reaches the frontend has a real id, so
 * there is no synthetic `legacy:<eid>:<idx>` key in these stores.
 */

import type { ExecutionViewChangeset } from "runtimed";
import type { HostBlobResolver } from "@nteract/notebook-host";
import type { JupyterOutput } from "../types";
import type { NotebookHandle } from "../wasm/runtimed-wasm/runtimed_wasm.js";
import { getBlobResolver, refreshBlobResolver } from "./blob-port";
import { logger } from "./logger";
import {
  type OutputManifest,
  resolveManifest,
  resolveManifestSync,
} from "./manifest-resolution";
import { isOutputManifest } from "./materialize-cells";
import {
  deleteExecutions,
  getExecutionById,
  resetNotebookExecutions,
  setCellExecutionPointer,
  setExecution,
  setNotebookQueueProjection,
} from "@/components/notebook/state/execution-store";
import {
  deleteOutputs,
  getOutputById,
  resetNotebookOutputs,
  setOutput,
} from "@/components/notebook/state/output-store";
import { markExecutionPerformance } from "./execution-performance";

export interface ApplyOutputChangesetOptions {
  /**
   * Host-provided resolver for callers that already own blob access.
   *
   * Desktop leaves this unset and falls back to the blob-port store. Cloud
   * passes its authenticated HTTP resolver so runtime-state projection does
   * not depend on desktop host discovery.
   */
  blobResolver?: HostBlobResolver | null;
  refreshBlobResolver?: () => Promise<HostBlobResolver | null>;
  /** Test hook: per-attempt retry delay override (default 250ms, 1s). */
  retryDelaysMs?: readonly number[];
}

// ── Output projection failure surface (FSB-1) ────────────────────────
//
// A failed manifest resolution used to be swallowed at `warn`, leaving the
// output store silently stale. Failures are now retried with bounded
// backoff, and outputs that still fail are recorded here so UI and
// diagnostics can see "N outputs failed to load" instead of nothing.
// A later successful resolution (next changeset tick, reconnect) clears
// the entry.

const OUTPUT_RETRY_DELAYS_MS: readonly number[] = [250, 1000];

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

function recordOutputProjectionFailure(output_id: string): void {
  if (failedOutputIds.has(output_id)) return;
  failedOutputIds.add(output_id);
  notifyFailureSubscribers();
}

function clearOutputProjectionFailure(output_id: string): void {
  if (!failedOutputIds.delete(output_id)) return;
  notifyFailureSubscribers();
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
): void {
  if (!changeset) return;

  for (const [execution_id, snapshot] of changeset.execution_upserts ?? []) {
    setExecution(execution_id, snapshot);
    markExecutionPerformance(`runtime.execution.snapshot.${snapshot.status}`, {
      executionId: execution_id,
      outputCount: snapshot.output_ids.length,
      executionCount: snapshot.execution_count,
    });
  }

  const removedExecutionIds = changeset.removed_execution_ids ?? [];
  if (removedExecutionIds.length > 0) {
    deleteExecutions(removedExecutionIds);
  }

  for (const [cell_id, execution_id] of changeset.cell_pointer_changes ?? []) {
    setCellExecutionPointer(cell_id, execution_id);
  }

  if (changeset.queue?.notebook) {
    setNotebookQueueProjection({
      executing_cell_id: changeset.queue.notebook.executing_cell_id ?? null,
      queued_cell_ids: changeset.queue.notebook.queued_cell_ids,
    });
  }
}

/**
 * Seed the outputs / executions stores directly from the WASM handle.
 *
 * `initialSyncComplete$` can fire before the RuntimeStateDoc sync frame
 * lands. Walking the handle for each cell's current `execution_id` keeps
 * any outputs already stored in the notebook doc visible immediately rather
 * than waiting for the runtime-state catch-up tick.
 */
export function seedOutputStoresFromHandle(
  handle: NotebookHandle,
  cell_ids: string[],
): void {
  for (const cellId of cell_ids) {
    const executionId = handle.get_cell_execution_id(cellId) ?? null;
    if (!executionId) continue;
    const rawOutputs = (handle.get_cell_outputs(cellId) as unknown[]) ?? [];
    if (rawOutputs.length === 0) continue;

    const output_ids = collectOutputIds(rawOutputs);
    if (output_ids.length === 0) continue;

    // Build a minimal execution snapshot only when Rust has not already
    // projected the authoritative RuntimeStateDoc entry. Runtime sync can
    // arrive before notebook interactive materialization; the eager seed path
    // must not downgrade a real running/done/error snapshot to a placeholder.
    if (!getExecutionById(executionId)) {
      setExecution(executionId, {
        execution_count: null,
        status: "done",
        success: null,
        output_ids,
      });
    }

    // Populate the outputs store for each output. Plain JupyterOutputs
    // (already resolved by full materialization) go in directly;
    // manifests kick through the sync resolver.
    for (let i = 0; i < rawOutputs.length; i++) {
      const output = rawOutputs[i];
      if (!output || typeof output !== "object") continue;
      const oid = output_ids[i];
      if (!oid) continue;
      const existing = getOutputById(oid);
      if (existing === output) continue;
      const sync = tryResolveSync(output, getBlobResolver());
      if (sync) setOutput(oid, sync);
    }
  }
}

// ── Outputs store projection ─────────────────────────────────────────

/**
 * Apply the per-output changeset emitted by WASM.
 *
 * `changed` carries `(output_id, narrowed_manifest)` pairs — manifests
 * are already MIME-narrowed and have binary ContentRefs resolved to
 * `{url}` variants. The only remaining work here is fetching text blob
 * refs (which still require an HTTP round trip) before handing the
 * fully-resolved `JupyterOutput` to the store.
 *
 * Removed output_ids are dropped from the store.
 */
export async function applyOutputChangeset(
  changed: Array<[string, unknown]>,
  removed_ids: string[],
  options: ApplyOutputChangesetOptions = {},
): Promise<void> {
  if (removed_ids.length > 0) {
    deleteOutputs(removed_ids);
    let droppedFailure = false;
    for (const output_id of removed_ids) {
      droppedFailure = failedOutputIds.delete(output_id) || droppedFailure;
    }
    if (droppedFailure) notifyFailureSubscribers();
  }
  if (changed.length === 0) return;

  // Stream/display-update manifests with text blob refs need host blob access.
  // Fetch it on demand so a race between the first manifest and resolver
  // discovery doesn't drop outputs on the floor.
  let blobResolver =
    "blobResolver" in options ? options.blobResolver ?? null : getBlobResolver();
  if (blobResolver === null && changed.some(([, raw]) => isOutputManifest(raw))) {
    blobResolver = options.refreshBlobResolver
      ? await options.refreshBlobResolver()
      : await refreshBlobResolver();
  }

  const retryDelays = options.retryDelaysMs ?? OUTPUT_RETRY_DELAYS_MS;
  for (const [output_id, raw] of changed) {
    const sync = tryResolveSync(raw, blobResolver);
    if (sync) {
      setOutput(output_id, sync);
      clearOutputProjectionFailure(output_id);
      markExecutionPerformance("runtime.output.applied", { outputId: output_id });
      continue;
    }
    if (blobResolver === null) {
      logger.warn(
        `[outputs-store] blob resolver unavailable; deferring output ${output_id}`,
      );
      recordOutputProjectionFailure(output_id);
      continue;
    }
    if (!isOutputManifest(raw)) continue;
    // Retry transient resolution failures (blob HTTP blips) with bounded
    // backoff before declaring the output stale (FSB-1). Only the final
    // outcome is logged; per-attempt noise stays at debug.
    let resolvedOk = false;
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        const resolved = await resolveManifest(raw, blobResolver);
        setOutput(output_id, resolved);
        clearOutputProjectionFailure(output_id);
        markExecutionPerformance("runtime.output.applied", { outputId: output_id });
        resolvedOk = true;
        break;
      } catch (err) {
        if (attempt < retryDelays.length) {
          logger.debug(
            `[outputs-store] resolve attempt ${attempt + 1} failed for ${output_id}; retrying`,
          );
          await sleep(retryDelays[attempt]);
        } else {
          logger.warn(
            `[outputs-store] Failed to resolve output ${output_id} after ${attempt + 1} attempts:`,
            err,
          );
        }
      }
    }
    if (!resolvedOk) {
      recordOutputProjectionFailure(output_id);
    }
  }
}

function tryResolveSync(
  raw: unknown,
  blobResolver: HostBlobResolver | null,
): JupyterOutput | null {
  if (isOutputManifest(raw)) {
    if (blobResolver === null) return null;
    return resolveManifestSync(raw as OutputManifest, blobResolver);
  }
  // Plain JupyterOutput object — no refs, no resolution needed.
  if (typeof raw === "object" && raw !== null && "output_type" in raw) {
    return raw as JupyterOutput;
  }
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as JupyterOutput;
    } catch {
      return null;
    }
  }
  return null;
}

export function resetRuntimeStoresProjection(): void {
  resetNotebookExecutions();
  resetNotebookOutputs();
  if (failedOutputIds.size > 0) {
    failedOutputIds.clear();
    notifyFailureSubscribers();
  }
}

function collectOutputIds(outputs: readonly unknown[] | undefined): string[] {
  const ids: string[] = [];
  if (!outputs) return ids;
  for (const output of outputs) {
    if (!output || typeof output !== "object") continue;
    const oid = (output as { output_id?: unknown }).output_id;
    if (typeof oid === "string" && oid.length > 0) {
      ids.push(oid);
    }
  }
  return ids;
}
