/** Place the existing toolbar beside a visible selection, or keep its normal row.
 *
 * `block` is the box of the code block that holds the selection. The toolbar
 * then sits outside that box, at the edge nearer the selection, so it never
 * covers the block's own controls or code the pointer may reach for next.
 * When neither edge has room it goes beside the selection as usual. */
export function selectionToolbarPosition({ start, end, width, height, viewport, block }) {
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
  const fits = (y) => Number.isFinite(y) && y >= top + margin && y + height <= bottom - margin;
  const outside = block ? [block.top - gap - height, block.bottom + gap] : [];
  if (block && selectionTop - block.top > block.bottom - selectionBottom) outside.reverse();
  const above = selectionTop - gap - height;
  const below = selectionBottom + gap;
  const y =
    outside.find(fits) ??
    (above >= top + margin ? above : below + height <= bottom - margin ? below : null);
  if (y === null) return null;
  const center = (start.left + end.right) / 2;
  return {
    left: Math.round(Math.max(left + margin, Math.min(center - width / 2, right - margin - width))),
    top: Math.round(y),
  };
}
