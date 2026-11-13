// The chart Workers a document shares. Every chart on a Page draws through
// at most CHART_WORKERS Workers (viewer/chart-worker.mjs), started when a
// chart first draws. Each chart is pinned to the Worker with the fewest
// charts when it mounts, and its data is posted to that Worker once.
//
// CHART_WORKERS is 1. Most Pages hold one to three charts, where more Workers
// change nothing; at ten charts three Workers draw 0.1 to 0.3 s sooner but
// cost 70 to 170 MiB more, and a phone pays for memory on every Page with a
// chart (PR 5042 has the numbers). The pool logic is tested at sizes 1 and 2,
// so the constant can change without new code.
//
// A Worker runs one draw at a time (chart-dataflow.mjs serveCharts): first
// draws go ahead of redraws of a chart already on screen, so a resize never
// holds up a chart the reader hasn't seen yet.
//
// `chartPool` is the pure transition function; `createChartPool` runs its
// effects. A draw's timer starts when its Worker posts `start`, so a queue or
// a cold Worker never spends the draw's time. A Worker that doesn't post
// `ready` within CHART_READY_MS, or fails to load, fails the draws waiting on
// it. When a draw outlasts its timer, only that chart fails: the Worker is
// terminated and replaced, and the other charts pinned to it send their data
// again and draw on the replacement. A hidden document holds its draws: the
// Workers running them are terminated, and the draws start again on fresh
// Workers when the document shows. The last chart to leave a Worker
// terminates it, so no Worker outlives its charts. There is no in-page
// fallback: a Worker that can't start fails its charts.
import { Observable } from "rxjs";

export const CHART_WORKERS = 1;
/** How long a new Worker may take to load its script and post `ready`. */
export const CHART_READY_MS = 4_000;
export const WORKER_DIDNT_START = "The chart Worker didn't start.";
/** What a chart says when its draw outlasts its timer. */
export const TIMED_OUT = "This chart took too long to draw.";
// How late a draw's timer may fire before the page counts itself as the one
// that was busy, and how long it then waits for a queued answer.
export const LATE_MS = 250;
export const GRACE_MS = 50;

/**
 * The pool's state. `slots[i]` is one Worker: its generation (each Worker
 * started in a slot gets the next; events from an older one are dropped),
 * its phase (`down`: none running; `starting`; `ready`) and the chart keys
 * pinned to it. `draws[id]` is one draw: its chart key, phase (`queued`:
 * posted, not started; `running`; `held`: waiting for the document to show;
 * `abandoned`: running, but its chart no longer wants it) and message.
 */
export const initialPool = (size = CHART_WORKERS) =>
  Object.freeze({ size, slots: [], keys: {}, draws: {}, hidden: false });

const timeoutResult = Object.freeze({
  error: { message: TIMED_OUT, refusal: true },
  timedOut: true,
});
const failed = (message) => ({ error: { message, refusal: false } });

/** Every draw on `slot` in `phases`, by id. */
const drawsOn = (state, slot, phases) =>
  Object.entries(state.draws).filter(
    ([, draw]) => draw.slot === slot && (!phases || phases.includes(draw.phase)),
  );

const withSlot = (state, index, change) => ({
  ...state,
  slots: state.slots.map((slot, i) => (i === index ? { ...slot, ...change } : slot)),
});

const withDraws = (state, change) => {
  const draws = { ...state.draws };
  for (const [id, draw] of Object.entries(change))
    if (draw === null) delete draws[id];
    else draws[id] = draw;
  return { ...state, draws };
};

/** Start a new Worker in `slot`: send every pinned chart's data, then every
 * queued or held draw on it, in id order. */
function spawn(state, slot) {
  const gen = state.slots[slot].gen + 1;
  let next = withSlot(state, slot, { gen, phase: "starting" });
  const effects = [
    { type: "spawn", slot, gen },
    { type: "timer", name: `ready:${slot}`, kind: "ready", slot, gen },
  ];
  for (const key of next.slots[slot].keys) effects.push({ type: "data", slot, gen, key });
  const waiting = drawsOn(next, slot, ["queued", "held"]).sort(([a], [b]) => a - b);
  const change = {};
  for (const [id, draw] of waiting) {
    change[id] = { ...draw, phase: "queued" };
    effects.push({ type: "post", slot, gen, message: draw.message });
  }
  next = withDraws(next, change);
  return { state: next, effects };
}

/** Terminate the Worker in `slot`, if one runs. */
function stop(state, slot) {
  if (state.slots[slot].phase === "down") return { state, effects: [] };
  return {
    state: withSlot(state, slot, { phase: "down" }),
    effects: [
      { type: "terminate", slot },
      { type: "clear", name: `ready:${slot}` },
    ],
  };
}

/** Terminate `slot`'s Worker and start a fresh one if charts are pinned to
 * it: their data and their queued draws go to the replacement. A draw that
 * was running there is queued again. */
function restart(state, slot) {
  const stopped = stop(state, slot);
  let next = stopped.state;
  const change = {};
  for (const [id, draw] of drawsOn(next, slot, ["running"]))
    change[id] = { ...draw, phase: "queued" };
  next = withDraws(next, change);
  if (!next.slots[slot].keys.length) return { state: next, effects: stopped.effects };
  const started = spawn(next, slot);
  return { state: started.state, effects: [...stopped.effects, ...started.effects] };
}

/** Fail every draw on `slot` with `result` and leave no Worker running. */
function failSlot(state, slot, result) {
  const stopped = stop(state, slot);
  const effects = [...stopped.effects];
  const change = {};
  for (const [id, draw] of drawsOn(stopped.state, slot)) {
    change[id] = null;
    effects.push({ type: "clear", name: `draw:${id}` });
    if (draw.phase !== "abandoned") effects.push({ type: "deliver", id: Number(id), result });
  }
  return { state: withDraws(stopped.state, change), effects };
}

const current = (state, { slot, gen }) =>
  state.slots[slot] && state.slots[slot].gen === gen && state.slots[slot].phase !== "down";

const unchanged = (state) => ({ state, effects: [] });

/**
 * One step of the pool: `event` applied to `state`, with the effects to run.
 * Events carrying `slot` and `gen` come from a Worker; a stale generation is
 * ignored.
 */
export function chartPool(state, event) {
  switch (event.type) {
    case "attach": {
      if (Object.hasOwn(state.keys, event.key)) return unchanged(state);
      let next = state;
      const loads = next.slots.map((slot) => slot.keys.length);
      const least = loads.length ? Math.min(...loads) : 0;
      let slot = loads.indexOf(least);
      if (next.slots.length < next.size && (slot < 0 || least > 0)) {
        slot = next.slots.length;
        next = { ...next, slots: [...next.slots, { gen: 0, phase: "down", keys: [] }] };
      }
      next = withSlot(next, slot, { keys: [...next.slots[slot].keys, event.key] });
      next = { ...next, keys: { ...next.keys, [event.key]: slot } };
      // A pinned chart's data waits for its first draw if its Worker is down.
      if (next.slots[slot].phase === "down") return unchanged(next);
      return {
        state: next,
        effects: [{ type: "data", slot, gen: next.slots[slot].gen, key: event.key }],
      };
    }
    case "detach": {
      if (!Object.hasOwn(state.keys, event.key)) return unchanged(state);
      const slot = state.keys[event.key];
      const keys = { ...state.keys };
      delete keys[event.key];
      let next = { ...state, keys };
      next = withSlot(next, slot, { keys: next.slots[slot].keys.filter((k) => k !== event.key) });
      const alive = next.slots[slot].phase !== "down";
      const gen = next.slots[slot].gen;
      const effects = [];
      const change = {};
      for (const [id, draw] of Object.entries(next.draws)) {
        if (draw.key !== event.key) continue;
        if (draw.phase === "running") change[id] = { ...draw, phase: "abandoned" };
        else if (draw.phase !== "abandoned") {
          change[id] = null;
          if (draw.phase === "queued")
            effects.push({ type: "post", slot, gen, message: { type: "cancel", id: Number(id) } });
        }
      }
      next = withDraws(next, change);
      if (alive)
        effects.push({ type: "post", slot, gen, message: { type: "drop", key: event.key } });
      if (next.slots[slot].keys.length) return { state: next, effects };
      // The last chart left: nothing runs there, abandoned draws included.
      const emptied = failSlot(next, slot, null);
      return { state: emptied.state, effects: [...effects, ...emptied.effects] };
    }
    case "draw": {
      if (!Object.hasOwn(state.keys, event.key)) return unchanged(state);
      const slot = state.keys[event.key];
      const draw = {
        key: event.key,
        slot,
        phase: state.hidden ? "held" : "queued",
        message: event.message,
      };
      const next = withDraws(state, { [event.id]: draw });
      if (state.hidden) return unchanged(next);
      if (next.slots[slot].phase === "down") return spawn(next, slot);
      return {
        state: next,
        effects: [{ type: "post", slot, gen: next.slots[slot].gen, message: event.message }],
      };
    }
    case "cancel": {
      const draw = state.draws[event.id];
      if (!draw || draw.phase === "abandoned") return unchanged(state);
      const { slot } = draw;
      const gen = state.slots[slot].gen;
      if (draw.phase === "held") return unchanged(withDraws(state, { [event.id]: null }));
      if (draw.phase === "queued")
        return {
          state: withDraws(state, { [event.id]: null }),
          effects: [{ type: "post", slot, gen, message: { type: "cancel", id: event.id } }],
        };
      // Running. A Worker can't stop a draw part way, so cut it off only when
      // no other chart is waiting on that Worker; otherwise the draw runs out
      // under its timer and its answer is dropped.
      const others = drawsOn(state, slot, ["queued", "running"]).some(
        ([id, other]) => Number(id) !== event.id && other.key !== draw.key,
      );
      if (others)
        return unchanged(withDraws(state, { [event.id]: { ...draw, phase: "abandoned" } }));
      const restarted = restart(withDraws(state, { [event.id]: null }), slot);
      return {
        state: restarted.state,
        effects: [{ type: "clear", name: `draw:${event.id}` }, ...restarted.effects],
      };
    }
    case "ready": {
      if (!current(state, event) || state.slots[event.slot].phase !== "starting")
        return unchanged(state);
      return {
        state: withSlot(state, event.slot, { phase: "ready" }),
        effects: [{ type: "clear", name: `ready:${event.slot}` }],
      };
    }
    case "start": {
      const draw = state.draws[event.id];
      if (!current(state, event) || !draw || draw.slot !== event.slot || draw.phase !== "queued")
        return unchanged(state);
      return {
        state: withDraws(state, { [event.id]: { ...draw, phase: "running" } }),
        effects: [{ type: "timer", name: `draw:${event.id}`, kind: "draw", id: event.id }],
      };
    }
    case "answer": {
      const draw = state.draws[event.id];
      if (!current(state, event) || !draw || draw.slot !== event.slot) return unchanged(state);
      if (draw.phase !== "running" && draw.phase !== "abandoned") return unchanged(state);
      const effects = [{ type: "clear", name: `draw:${event.id}` }];
      if (draw.phase === "running")
        effects.push({ type: "deliver", id: event.id, result: event.result });
      return { state: withDraws(state, { [event.id]: null }), effects };
    }
    case "drawTimeout": {
      const draw = state.draws[event.id];
      if (!draw || (draw.phase !== "running" && draw.phase !== "abandoned"))
        return unchanged(state);
      const effects = [];
      if (draw.phase === "running")
        effects.push({ type: "deliver", id: event.id, result: timeoutResult });
      const next = withDraws(state, { [event.id]: null });
      // A replacement starts at once only for the other charts pinned there;
      // the timed-out chart alone starts one with its next draw, if any.
      const others = next.slots[draw.slot].keys.some((key) => key !== draw.key);
      const after = others ? restart(next, draw.slot) : stop(next, draw.slot);
      return { state: after.state, effects: [...effects, ...after.effects] };
    }
    case "failed": {
      if (!current(state, event)) return unchanged(state);
      return failSlot(state, event.slot, failed(event.message || WORKER_DIDNT_START));
    }
    case "readyTimeout": {
      if (!current(state, event) || state.slots[event.slot].phase !== "starting")
        return unchanged(state);
      return failSlot(state, event.slot, failed(WORKER_DIDNT_START));
    }
    case "hide": {
      if (state.hidden) return unchanged(state);
      let next = { ...state, hidden: true };
      const effects = [];
      next.slots.forEach((_, slot) => {
        const busy = drawsOn(next, slot, ["queued", "running", "abandoned"]);
        if (!busy.length) return;
        const stopped = stop(next, slot);
        next = stopped.state;
        effects.push(...stopped.effects);
        const change = {};
        for (const [id, draw] of busy) {
          effects.push({ type: "clear", name: `draw:${id}` });
          change[id] = draw.phase === "abandoned" ? null : { ...draw, phase: "held" };
        }
        next = withDraws(next, change);
      });
      return { state: next, effects };
    }
    case "show": {
      if (!state.hidden) return unchanged(state);
      let next = { ...state, hidden: false };
      const effects = [];
      next.slots.forEach((slot, index) => {
        const held = drawsOn(next, index, ["held"]);
        if (!held.length) return;
        if (slot.phase === "down") {
          const started = spawn(next, index);
          next = started.state;
          effects.push(...started.effects);
          return;
        }
        const change = {};
        for (const [id, draw] of held.sort(([a], [b]) => a - b)) {
          change[id] = { ...draw, phase: "queued" };
          effects.push({ type: "post", slot: index, gen: slot.gen, message: draw.message });
        }
        next = withDraws(next, change);
      });
      return { state: next, effects };
    }
  }
  throw new Error(`unknown chart pool event ${event.type}`);
}

/**
 * Run a chart pool for one document. Options:
 * - `create()` starts a Worker (`new Worker(url)`); it may throw.
 * - `size`, `timeoutMs` (a draw, from its `start`), `readyMs`.
 * - `doc`: the document whose visibility holds draws.
 * Returns `{ attach(payload) }`. `payload()` builds a chart's data message
 * for one Worker: `{ datasets, transfer }`, owned by that Worker once posted.
 * `attach` returns `{ draw(message), detach() }`; `draw` is an Observable of
 * one result: the Worker's answer, `{ error }`, or the timeout.
 */
export function createChartPool({
  create,
  size = CHART_WORKERS,
  timeoutMs,
  readyMs = CHART_READY_MS,
  doc = null,
}) {
  let state = initialPool(size);
  const workers = [];
  const timers = new Map();
  const payloads = new Map();
  const deliveries = new Map();
  let keys = 0;
  let ids = 0;

  const pending = [];
  let stepping = false;
  const dispatch = (event) => {
    pending.push(event);
    if (stepping) return;
    stepping = true;
    try {
      while (pending.length) {
        const result = chartPool(state, pending.shift());
        state = result.state;
        for (const effect of result.effects) run(effect);
      }
    } finally {
      stepping = false;
    }
  };

  const clear = (name) => {
    clearTimeout(timers.get(name));
    timers.delete(name);
  };

  function run(effect) {
    switch (effect.type) {
      case "spawn": {
        const { slot, gen } = effect;
        workers[slot]?.terminate();
        workers[slot] = null;
        let worker;
        try {
          worker = create();
        } catch (error) {
          dispatch({ type: "failed", slot, gen, message: error?.message || WORKER_DIDNT_START });
          return;
        }
        worker.addEventListener("message", ({ data }) => {
          if (data?.type === "ready") dispatch({ type: "ready", slot, gen });
          else if (data?.type === "start") dispatch({ type: "start", slot, gen, id: data.id });
          else if (data?.type === "answer") {
            const { type, id, ...result } = data;
            dispatch({ type: "answer", slot, gen, id, result });
          }
        });
        worker.addEventListener("error", (event) => {
          event.preventDefault?.();
          dispatch({ type: "failed", slot, gen, message: event.message || WORKER_DIDNT_START });
        });
        workers[slot] = { worker, gen };
        return;
      }
      case "terminate":
        workers[effect.slot]?.worker.terminate();
        workers[effect.slot] = null;
        return;
      case "post": {
        const target = workers[effect.slot];
        if (target?.gen === effect.gen) target.worker.postMessage(effect.message);
        return;
      }
      case "data": {
        const target = workers[effect.slot];
        if (target?.gen !== effect.gen) return;
        try {
          const { datasets, transfer = [] } = payloads.get(effect.key)();
          target.worker.postMessage({ type: "data", key: effect.key, datasets }, transfer);
        } catch (error) {
          // Data that can't cross (a function in a row) fails that chart's
          // draws, in the Worker, with the sentence.
          target.worker.postMessage({
            type: "data",
            key: effect.key,
            failed: String(error?.message ?? error),
          });
        }
        return;
      }
      case "timer": {
        clear(effect.name);
        if (effect.kind === "ready") {
          const { slot, gen } = effect;
          timers.set(
            effect.name,
            setTimeout(() => dispatch({ type: "readyTimeout", slot, gen }), readyMs),
          );
          return;
        }
        // A timer that fires late means the page's own thread was busy
        // (drawing a large chart, say), not the Worker; an answer may already
        // be queued behind it, so it waits one more beat before cutting off.
        const due = performance.now() + timeoutMs;
        let graced = false;
        const expire = () => {
          if (!graced && performance.now() - due > LATE_MS) {
            graced = true;
            timers.set(effect.name, setTimeout(expire, GRACE_MS));
            return;
          }
          timers.delete(effect.name);
          dispatch({ type: "drawTimeout", id: effect.id });
        };
        timers.set(effect.name, setTimeout(expire, timeoutMs));
        return;
      }
      case "clear":
        return clear(effect.name);
      case "deliver": {
        const deliver = deliveries.get(effect.id);
        deliveries.delete(effect.id);
        deliver?.(effect.result);
        return;
      }
    }
    throw new Error(`unknown chart pool effect ${effect.type}`);
  }

  // The pool listens to its document only while a chart is attached.
  let attached = 0;
  const onVisibility = () => dispatch({ type: doc.visibilityState === "hidden" ? "hide" : "show" });

  return {
    attach(payload) {
      const key = `chart-${++keys}`;
      payloads.set(key, payload);
      if (doc && attached++ === 0) {
        doc.addEventListener("visibilitychange", onVisibility);
        onVisibility();
      }
      dispatch({ type: "attach", key });
      return {
        draw: (message) =>
          new Observable((subscriber) => {
            const id = ++ids;
            deliveries.set(id, (result) => {
              subscriber.next(result);
              subscriber.complete();
            });
            dispatch({ type: "draw", key, id, message: { type: "draw", id, key, ...message } });
            return () => {
              if (deliveries.delete(id)) dispatch({ type: "cancel", id });
            };
          }),
        detach() {
          if (!payloads.delete(key)) return;
          dispatch({ type: "detach", key });
          if (doc && --attached === 0) doc.removeEventListener("visibilitychange", onVisibility);
        },
      };
    },
  };
}
