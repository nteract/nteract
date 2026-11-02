// The visible part of the page on a phone. iOS keeps the layout viewport full
// height while the keyboard is up and scrolls a smaller visual viewport inside
// it, so fixed and sticky elements fall behind the keyboard or off the top.
// Pages publishes the visual viewport's edges as CSS variables; the mobile
// formatting bar sits on --vv-bottom, the header follows --vv-top, and menus
// above the bar cap their height with --vv-height.
//
// The bars follow the visual viewport while something covers its bottom or
// the Page is zoomed. At scale 1 with nothing editable focused, browser
// toolbars collapsing and growing, rubber-band overscroll and stale offsets
// all change the visual viewport while the Page scrolls, and the browser
// already keeps fixed and sticky elements on screen for those on its
// compositor. Following them from script would move the bars a frame or more
// behind the scroll, which reads as a jiggle, so the insets stay at zero then.
import { animationFrameScheduler, auditTime, fromEvent, merge } from "rxjs";

/** Narrow touch screens get the compact bar; desktop keeps its toolbar. */
export const MOBILE_EDITOR_QUERY = "(max-width: 600px) and (pointer: coarse)";

/** The least a software keyboard covers, in CSS pixels. Browser toolbars
 * change the visible height by less; a phone keyboard, even without its
 * accessory row, covers more than 200px. */
export const KEYBOARD_MIN_HEIGHT = 120;

/** How far from 1 the visual viewport's scale may drift before the Page
 * counts as pinch-zoomed. Browsers report scales like 1.0000001 unzoomed. */
export const ZOOM_EPSILON = 0.01;

const finite = (...values) => values.every(Number.isFinite);

/** Where the bars go for one visual viewport measurement, in CSS pixels.
 * `keyboard` is how much of the layout viewport the keyboard covers; it holds
 * still while iOS pans the visual viewport, unlike `top` and `bottom`, which
 * are the visual viewport's distance from the layout viewport's edges.
 *
 * The bars follow the visual viewport when the Page is zoomed, when a
 * software keyboard covers at least KEYBOARD_MIN_HEIGHT, or, while `editing`
 * (an editable element has focus), when anything covers the bottom at all: a
 * hardware keyboard's shortcut strip is shorter than any software keyboard.
 * Otherwise all four are zero and `height` is the layout height. */
export function viewportInsets({ visualViewport, layoutHeight, editing = false }) {
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
  const zoomed = Math.abs(scale - 1) > ZOOM_EPSILON;
  // Pinch zoom shrinks the visual viewport by the scale; only a keyboard
  // leaves part of the layout viewport uncovered at scale.
  const keyboard = Math.max(0, Math.round(layoutHeight - height * scale));
  const follow = zoomed || keyboard >= KEYBOARD_MIN_HEIGHT || (editing && keyboard > 0);
  if (!follow) return docked;
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

const NOT_TYPED_INTO =
  "[type=button], [type=checkbox], [type=color], [type=file], [type=image], [type=radio], [type=range], [type=reset], [type=submit]";

/** Whether focusing `element` can bring up a keyboard or picker: editable
 * content, a text field or a select. */
export function isEditable(element) {
  if (!element) return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  return tag === "INPUT" && !element.matches?.(NOT_TYPED_INTO);
}

/** Keep the `--vv-*` variables on `root` current. Returns a stop function. */
export function trackVisualViewport(win = window, root = win.document.documentElement) {
  const viewport = win.visualViewport;
  const doc = win.document;
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
      editing: isEditable(doc?.activeElement),
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
  // Focus changes which insets count, so they re-measure too. focusout runs
  // before the next element has focus; the frame audit reads it after.
  const focus = doc?.addEventListener
    ? [fromEvent(doc, "focusin"), fromEvent(doc, "focusout")]
    : [];
  const subscription = merge(fromEvent(viewport, "resize"), fromEvent(viewport, "scroll"), ...focus)
    .pipe(auditTime(0, animationFrameScheduler))
    .subscribe(apply);
  return () => {
    subscription.unsubscribe();
    for (const name of ["--vv-top", "--vv-bottom", "--vv-keyboard", "--vv-height"])
      root.style.removeProperty(name);
  };
}
