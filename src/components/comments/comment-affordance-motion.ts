/**
 * Motion for the comment-on-selection affordance, shared by the CodeMirror editor
 * plane and the rendered-markdown plane.
 *
 * The badge mounts open, so the label is readable the moment a selection raises it.
 * If nothing touches it for a beat it shrinks to a dot: a pill parked next to code
 * is noise once it has been read. Hover or focus springs it back open, and leaving
 * shrinks it again.
 *
 * The morph is a staged sequence driven by the Web Animations API, not CSS: the pill
 * spreads down to a circle, then the circle shrinks to a dot (and the reverse on
 * open). WAAPI buys two things a CSS keyframe could not. It reverses cleanly with a
 * negative playback rate from wherever the morph got to (CSS keyframes snap back,
 * and a transition-reverse cannot replay the intermediate "circle" stop). And it
 * lets us measure the badge's natural box and animate to exactly that, FLIP-style,
 * instead of guessing a fixed cap that clips longer labels.
 *
 * Events are the input, the Animation handle is the manifested state: the idle timer
 * and pointer-leave/blur play it toward the dot, hover and focus play it back open.
 * CSS owns the open look; this owns the collapse.
 */

// Total morph duration. Open and close share one handle, so they match.
const MORPH_DURATION_MS = 260;
// Idle time before an untouched badge shrinks to a dot.
const COLLAPSE_DELAY_MS = 1000;
// Diameter of the resting dot, kept in sync with comment-affordance.css.
const DOT_SIZE = 8;
// Horizontal padding assumed only when the badge cannot be measured (not laid out
// yet); the measured path reads the real padding off the element.
const FALLBACK_PILL_PADDING_X = 10;
const FALLBACK_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

export interface CommentAffordanceMotionOptions {
  /** Idle time before the badge shrinks to a dot. */
  collapseDelayMs?: number;
}

/**
 * Wire the collapse-to-dot motion onto an affordance badge. The badge must contain a
 * `.comment-affordance-label` element and normally sits inside a
 * `.comment-affordance` wrapper, which becomes the hover zone so the padding around
 * a collapsed dot still opens it.
 *
 * Returns a disposer that removes the listeners, clears the timer, and cancels the
 * animations (leaving the badge at its CSS open state). Safe to call where WAAPI is
 * absent (SSR, jsdom): it no-ops and returns a disposer, so the badge simply stays
 * open.
 */
export function wireCommentAffordanceMotion(
  badge: HTMLElement,
  options: CommentAffordanceMotionOptions = {},
): () => void {
  if (typeof window === "undefined" || typeof badge.animate !== "function") {
    return () => {};
  }
  const label = badge.querySelector<HTMLElement>(".comment-affordance-label");
  if (!label) return () => {};

  const zone = badge.closest<HTMLElement>(".comment-affordance") ?? badge;
  const collapseDelayMs = options.collapseDelayMs ?? COLLAPSE_DELAY_MS;
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  // 1ms rather than 0 for reduced motion: the morph is effectively instant, but a
  // zero-duration animation has no well-defined "open end" to park at.
  const duration = reduceMotion ? 1 : MORPH_DURATION_MS;

  // Read the design tokens from CSS so sizes and easing have one source of truth,
  // and measure the badge while it is still at its natural size. It mounts open, so
  // this is the real pill box, padding and font included.
  const styles = getComputedStyle(badge);
  const easing = styles.getPropertyValue("--comment-affordance-ease").trim() || FALLBACK_EASE;
  const dotSize = parseFloat(styles.getPropertyValue("--comment-affordance-dot-size")) || DOT_SIZE;
  const paddingX = styles.paddingLeft || `${FALLBACK_PILL_PADDING_X}px`;
  const measured = badge.getBoundingClientRect();
  const pillWidth =
    Math.ceil(measured.width) || Math.ceil(label.scrollWidth) + FALLBACK_PILL_PADDING_X * 2;
  const pillHeight =
    Math.ceil(measured.height) ||
    parseFloat(styles.getPropertyValue("--comment-affordance-pill-height")) ||
    dotSize;

  // Stage the open with per-keyframe easing: grow from the dot to a circle by 40%,
  // then spread to the pill. Overall timing stays linear so each stage owns its own
  // decelerating curve instead of one curve warping the whole sequence.
  const badgeAnim = badge.animate(
    [
      {
        maxWidth: `${dotSize}px`,
        height: `${dotSize}px`,
        paddingLeft: "0px",
        paddingRight: "0px",
        easing,
      },
      {
        maxWidth: `${pillHeight}px`,
        height: `${pillHeight}px`,
        paddingLeft: "0px",
        paddingRight: "0px",
        offset: 0.4,
        easing,
      },
      {
        maxWidth: `${pillWidth}px`,
        height: `${pillHeight}px`,
        paddingLeft: paddingX,
        paddingRight: paddingX,
      },
    ],
    { duration, easing: "linear", fill: "both" },
  );
  // Letters fade in only once there is room, in the back half of the spread.
  const labelAnim = label.animate([{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }], {
    duration,
    easing: "linear",
    fill: "both",
  });
  // Park at the open end: the badge is already open, the morph only ever plays from
  // here toward the dot and back.
  const animations = [badgeAnim, labelAnim];
  for (const animation of animations) {
    animation.currentTime = duration;
    animation.pause();
  }

  let collapseTimer: number | null = null;
  const clearCollapseTimer = () => {
    if (collapseTimer === null) return;
    window.clearTimeout(collapseTimer);
    collapseTimer = null;
  };

  const drive = (rate: number) => {
    for (const animation of animations) {
      animation.playbackRate = rate;
      animation.play();
    }
  };

  const open = () => {
    // The idle collapse only governs the badge's first moment; once the pointer or
    // keyboard has arrived, leave and blur own the close.
    clearCollapseTimer();
    drive(1);
  };
  const close = () => drive(-1);

  const collapseWhenIdle = () => {
    collapseTimer = null;
    // Never shrink out from under a pointer or focus that is already on the
    // affordance (a selection can end right under the cursor); leave and blur close
    // it instead.
    if (zone.matches(":hover") || zone.contains(document.activeElement)) return;
    close();
  };
  collapseTimer = window.setTimeout(collapseWhenIdle, collapseDelayMs);

  zone.addEventListener("pointerenter", open);
  zone.addEventListener("pointerleave", close);
  // pointercancel: an interrupted touch (the system takes over the pointer for a
  // scroll or gesture) fires no pointerleave, so close here too or the badge would
  // stay open.
  zone.addEventListener("pointercancel", close);
  badge.addEventListener("focus", open);
  badge.addEventListener("blur", close);

  return () => {
    clearCollapseTimer();
    zone.removeEventListener("pointerenter", open);
    zone.removeEventListener("pointerleave", close);
    zone.removeEventListener("pointercancel", close);
    badge.removeEventListener("focus", open);
    badge.removeEventListener("blur", close);
    badgeAnim.cancel();
    labelAnim.cancel();
  };
}