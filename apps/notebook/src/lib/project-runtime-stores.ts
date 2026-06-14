/**
 * Desktop glue between SyncEngine events and the shared runtime/output stores.
 *
 * The store mutation and retry logic lives in shared notebook state so desktop
 * and cloud render from the same facts. This module supplies desktop-only
 * concerns: blob resolver discovery, logging, and performance marks.
 *
 * `output_id` is a daemon-side invariant — `create_manifest` always stamps one
 * (and `outputs_to_manifest_refs` stamps a fallback on the error path). Every
 * output that reaches the frontend has a real id, so there is no synthetic
 * `legacy:<eid>:<idx>` key in these stores.
 */

import type { ExecutionViewChangeset } from "runtimed";
import type { NotebookHandle } from "../wasm/runtimed-wasm/runtimed_wasm.js";
import { getBlobResolver, refreshBlobResolver } from "./blob-port";
import { getExecutionById, setExecution } from "@/components/notebook/state/execution-store";
import { getOutputById, setOutput } from "@/components/notebook/state/output-store";
import { markExecutionPerformance } from "./execution-performance";
import { logger } from "./logger";
import {
  applyExecutionViewChangeset as applyExecutionViewChangesetToStores,
  applyOutputChangeset as applyOutputChangesetToStores,
  getOutputProjectionFailures,
  resetRuntimeStoresProjection,
  resolveOutputProjectionSync,
  subscribeOutputProjectionFailures,
  useOutputProjectionFailures,
  type ApplyOutputChangesetOptions as SharedApplyOutputChangesetOptions,
} from "@/components/notebook/state/runtime-store-projection";

export {
  getOutputProjectionFailures,
  resetRuntimeStoresProjection,
  subscribeOutputProjectionFailures,
  useOutputProjectionFailures,
};

export interface ApplyOutputChangesetOptions
  extends Omit<SharedApplyOutputChangesetOptions, "logger" | "onOutputApplied"> {}

export function applyExecutionViewChangeset(
  changeset: ExecutionViewChangeset | null | undefined,
): void {
  applyExecutionViewChangesetToStores(changeset, {
    onExecutionSnapshot: (executionId, snapshot) => {
      markExecutionPerformance(`runtime.execution.snapshot.${snapshot.status}`, {
        executionId,
        outputCount: snapshot.output_ids.length,
        executionCount: snapshot.execution_count,
      });
    },
  });
}

/**
 * Seed the outputs / executions stores directly from the WASM handle.
 *
 * `initialSyncComplete$` can fire before the RuntimeStateDoc sync frame lands.
 * Walking the handle for each cell's current `execution_id` keeps any outputs
 * already stored in the notebook doc visible immediately rather than waiting
 * for the runtime-state catch-up tick.
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

    const outputIds = collectOutputIds(rawOutputs);
    if (outputIds.length === 0) continue;

    // Build a minimal execution snapshot only when Rust has not already
    // projected the authoritative RuntimeStateDoc entry. Runtime sync can
    // arrive before notebook interactive materialization; the eager seed path
    // must not downgrade a real running/done/error snapshot to a placeholder.
    if (!getExecutionById(executionId)) {
      setExecution(executionId, {
        execution_count: null,
        status: "done",
        success: null,
        output_ids: outputIds,
      });
    }

    // Populate the outputs store for each output. Plain JupyterOutputs
    // (already resolved by full materialization) go in directly; manifests kick
    // through a sync resolver when possible.
    for (let i = 0; i < rawOutputs.length; i++) {
      const output = rawOutputs[i];
      if (!output || typeof output !== "object") continue;
      const outputId = outputIds[i];
      if (!outputId) continue;
      const existing = getOutputById(outputId);
      if (existing === output) continue;
      const sync = resolveOutputProjectionSync(output, getBlobResolver());
      if (sync) setOutput(outputId, sync);
    }
  }
}

export async function applyOutputChangeset(
  changed: Array<[string, unknown]>,
  removed_ids: string[],
  options: ApplyOutputChangesetOptions = {},
): Promise<void> {
  const blobResolver =
    "blobResolver" in options ? options.blobResolver ?? null : getBlobResolver();

  await applyOutputChangesetToStores(changed, removed_ids, {
    ...options,
    blobResolver,
    refreshBlobResolver: options.refreshBlobResolver ?? refreshBlobResolver,
    logger,
    onOutputApplied: (outputId) => {
      markExecutionPerformance("runtime.output.applied", { outputId });
    },
  });
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
