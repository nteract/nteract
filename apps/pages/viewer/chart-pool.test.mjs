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

/** One line for a state and the results its step delivered: the hidden
 * flag, slot 0's phase, each job's phase by id, and each delivery's kind. */
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
  return `${state.hidden ? "hidden " : ""}${state.slots[0].phase} ${jobs || "-"} ${delivered || "-"}`;
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
};

// Every state against every event: the slot phase, the jobs, and what was
// delivered. A stale or unknown answer kills the Worker (WORKER_FAILED).
const TABLE = {
  down: {
    "draw a": "starting 3:waiting -",
    "redraw a": "starting 3:waiting -",
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
  },
  starting: {
    "draw a": "starting 1:waiting 3:waiting -",
    "redraw a": "starting 1:waiting 3:waiting -",
    "cancel 1": "starting - -",
    "cancel 2": "starting 1:waiting -",
    ready: "probing 1:waiting -",
    probed: "down - 1=error",
    "answer 1": "down - 1=error",
    "answer 2": "down - 1=error",
    "timeout 1": "starting 1:waiting -",
    failed: "down - 1=error",
    readyTimeout: "down - 1=error",
    hide: "hidden down 1:waiting -",
    show: "starting 1:waiting -",
    "detach a": "starting - -",
    "detach b": "starting 1:waiting -",
    "attach c": "starting 1:waiting -",
  },
  probing: {
    "draw a": "probing 1:waiting 3:waiting -",
    "redraw a": "probing 1:waiting 3:waiting -",
    "cancel 1": "probing - -",
    "cancel 2": "probing 1:waiting -",
    ready: "probing 1:waiting -",
    probed: "busy 1:running -",
    "answer 1": "down - 1=error",
    "answer 2": "down - 1=error",
    "timeout 1": "probing 1:waiting -",
    failed: "down - 1=error",
    readyTimeout: "down - 1=error",
    hide: "hidden down 1:waiting -",
    show: "probing 1:waiting -",
    "detach a": "probing - -",
    "detach b": "probing 1:waiting -",
    "attach c": "probing 1:waiting -",
  },
  idle: {
    "draw a": "busy 3:running -",
    "redraw a": "busy 3:running -",
    "cancel 1": "idle - -",
    "cancel 2": "idle - -",
    ready: "idle - -",
    probed: "down - -",
    "answer 1": "down - -",
    "answer 2": "down - -",
    "timeout 1": "idle - -",
    failed: "down - -",
    readyTimeout: "idle - -",
    hide: "hidden idle - -",
    show: "idle - -",
    "detach a": "idle - -",
    "detach b": "idle - -",
    "attach c": "idle - -",
  },
  busy: {
    "draw a": "busy 1:running 3:waiting -",
    "redraw a": "busy 1:running 3:waiting -",
    "cancel 1": "down - -",
    "cancel 2": "busy 1:running -",
    ready: "busy 1:running -",
    probed: "down - 1=error",
    "answer 1": "idle - 1=answer",
    "answer 2": "down - 1=error",
    "timeout 1": "down - 1=timeout",
    failed: "down - 1=error",
    readyTimeout: "busy 1:running -",
    hide: "hidden down 1:waiting -",
    show: "busy 1:running -",
    "detach a": "busy 1:abandoned -",
    "detach b": "busy 1:running -",
    "attach c": "busy 1:running -",
  },
  "busy+waiting": {
    "draw a": "busy 1:running 2:waiting 3:waiting -",
    "redraw a": "busy 1:running 2:waiting 3:waiting -",
    "cancel 1": "busy 1:abandoned 2:waiting -",
    "cancel 2": "busy 1:running -",
    ready: "busy 1:running 2:waiting -",
    probed: "starting 2:waiting 1=error",
    "answer 1": "busy 2:running 1=answer",
    "answer 2": "starting 2:waiting 1=error",
    "timeout 1": "starting 2:waiting 1=timeout",
    failed: "starting 2:waiting 1=error",
    readyTimeout: "busy 1:running 2:waiting -",
    hide: "hidden down 1:waiting 2:waiting -",
    show: "busy 1:running 2:waiting -",
    "detach a": "busy 1:abandoned 2:waiting -",
    "detach b": "busy 1:running -",
    "attach c": "busy 1:running 2:waiting -",
  },
  "abandoned+waiting": {
    "draw a": "busy 1:abandoned 2:waiting 3:waiting -",
    "redraw a": "busy 1:abandoned 2:waiting 3:waiting -",
    "cancel 1": "busy 1:abandoned 2:waiting -",
    "cancel 2": "busy 1:abandoned -",
    ready: "busy 1:abandoned 2:waiting -",
    probed: "starting 2:waiting -",
    "answer 1": "busy 2:running -",
    "answer 2": "starting 2:waiting -",
    "timeout 1": "starting 2:waiting -",
    failed: "starting 2:waiting -",
    readyTimeout: "busy 1:abandoned 2:waiting -",
    hide: "hidden down 2:waiting -",
    show: "busy 1:abandoned 2:waiting -",
    "detach a": "busy 1:abandoned 2:waiting -",
    "detach b": "busy 1:abandoned -",
    "attach c": "busy 1:abandoned 2:waiting -",
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
    show: "starting 1:waiting 2:waiting -",
    "detach a": "hidden down 2:waiting -",
    "detach b": "hidden down 1:waiting -",
    "attach c": "hidden down 1:waiting 2:waiting -",
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
});

for (const [name, start] of Object.entries(STATES))
  test(`every event from ${name}`, () => {
    assert.deepEqual(Object.keys(TABLE[name]).sort(), Object.keys(EVENTS).sort());
    for (const [label, event] of Object.entries(EVENTS)) {
      const { state, effects } = chartPool(start, event(start));
      assert.equal(summary(state, effects), TABLE[name][label], `${name} + ${label}`);
    }
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
