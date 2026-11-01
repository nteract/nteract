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

/** A caret that leaves one block and lands in another within this window is
 * one move. Blocks measure on their own frames, so the old block can report
 * the departure before the new block reports the arrival. */
export const GLIDE_HANDOFF_MS = 1000;

export const HIDDEN = Object.freeze({ name: "hidden", last: null });

const point = ({ x, y, height }) => ({ x, y, height });

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
 *
 * `config` is `{ enabled, reducedMotion, maxJumpPx, handoffMs? }`.
 * Returns `{ state, effect }`. Effects are data, run by the caller after the
 * transition: `{ type: "glide", anchor, from, to }` or `{ type: "cancel" }`.
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
      effect: s.name === "gliding" ? { type: "cancel" } : null,
    };
  }
  if (event.type === "settled") {
    if (s.name !== "gliding" || s.anchor !== event.anchor) return { state: s, effect: null };
    const { from: _from, ...rest } = s;
    return { state: { ...rest, name: "resting" }, effect: null };
  }
  throw Error(`Unknown caret glide event: ${event.type}`);
}

// A new anchor. Guards: the experiment is on, motion is allowed, the caret
// actually moved, and the move is within the long-jump limit.
function move(previous, next, config, wasGliding) {
  const distance = Math.hypot(next.x - previous.x, next.y - previous.y);
  if (
    !config.enabled ||
    config.reducedMotion ||
    distance < 1 ||
    (config.maxJumpPx > 0 && distance > config.maxJumpPx)
  )
    return {
      state: { name: "resting", ...next },
      effect: wasGliding ? { type: "cancel" } : null,
    };
  const from = point(previous);
  return {
    state: { name: "gliding", ...next, from },
    effect: { type: "glide", anchor: next.anchor, from, to: point(next) },
  };
}

/**
 * One Page's caret motion: a state per agent caret, shared by every block's
 * editor so a move between blocks is one glide. Each block reports the agent
 * carets it measured; effects come back for that block to run.
 */
export function createCaretGlide({ settings, now, reducedMotion = () => false }) {
  const states = new Map();
  const shown = new Map();
  const config = () => ({
    enabled: settings.enabled,
    reducedMotion: reducedMotion(),
    maxJumpPx: settings.maxJumpPx,
  });
  const step = (session, event) => {
    const { state, effect } = glideTransition(states.get(session), event, config());
    if (state.name === "hidden" && !state.last) states.delete(session);
    else states.set(session, state);
    return effect ? { session, ...effect } : null;
  };
  return {
    settings,
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
  };
}

const glides = new WeakMap();
/** The caret motion for one Page session, shared by its block editors. */
export function caretGlideFor(replica, options) {
  if (!glides.has(replica)) glides.set(replica, createCaretGlide(options));
  return glides.get(replica);
}

/**
 * Run glide effects against one block's caret layer. `offset` is the layer's
 * position within the article, so article-relative points become layer
 * positions. Agent carets carry `data-glide="<session>"`; ghosts go in
 * `ghostLayer`. The Web Animations API moves the caret with a transform, so
 * layout never reflows. Returns nothing; finished glides call `onSettled`.
 */
export function runGlideEffects({
  effects,
  layer,
  ghostLayer,
  offset,
  settings,
  running,
  onSettled,
}) {
  for (const effect of effects) {
    const caret = [...(layer?.querySelectorAll("[data-glide]") ?? [])].find(
      (element) => element.dataset.glide === effect.session,
    );
    running.get(effect.session)?.cancel();
    running.delete(effect.session);
    if (effect.type !== "glide") continue;
    const from = { x: effect.from.x - offset.x, y: effect.from.y - offset.y };
    if (caret && settings.ghostFadeMs > 0 && ghostLayer) {
      const ghost = ghostLayer.ownerDocument.createElement("span");
      ghost.className = "agent-caret-ghost";
      ghost.dataset.glideGhost = effect.session;
      ghost.style.left = `${from.x}px`;
      ghost.style.top = `${from.y}px`;
      ghost.style.height = `${effect.from.height}px`;
      const color = caret.style.getPropertyValue("--peer-color");
      if (color) ghost.style.setProperty("--peer-color", color);
      ghostLayer.append(ghost);
      const fade = ghost.animate?.([{ opacity: 0.3 }, { opacity: 0 }], {
        duration: settings.ghostFadeMs,
        easing: "ease-out",
        fill: "forwards",
      });
      if (fade)
        fade.finished.then(
          () => ghost.remove(),
          () => ghost.remove(),
        );
      else ghost.remove();
    }
    if (!caret?.animate || settings.durationMs <= 0) {
      onSettled(effect.session, effect.anchor);
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
      onSettled(effect.session, effect.anchor);
      continue;
    }
    running.set(effect.session, animation);
    animation.finished.then(
      () => {
        if (running.get(effect.session) === animation) running.delete(effect.session);
        onSettled(effect.session, effect.anchor);
      },
      () => {
        // Cancelled by a newer effect, which owns the caret now.
      },
    );
  }
}
