// The visible part of the page on a phone. iOS keeps the layout viewport full
// height while the keyboard is up and scrolls a smaller visual viewport inside
// it, so fixed and sticky elements fall behind the keyboard or off the top.
// Pages publishes the visual viewport's edges as CSS variables; the mobile
// formatting bar sits on --vv-bottom, the header follows --vv-top, and menus
// above the bar cap their height with --vv-height.
//
// Only a software keyboard moves the bars. Without one, browser toolbars
// collapsing and growing, rubber-band overscroll and stale offsets all change
// the visual viewport while the Page scrolls, and the browser already keeps
// fixed and sticky elements on screen for those on its compositor. Following
// them from script would move the bars a frame or more behind the scroll,
// which reads as a jiggle, so the insets stay at zero until a keyboard covers
// the bottom.
import { animationFrameScheduler, auditTime, fromEvent, merge } from "rxjs";

/** Narrow touch screens get the compact bar; desktop keeps its toolbar. */
export const MOBILE_EDITOR_QUERY = "(max-width: 600px) and (pointer: coarse)";

/** The least a software keyboard covers, in CSS pixels. Browser toolbars
 * change the visible height by less; a phone keyboard, even without its
 * accessory row, covers more than 200px. */
export const KEYBOARD_MIN_HEIGHT = 120;

const finite = (...values) => values.every(Number.isFinite);

/** Where the bars go for one visual viewport measurement, in CSS pixels.
 * `keyboard` is how much of the layout viewport the keyboard covers; it holds
 * still while iOS pans the visual viewport, unlike `top` and `bottom`, which
 * are the visual viewport's distance from the layout viewport's edges. All
 * four are zero, and `height` is the layout height, when no keyboard is up. */
export function viewportInsets({ visualViewport, layoutHeight }) {
  const { offsetTop, height } = visualViewport ?? {};
  const scale = Number.isFinite(visualViewport?.scale) ? visualViewport.scale : 1;
  const docked = {
    top: 0,
    bottom: 0,
    keyboard: 0,
    height: finite(layoutHeight) && layoutHeight > 0 ? layoutHeight : 0,
  };
  if (!finite(offsetTop, height, layoutHeight) || height <= 0 || layoutHeight <= 0 || scale <= 0)
    return docked;
  // Pinch zoom shrinks the visual viewport by the scale; only a keyboard
  // leaves part of the layout viewport uncovered at scale.
  const keyboard = Math.round(layoutHeight - height * scale);
  if (keyboard < KEYBOARD_MIN_HEIGHT) return docked;
  // Round the top and height, and derive the bottom from them, so the header
  // and the bar stay exactly one visual viewport apart while iOS pans.
  const top = Math.max(0, Math.round(offsetTop));
  const visible = Math.round(Math.min(height, layoutHeight));
  return {
    top,
    bottom: Math.max(0, Math.round(layoutHeight) - top - visible),
    keyboard,
    height: visible,
  };
}

/** Keep the `--vv-*` variables on `root` current. Returns a stop function. */
export function trackVisualViewport(win = window, root = win.document.documentElement) {
  const viewport = win.visualViewport;
  const published = new Map();
  const set = (name, value) => {
    if (published.get(name) === value) return;
    published.set(name, value);
    root.style.setProperty(name, value);
  };
  const apply = () => {
    const { top, bottom, keyboard, height } = viewportInsets({
      visualViewport: viewport,
      layoutHeight: root.clientHeight,
    });
    set("--vv-top", `${top}px`);
    set("--vv-bottom", `${bottom}px`);
    set("--vv-keyboard", `${keyboard}px`);
    // Without a visual viewport nothing would keep this current, so leave it
    // unset and let CSS fall back to 100dvh.
    if (viewport && height) set("--vv-height", `${height}px`);
  };
  apply();
  if (!viewport) return () => {};
  const subscription = merge(fromEvent(viewport, "resize"), fromEvent(viewport, "scroll"))
    .pipe(auditTime(0, animationFrameScheduler))
    .subscribe(apply);
  return () => {
    subscription.unsubscribe();
    for (const name of ["--vv-top", "--vv-bottom", "--vv-keyboard", "--vv-height"])
      root.style.removeProperty(name);
  };
}
