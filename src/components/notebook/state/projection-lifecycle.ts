import { shouldPreserveBootstrapProjection } from "./bootstrap-preservation";
import { getCellIdsSnapshot } from "./cell-store";

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
