/**
 * Motion for the comment-on-selection affordance, shared by the CodeMirror
 * editor plane and the rendered-markdown plane.
 *
 * The open is a staged morph driven by the Web Animations API, not CSS: a dot
 * grows to a circle, spreads to a pill, then reveals the label. WAAPI buys two
 * things a CSS keyframe could not. It reverses cleanly with `reverse()` from
 * wherever the open got to (CSS keyframes snap back, and a transition-reverse
 * cannot replay the intermediate "circle" stop). And it lets us measure the
 * label's natural width and animate to that, FLIP-style, instead of guessing a
 * fixed cap that clips long labels.
 *
 * Events are the input, the Animation handle is the manifested state: hover and
 * focus play it forward, leave and blur play it back. CSS owns the resting look;
 * this owns the open.
 */

// Total open duration. The reverse uses the same handle, so close matches.
const OPEN_DURATION_MS = 260;
// Horizontal padding of the open pill, also the width we add when measuring.
const PILL_PADDING_X = 10;
// Height the dot grows to before it spreads (the pill height).
const PILL_HEIGHT = 20;
// Size of the resting dot, kept in sync with comment-affordance.css.
const DOT_SIZE = 8;
const FALLBACK_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

/**
 * Wire hover/focus motion onto an affordance button. Returns a disposer that
 * removes the listeners and cancels the animations. Safe to call where WAAPI is
 * absent (SSR, jsdom): it no-ops and returns a disposer.
 */
export function wireCommentAffordanceMotion(button: HTMLElement): () => void {
  if (typeof window === "undefined" || typeof button.animate !== "function") {
    return () => {};
  }
  const dot = button.querySelector<HTMLElement>(".comment-affordance-dot");
  const label = button.querySelector<HTMLElement>(".comment-affordance-label");
  if (!dot || !label) return () => {};

  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  let dotAnim: Animation | null = null;
  let labelAnim: Animation | null = null;

  const ensure = () => {
    if (dotAnim) return;
    // Read the design tokens from CSS so sizes and easing have one source of
    // truth. Lazy, on first hover, when the button is in the DOM and these
    // custom properties resolve.
    const styles = getComputedStyle(button);
    const easing = styles.getPropertyValue("--comment-affordance-ease").trim() || FALLBACK_EASE;
    const dotSize =
      parseFloat(styles.getPropertyValue("--comment-affordance-dot-size")) || DOT_SIZE;
    const pillHeight =
      parseFloat(styles.getPropertyValue("--comment-affordance-pill-height")) || PILL_HEIGHT;
    const duration = reduceMotion ? 0 : OPEN_DURATION_MS;
    // Measure the label at its natural width (nowrap, so scrollWidth is the full
    // text even while the dot clips it), then grow the pill to fit it exactly.
    const target = Math.ceil(label.scrollWidth) + PILL_PADDING_X * 2;
    // Stage the open with per-keyframe easing: grow to a circle by 40%, then
    // spread to the pill. Overall timing stays linear so each stage owns its
    // own decelerating curve instead of one curve warping the whole sequence.
    dotAnim = dot.animate(
      [
        { maxWidth: `${dotSize}px`, height: `${dotSize}px`, padding: "0px", easing },
        {
          maxWidth: `${pillHeight}px`,
          height: `${pillHeight}px`,
          padding: "0px",
          offset: 0.4,
          easing,
        },
        { maxWidth: `${target}px`, height: `${pillHeight}px`, padding: `0 ${PILL_PADDING_X}px` },
      ],
      { duration, easing: "linear", fill: "both" },
    );
    // Letters fade in only once there is room, in the back half of the spread.
    labelAnim = label.animate([{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }], {
      duration,
      easing: "linear",
      fill: "both",
    });
    for (const anim of [dotAnim, labelAnim]) {
      anim.currentTime = 0;
      anim.pause();
    }
  };

  const drive = (rate: number) => {
    ensure();
    for (const anim of [dotAnim, labelAnim]) {
      if (!anim) continue;
      anim.playbackRate = rate;
      anim.play();
    }
  };

  const open = () => drive(1);
  const close = () => drive(-1);

  button.addEventListener("pointerenter", open);
  button.addEventListener("pointerleave", close);
  button.addEventListener("focus", open);
  button.addEventListener("blur", close);

  return () => {
    button.removeEventListener("pointerenter", open);
    button.removeEventListener("pointerleave", close);
    button.removeEventListener("focus", open);
    button.removeEventListener("blur", close);
    dotAnim?.cancel();
    labelAnim?.cancel();
  };
}
