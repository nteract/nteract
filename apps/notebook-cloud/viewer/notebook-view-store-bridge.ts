import { createNotebookViewStoreProjector } from "@/components/notebook/state/view-store-projection";
import {
  getCellIdsSnapshot,
  resetRuntimeState,
  resetRuntimeStoresProjection,
  shouldPreserveBootstrapProjection,
} from "../../notebook/src/notebook-surface-stores";
import type { ResolvedCell } from "./render-resolution";

const cloudViewStoreProjector = createNotebookViewStoreProjector({
  syntheticExecutionId: (cellId) => `cloud-execution:${cellId}`,
  syntheticOutputId: (cellId, outputIndex) => `cloud-output:${cellId}:${outputIndex}`,
  syntheticOutputPrefix: (cellId) => `cloud-output:${cellId}:`,
});

export function projectCloudCellsIntoNotebookViewStores(cells: readonly ResolvedCell[]): void {
  cloudViewStoreProjector.projectCells(cells);
}

export function cleanupCloudProjectionForRemovedCells(removedCellIds: readonly string[]): void {
  cloudViewStoreProjector.cleanupRemovedCells(removedCellIds);
}

export function resetCloudViewStoreProjection(): void {
  cloudViewStoreProjector.reset({ resetQueue: true });
}

/**
 * Bootstrap-preservation gate over EVERY store the cloud projection paints
 * (desktop pattern: useAutomergeNotebook's beforeBootstrap). CodeCell renders
 * outputs exclusively through the execution/output stores — preserving the
 * cell store while wiping those still blanks every output and execution
 * count, which is the dominant visual mass of a painted notebook. So the
 * gate keeps or clears them together; `resetPoolState` stays with the
 * caller, unconditional, matching desktop.
 *
 * Stale-data safety on preserve: the next materialization replaces cells
 * wholesale and `projectCloudCellsIntoNotebookViewStores` sweeps stale
 * cloud-owned output/execution ids via the `cloudOwned*` difference sets,
 * which this function leaves intact.
 *
 * Returns true when the painted projection was preserved.
 */
export function resetCloudProjectionUnlessPreserved(options: {
  /** `id:`-prefixed identity of the notebook whose cells are painted, or null. */
  paintedNotebookIdentity: string | null;
  /** `id:`-prefixed identity of the notebook this session targets. */
  nextNotebookIdentity: string;
}): boolean {
  const preserve = shouldPreserveBootstrapProjection({
    previousIdentity: options.paintedNotebookIdentity,
    nextIdentity: options.nextNotebookIdentity,
    visibleCellCount: getCellIdsSnapshot().length,
  });
  if (!preserve) {
    resetCloudViewStoreProjection();
    resetRuntimeState();
    resetRuntimeStoresProjection();
  }
  return preserve;
}
