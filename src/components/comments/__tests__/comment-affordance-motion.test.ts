import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { wireCommentAffordanceMotion } from "../comment-affordance-motion";

/** Records what the helper asks of the Animation handles it drives. */
interface FakeAnimation {
  playbackRate: number;
  currentTime: number | null;
  paused: boolean;
  cancelled: boolean;
  /** Playback rate at each play() call, in order. */
  plays: number[];
  play(): void;
  pause(): void;
  cancel(): void;
}

function stubWebAnimations(): FakeAnimation[] {
  const animations: FakeAnimation[] = [];
  HTMLElement.prototype.animate = function fakeAnimate(
    _keyframes: unknown,
    options: { duration?: number } = {},
  ) {
    const animation: FakeAnimation = {
      playbackRate: 1,
      currentTime: null,
      paused: false,
      cancelled: false,
      plays: [],
      play() {
        this.paused = false;
        this.plays.push(this.playbackRate);
      },
      pause() {
        this.paused = true;
      },
      cancel() {
        this.cancelled = true;
      },
    };
    Object.defineProperty(animation, "duration", { value: options.duration });
    animations.push(animation);
    return animation as unknown as Animation;
  } as typeof HTMLElement.prototype.animate;
  return animations;
}

function mountAffordance(): { zone: HTMLElement; badge: HTMLElement } {
  const zone = document.createElement("span");
  zone.className = "comment-affordance";
  const badge = document.createElement("button");
  badge.className = "comment-affordance-badge";
  const label = document.createElement("span");
  label.className = "comment-affordance-label";
  label.textContent = "Comment";
  badge.appendChild(label);
  zone.appendChild(badge);
  document.body.appendChild(zone);
  return { zone, badge };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  // biome-ignore lint/performance/noDelete: restore the prototype to jsdom's default
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
});

describe("wireCommentAffordanceMotion", () => {
  it("parks the badge open, then shrinks it to a dot once the idle delay passes", () => {
    vi.useFakeTimers();
    const animations = stubWebAnimations();
    const { badge } = mountAffordance();

    const dispose = wireCommentAffordanceMotion(badge, { collapseDelayMs: 1000 });

    // Both handles (the badge box and the label reveal) start at the open end.
    expect(animations).toHaveLength(2);
    for (const animation of animations) {
      expect(animation.currentTime).toBe(260);
      expect(animation.paused).toBe(true);
      expect(animation.plays).toEqual([]);
    }

    vi.advanceTimersByTime(999);
    expect(animations.every((animation) => animation.plays.length === 0)).toBe(true);

    vi.advanceTimersByTime(1);
    // Negative playback rate: the same handle runs the open morph backwards.
    for (const animation of animations) {
      expect(animation.plays).toEqual([-1]);
    }

    dispose();
  });

  it("keeps the badge open when the pointer arrives first, and closes it on leave", () => {
    vi.useFakeTimers();
    const animations = stubWebAnimations();
    const { zone, badge } = mountAffordance();

    const dispose = wireCommentAffordanceMotion(badge, { collapseDelayMs: 1000 });

    zone.dispatchEvent(new Event("pointerenter"));
    vi.advanceTimersByTime(5000);
    // Opened once by the hover; the idle collapse was cancelled, not merely delayed.
    for (const animation of animations) {
      expect(animation.plays).toEqual([1]);
    }

    zone.dispatchEvent(new Event("pointerleave"));
    for (const animation of animations) {
      expect(animation.plays).toEqual([1, -1]);
    }

    dispose();
  });

  it("stops driving the badge once disposed", () => {
    vi.useFakeTimers();
    const animations = stubWebAnimations();
    const { zone, badge } = mountAffordance();

    const dispose = wireCommentAffordanceMotion(badge, { collapseDelayMs: 1000 });
    dispose();

    vi.advanceTimersByTime(5000);
    zone.dispatchEvent(new Event("pointerenter"));
    for (const animation of animations) {
      expect(animation.cancelled).toBe(true);
      expect(animation.plays).toEqual([]);
    }
  });

  it("leaves the badge open where the Web Animations API is unavailable", () => {
    const { badge } = mountAffordance();

    // No animate() on the prototype: jsdom, SSR, older engines.
    expect(() => wireCommentAffordanceMotion(badge)()).not.toThrow();
  });
});
