/**
 * The chart warm-up an editor's view embeds share (wordgard-views.mjs
 * `chartWarmup`), as a state machine.
 *
 * Each connected embed holds the warm-up for its document, by id. While any
 * document is held, the chart chunk is loaded once, and one document's chart
 * pool is kept warm (view-chart.mjs `warm`). The warm document is a held one
 * whenever the chunk has loaded; when it stops being held, its pool cools a
 * microtask later, so an embed that Wordgard disconnects and connects again
 * in one turn keeps it, and the warm-up moves to another held document if
 * there is one.
 *
 * States:
 * - idle: nothing is held and the chunk isn't loading or loaded. A chunk that
 *   failed comes back here once nothing holds it, so a later embed tries
 *   again.
 * - loading: the chunk is loading. `holds` counts the embeds per document.
 * - failed: the chunk didn't load, and `holds` is not empty. Nothing warms;
 *   each embed's own load reports the failure.
 * - ready: the chunk has loaded. `warm` is the document whose pool is warm,
 *   or null; `settling` is true while a `settle` is deferred.
 *
 * Events: `hold` and `release` (an embed in `doc` connected or disconnected),
 * `loaded` and `loadFailed` (the chunk's import settled), and `settle` (the
 * deferred check after a release).
 *
 * Effects: `load` (import the chunk), `warm` and `cool` (start or let go of
 * `doc`'s warm pool) and `defer` (dispatch `settle` in a microtask).
 */
import { defineMachine, reject } from "../shared/machine.mjs";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const isDoc = (doc) => typeof doc === "string" && doc !== "";
const validHolds = (holds) => {
  check(holds !== null && typeof holds === "object" && !Array.isArray(holds), "holds is an object");
  for (const [doc, count] of Object.entries(holds))
    check(isDoc(doc) && Number.isSafeInteger(count) && count > 0, "each hold count is positive");
};
const withDoc = (value) => {
  only(value, ["type", "doc"]);
  check(isDoc(value.doc), "doc is an id");
};
const bare = (value) => only(value, ["type"]);

export const chartWarmupSpec = Object.freeze({
  name: "chart-warmup",
  states: ["idle", "loading", "failed", "ready"],
  events: ["hold", "release", "loaded", "loadFailed", "settle"],
  cases: {
    "loading/release": ["held", "not-held"],
    "loading/loaded": ["held", "empty"],
    "loading/loadFailed": ["held", "empty"],
    "failed/release": ["others-held", "last", "not-held"],
    "ready/hold": ["first", "move", "same", "other"],
    "ready/release": ["warm-left", "still-held", "settling", "other", "not-held"],
    "ready/settle": ["kept", "move", "cool", "not-settling"],
  },
  validate: {
    states: {
      idle: (state) => only(state, ["name"]),
      loading(state) {
        only(state, ["name", "holds"]);
        validHolds(state.holds);
      },
      failed(state) {
        only(state, ["name", "holds"]);
        validHolds(state.holds);
        check(Object.keys(state.holds).length > 0, "a failed chunk is held");
      },
      ready(state) {
        only(state, ["name", "holds", "warm", "settling"]);
        validHolds(state.holds);
        check(state.warm === null || isDoc(state.warm), "warm is a doc id or null");
        check(typeof state.settling === "boolean", "settling is a boolean");
      },
    },
    events: { hold: withDoc, release: withDoc, loaded: bare, loadFailed: bare, settle: bare },
    effects: { load: bare, warm: withDoc, cool: withDoc, defer: bare },
  },
});

export const WARMUP_REJECT = Object.freeze({
  notHeld: "That document holds no embed",
  noLoad: "No chunk load is running",
  noSettle: "No settle is deferred",
});

const ok = (state, ...effects) => ({ state, effects });
const IDLE = Object.freeze({ name: "idle" });
const LOAD = Object.freeze({ type: "load" });
const DEFER = Object.freeze({ type: "defer" });
const warm = (doc) => ({ type: "warm", doc });
const cool = (doc) => ({ type: "cool", doc });

const held = (holds, doc) => doc !== null && Object.hasOwn(holds, doc);
const add = (holds, doc) => ({ ...holds, [doc]: (held(holds, doc) ? holds[doc] : 0) + 1 });
const remove = (holds, doc) => {
  const next = { ...holds };
  if (next[doc] > 1) next[doc] -= 1;
  else delete next[doc];
  return next;
};
/** The most recently first-held document still held, or null. */
const latest = (holds) => Object.keys(holds).at(-1) ?? null;

function transition(state, event) {
  const { name } = state;
  if (name === "idle") {
    if (event.type === "hold") return ok({ name: "loading", holds: { [event.doc]: 1 } }, LOAD);
    if (event.type === "release") return reject(state, WARMUP_REJECT.notHeld);
    if (event.type === "settle") return reject(state, WARMUP_REJECT.noSettle);
    return reject(state, WARMUP_REJECT.noLoad);
  }
  if (name === "loading") {
    switch (event.type) {
      case "hold":
        return ok({ name, holds: add(state.holds, event.doc) });
      case "release":
        if (!held(state.holds, event.doc)) return reject(state, WARMUP_REJECT.notHeld);
        return ok({ name, holds: remove(state.holds, event.doc) });
      case "loaded": {
        const doc = latest(state.holds);
        return ok(
          { name: "ready", holds: state.holds, warm: doc, settling: false },
          ...(doc === null ? [] : [warm(doc)]),
        );
      }
      case "loadFailed":
        return Object.keys(state.holds).length
          ? ok({ name: "failed", holds: state.holds })
          : ok(IDLE);
      case "settle":
        return reject(state, WARMUP_REJECT.noSettle);
    }
  }
  if (name === "failed") {
    switch (event.type) {
      case "hold":
        return ok({ name, holds: add(state.holds, event.doc) });
      case "release": {
        if (!held(state.holds, event.doc)) return reject(state, WARMUP_REJECT.notHeld);
        const holds = remove(state.holds, event.doc);
        return Object.keys(holds).length ? ok({ name, holds }) : ok(IDLE);
      }
      case "settle":
        return reject(state, WARMUP_REJECT.noSettle);
      default:
        return reject(state, WARMUP_REJECT.noLoad);
    }
  }
  // ready
  switch (event.type) {
    case "hold": {
      const holds = add(state.holds, event.doc);
      if (state.warm === null) return ok({ ...state, holds, warm: event.doc }, warm(event.doc));
      // The warm document's last embed left, and this one is elsewhere: the
      // warm-up moves now rather than at the settle.
      if (state.warm !== event.doc && !held(state.holds, state.warm))
        return ok({ ...state, holds, warm: event.doc }, cool(state.warm), warm(event.doc));
      return ok({ ...state, holds });
    }
    case "release": {
      if (!held(state.holds, event.doc)) return reject(state, WARMUP_REJECT.notHeld);
      const holds = remove(state.holds, event.doc);
      if (state.warm === null || held(holds, state.warm) || state.settling)
        return ok({ ...state, holds });
      return ok({ ...state, holds, settling: true }, DEFER);
    }
    case "settle": {
      if (!state.settling) return reject(state, WARMUP_REJECT.noSettle);
      const settled = { ...state, settling: false };
      if (state.warm === null || held(state.holds, state.warm)) return ok(settled);
      const doc = latest(state.holds);
      return ok({ ...settled, warm: doc }, cool(state.warm), ...(doc === null ? [] : [warm(doc)]));
    }
    default:
      return reject(state, WARMUP_REJECT.noLoad);
  }
}

export const chartWarmupMachine = defineMachine({
  ...chartWarmupSpec,
  initial: IDLE,
  transition,
});
