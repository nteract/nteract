/**
 * Pick the surviving cell that should remain selected after deleting a cell.
 * Prefer the next cell (which moves into the deleted cell's position), then
 * fall back to the previous cell when deleting the final cell.
 */
export function getFocusAfterCellDeletion(
  cellIds: readonly string[],
  deletedCellId: string,
): string | null {
  return getFocusAfterCellsDeletion(cellIds, [deletedCellId]);
}

/**
 * Same, for deleting several cells at once: the first surviving cell after the
 * last deleted one, else the nearest survivor before it. Never a deleted cell.
 */
export function getFocusAfterCellsDeletion(
  cellIds: readonly string[],
  deletedCellIds: readonly string[],
): string | null {
  const deleted = new Set(deletedCellIds);
  let last = -1;
  cellIds.forEach((id, index) => {
    if (deleted.has(id)) last = index;
  });
  if (last < 0) return null;
  const after = cellIds.slice(last + 1).find((id) => !deleted.has(id));
  if (after) return after;
  for (let index = last - 1; index >= 0; index--) {
    if (!deleted.has(cellIds[index])) return cellIds[index];
  }
  return null;
}
