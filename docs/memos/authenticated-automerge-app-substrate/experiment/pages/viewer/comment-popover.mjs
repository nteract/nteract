// Geometry for the inline comment composer. Pure functions over client
// rectangles so the placement rules can be tested without a browser.

const finite = (...values) => values.every(Number.isFinite);

/**
 * The box a passage occupies, from the client rects of its highlighted
 * segments. Horizontal placement starts at the passage's first character;
 * vertical placement spans every line. Returns null when nothing is visible.
 */
export function passageRect(rects) {
  const visible = [...rects].filter(
    (rect) => finite(rect.left, rect.top, rect.right, rect.bottom) && rect.bottom > rect.top,
  );
  if (!visible.length) return null;
  return {
    left: visible[0].left,
    top: Math.min(...visible.map((rect) => rect.top)),
    right: Math.max(...visible.map((rect) => rect.right)),
    bottom: Math.max(...visible.map((rect) => rect.bottom)),
  };
}

/**
 * Place a `width` × `height` popover next to `anchor` inside `viewport`.
 *
 * The popover goes below the passage. When that would cross the viewport's
 * bottom it flips above; when neither side fits, it takes the side with more
 * room. Either way it is clamped inside the viewport, so a passage scrolled
 * out of view leaves the popover pinned to the nearest edge.
 */
export function commentPopoverPosition({ anchor, width, height, viewport, margin = 12, gap = 8 }) {
  const { left, top, right, bottom } = viewport ?? {};
  if (
    !anchor ||
    !finite(anchor.left, anchor.top, anchor.bottom, width, height, left, top, right, bottom) ||
    width <= 0 ||
    height <= 0
  )
    return null;
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - height;
  const fitsBelow = below + height <= bottom - margin;
  const fitsAbove = above >= top + margin;
  const placement =
    fitsBelow || (!fitsAbove && bottom - anchor.bottom >= anchor.top - top) ? "below" : "above";
  const clamp = (value, low, high) => Math.max(low, Math.min(value, high));
  return {
    left: Math.round(clamp(anchor.left, left + margin, Math.max(left + margin, right - margin - width))),
    top: Math.round(
      clamp(
        placement === "below" ? below : above,
        top + margin,
        Math.max(top + margin, bottom - margin - height),
      ),
    ),
    placement,
  };
}
