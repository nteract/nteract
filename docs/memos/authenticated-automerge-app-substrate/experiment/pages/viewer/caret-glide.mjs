// Agent caret glide (experiment, see GLIDE_DEFAULTS in feature-flags.mjs).
//
// A write batch lands all at once, so the honest motion is the move itself:
// when an agent's next batch lands somewhere new, its caret glides there from
// where it was and a ghost fades at the old spot. Only agent carets glide, and
// only on an anchor change: a new agent record (agent id, seq and the write's
// end cursor). Text edits that shift a caret keep its anchor, so they move it
// without a glide.
//
// Positions are relative to the Page's article, so a caret that leaves one
// block's editor and lands in another is still one move, and scrolling does
// not change them.
import { defer, distinctUntilChanged, filter, fromEvent, map, of, share, startWith } from "rxjs";

/** A caret that leaves one block and lands in another within this window is
 * one move. Blocks measure on their own frames, so the old block can report
 * the departure before the new block reports the arrival. */
export const GLIDE_HANDOFF_MS = 1000;

export const HIDDEN = Object.freeze({ name: "hidden", last: null });

const point = ({ x, y, height }) => ({ x, y, height });
const CANCEL = Object.freeze({ type: "cancel" });

/**
 * The one transition function for one agent's caret.
 *
 * States:
 * - `hidden`: no caret on screen. `last` remembers where it was for
 *   GLIDE_HANDOFF_MS, so a block-to-block move still glides.
 * - `resting`: the caret is at `anchor`, drawn at x/y.
 * - `gliding`: the caret is moving from `from` to x/y for `anchor`.
 *
 * Events:
 * - `{ type: "observed", anchor, block, x, y, height, at }` a block measured
 *   the caret.
 * - `{ type: "departed", block, at }` a block stopped showing the caret.
 * - `{ type: "settled", anchor }` the glide for `anchor` finished.
 * - `{ type: "motion-reduced" }` the browser now prefers reduced motion.
 *
 * `config` is `{ enabled, reducedMotion, maxJumpPx, handoffMs? }`.
 * Returns `{ state, effect }`. Effects are data, run by the caller after the
 * transition:
 * - `{ type: "glide", anchor, from, to, interrupts }` move the caret from
 *   `from` to `to` and leave a ghost at `from`. `interrupts` says a glide is
 *   still running; the caller starts from where that glide has drawn the
 *   caret, which only it knows.
 * - `{ type: "cancel" }` stop the caret's motion so it sits at its anchor,
 *   and remove its ghosts.
 */
export function glideTransition(state, event, config) {
  const s = state ?? HIDDEN;
  if (event.type === "observed") {
    const next = {
      anchor: event.anchor,
      block: event.block,
      x: event.x,
      y: event.y,
      height: event.height,
    };
    if (s.name === "hidden") {
      const recent =
        s.last && event.at - s.last.at <= (config.handoffMs ?? GLIDE_HANDOFF_MS) ? s.last : null;
      // First appearance, or the same write reappearing: no glide.
      if (!recent || recent.anchor === event.anchor)
        return { state: { name: "resting", ...next }, effect: null };
      return move(recent, next, config, false);
    }
    // Same anchor: a re-publish, an idle fade, or text shifting the caret.
    if (s.anchor === event.anchor) return { state: { ...s, ...next }, effect: null };
    return move(s, next, config, s.name === "gliding");
  }
  if (event.type === "departed") {
    if (s.name === "hidden" || s.block !== event.block) return { state: s, effect: null };
    return {
      state: {
        name: "hidden",
        last: { anchor: s.anchor, block: s.block, ...point(s), at: event.at },
      },
      effect: CANCEL,
    };
  }
  if (event.type === "settled") {
    if (s.name !== "gliding" || s.anchor !== event.anchor) return { state: s, effect: null };
    return { state: resting(s), effect: null };
  }
  if (event.type === "motion-reduced") {
    // Snap to the anchor and drop any ghost still fading.
    if (s.name === "hidden") return { state: s, effect: null };
    return { state: resting(s), effect: CANCEL };
  }
  throw Error(`Unknown caret glide event: ${event.type}`);
}

function resting(s) {
  const { from: _from, ...rest } = s;
  return { ...rest, name: "resting" };
}

// A new anchor. Guards: the experiment is on, motion is allowed, the caret
// actually moved, and the move is within the long-jump limit.
function move(previous, next, config, interrupts) {
  const distance = Math.hypot(next.x - previous.x, next.y - previous.y);
  if (
    !config.enabled ||
    config.reducedMotion ||
    distance < 1 ||
    (config.maxJumpPx > 0 && distance > config.maxJumpPx)
  )
    return { state: { name: "resting", ...next }, effect: interrupts ? CANCEL : null };
  const from = point(previous);
  return {
    state: { name: "gliding", ...next, from },
    effect: { type: "glide", anchor: next.anchor, from, to: point(next), interrupts },
  };
}

/**
 * One Page's caret motion: a state per agent caret, shared by every block's
 * editor so a move between blocks is one glide. Each block reports the agent
 * carets it measured; effects come back for that block to run.
 *
 * `reducedMotion$` emits the browser's reduced-motion preference, current
 * value first. While any block subscribes to `cancels$`, the preference is
 * followed; turning it on emits cancel effects for every caret, which each
 * block runs against its own animations.
 */
export function createCaretGlide({ settings, now, reducedMotion$ = of(false) }) {
  const states = new Map();
  const shown = new Map();
  let reduced = false;
  const config = () => ({
    enabled: settings.enabled,
    reducedMotion: reduced,
    maxJumpPx: settings.maxJumpPx,
  });
  const step = (session, event) => {
    const { state, effect } = glideTransition(states.get(session), event, config());
    if (state.name === "hidden" && !state.last) states.delete(session);
    else states.set(session, state);
    return effect ? { session, ...effect } : null;
  };
  const cancels$ = reducedMotion$.pipe(
    distinctUntilChanged(),
    map((value) => {
      reduced = value;
      if (!value) return [];
      return [...states.keys()]
        .map((session) => step(session, { type: "motion-reduced" }))
        .filter(Boolean);
    }),
    filter((effects) => effects.length > 0),
    share(),
  );
  return {
    settings,
    cancels$,
    /** `carets`: `[{ session, anchor, x, y, height }]`, article-relative. */
    observe(block, carets) {
      const at = now();
      const effects = [];
      const previous = shown.get(block) ?? new Set();
      const current = new Set();
      for (const caret of carets) {
        current.add(caret.session);
        const effect = step(caret.session, { type: "observed", block, at, ...caret });
        if (effect) effects.push(effect);
      }
      for (const session of previous)
        if (!current.has(session)) {
          const effect = step(session, { type: "departed", block, at });
          if (effect) effects.push(effect);
        }
      if (current.size) shown.set(block, current);
      else shown.delete(block);
      return effects;
    },
    settle(session, anchor) {
      step(session, { type: "settled", anchor });
    },
    /** The block's editor is gone. */
    release(block) {
      const at = now();
      for (const session of shown.get(block) ?? []) step(session, { type: "departed", block, at });
      shown.delete(block);
    },
    state: (session) => states.get(session) ?? HIDDEN,
    /** Whether an effect still matches the state it came from. A glide that
     * waited for a render is stale once its caret stopped gliding to that
     * anchor: a newer write, a removal, or reduced motion came first. */
    current(effect) {
      if (effect.type !== "glide") return true;
      const state = states.get(effect.session);
      return !reduced && state?.name === "gliding" && state.anchor === effect.anchor;
    },
  };
}

/** A media query's matches: the value at subscribe time, then each change.
 * The stream outlives its subscribers, so the first value is read late. */
export const mediaMatches$ = (query) =>
  defer(() =>
    fromEvent(query, "change").pipe(
      map((event) => event.matches),
      startWith(query.matches),
    ),
  );

const glides = new WeakMap();
/** The caret motion for one Page session, shared by its block editors. */
export function caretGlideFor(replica, options) {
  if (!glides.has(replica)) glides.set(replica, createCaretGlide(options));
  return glides.get(replica);
}

/**
 * Runs glide effects against one block's caret layer and owns every
 * animation and ghost it starts, so cancel and dispose leave nothing behind.
 * Agent carets carry `data-glide="<session>"`; ghosts go in `ghostLayer`. The
 * Web Animations API moves the caret with a transform, so layout never
 * reflows. Finished glides call `onSettled`.
 *
 * Measured effects wait in `queue` until React has drawn each caret at its
 * new position, then `flush` runs the ones `isCurrent` still accepts. A
 * cancel drops queued glides for its caret.
 */
export function createGlideRunner({
  layer,
  ghostLayer,
  settings,
  onSettled,
  isCurrent = () => true,
}) {
  // Batches of { effects, offset } waiting for a render.
  let pending = [];
  // session -> { animation, from, to }, in layer coordinates.
  const running = new Map();
  // session -> Set of { element, animation }.
  const ghosts = new Map();
  const caretFor = (session) =>
    [...(layer?.querySelectorAll("[data-glide]") ?? [])].find(
      (element) => element.dataset.glide === session,
    );
  const stop = (session) => {
    const record = running.get(session);
    running.delete(session);
    record?.animation.cancel();
  };
  const removeGhosts = (session) => {
    for (const ghost of ghosts.get(session) ?? []) {
      ghost.animation?.cancel();
      ghost.element.remove();
    }
    ghosts.delete(session);
  };
  // Where a running glide has drawn the caret: its eased progress between
  // the points it started with. Read once, when a newer glide interrupts it.
  const drawn = ({ animation, from, to }) => {
    const progress = animation.effect?.getComputedTiming?.().progress;
    if (typeof progress !== "number") return to;
    return { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress };
  };
  function addGhost(session, caret, at, height) {
    const element = ghostLayer.ownerDocument.createElement("span");
    element.className = "agent-caret-ghost";
    element.dataset.glideGhost = session;
    element.style.left = `${at.x}px`;
    element.style.top = `${at.y}px`;
    element.style.height = `${height}px`;
    const color = caret.style.getPropertyValue("--peer-color");
    if (color) element.style.setProperty("--peer-color", color);
    ghostLayer.append(element);
    const animation = element.animate?.([{ opacity: 0.3 }, { opacity: 0 }], {
      duration: settings.ghostFadeMs,
      easing: "ease-out",
      fill: "forwards",
    });
    if (!animation) return element.remove();
    const ghost = { element, animation };
    if (!ghosts.has(session)) ghosts.set(session, new Set());
    ghosts.get(session).add(ghost);
    const done = () => {
      element.remove();
      ghosts.get(session)?.delete(ghost);
      if (ghosts.get(session)?.size === 0) ghosts.delete(session);
    };
    animation.finished.then(done, done);
  }
  const runner = {
    /** `offset` is the layer's position within the article. */
    queue(effects, offset) {
      if (effects.length) pending.push({ effects, offset });
    },
    flush() {
      const batches = pending;
      pending = [];
      for (const { effects, offset } of batches) runner.run(effects.filter(isCurrent), offset);
    },
    run(effects, offset = { x: 0, y: 0 }) {
      for (const effect of effects) {
        const { session } = effect;
        if (effect.type !== "glide") {
          pending = pending.map((batch) => ({
            ...batch,
            effects: batch.effects.filter((queued) => queued.session !== session),
          }));
          stop(session);
          removeGhosts(session);
          continue;
        }
        const previous = running.get(session);
        const from =
          effect.interrupts && previous
            ? drawn(previous)
            : { x: effect.from.x - offset.x, y: effect.from.y - offset.y };
        stop(session);
        const caret = caretFor(session);
        if (caret && settings.ghostFadeMs > 0 && ghostLayer)
          addGhost(session, caret, from, effect.from.height);
        if (!caret?.animate || settings.durationMs <= 0) {
          onSettled(session, effect.anchor);
          continue;
        }
        const to = { x: effect.to.x - offset.x, y: effect.to.y - offset.y };
        let animation;
        try {
          animation = caret.animate(
            [
              { transform: `translate(${from.x - to.x}px, ${from.y - to.y}px)` },
              { transform: "translate(0px, 0px)" },
            ],
            { duration: settings.durationMs, easing: settings.easing },
          );
        } catch {
          onSettled(session, effect.anchor);
          continue;
        }
        const record = { animation, from, to };
        running.set(session, record);
        animation.finished.then(
          () => {
            if (running.get(session) !== record) return;
            running.delete(session);
            onSettled(session, effect.anchor);
          },
          () => {
            // Cancelled: whoever cancelled it owns the caret now.
          },
        );
      }
    },
    /** The editor is gone: stop every glide and remove every ghost. */
    dispose() {
      pending = [];
      for (const session of running.keys()) stop(session);
      for (const session of ghosts.keys()) removeGhosts(session);
    },
    get running() {
      return running.size;
    },
    get ghosts() {
      return [...ghosts.values()].reduce((total, set) => total + set.size, 0);
    },
  };
  return runner;
}
