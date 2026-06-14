import { shouldPreserveBootstrapProjection } from "./bootstrap-preservation";
import { getCellIdsSnapshot } from "./cell-store";
import { resetRuntimeState } from "./runtime-state";
import { resetRuntimeStoresProjection } from "./runtime-store-projection";
import {
  createNotebookViewStoreProjector,
  type NotebookViewStoreProjectionCell,
} from "./view-store-projection";

const notebookViewStoreProjector = createNotebookViewStoreProjector();

export function projectNotebookCellsIntoViewStores(
  cells: readonly NotebookViewStoreProjectionCell[],
): void {
  notebookViewStoreProjector.projectCells(cells);
}

export function cleanupNotebookProjectionForRemovedCells(removedCellIds: readonly string[]): void {
  notebookViewStoreProjector.cleanupRemovedCells(removedCellIds);
}

export function resetNotebookViewStoreProjection(): void {
  notebookViewStoreProjector.reset({ resetQueue: true });
}

export function resetNotebookProjectionStores(): void {
  resetNotebookViewStoreProjection();
  resetRuntimeState();
  resetRuntimeStoresProjection();
}

export function shouldPreserveCurrentNotebookProjection({
  previousIdentity,
  nextIdentity,
}: {
  previousIdentity: string | null;
  nextIdentity: string | null;
}): boolean {
  return shouldPreserveBootstrapProjection({
    previousIdentity,
    nextIdentity,
    visibleCellCount: getCellIdsSnapshot().length,
  });
}

/**
 * Bootstrap-preservation gate over every store the notebook projection paints.
 * CodeCell renders outputs through execution/output stores, so preserving the
 * cell list while clearing those stores still blanks the dominant visual mass.
 *
 * Hosts still own when this gate runs. The shared lifecycle only decides
 * whether the currently painted notebook projection is reusable for the next
 * notebook identity, and clears the shared projection/runtime stores together
 * when it is not.
 *
 * Returns true when the painted projection was preserved.
 */
export function resetNotebookProjectionUnlessPreserved(options: {
  /** Stable identity of the notebook whose cells are painted, or null. */
  previousIdentity: string | null;
  /** Stable identity of the notebook this session targets, or null. */
  nextIdentity: string | null;
}): boolean {
  const preserve = shouldPreserveCurrentNotebookProjection(options);
  if (!preserve) {
    resetNotebookProjectionStores();
  }
  return preserve;
}
