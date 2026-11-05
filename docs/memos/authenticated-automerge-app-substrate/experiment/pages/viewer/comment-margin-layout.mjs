/**
 * Margin thread layout. Cards sit beside their passages without overlapping.
 * Pure: callers measure anchors and card heights, this decides positions.
 *
 * items:   [{ id, anchorTop, height }] in any order (px, same coordinate space)
 * options: { gap, activeId }
 * returns: [{ id, top }] in document order
 *
 * Without an active card, cards keep their anchor top and push later cards
 * down. With one, the active card sits exactly at its anchor; cards after it
 * push down and cards before it push up, so the conversation being read
 * lines up with its passage.
 */
export function layoutMargin(items, { gap = 8, activeId = null } = {}) {
  const sorted = [...items].sort((a, b) => a.anchorTop - b.anchorTop || (a.id < b.id ? -1 : 1));
  const tops = Array.from({ length: sorted.length });
  const pivot = activeId === null ? -1 : sorted.findIndex((item) => item.id === activeId);
  if (pivot < 0) {
    let floor = -Infinity;
    sorted.forEach((item, index) => {
      tops[index] = Math.max(item.anchorTop, floor);
      floor = tops[index] + item.height + gap;
    });
  } else {
    tops[pivot] = sorted[pivot].anchorTop;
    for (let index = pivot + 1; index < sorted.length; index++)
      tops[index] = Math.max(
        sorted[index].anchorTop,
        tops[index - 1] + sorted[index - 1].height + gap,
      );
    for (let index = pivot - 1; index >= 0; index--)
      tops[index] = Math.min(sorted[index].anchorTop, tops[index + 1] - gap - sorted[index].height);
  }
  return sorted.map((item, index) => ({ id: item.id, top: tops[index] }));
}

/**
 * Whether margin cards fit beside the Page. When they don't, the comments
 * panel's drill-in view is the only way to read threads.
 */
export function marginFits({ viewportWidth, contentRight, cardWidth, gutter = 24 }) {
  return viewportWidth - contentRight >= cardWidth + gutter * 2;
}
