/** Place the existing toolbar beside a visible selection, or keep its normal row. */
export function selectionToolbarPosition({ start, end, width, height, viewport }) {
  const margin = 12;
  const gap = 10;
  const { left, top, right, bottom } = viewport;
  const selectionTop = Math.min(start.top, end.top);
  const selectionBottom = Math.max(start.bottom, end.bottom);
  if (
    ![
      left,
      top,
      right,
      bottom,
      width,
      height,
      selectionTop,
      selectionBottom,
      start.left,
      end.right,
    ].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0 ||
    width > right - left - margin * 2 ||
    selectionTop < top ||
    selectionBottom > bottom
  )
    return null;
  const above = selectionTop - gap - height;
  const below = selectionBottom + gap;
  const y = above >= top + margin ? above : below + height <= bottom - margin ? below : null;
  if (y === null) return null;
  const center = (start.left + end.right) / 2;
  return {
    left: Math.round(Math.max(left + margin, Math.min(center - width / 2, right - margin - width))),
    top: Math.round(y),
  };
}
