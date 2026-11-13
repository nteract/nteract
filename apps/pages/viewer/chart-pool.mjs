// The chart Workers a document shares, and the page's dispatch to them.
// Every chart on a Page draws through at most CHART_WORKERS Workers
// (viewer/chart-worker.mjs), each started when a chart pinned to it first
// draws. Each chart is pinned to the Worker with the fewest charts when it
// mounts.
//
// CHART_WORKERS is 1. Most Pages hold one to three charts, where more Workers
// change nothing; at ten charts three Workers draw 0.1 to 0.3 s sooner but
// cost 70 to 170 MiB more, and a phone pays for memory on every Page with a
// chart (PR 5042 has the numbers). The pool is tested at sizes 1 and 2, so
// the constant can change without new code.
//
// The page owns dispatch: it hands a Worker one job at a time and knows which
// job that is and when it was posted. A job carries the chart's data the
// first time that Worker draws the chart, so decoding and normalizing the
// data run inside the job. One timer, CHART_TIMEOUT_MS from the post, covers
// the whole job: data, compile, dataflow, answer. A job the page no longer
// wants while its Worker runs it stays watched by that timer; if it hangs,
// the Worker is replaced. Waiting jobs are picked first draws first, then in
// the order they came.
//
// A Page that holds a chart warms the pool before its first chart draws
// (`warm`): the Worker it will draw in starts, with no job, so it is ready
// and probed by the time the chart's data is. While the pool is warm, a
// Worker whose last chart leaves stays; `cool` stops a Worker no chart
// holds.
//
// `chartPool` is the pure transition function over named Worker states and
// job states (the table below); `createChartPool` runs its effects.
//
// Worker (slot) states:
//   down      no Worker running
//   starting  started, waiting for `ready` (CHART_READY_MS)
//   probing   ready, measuring the font probe (chart-font.mjs) within the
//             same CHART_READY_MS; its answer sets `slot.font`, the stack
//             every chart on this Worker generation draws in
//   idle      ready, no job
//   busy      running exactly one job, `slot.job`
// Job states:
//   waiting    in the page's queue
//   running    posted to its Worker, watched by its timer
//   abandoned  running, but its chart no longer wants the answer
//
// A Worker that doesn't post `ready` and its probe answer in time, or fails
// while starting or probing, fails every job waiting on it. One that fails while running a job, or sends a
// message that isn't a valid answer to its one job, fails that job and is
// replaced for the others. A Worker started warm that fails, with no job
// waiting, goes down quietly; the next draw starts it again. When a job
// outlasts its timer, only that chart fails. A hidden document stops Workers
// that are starting or busy and holds the jobs; they run again when it
// shows. The last chart to leave a Worker terminates it, unless the pool is
// warm. There is no in-page fallback.
import { Observable } from "rxjs";
import {
  CHART_FALLBACK_FONT,
  PROBE_MAX_WIDTH,
  chooseChartFont,
  probeCount,
  probeItems,
} from "./chart-font.mjs";

export const CHART_WORKERS = 1;
/** How long a new Worker may take to load its script, post `ready` and
 * answer the font probe. */
export const CHART_READY_MS = 4_000;
export const WORKER_DIDNT_START = "The chart Worker didn't start.";
export const WORKER_FAILED = "The chart Worker stopped.";
/** What a chart says when its job outlasts its timer. */
export const TIMED_OUT = "This chart took too long to draw.";
// How late a job's timer may fire before the page counts itself as the one
// that was busy, and how long it then waits for an answer already queued.
export const LATE_MS = 250;
export const GRACE_MS = 50;
/** Longest error message a Worker's answer may carry to the page. */
export const WORKER_MESSAGE_MAX = 300;

export const initialPool = (size = CHART_WORKERS) =>
  Object.freeze({
    size,
    hidden: false,
    warm: false,
    slots: [],
    keys: new Map(),
    jobs: new Map(),
  });

const timeoutResult = Object.freeze({
  error: Object.freeze({ message: TIMED_OUT, refusal: true }),
  timedOut: true,
});
const failure = (message) => ({ error: { message, refusal: false } });

const setSlot = (state, index, change) => ({
  ...state,
  slots: state.slots.map((slot, i) => (i === index ? { ...slot, ...change } : slot)),
});
const setJobs = (state, change) => {
  const jobs = new Map(state.jobs);
  for (const [id, job] of change)
    if (job === null) jobs.delete(id);
    else jobs.set(id, job);
  return { ...state, jobs };
};
const jobsOn = (state, slot, phases) =>
  [...state.jobs].filter(([, job]) => job.slot === slot && phases.includes(job.phase));

/** Start `slot`'s Worker, which is down. */
function start(state, slot) {
  const gen = state.slots[slot].gen + 1;
  return {
    state: setSlot(state, slot, { gen, phase: "starting", job: null, loaded: [], font: null }),
    effects: [
      { type: "spawn", slot, gen },
      { type: "timer", name: `ready:${slot}`, kind: "ready", slot, gen },
    ],
  };
}

const newSlot = () => ({ gen: 0, phase: "down", job: null, keys: [], loaded: [], font: null });

/** Run what can run on `slot`: start its Worker if it's down and a job
 * waits, or post the next waiting job if it's idle. */
function pump(state, slot) {
  if (state.hidden) return { state, effects: [] };
  const current = state.slots[slot];
  const waiting = jobsOn(state, slot, ["waiting"]);
  if (!waiting.length) return { state, effects: [] };
  if (current.phase === "down") return start(state, slot);
  if (current.phase !== "idle") return { state, effects: [] };
  // First draws before redraws, then in the order they came.
  const [[id, job]] = waiting.sort(
    ([a, x], [b, y]) => Number(x.redraw) - Number(y.redraw) || a - b,
  );
  const withData = !current.loaded.includes(job.key);
  let next = setSlot(state, slot, {
    phase: "busy",
    job: id,
    loaded: withData ? [...current.loaded, job.key] : current.loaded,
  });
  next = setJobs(next, [[id, { ...job, phase: "running" }]]);
  return {
    state: next,
    effects: [
      {
        type: "job",
        slot,
        gen: current.gen,
        id,
        key: job.key,
        withData,
        font: current.font,
        message: job.message,
      },
      { type: "timer", name: `job:${id}`, kind: "job", id },
    ],
  };
}

/** Terminate `slot`'s Worker. Its running or abandoned job leaves with it;
 * `result` is delivered to a running one (null: delivered to none). Jobs
 * waiting on the slot stay, unless `failWaiting`. */
function stop(state, slot, result, { failWaiting = false } = {}) {
  const effects = [];
  const current = state.slots[slot];
  if (current.phase !== "down")
    effects.push({ type: "terminate", slot }, { type: "clear", name: `ready:${slot}` });
  const change = [];
  for (const [id, job] of state.jobs) {
    if (job.slot !== slot) continue;
    const active = job.phase === "running" || job.phase === "abandoned";
    if (!active && !(failWaiting && job.phase === "waiting")) continue;
    change.push([id, null]);
    effects.push({ type: "clear", name: `job:${id}` });
    if (job.phase !== "abandoned" && result) effects.push({ type: "deliver", id, result });
  }
  const next = setJobs(setSlot(state, slot, { phase: "down", job: null, loaded: [] }), change);
  return { state: next, effects };
}

const then = (first, step) => {
  const second = step(first.state);
  return { state: second.state, effects: [...first.effects, ...second.effects] };
};
const unchanged = (state) => ({ state, effects: [] });
const fromWorker = (state, { slot, gen }) =>
  state.slots[slot]?.gen === gen && state.slots[slot].phase !== "down";

/**
 * One step of the pool: `event` applied to `state`, with the effects to run.
 * Events with `slot` and `gen` come from a Worker; one from an older Worker
 * is ignored.
 */
export function chartPool(state, event) {
  switch (event.type) {
    case "attach": {
      if (state.keys.has(event.key)) return unchanged(state);
      let next = state;
      const loads = next.slots.map((slot) => slot.keys.length);
      const least = loads.length ? Math.min(...loads) : 0;
      let slot = loads.indexOf(least);
      if (next.slots.length < next.size && (slot < 0 || least > 0)) {
        slot = next.slots.length;
        next = { ...next, slots: [...next.slots, newSlot()] };
      }
      next = setSlot(next, slot, { keys: [...next.slots[slot].keys, event.key] });
      return unchanged({ ...next, keys: new Map(next.keys).set(event.key, slot) });
    }
    case "detach": {
      if (!state.keys.has(event.key)) return unchanged(state);
      const slot = state.keys.get(event.key);
      const keys = new Map(state.keys);
      keys.delete(event.key);
      const current = state.slots[slot];
      let next = setSlot({ ...state, keys }, slot, {
        keys: current.keys.filter((key) => key !== event.key),
        loaded: current.loaded.filter((key) => key !== event.key),
      });
      const change = [];
      for (const [id, job] of next.jobs) {
        if (job.key !== event.key) continue;
        if (job.phase === "waiting") change.push([id, null]);
        else if (job.phase === "running") change.push([id, { ...job, phase: "abandoned" }]);
      }
      next = setJobs(next, change);
      if (!next.slots[slot].keys.length && !next.warm) return stop(next, slot, null);
      const effects =
        current.phase !== "down" && current.loaded.includes(event.key)
          ? [{ type: "post", slot, gen: current.gen, message: { type: "drop", key: event.key } }]
          : [];
      return { state: next, effects };
    }
    case "draw": {
      if (!state.keys.has(event.key) || state.jobs.has(event.id)) return unchanged(state);
      const slot = state.keys.get(event.key);
      const job = {
        key: event.key,
        slot,
        phase: "waiting",
        redraw: event.redraw === true,
        message: event.message,
      };
      return pump(setJobs(state, [[event.id, job]]), slot);
    }
    case "cancel": {
      const job = state.jobs.get(event.id);
      if (!job || job.phase === "abandoned") return unchanged(state);
      if (job.phase === "waiting") return unchanged(setJobs(state, [[event.id, null]]));
      // Running. A Worker can't stop a job part way. When no other chart
      // waits on it, the Worker is replaced at once; otherwise the job runs
      // out under its timer, and its answer is dropped.
      const others = jobsOn(state, job.slot, ["waiting"]).some(
        ([, other]) => other.key !== job.key,
      );
      if (others) return unchanged(setJobs(state, [[event.id, { ...job, phase: "abandoned" }]]));
      return then(stop(state, job.slot, null), (next) => pump(next, job.slot));
    }
    case "ready": {
      if (!fromWorker(state, event) || state.slots[event.slot].phase !== "starting")
        return unchanged(state);
      // The ready timer keeps running until the probe answers.
      const { gen } = state.slots[event.slot];
      return {
        state: setSlot(state, event.slot, { phase: "probing" }),
        effects: [{ type: "probe", slot: event.slot, gen }],
      };
    }
    case "probed": {
      if (!fromWorker(state, event)) return unchanged(state);
      // A correct Worker answers the probe once, while it's being probed.
      if (state.slots[event.slot].phase !== "probing")
        return chartPool(state, { ...event, type: "failed", message: WORKER_FAILED });
      const font = chooseChartFont(event.stacks, event.page, event.worker);
      const probed = {
        state: setSlot(state, event.slot, { phase: "idle", font }),
        effects: [{ type: "clear", name: `ready:${event.slot}` }],
      };
      return then(probed, (next) => pump(next, event.slot));
    }
    case "answer": {
      if (!fromWorker(state, event)) return unchanged(state);
      const current = state.slots[event.slot];
      // A correct Worker answers only its one job.
      if (current.phase !== "busy" || current.job !== event.id)
        return chartPool(state, { ...event, type: "failed", message: WORKER_FAILED });
      const job = state.jobs.get(event.id);
      const effects = [{ type: "clear", name: `job:${event.id}` }];
      if (job.phase === "running")
        effects.push({ type: "deliver", id: event.id, result: event.result });
      const next = setSlot(setJobs(state, [[event.id, null]]), event.slot, {
        phase: "idle",
        job: null,
      });
      return then({ state: next, effects }, (after) => pump(after, event.slot));
    }
    case "jobTimeout": {
      const job = state.jobs.get(event.id);
      if (!job || (job.phase !== "running" && job.phase !== "abandoned")) return unchanged(state);
      return then(stop(state, job.slot, timeoutResult), (next) => pump(next, job.slot));
    }
    case "failed": {
      if (!fromWorker(state, event)) return unchanged(state);
      const result = failure(event.message || WORKER_FAILED);
      // A Worker that never started fails every job waiting on it; one that
      // fails later fails its own job, and the others get a fresh Worker.
      if (["starting", "probing"].includes(state.slots[event.slot].phase))
        return stop(state, event.slot, failure(event.message || WORKER_DIDNT_START), {
          failWaiting: true,
        });
      return then(stop(state, event.slot, result), (next) => pump(next, event.slot));
    }
    case "readyTimeout": {
      if (
        !fromWorker(state, event) ||
        !["starting", "probing"].includes(state.slots[event.slot].phase)
      )
        return unchanged(state);
      return stop(state, event.slot, failure(WORKER_DIDNT_START), { failWaiting: true });
    }
    case "warm": {
      // Start the Worker the first chart will join (slot 0, the least
      // loaded), unless a Worker is already up.
      if (state.warm) return unchanged(state);
      const next = { ...state, warm: true };
      if (next.hidden || next.size < 1 || next.slots.some((slot) => slot.phase !== "down"))
        return unchanged(next);
      return start(next.slots.length ? next : { ...next, slots: [newSlot()] }, 0);
    }
    case "cool": {
      if (!state.warm) return unchanged(state);
      let result = unchanged({ ...state, warm: false });
      state.slots.forEach((slot, index) => {
        if (slot.keys.length || slot.phase === "down") return;
        result = then(result, (next) => stop(next, index, null));
      });
      return result;
    }
    case "hide": {
      if (state.hidden) return unchanged(state);
      let result = unchanged({ ...state, hidden: true });
      state.slots.forEach((slot, index) => {
        if (!["starting", "probing", "busy"].includes(slot.phase)) return;
        result = then(result, (next) => {
          // The running job waits again; an abandoned one leaves.
          const change = [];
          for (const [id, job] of next.jobs)
            if (job.slot === index && job.phase === "running")
              change.push([id, { ...job, phase: "waiting" }]);
          return stop(setJobs(next, change), index, null);
        });
      });
      return result;
    }
    case "show": {
      if (!state.hidden) return unchanged(state);
      let result = unchanged({ ...state, hidden: false });
      state.slots.forEach((_, index) => {
        result = then(result, (next) => pump(next, index));
      });
      return result;
    }
  }
  throw new Error(`unknown chart pool event ${event.type}`);
}

/** A Worker's error message as the page may show it: one line of text of at
 * most WORKER_MESSAGE_MAX characters, or a stand-in. */
function workerError(error) {
  const text = typeof error?.message === "string" ? error.message : "";
  const line = text.length <= WORKER_MESSAGE_MAX * 4 ? text.replace(/\s+/g, " ").trim() : "";
  const message =
    line && line.length <= WORKER_MESSAGE_MAX && !/[\u0000-\u001f\u007f]/.test(line) ? line : "";
  return { message, refusal: error?.refusal === true && message !== "" };
}

/**
 * Run a chart pool for one document. Options:
 * - `create()` starts a Worker (`new Worker(url)`); it may throw.
 * - `size`, `timeoutMs` (a job, from its post), `readyMs`.
 * - `doc`: the document whose visibility holds jobs.
 * - `font()`: the Page's font stack, which each new Worker is probed with.
 * - `measure(items)`: the widths the page draws probe items at, or null when
 *   it can't lay text out (then every Worker draws in the fallback).
 * Returns `{ attach(payload), warm() }`. `payload()` builds a chart's data
 * for one Worker: `{ datasets, transfer }`, owned by that Worker once posted.
 * `attach` returns `{ draw(message, { redraw }), detach() }`; `draw` is an
 * Observable of one result: the Worker's answer, `{ error }`, or the timeout.
 * `warm()` keeps the pool warm until every caller has called the function it
 * returns.
 */
export function createChartPool({
  create,
  size = CHART_WORKERS,
  timeoutMs,
  readyMs = CHART_READY_MS,
  doc = null,
  font = () => CHART_FALLBACK_FONT,
  measure = () => null,
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

  // The stacks each Worker generation was probed with, by slot.
  const probes = [];

  /** What a Worker posted, checked: `{ type: "ready" }`; `{ type: "probed",
   * widths }` with exactly the widths its probe asked for, each a finite
   * number from 0 to PROBE_MAX_WIDTH; or `{ type: "answer", id }` with a
   * safe-integer id. Anything else fails the Worker: a correct one never
   * sends it, and a Worker that does can't be trusted with the next job. */
  const onMessage =
    (slot, gen) =>
    ({ data }) => {
      const stacks = probes[slot];
      const valid =
        data !== null &&
        typeof data === "object" &&
        !Array.isArray(data) &&
        (data.type === "ready" ||
          (data.type === "probed" &&
            stacks?.gen === gen &&
            Array.isArray(data.widths) &&
            data.widths.length === probeCount(stacks.stacks) &&
            data.widths.every(
              (width) =>
                typeof width === "number" &&
                Number.isFinite(width) &&
                width >= 0 &&
                width <= PROBE_MAX_WIDTH,
            )) ||
          (data.type === "answer" && Number.isSafeInteger(data.id)));
      if (!valid) return dispatch({ type: "failed", slot, gen, message: WORKER_FAILED });
      if (data.type === "ready") return dispatch({ type: "ready", slot, gen });
      if (data.type === "probed") {
        let page = null;
        try {
          page = measure(probeItems(stacks.stacks));
        } catch {
          page = null;
        }
        return dispatch({
          type: "probed",
          slot,
          gen,
          stacks: stacks.stacks,
          page,
          worker: [...data.widths],
        });
      }
      const { scene, background, width, height, origin } = data;
      const result = Object.hasOwn(data, "error")
        ? { error: workerError(data.error) }
        : { scene, background, width, height, origin };
      dispatch({ type: "answer", slot, gen, id: data.id, result });
    };

  function run(effect) {
    switch (effect.type) {
      case "spawn": {
        const { slot, gen } = effect;
        workers[slot]?.worker.terminate();
        workers[slot] = null;
        let worker;
        try {
          worker = create();
        } catch (error) {
          dispatch({ type: "failed", slot, gen, message: WORKER_DIDNT_START });
          return;
        }
        worker.addEventListener("message", onMessage(slot, gen));
        worker.addEventListener("error", (event) => {
          event.preventDefault?.();
          dispatch({ type: "failed", slot, gen, message: WORKER_DIDNT_START });
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
      case "probe": {
        const target = workers[effect.slot];
        if (target?.gen !== effect.gen) return;
        let own = CHART_FALLBACK_FONT;
        try {
          own = font() || CHART_FALLBACK_FONT;
        } catch {}
        const stacks = [own, CHART_FALLBACK_FONT];
        probes[effect.slot] = { gen: effect.gen, stacks };
        target.worker.postMessage({ type: "probe", fonts: stacks });
        return;
      }
      case "job": {
        const target = workers[effect.slot];
        if (target?.gen !== effect.gen) return;
        const message = {
          type: "draw",
          id: effect.id,
          key: effect.key,
          ...effect.message,
          theme: { ...effect.message.theme, font: effect.font ?? CHART_FALLBACK_FONT },
        };
        if (!effect.withData) return target.worker.postMessage(message);
        try {
          const { datasets, transfer = [] } = payloads.get(effect.key)();
          target.worker.postMessage({ ...message, datasets }, transfer);
        } catch (error) {
          // Data that can't cross (a function in a row) fails the job in the
          // Worker, with why.
          target.worker.postMessage({ ...message, failed: String(error?.message ?? error) });
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
          dispatch({ type: "jobTimeout", id: effect.id });
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

  // The pool listens to its document only while a chart is attached or a
  // caller keeps it warm.
  let listeners = 0;
  const onVisibility = () => dispatch({ type: doc.visibilityState === "hidden" ? "hide" : "show" });
  const listen = () => {
    if (!doc || listeners++ > 0) return;
    doc.addEventListener("visibilitychange", onVisibility);
    onVisibility();
  };
  const unlisten = () => {
    if (doc && --listeners === 0) doc.removeEventListener("visibilitychange", onVisibility);
  };
  let warmers = 0;

  return {
    warm() {
      let held = true;
      listen();
      if (warmers++ === 0) dispatch({ type: "warm" });
      return () => {
        if (!held) return;
        held = false;
        if (--warmers === 0) dispatch({ type: "cool" });
        unlisten();
      };
    },
    attach(payload) {
      const key = `chart-${++keys}`;
      payloads.set(key, payload);
      listen();
      dispatch({ type: "attach", key });
      return {
        draw: (message, { redraw = false } = {}) =>
          new Observable((subscriber) => {
            const id = ++ids;
            deliveries.set(id, (result) => {
              subscriber.next(result);
              subscriber.complete();
            });
            dispatch({ type: "draw", key, id, redraw, message });
            return () => {
              if (deliveries.delete(id)) dispatch({ type: "cancel", id });
            };
          }),
        detach() {
          if (!payloads.delete(key)) return;
          dispatch({ type: "detach", key });
          unlisten();
        },
      };
    },
  };
}
