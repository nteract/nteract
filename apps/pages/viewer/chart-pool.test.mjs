import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  GRACE_MS,
  LATE_MS,
  TIMED_OUT,
  WORKER_DIDNT_START,
  WORKER_FAILED,
  chartPool,
  createChartPool,
  initialPool,
} from "./chart-pool.mjs";
import { CHART_FALLBACK_FONT, probeCount } from "./chart-font.mjs";

const PAGE_FONT = "Inter, sans-serif";
const STACKS = [PAGE_FONT, CHART_FALLBACK_FONT];
const WIDTHS = Array.from({ length: probeCount(STACKS) }, (_, i) => 50 + i);
/** A Worker's probe answer, in the page's measure: widths that agree. */
const probed = (slot, gen, { page = WIDTHS, worker = WIDTHS } = {}) => ({
  type: "probed",
  slot,
  gen,
  stacks: STACKS,
  page,
  worker,
});
/** A Worker that starts: `ready`, then its probe answer. */
const started = (slot, gen) => [{ type: "ready", slot, gen }, probed(slot, gen)];

/** Apply `events` from `state`; return the last state and every effect. */
function play(events, state = initialPool(1)) {
  const effects = [];
  for (const event of events) {
    const result = chartPool(state, event);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}
const types = (effects) => effects.map((effect) => effect.type);
const draw = (id, key, redraw = false) => ({
  type: "draw",
  id,
  key,
  redraw,
  message: { spec: id },
});
const gen = (state, slot = 0) => state.slots[slot]?.gen ?? 0;

/** One effect, short: what it does and to what. Deliveries are summarized
 * apart. */
function effectName(effect) {
  switch (effect.type) {
    case "timer":
      return `timer:${effect.kind}`;
    case "clear":
      return `clear:${effect.name.split(":")[0]}`;
    case "post":
      return `post:${effect.message.type}`;
    case "job":
      return `job:${effect.id}${effect.withData ? "+data" : ""}`;
    default:
      return effect.type;
  }
}

/** One line for a state and the results its step delivered: the warm and
 * hidden flags, slot 0's phase, each job's phase by id, each delivery's
 * kind, and the other effects in order. */
function summary(state, effects) {
  const jobs = [...state.jobs]
    .sort(([a], [b]) => a - b)
    .map(([id, job]) => `${id}:${job.phase}`)
    .join(" ");
  const delivered = effects
    .filter((effect) => effect.type === "deliver")
    .map(
      ({ id, result }) =>
        `${id}=${result.timedOut ? "timeout" : result.error ? "error" : "answer"}`,
    )
    .join(" ");
  const others = effects.filter((effect) => effect.type !== "deliver").map(effectName);
  return `${state.warm ? "warm " : ""}${state.hidden ? "hidden " : ""}${state.slots[0].phase} ${jobs || "-"} ${delivered || "-"}${others.length ? ` [${others.join(" ")}]` : ""}`;
}

// The states a one-Worker pool reaches with charts "a" and "b" attached.
const attached = play([
  { type: "attach", key: "a" },
  { type: "attach", key: "b" },
]).state;
const STATES = {};
STATES.down = attached;
STATES.starting = play([draw(1, "a")], STATES.down).state;
STATES.probing = play([{ type: "ready", slot: 0, gen: 1 }], STATES.starting).state;
STATES.busy = play([probed(0, 1)], STATES.probing).state;
STATES.idle = play([{ type: "answer", slot: 0, gen: 1, id: 1, result: {} }], STATES.busy).state;
STATES["busy+waiting"] = play([draw(2, "b")], STATES.busy).state;
STATES["abandoned+waiting"] = play([{ type: "cancel", id: 1 }], STATES["busy+waiting"]).state;
STATES.hidden = play([{ type: "hide" }], STATES["busy+waiting"]).state;
// A Page with a chart warms its pool before any chart attaches.
STATES.warm = play([{ type: "warm" }]).state;
STATES["warm idle"] = play(started(0, 1), STATES.warm).state;
STATES["warm, drawn"] = play(
  [
    { type: "attach", key: "a" },
    draw(1, "a"),
    { type: "answer", slot: 0, gen: 1, id: 1, result: {} },
  ],
  STATES["warm idle"],
).state;
STATES["warm probing"] = play([{ type: "ready", slot: 0, gen: 1 }], STATES.warm).state;
STATES["warm hidden"] = play([{ type: "hide" }], STATES.warm).state;
STATES["warm busy"] = play([{ type: "attach", key: "a" }, draw(1, "a")], STATES["warm idle"]).state;
// Its chart left while the job ran: no keys, and the Worker stays warm.
STATES["warm abandoned"] = play([{ type: "detach", key: "a" }], STATES["warm busy"]).state;
// A hung job replaced the Worker: generation 2 starts for the waiting job.
STATES.replaced = play([{ type: "jobTimeout", id: 1 }], STATES["busy+waiting"]).state;

const EVENTS = {
  "draw a": () => draw(3, "a"),
  "redraw a": () => draw(3, "a", true),
  "cancel 1": () => ({ type: "cancel", id: 1 }),
  "cancel 2": () => ({ type: "cancel", id: 2 }),
  ready: (state) => ({ type: "ready", slot: 0, gen: gen(state) }),
  probed: (state) => probed(0, gen(state)),
  "answer 1": (state) => ({ type: "answer", slot: 0, gen: gen(state), id: 1, result: {} }),
  "answer 2": (state) => ({ type: "answer", slot: 0, gen: gen(state), id: 2, result: {} }),
  "timeout 1": () => ({ type: "jobTimeout", id: 1 }),
  failed: (state) => ({ type: "failed", slot: 0, gen: gen(state), message: "" }),
  readyTimeout: (state) => ({ type: "readyTimeout", slot: 0, gen: gen(state) }),
  hide: () => ({ type: "hide" }),
  show: () => ({ type: "show" }),
  "detach a": () => ({ type: "detach", key: "a" }),
  "detach b": () => ({ type: "detach", key: "b" }),
  "attach c": () => ({ type: "attach", key: "c" }),
  warm: () => ({ type: "warm" }),
  cool: () => ({ type: "cool" }),
  // An older Worker generation's messages; its error reaches the pool as
  // `failed`.
  "stale ready": (state) => ({ type: "ready", slot: 0, gen: gen(state) - 1 }),
  "stale probed": (state) => probed(0, gen(state) - 1),
  "stale failed": (state) => ({ type: "failed", slot: 0, gen: gen(state) - 1, message: "" }),
};

// Every state against every event: the slot phase, the jobs, and what was
// delivered. A stale or unknown answer kills the Worker (WORKER_FAILED).
const TABLE = {
  down: {
    "draw a": "starting 3:waiting - [spawn timer:ready]",
    "redraw a": "starting 3:waiting - [spawn timer:ready]",
    "cancel 1": "down - -",
    "cancel 2": "down - -",
    ready: "down - -",
    probed: "down - -",
    "answer 1": "down - -",
    "answer 2": "down - -",
    "timeout 1": "down - -",
    failed: "down - -",
    readyTimeout: "down - -",
    hide: "hidden down - -",
    show: "down - -",
    "detach a": "down - -",
    "detach b": "down - -",
    "attach c": "down - -",
    warm: "warm starting - - [spawn timer:ready]",
    cool: "down - -",
    "stale ready": "down - -",
    "stale probed": "down - -",
    "stale failed": "down - -",
  },
  starting: {
    "draw a": "starting 1:waiting 3:waiting -",
    "redraw a": "starting 1:waiting 3:waiting -",
    "cancel 1": "starting - -",
    "cancel 2": "starting 1:waiting -",
    ready: "probing 1:waiting - [probe]",
    probed: "down - 1=error [terminate clear:ready clear:job]",
    "answer 1": "down - 1=error [terminate clear:ready clear:job]",
    "answer 2": "down - 1=error [terminate clear:ready clear:job]",
    "timeout 1": "starting 1:waiting -",
    failed: "down - 1=error [terminate clear:ready clear:job]",
    readyTimeout: "down - 1=error [terminate clear:ready clear:job]",
    hide: "hidden down 1:waiting - [terminate clear:ready]",
    show: "starting 1:waiting -",
    "detach a": "starting - -",
    "detach b": "starting 1:waiting -",
    "attach c": "starting 1:waiting -",
    warm: "warm starting 1:waiting -",
    cool: "starting 1:waiting -",
    "stale ready": "starting 1:waiting -",
    "stale probed": "starting 1:waiting -",
    "stale failed": "starting 1:waiting -",
  },
  probing: {
    "draw a": "probing 1:waiting 3:waiting -",
    "redraw a": "probing 1:waiting 3:waiting -",
    "cancel 1": "probing - -",
    "cancel 2": "probing 1:waiting -",
    ready: "probing 1:waiting -",
    probed: "busy 1:running - [clear:ready job:1+data timer:job]",
    "answer 1": "down - 1=error [terminate clear:ready clear:job]",
    "answer 2": "down - 1=error [terminate clear:ready clear:job]",
    "timeout 1": "probing 1:waiting -",
    failed: "down - 1=error [terminate clear:ready clear:job]",
    readyTimeout: "down - 1=error [terminate clear:ready clear:job]",
    hide: "hidden down 1:waiting - [terminate clear:ready]",
    show: "probing 1:waiting -",
    "detach a": "probing - -",
    "detach b": "probing 1:waiting -",
    "attach c": "probing 1:waiting -",
    warm: "warm probing 1:waiting -",
    cool: "probing 1:waiting -",
    "stale ready": "probing 1:waiting -",
    "stale probed": "probing 1:waiting -",
    "stale failed": "probing 1:waiting -",
  },
  busy: {
    "draw a": "busy 1:running 3:waiting -",
    "redraw a": "busy 1:running 3:waiting -",
    "cancel 1": "down - - [terminate clear:ready clear:job]",
    "cancel 2": "busy 1:running -",
    ready: "busy 1:running -",
    probed: "down - 1=error [terminate clear:ready clear:job]",
    "answer 1": "idle - 1=answer [clear:job]",
    "answer 2": "down - 1=error [terminate clear:ready clear:job]",
    "timeout 1": "down - 1=timeout [terminate clear:ready clear:job]",
    failed: "down - 1=error [terminate clear:ready clear:job]",
    readyTimeout: "busy 1:running -",
    hide: "hidden down 1:waiting - [terminate clear:ready]",
    show: "busy 1:running -",
    "detach a": "busy 1:abandoned - [post:drop]",
    "detach b": "busy 1:running -",
    "attach c": "busy 1:running -",
    warm: "warm busy 1:running -",
    cool: "busy 1:running -",
    "stale ready": "busy 1:running -",
    "stale probed": "busy 1:running -",
    "stale failed": "busy 1:running -",
  },
  idle: {
    "draw a": "busy 3:running - [job:3 timer:job]",
    "redraw a": "busy 3:running - [job:3 timer:job]",
    "cancel 1": "idle - -",
    "cancel 2": "idle - -",
    ready: "idle - -",
    probed: "down - - [terminate clear:ready]",
    "answer 1": "down - - [terminate clear:ready]",
    "answer 2": "down - - [terminate clear:ready]",
    "timeout 1": "idle - -",
    failed: "down - - [terminate clear:ready]",
    readyTimeout: "idle - -",
    hide: "hidden idle - -",
    show: "idle - -",
    "detach a": "idle - - [post:drop]",
    "detach b": "idle - -",
    "attach c": "idle - -",
    warm: "warm idle - -",
    cool: "idle - -",
    "stale ready": "idle - -",
    "stale probed": "idle - -",
    "stale failed": "idle - -",
  },
  "busy+waiting": {
    "draw a": "busy 1:running 2:waiting 3:waiting -",
    "redraw a": "busy 1:running 2:waiting 3:waiting -",
    "cancel 1": "busy 1:abandoned 2:waiting -",
    "cancel 2": "busy 1:running -",
    ready: "busy 1:running 2:waiting -",
    probed: "starting 2:waiting 1=error [terminate clear:ready clear:job spawn timer:ready]",
    "answer 1": "busy 2:running 1=answer [clear:job job:2+data timer:job]",
    "answer 2": "starting 2:waiting 1=error [terminate clear:ready clear:job spawn timer:ready]",
    "timeout 1": "starting 2:waiting 1=timeout [terminate clear:ready clear:job spawn timer:ready]",
    failed: "starting 2:waiting 1=error [terminate clear:ready clear:job spawn timer:ready]",
    readyTimeout: "busy 1:running 2:waiting -",
    hide: "hidden down 1:waiting 2:waiting - [terminate clear:ready]",
    show: "busy 1:running 2:waiting -",
    "detach a": "busy 1:abandoned 2:waiting - [post:drop]",
    "detach b": "busy 1:running -",
    "attach c": "busy 1:running 2:waiting -",
    warm: "warm busy 1:running 2:waiting -",
    cool: "busy 1:running 2:waiting -",
    "stale ready": "busy 1:running 2:waiting -",
    "stale probed": "busy 1:running 2:waiting -",
    "stale failed": "busy 1:running 2:waiting -",
  },
  "abandoned+waiting": {
    "draw a": "busy 1:abandoned 2:waiting 3:waiting -",
    "redraw a": "busy 1:abandoned 2:waiting 3:waiting -",
    "cancel 1": "busy 1:abandoned 2:waiting -",
    "cancel 2": "busy 1:abandoned -",
    ready: "busy 1:abandoned 2:waiting -",
    probed: "starting 2:waiting - [terminate clear:ready clear:job spawn timer:ready]",
    "answer 1": "busy 2:running - [clear:job job:2+data timer:job]",
    "answer 2": "starting 2:waiting - [terminate clear:ready clear:job spawn timer:ready]",
    "timeout 1": "starting 2:waiting - [terminate clear:ready clear:job spawn timer:ready]",
    failed: "starting 2:waiting - [terminate clear:ready clear:job spawn timer:ready]",
    readyTimeout: "busy 1:abandoned 2:waiting -",
    hide: "hidden down 2:waiting - [terminate clear:ready clear:job]",
    show: "busy 1:abandoned 2:waiting -",
    "detach a": "busy 1:abandoned 2:waiting - [post:drop]",
    "detach b": "busy 1:abandoned -",
    "attach c": "busy 1:abandoned 2:waiting -",
    warm: "warm busy 1:abandoned 2:waiting -",
    cool: "busy 1:abandoned 2:waiting -",
    "stale ready": "busy 1:abandoned 2:waiting -",
    "stale probed": "busy 1:abandoned 2:waiting -",
    "stale failed": "busy 1:abandoned 2:waiting -",
  },
  hidden: {
    "draw a": "hidden down 1:waiting 2:waiting 3:waiting -",
    "redraw a": "hidden down 1:waiting 2:waiting 3:waiting -",
    "cancel 1": "hidden down 2:waiting -",
    "cancel 2": "hidden down 1:waiting -",
    ready: "hidden down 1:waiting 2:waiting -",
    probed: "hidden down 1:waiting 2:waiting -",
    "answer 1": "hidden down 1:waiting 2:waiting -",
    "answer 2": "hidden down 1:waiting 2:waiting -",
    "timeout 1": "hidden down 1:waiting 2:waiting -",
    failed: "hidden down 1:waiting 2:waiting -",
    readyTimeout: "hidden down 1:waiting 2:waiting -",
    hide: "hidden down 1:waiting 2:waiting -",
    show: "starting 1:waiting 2:waiting - [spawn timer:ready]",
    "detach a": "hidden down 2:waiting -",
    "detach b": "hidden down 1:waiting -",
    "attach c": "hidden down 1:waiting 2:waiting -",
    warm: "warm hidden down 1:waiting 2:waiting -",
    cool: "hidden down 1:waiting 2:waiting -",
    "stale ready": "hidden down 1:waiting 2:waiting -",
    "stale probed": "hidden down 1:waiting 2:waiting -",
    "stale failed": "hidden down 1:waiting 2:waiting -",
  },
  warm: {
    "draw a": "warm starting - -",
    "redraw a": "warm starting - -",
    "cancel 1": "warm starting - -",
    "cancel 2": "warm starting - -",
    ready: "warm probing - - [probe]",
    probed: "warm down - - [terminate clear:ready]",
    "answer 1": "warm down - - [terminate clear:ready]",
    "answer 2": "warm down - - [terminate clear:ready]",
    "timeout 1": "warm starting - -",
    failed: "warm down - - [terminate clear:ready]",
    readyTimeout: "warm down - - [terminate clear:ready]",
    hide: "warm hidden down - - [terminate clear:ready]",
    show: "warm starting - -",
    "detach a": "warm starting - -",
    "detach b": "warm starting - -",
    "attach c": "warm starting - -",
    warm: "warm starting - -",
    cool: "down - - [terminate clear:ready]",
    "stale ready": "warm starting - -",
    "stale probed": "warm starting - -",
    "stale failed": "warm starting - -",
  },
  "warm idle": {
    "draw a": "warm idle - -",
    "redraw a": "warm idle - -",
    "cancel 1": "warm idle - -",
    "cancel 2": "warm idle - -",
    ready: "warm idle - -",
    probed: "warm down - - [terminate clear:ready]",
    "answer 1": "warm down - - [terminate clear:ready]",
    "answer 2": "warm down - - [terminate clear:ready]",
    "timeout 1": "warm idle - -",
    failed: "warm down - - [terminate clear:ready]",
    readyTimeout: "warm idle - -",
    hide: "warm hidden idle - -",
    show: "warm idle - -",
    "detach a": "warm idle - -",
    "detach b": "warm idle - -",
    "attach c": "warm idle - -",
    warm: "warm idle - -",
    cool: "down - - [terminate clear:ready]",
    "stale ready": "warm idle - -",
    "stale probed": "warm idle - -",
    "stale failed": "warm idle - -",
  },
  "warm, drawn": {
    "draw a": "warm busy 3:running - [job:3 timer:job]",
    "redraw a": "warm busy 3:running - [job:3 timer:job]",
    "cancel 1": "warm idle - -",
    "cancel 2": "warm idle - -",
    ready: "warm idle - -",
    probed: "warm down - - [terminate clear:ready]",
    "answer 1": "warm down - - [terminate clear:ready]",
    "answer 2": "warm down - - [terminate clear:ready]",
    "timeout 1": "warm idle - -",
    failed: "warm down - - [terminate clear:ready]",
    readyTimeout: "warm idle - -",
    hide: "warm hidden idle - -",
    show: "warm idle - -",
    "detach a": "warm idle - - [post:drop]",
    "detach b": "warm idle - -",
    "attach c": "warm idle - -",
    warm: "warm idle - -",
    cool: "idle - -",
    "stale ready": "warm idle - -",
    "stale probed": "warm idle - -",
    "stale failed": "warm idle - -",
  },
  "warm probing": {
    "draw a": "warm probing - -",
    "redraw a": "warm probing - -",
    "cancel 1": "warm probing - -",
    "cancel 2": "warm probing - -",
    ready: "warm probing - -",
    probed: "warm idle - - [clear:ready]",
    "answer 1": "warm down - - [terminate clear:ready]",
    "answer 2": "warm down - - [terminate clear:ready]",
    "timeout 1": "warm probing - -",
    failed: "warm down - - [terminate clear:ready]",
    readyTimeout: "warm down - - [terminate clear:ready]",
    hide: "warm hidden down - - [terminate clear:ready]",
    show: "warm probing - -",
    "detach a": "warm probing - -",
    "detach b": "warm probing - -",
    "attach c": "warm probing - -",
    warm: "warm probing - -",
    cool: "down - - [terminate clear:ready]",
    "stale ready": "warm probing - -",
    "stale probed": "warm probing - -",
    "stale failed": "warm probing - -",
  },
  "warm hidden": {
    "draw a": "warm hidden down - -",
    "redraw a": "warm hidden down - -",
    "cancel 1": "warm hidden down - -",
    "cancel 2": "warm hidden down - -",
    ready: "warm hidden down - -",
    probed: "warm hidden down - -",
    "answer 1": "warm hidden down - -",
    "answer 2": "warm hidden down - -",
    "timeout 1": "warm hidden down - -",
    failed: "warm hidden down - -",
    readyTimeout: "warm hidden down - -",
    hide: "warm hidden down - -",
    show: "warm starting - - [spawn timer:ready]",
    "detach a": "warm hidden down - -",
    "detach b": "warm hidden down - -",
    "attach c": "warm hidden down - -",
    warm: "warm hidden down - -",
    cool: "hidden down - -",
    "stale ready": "warm hidden down - -",
    "stale probed": "warm hidden down - -",
    "stale failed": "warm hidden down - -",
  },
  "warm busy": {
    "draw a": "warm busy 1:running 3:waiting -",
    "redraw a": "warm busy 1:running 3:waiting -",
    "cancel 1": "warm down - - [terminate clear:ready clear:job]",
    "cancel 2": "warm busy 1:running -",
    ready: "warm busy 1:running -",
    probed: "warm down - 1=error [terminate clear:ready clear:job]",
    "answer 1": "warm idle - 1=answer [clear:job]",
    "answer 2": "warm down - 1=error [terminate clear:ready clear:job]",
    "timeout 1": "warm down - 1=timeout [terminate clear:ready clear:job]",
    failed: "warm down - 1=error [terminate clear:ready clear:job]",
    readyTimeout: "warm busy 1:running -",
    hide: "warm hidden down 1:waiting - [terminate clear:ready]",
    show: "warm busy 1:running -",
    "detach a": "warm busy 1:abandoned - [post:drop]",
    "detach b": "warm busy 1:running -",
    "attach c": "warm busy 1:running -",
    warm: "warm busy 1:running -",
    cool: "busy 1:running -",
    "stale ready": "warm busy 1:running -",
    "stale probed": "warm busy 1:running -",
    "stale failed": "warm busy 1:running -",
  },
  "warm abandoned": {
    "draw a": "warm busy 1:abandoned -",
    "redraw a": "warm busy 1:abandoned -",
    "cancel 1": "warm busy 1:abandoned -",
    "cancel 2": "warm busy 1:abandoned -",
    ready: "warm busy 1:abandoned -",
    probed: "warm down - - [terminate clear:ready clear:job]",
    "answer 1": "warm idle - - [clear:job]",
    "answer 2": "warm down - - [terminate clear:ready clear:job]",
    "timeout 1": "warm down - - [terminate clear:ready clear:job]",
    failed: "warm down - - [terminate clear:ready clear:job]",
    readyTimeout: "warm busy 1:abandoned -",
    hide: "warm hidden down - - [terminate clear:ready clear:job]",
    show: "warm busy 1:abandoned -",
    "detach a": "warm busy 1:abandoned -",
    "detach b": "warm busy 1:abandoned -",
    "attach c": "warm busy 1:abandoned -",
    warm: "warm busy 1:abandoned -",
    cool: "down - - [terminate clear:ready clear:job]",
    "stale ready": "warm busy 1:abandoned -",
    "stale probed": "warm busy 1:abandoned -",
    "stale failed": "warm busy 1:abandoned -",
  },
  replaced: {
    "draw a": "starting 2:waiting 3:waiting -",
    "redraw a": "starting 2:waiting 3:waiting -",
    "cancel 1": "starting 2:waiting -",
    "cancel 2": "starting - -",
    ready: "probing 2:waiting - [probe]",
    probed: "down - 2=error [terminate clear:ready clear:job]",
    "answer 1": "down - 2=error [terminate clear:ready clear:job]",
    "answer 2": "down - 2=error [terminate clear:ready clear:job]",
    "timeout 1": "starting 2:waiting -",
    failed: "down - 2=error [terminate clear:ready clear:job]",
    readyTimeout: "down - 2=error [terminate clear:ready clear:job]",
    hide: "hidden down 2:waiting - [terminate clear:ready]",
    show: "starting 2:waiting -",
    "detach a": "starting 2:waiting -",
    "detach b": "starting - -",
    "attach c": "starting 2:waiting -",
    warm: "warm starting 2:waiting -",
    cool: "starting 2:waiting -",
    "stale ready": "starting 2:waiting -",
    "stale probed": "starting 2:waiting -",
    "stale failed": "starting 2:waiting -",
  },
};

test("the states the table starts from are the ones they're named for", () => {
  assert.equal(summary(STATES.down, []), "down - -");
  assert.equal(summary(STATES.starting, []), "starting 1:waiting -");
  assert.equal(summary(STATES.probing, []), "probing 1:waiting -");
  assert.equal(summary(STATES.busy, []), "busy 1:running -");
  assert.equal(summary(STATES.idle, []), "idle - -");
  assert.equal(summary(STATES["busy+waiting"], []), "busy 1:running 2:waiting -");
  assert.equal(summary(STATES["abandoned+waiting"], []), "busy 1:abandoned 2:waiting -");
  assert.equal(summary(STATES.hidden, []), "hidden down 1:waiting 2:waiting -");
  assert.equal(summary(STATES.warm, []), "warm starting - -");
  assert.equal(summary(STATES["warm idle"], []), "warm idle - -");
  assert.equal(summary(STATES["warm, drawn"], []), "warm idle - -");
  assert.equal(summary(STATES["warm probing"], []), "warm probing - -");
  assert.equal(summary(STATES["warm hidden"], []), "warm hidden down - -");
  assert.equal(summary(STATES["warm busy"], []), "warm busy 1:running -");
  assert.equal(summary(STATES["warm abandoned"], []), "warm busy 1:abandoned -");
  assert.deepEqual(STATES["warm abandoned"].slots[0].keys, []);
  assert.equal(summary(STATES.replaced, []), "starting 2:waiting -");
  assert.equal(gen(STATES.replaced), 2);
});

for (const [name, start] of Object.entries(STATES))
  test(`every event from ${name}`, () => {
    assert.deepEqual(Object.keys(TABLE[name]).sort(), Object.keys(EVENTS).sort());
    for (const [label, event] of Object.entries(EVENTS)) {
      const { state, effects } = chartPool(start, event(start));
      assert.equal(summary(state, effects), TABLE[name][label], `${name} + ${label}`);
    }
  });

test("a warm pool starts its Worker when its document shows, however it was hidden", () => {
  const spawned = (effects) => effects.filter((effect) => effect.type === "spawn");
  // Hidden before it warmed: nothing starts until it shows.
  const early = play([{ type: "hide" }, { type: "warm" }]);
  assert.deepEqual(spawned(early.effects), []);
  const shown = chartPool(early.state, { type: "show" });
  assert.deepEqual(shown.effects, [
    { type: "spawn", slot: 0, gen: 1 },
    { type: "timer", name: "ready:0", kind: "ready", slot: 0, gen: 1 },
  ]);
  // Hidden while the warm Worker started: it stops, and starts again on show.
  const starting = play([{ type: "warm" }, { type: "hide" }]);
  assert.deepEqual(types(starting.effects), ["spawn", "timer", "terminate", "clear"]);
  const again = chartPool(starting.state, { type: "show" });
  assert.deepEqual(spawned(again.effects), [{ type: "spawn", slot: 0, gen: 2 }]);
  // A warm Worker already up isn't started twice, and a cooled pool starts
  // nothing on show.
  const up = play([{ type: "warm" }, ...started(0, 1), { type: "hide" }, { type: "show" }]);
  assert.equal(spawned(up.effects).length, 1);
  const cooled = play([{ type: "warm" }, { type: "hide" }, { type: "cool" }, { type: "show" }]);
  assert.equal(spawned(cooled.effects).length, 1);
  assert.equal(cooled.state.slots[0].phase, "down");
});

test("a job carries its chart's data the first time a Worker draws that chart", () => {
  const { state, effects } = play([{ type: "attach", key: "a" }, draw(1, "a"), ...started(0, 1)]);
  const job = effects.find((effect) => effect.type === "job");
  assert.deepEqual(job, {
    type: "job",
    slot: 0,
    gen: 1,
    id: 1,
    key: "a",
    withData: true,
    font: PAGE_FONT,
    message: { spec: 1 },
  });
  assert.deepEqual(effects.at(-1), { type: "timer", name: "job:1", kind: "job", id: 1 });
  const again = play([{ type: "answer", slot: 0, gen: 1, id: 1, result: {} }, draw(2, "a")], state);
  assert.equal(again.effects.find((effect) => effect.type === "job").withData, false);
  // A replacement Worker gets the data again.
  const replaced = play(
    [{ type: "jobTimeout", id: 2 }, draw(3, "a"), ...started(0, 2)],
    again.state,
  );
  assert.equal(replaced.effects.find((effect) => effect.type === "job").withData, true);
});

test("first draws go ahead of redraws, then jobs run in the order they came", () => {
  const { state } = play([
    { type: "attach", key: "a" },
    { type: "attach", key: "b" },
    { type: "attach", key: "c" },
    draw(1, "a"),
    ...started(0, 1),
    draw(2, "a", true),
    draw(3, "b"),
    draw(4, "c"),
  ]);
  const order = [];
  let next = state;
  for (const id of [1, 3, 4, 2]) {
    const step = chartPool(next, { type: "answer", slot: 0, gen: 1, id, result: {} });
    next = step.state;
    const job = step.effects.find((effect) => effect.type === "job");
    if (job) order.push(job.id);
  }
  assert.deepEqual(order, [3, 4, 2]);
});

test("the last chart to leave a Worker terminates it, abandoned job and all", () => {
  const { state } = play([{ type: "attach", key: "a" }, draw(1, "a"), ...started(0, 1)]);
  const step = chartPool(state, { type: "detach", key: "a" });
  assert.deepEqual(types(step.effects), ["terminate", "clear", "clear"]);
  assert.equal(step.state.slots[0].phase, "down");
  assert.equal(step.state.jobs.size, 0);
  // A message from the terminated Worker is ignored.
  assert.equal(
    chartPool(step.state, { type: "answer", slot: 0, gen: 1, id: 1, result: {} }).state,
    step.state,
  );
  // A detached chart sends a drop to a Worker that holds its data.
  const two = play(
    [
      { type: "attach", key: "b" },
      { type: "answer", slot: 0, gen: 1, id: 1, result: {} },
    ],
    state,
  );
  assert.deepEqual(chartPool(two.state, { type: "detach", key: "a" }).effects, [
    { type: "post", slot: 0, gen: 1, message: { type: "drop", key: "a" } },
  ]);
  assert.throws(() => chartPool(state, { type: "nonsense" }), /unknown chart pool event/);
});

test("ids are compared exactly: a draw id is never matched by its string", () => {
  const { state } = play([{ type: "attach", key: "a" }, draw(1, "a"), ...started(0, 1)]);
  const step = chartPool(state, { type: "answer", slot: 0, gen: 1, id: "1", result: {} });
  assert.deepEqual(
    step.effects
      .filter((effect) => effect.type === "deliver")
      .map((effect) => effect.result.error.message),
    [WORKER_FAILED],
  );
});

for (const size of [1, 2])
  test(`at size ${size}: charts pin, a hung Worker is replaced, and only the charts waiting on it move`, () => {
    const keys = ["a", "b", "c", "d"];
    const { state, effects } = play(
      [
        ...keys.map((key) => ({ type: "attach", key })),
        ...keys.map((key, index) => draw(index + 1, key)),
      ],
      initialPool(size),
    );
    assert.deepEqual(
      state.slots.map((slot) => slot.keys),
      size === 1
        ? [keys]
        : [
            ["a", "c"],
            ["b", "d"],
          ],
    );
    assert.equal(effects.filter((effect) => effect.type === "spawn").length, size);
    const ready = play(
      state.slots.flatMap((_, slot) => started(slot, 1)),
      state,
    );
    // Each Worker took its first chart's job; "a" hangs on Worker 0.
    assert.deepEqual(
      ready.effects.filter((effect) => effect.type === "job").map((effect) => effect.id),
      size === 1 ? [1] : [1, 2],
    );
    const hung = chartPool(ready.state, { type: "jobTimeout", id: 1 });
    assert.deepEqual(
      hung.effects.filter((effect) => effect.type === "deliver").map((effect) => effect.id),
      [1],
    );
    assert.deepEqual(
      hung.effects.filter((effect) => effect.type === "spawn"),
      [{ type: "spawn", slot: 0, gen: 2 }],
    );
    // The replacement takes the next job pinned to it, with that chart's data.
    const next = play(started(0, 2), hung.state);
    const job = next.effects.find((effect) => effect.type === "job");
    assert.equal(job.key, size === 1 ? "b" : "c");
    assert.equal(job.withData, true);
    if (size === 2) assert.equal(next.state.slots[1].gen, 1, "the other Worker is untouched");
  });

/** A Worker the interpreter drives, recording what it's sent: font probes in
 * `probes`, everything else in `sent`. */
class FakeWorker extends EventTarget {
  constructor(log) {
    super();
    this.log = log;
    this.sent = [];
    this.probes = [];
    this.terminated = false;
    log.push(this);
  }
  postMessage(message, transfer) {
    if (message?.type === "probe") this.probes.push(message);
    else this.sent.push({ message, transfer });
  }
  reply(data) {
    this.dispatchEvent(Object.assign(new Event("message"), { data }));
  }
  /** Say ready, then answer the probe the page sends with `widths`. */
  start(widths = (count) => Array.from({ length: count }, (_, i) => 50 + i)) {
    this.reply({ type: "ready" });
    const { fonts } = this.probes.at(-1);
    this.reply({ type: "probed", widths: widths(probeCount(fonts)) });
  }
  terminate() {
    this.terminated = true;
  }
}

test("the interpreter posts a job once its Worker is ready and times it from the post, with one grace beat", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const log = [];
    const pool = createChartPool({ create: () => new FakeWorker(log), size: 1, timeoutMs: 1000 });
    const client = pool.attach(() => ({ datasets: { d: { rows: [] } }, transfer: [] }));
    const results = [];
    client.draw({ spec: {} }).subscribe((result) => results.push(result));
    const [worker] = log;
    // A cold Worker: nothing is posted, and no job timer runs, before ready.
    mock.timers.tick(3000);
    assert.deepEqual(worker.sent, []);
    worker.start();
    assert.deepEqual(
      worker.sent.map(({ message }) => [message.type, Object.hasOwn(message, "datasets")]),
      [["draw", true]],
    );
    mock.timers.tick(999);
    assert.deepEqual(results, []);
    mock.timers.tick(1);
    assert.equal(results[0].error.message, TIMED_OUT);
    assert.equal(results[0].timedOut, true);
    assert.equal(worker.terminated, true);
    assert.equal(log.length, 1, "no replacement waits for a chart alone");
    // Its next draw starts a Worker, and sends the data with the job.
    client.draw({ spec: {} }).subscribe(() => {});
    log[1].start();
    assert.ok(Object.hasOwn(log[1].sent[0].message, "datasets"));
    client.detach();
    assert.equal(log[1].terminated, true);
  } finally {
    mock.timers.reset();
  }
  assert.ok(LATE_MS > GRACE_MS);
});

test("the interpreter fails a Worker that never says ready, and a chart whose data can't cross", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const log = [];
    const pool = createChartPool({
      create: () => new FakeWorker(log),
      size: 1,
      timeoutMs: 1000,
      readyMs: 300,
    });
    const client = pool.attach(() => {
      throw new Error("Function object could not be cloned.");
    });
    const results = [];
    client.draw({ spec: {} }).subscribe((result) => results.push(result));
    mock.timers.tick(300);
    assert.equal(results[0].error.message, WORKER_DIDNT_START);
    assert.equal(log[0].terminated, true);
    client.draw({ spec: {} }).subscribe((result) => results.push(result));
    log[1].start();
    const { message } = log[1].sent[0];
    assert.equal(message.failed, "Function object could not be cloned.");
    assert.equal(Object.hasOwn(message, "datasets"), false);
    client.detach();
  } finally {
    mock.timers.reset();
  }
});

test("the interpreter checks every Worker message, and bounds the error text it passes on", () => {
  const log = [];
  const pool = createChartPool({ create: () => new FakeWorker(log), size: 1, timeoutMs: 1000 });
  const client = pool.attach(() => ({ datasets: {}, transfer: [] }));
  const draws = [];
  const next = () => {
    const results = [];
    client.draw({ spec: {} }).subscribe((result) => results.push(result));
    draws.push(results);
    const worker = log.at(-1);
    if (!worker.sent.length) worker.start();
    return { worker, id: worker.sent.at(-1).message.id, results };
  };
  // Malformed envelopes kill the Worker and fail the job.
  for (const data of [null, "answer", [], { type: "start", id: 1 }, { type: "answer" }]) {
    const { worker, results } = next();
    worker.reply(data);
    assert.equal(worker.terminated, true, JSON.stringify(data));
    assert.equal(results[0].error.message, WORKER_FAILED);
  }
  {
    const { worker, id, results } = next();
    worker.reply({ type: "answer", id: String(id) });
    assert.equal(worker.terminated, true, "a string id is not the job's id");
    assert.equal(results[0].error.message, WORKER_FAILED);
  }
  // Error text: one bounded line, and a refusal only with valid text.
  for (const [error, expected] of [
    [
      { message: "x".repeat(10_000_000), refusal: true },
      { message: "", refusal: false },
    ],
    [
      { message: "Two\nlines.", refusal: true },
      { message: "Two lines.", refusal: true },
    ],
    [
      { message: "bell\u0007", refusal: true },
      { message: "", refusal: false },
    ],
    [
      { message: 42, refusal: "yes" },
      { message: "", refusal: false },
    ],
    [
      { message: "A sentence.", refusal: 1 },
      { message: "A sentence.", refusal: false },
    ],
  ]) {
    const { worker, id, results } = next();
    worker.reply({ type: "answer", id, error });
    assert.deepEqual(results[0], { error: expected });
  }
  client.detach();
});

test("virtual time: a Worker that takes the job and never answers, even before starting it, is cut off", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const log = [];
    const pool = createChartPool({ create: () => new FakeWorker(log), size: 1, timeoutMs: 1000 });
    const client = pool.attach(() => ({ datasets: { d: { rows: [] } }, transfer: [] }));
    const results = [];
    client.draw({ spec: {} }).subscribe((result) => results.push(result));
    log[0].start();
    // The Worker decodes the data, or hangs doing it: it sends nothing more.
    mock.timers.tick(999);
    assert.deepEqual(results, []);
    mock.timers.tick(1);
    assert.equal(results[0]?.error.message, TIMED_OUT);
    assert.equal(log[0].terminated, true);
    client.detach();
  } finally {
    mock.timers.reset();
  }
});

test("virtual time: a job cancelled while its Worker runs it stays watched, and the next draw runs on a replacement", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const log = [];
    const pool = createChartPool({ create: () => new FakeWorker(log), size: 1, timeoutMs: 1000 });
    const a = pool.attach(() => ({ datasets: { d: { rows: [] } }, transfer: [] }));
    const b = pool.attach(() => ({ datasets: { d: { rows: [] } }, transfer: [] }));
    const results = { a: [], b: [] };
    const first = a.draw({ spec: {} }).subscribe((result) => results.a.push(result));
    b.draw({ spec: {} }).subscribe((result) => results.b.push(result));
    log[0].start();
    // A resize supersedes a's draw after the Worker took it; the Worker hangs.
    first.unsubscribe();
    a.draw({ spec: {}, width: 200 }).subscribe((result) => results.a.push(result));
    mock.timers.tick(5000);
    assert.equal(log[0].terminated, true, "the hung Worker is cut off");
    assert.equal(log.length, 2, "a replacement takes the waiting draws");
    assert.deepEqual(results.a, [], "the cancelled draw's chart hears nothing");
    log[1].start();
    // One job at a time, with the chart's data, since this Worker has none.
    const [job] = log[1].sent.map(({ message }) => message);
    assert.equal(log[1].sent.length, 1);
    assert.equal(job.type, "draw");
    assert.deepEqual(job.datasets, { d: { rows: [] } });
    log[1].reply({ type: "answer", id: job.id, scene: { marktype: "group", items: [] } });
    assert.equal(log[1].sent.length, 2, "the next job goes once the first answers");
    assert.ok(results.a.length + results.b.length === 1);
    a.detach();
    b.detach();
  } finally {
    mock.timers.reset();
  }
});

test("a new Worker is probed once: the Page's stack when it measures the same, the fallback when not", () => {
  const theme = { dark: false };
  for (const [label, page, expected] of [
    ["agrees", (items) => items.map((_, i) => 50 + i), "Inter, sans-serif"],
    ["within 1 px", (items) => items.map((_, i) => 50.9 + i), "Inter, sans-serif"],
    ["one width off", (items) => items.map((_, i) => (i === 3 ? 60 : 50 + i)), CHART_FALLBACK_FONT],
    ["the page can't measure", () => null, CHART_FALLBACK_FONT],
  ]) {
    const log = [];
    const pool = createChartPool({
      create: () => new FakeWorker(log),
      size: 1,
      timeoutMs: 1000,
      font: () => "Inter, sans-serif",
      measure: page,
    });
    const client = pool.attach(() => ({ datasets: {}, transfer: [] }));
    client.draw({ spec: {}, theme }).subscribe(() => {});
    const [worker] = log;
    worker.start();
    assert.deepEqual(worker.probes, [
      { type: "probe", fonts: ["Inter, sans-serif", CHART_FALLBACK_FONT] },
    ]);
    const job = worker.sent[0].message;
    assert.equal(job.theme.font, expected, label);
    assert.equal(job.theme.dark, false);
    // Every later job on this Worker carries the same choice, unprobed.
    worker.reply({ type: "answer", id: job.id, scene: { marktype: "group", items: [] } });
    client.draw({ spec: {}, theme }).subscribe(() => {});
    assert.equal(worker.sent[1].message.theme.font, expected, label);
    assert.equal(worker.probes.length, 1);
    client.detach();
  }
});

test("a probe answer is checked like any Worker message", () => {
  const count = probeCount(STACKS);
  const bad = [
    { type: "probed" },
    { type: "probed", widths: "1,2" },
    { type: "probed", widths: Array(count - 1).fill(10) },
    { type: "probed", widths: Array(count + 1).fill(10) },
    { type: "probed", widths: [...Array(count - 1).fill(10), "10"] },
    { type: "probed", widths: [...Array(count - 1).fill(10), Number.NaN] },
    { type: "probed", widths: [...Array(count - 1).fill(10), Infinity] },
    { type: "probed", widths: [...Array(count - 1).fill(10), -1] },
    { type: "probed", widths: [...Array(count - 1).fill(10), 100_001] },
  ];
  for (const data of bad) {
    const log = [];
    const pool = createChartPool({ create: () => new FakeWorker(log), size: 1, timeoutMs: 1000 });
    const client = pool.attach(() => ({ datasets: {}, transfer: [] }));
    const results = [];
    client.draw({ spec: {} }).subscribe((result) => results.push(result));
    log[0].reply({ type: "ready" });
    log[0].reply(data);
    assert.equal(log[0].terminated, true, JSON.stringify(data).slice(0, 80));
    assert.equal(results[0].error.message, WORKER_FAILED);
    assert.deepEqual(log[0].sent, [], "no job goes to a Worker that answered wrongly");
    client.detach();
  }
  // A probe answer once the Worker is running jobs is a message it never sends.
  const log = [];
  const pool = createChartPool({ create: () => new FakeWorker(log), size: 1, timeoutMs: 1000 });
  const client = pool.attach(() => ({ datasets: {}, transfer: [] }));
  const results = [];
  client.draw({ spec: {} }).subscribe((result) => results.push(result));
  log[0].start();
  log[0].reply({ type: "probed", widths: Array(count).fill(10) });
  assert.equal(log[0].terminated, true);
  assert.equal(results[0].error.message, WORKER_FAILED);
  client.detach();
});

test("a warm pool starts one Worker before any chart, which the first chart draws in at once", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const log = [];
    const pool = createChartPool({ create: () => new FakeWorker(log), size: 1, timeoutMs: 1000 });
    const first = pool.warm();
    const second = pool.warm();
    assert.equal(log.length, 1, "one Worker for every caller that warms");
    log[0].start();
    const client = pool.attach(() => ({ datasets: { d: { rows: [] } }, transfer: [] }));
    const results = [];
    client.draw({ spec: {} }).subscribe((result) => results.push(result));
    assert.equal(log.length, 1);
    assert.deepEqual(
      log[0].sent.map(({ message }) => [message.type, Object.hasOwn(message, "datasets")]),
      [["draw", true]],
      "the job goes out with no wait for ready",
    );
    log[0].reply({ type: "answer", id: log[0].sent[0].message.id, scene: null });
    assert.equal(results.length, 1);
    // Warm, the Worker outlives its last chart; cooled, it goes with it.
    client.detach();
    assert.equal(log[0].terminated, false);
    first();
    first();
    assert.equal(log[0].terminated, false, "one caller still holds it warm");
    second();
    assert.equal(log[0].terminated, true);
    assert.equal(log.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test("a warm Worker that fails to start says nothing; the first chart starts its own", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    for (const failure of ["throws", "never ready"]) {
      const log = [];
      let refuse = failure === "throws";
      const pool = createChartPool({
        create: () => {
          if (refuse) throw Error("no Workers here");
          return new FakeWorker(log);
        },
        size: 1,
        timeoutMs: 1000,
      });
      const release = pool.warm();
      refuse = false;
      mock.timers.tick(10_000);
      if (failure === "never ready")
        assert.equal(log[0].terminated, true, "cut off at its ready timer");
      const before = log.length;
      const client = pool.attach(() => ({ datasets: {}, transfer: [] }));
      const results = [];
      client.draw({ spec: {} }).subscribe((result) => results.push(result));
      assert.equal(log.length, before + 1, `${failure}: the chart's draw starts a Worker`);
      log.at(-1).start();
      assert.equal(log.at(-1).sent[0].message.type, "draw");
      assert.deepEqual(results, [], "no failure reaches the chart");
      client.detach();
      release();
    }
  } finally {
    mock.timers.reset();
  }
});

test("a hidden document warms nothing, and listens only while warm or drawing", () => {
  const log = [];
  const listeners = new Set();
  const doc = {
    visibilityState: "hidden",
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const pool = createChartPool({
    create: () => new FakeWorker(log),
    size: 1,
    timeoutMs: 1000,
    doc,
  });
  const release = pool.warm();
  assert.equal(log.length, 0);
  assert.equal(listeners.size, 1);
  release();
  assert.equal(listeners.size, 0);
});
