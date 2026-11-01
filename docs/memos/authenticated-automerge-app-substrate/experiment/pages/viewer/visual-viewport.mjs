// The visible part of the page on a phone. iOS keeps the layout viewport full
// height while the keyboard is up and scrolls a smaller visual viewport inside
// it, so fixed and sticky elements fall behind the keyboard or off the top.
// Pages publishes the visual viewport's edges as CSS variables; the mobile
// formatting bar sits on --vv-bottom, the header follows --vv-top, and menus
// above the bar cap their height with --vv-height.
import { animationFrameScheduler, auditTime, fromEvent, merge } from "rxjs";

/** Narrow touch screens get the compact bar; desktop keeps its toolbar. */
export const MOBILE_EDITOR_QUERY = "(max-width: 600px) and (pointer: coarse)";

const finite = (...values) => values.every(Number.isFinite);

/** How far the visual viewport sits from the layout viewport's top and bottom
 * edges, in CSS pixels. `bottom` is the keyboard (plus any accessory bar). */
export function viewportInsets({ visualViewport, layoutHeight }) {
  const { offsetTop, height } = visualViewport ?? {};
  if (!finite(offsetTop, height, layoutHeight) || height <= 0 || layoutHeight <= 0)
    return {
      top: 0,
      bottom: 0,
      height: finite(layoutHeight) && layoutHeight > 0 ? layoutHeight : 0,
    };
  return {
    top: Math.max(0, Math.round(offsetTop)),
    bottom: Math.max(0, Math.round(layoutHeight - (offsetTop + height))),
    height: Math.round(Math.min(height, layoutHeight)),
  };
}

/** Keep `--vv-top` and `--vv-bottom` on `root` current. Returns a stop function. */
export function trackVisualViewport(win = window, root = win.document.documentElement) {
  const viewport = win.visualViewport;
  const apply = () => {
    const { top, bottom, height } = viewportInsets({
      visualViewport: viewport,
      layoutHeight: root.clientHeight,
    });
    root.style.setProperty("--vv-top", `${top}px`);
    root.style.setProperty("--vv-bottom", `${bottom}px`);
    if (height) root.style.setProperty("--vv-height", `${height}px`);
  };
  apply();
  if (!viewport) return () => {};
  const subscription = merge(fromEvent(viewport, "resize"), fromEvent(viewport, "scroll"))
    .pipe(auditTime(0, animationFrameScheduler))
    .subscribe(apply);
  return () => {
    subscription.unsubscribe();
    root.style.removeProperty("--vv-top");
    root.style.removeProperty("--vv-bottom");
    root.style.removeProperty("--vv-height");
  };
}
