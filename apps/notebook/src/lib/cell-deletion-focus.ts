/**
 * Pick the surviving cell that should remain selected after deleting a cell.
 * Prefer the next cell (which moves into the deleted cell's position), then
 * fall back to the previous cell when deleting the final cell.
 */
export function getFocusAfterCellDeletion(
  cellIds: readonly string[],
  deletedCellId: string,
): string | null {
  const deletedIndex = cellIds.indexOf(deletedCellId);
  if (deletedIndex < 0) return null;
  return cellIds[deletedIndex + 1] ?? cellIds[deletedIndex - 1] ?? null;
}
