export type CellNavigationDirection = "previous" | "next";

export function findAdjacentVisibleCellId(
  cellIds: readonly string[],
  currentCellId: string,
  direction: CellNavigationDirection,
  isVisible: (cellId: string) => boolean,
): string | null {
  const currentIndex = cellIds.indexOf(currentCellId);
  if (currentIndex < 0) return null;

  const step = direction === "previous" ? -1 : 1;
  let targetIndex = currentIndex + step;
  while (targetIndex >= 0 && targetIndex < cellIds.length) {
    const targetCellId = cellIds[targetIndex];
    if (isVisible(targetCellId)) return targetCellId;
    targetIndex += step;
  }

  return null;
}
