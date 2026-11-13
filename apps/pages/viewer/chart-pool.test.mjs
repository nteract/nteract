import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  GRACE_MS,
  LATE_MS,
  TIMED_OUT,
  WORKER_DIDNT_START,
  chartPool,
  createChartPool,
  initialPool,
} from "./chart-pool.mjs";

/** Apply `events` from `state`; return the last state and every effect. */
function play(events, state = initialPool(3)) {
  const effects = [];
  for (const event of events) {
    const result = chartPool(state, event);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}
const types = (effects) => effects.map((effect) => effect.type);
const draw = (id, key) => ({ type: "draw", id, key, message: { type: "draw", id, key } });
const posted = (effects) =>
  effects.filter((effect) => effect.type === "post").map((effect) => effect.message);

test("attach pins charts to the least-loaded Worker, adding Workers up to the size, and starts none", () => {
  const { state, effects } = play(
    ["a", "b", "c", "d", "e"].map((key) => ({ type: "attach", key })),
  );
  assert.deepEqual(effects, []);
  assert.deepEqual(
    state.slots.map((slot) => slot.keys),
    [["a", "d"], ["b", "e"], ["c"]],
  );
  assert.ok(state.slots.every((slot) => slot.phase === "down"));
  // A second attach of the same key changes nothing.
  assert.equal(chartPool(state, { type: "attach", key: "a" }).state, state);
  // A size of one pins every chart to one Worker.
  const one = play(
    ["a", "b"].map((key) => ({ type: "attach", key })),
    initialPool(1),
  ).state;
  assert.deepEqual(
    one.slots.map((slot) => slot.keys),
    [["a", "b"]],
  );
});

test("a first draw starts its Worker, sends every pinned chart's data, then the draw", () => {
  const { state, effects } = play([
    { type: "attach", key: "a" },
    { type: "attach", key: "b" },
    { type: "attach", key: "c" },
    { type: "attach", key: "d" },
    draw(1, "a"),
  ]);
  assert.deepEqual(effects, [
    { type: "spawn", slot: 0, gen: 1 },
    { type: "timer", name: "ready:0", kind: "ready", slot: 0, gen: 1 },
    { type: "data", slot: 0, gen: 1, key: "a" },
    { type: "data", slot: 0, gen: 1, key: "d" },
    { type: "post", slot: 0, gen: 1, message: { type: "draw", id: 1, key: "a" } },
  ]);
  assert.equal(state.slots[0].phase, "starting");
  assert.equal(state.draws[1].phase, "queued");
  // A chart attached to a running Worker sends its data at once.
  const later = chartPool(state, { type: "attach", key: "e" });
  assert.equal(later.state.keys.e, 1);
  assert.deepEqual(later.effects, []);
  const joined = play(
    [
      { type: "detach", key: "b" },
      { type: "attach", key: "f" },
    ],
    state,
  );
  assert.equal(joined.state.keys.f, 1);
});

test("ready, start and answer move a draw from queued to delivered; stale Workers are ignored", () => {
  let { state } = play([{ type: "attach", key: "a" }, draw(1, "a")]);
  let step = chartPool(state, { type: "ready", slot: 0, gen: 1 });
  assert.deepEqual(step.effects, [{ type: "clear", name: "ready:0" }]);
  state = step.state;
  assert.equal(state.slots[0].phase, "ready");
  // A second ready, a stale start and an answer before its start change nothing.
  assert.equal(chartPool(state, { type: "ready", slot: 0, gen: 1 }).state, state);
  assert.equal(chartPool(state, { type: "start", slot: 0, gen: 0, id: 1 }).state, state);
  assert.equal(
    chartPool(state, { type: "answer", slot: 0, gen: 1, id: 1, result: {} }).state,
    state,
  );
  step = chartPool(state, { type: "start", slot: 0, gen: 1, id: 1 });
  assert.deepEqual(step.effects, [{ type: "timer", name: "draw:1", kind: "draw", id: 1 }]);
  state = step.state;
  assert.equal(state.draws[1].phase, "running");
  step = chartPool(state, { type: "answer", slot: 0, gen: 1, id: 1, result: { scene: 1 } });
  assert.deepEqual(step.effects, [
    { type: "clear", name: "draw:1" },
    { type: "deliver", id: 1, result: { scene: 1 } },
  ]);
  assert.deepEqual(step.state.draws, {});
  // A draw for a chart that isn't attached does nothing.
  assert.equal(chartPool(step.state, draw(9, "nobody")).state, step.state);
});

test("cancel drops a held or queued draw, abandons a running one others wait behind, or restarts", () => {
  const base = play([
    { type: "attach", key: "a" },
    { type: "attach", key: "b" },
    { type: "attach", key: "c" },
    { type: "attach", key: "d" },
    draw(1, "a"),
    { type: "ready", slot: 0, gen: 1 },
  ]).state;
  // Queued: the Worker is told to skip it.
  const queued = chartPool(base, { type: "cancel", id: 1 });
  assert.deepEqual(posted(queued.effects), [{ type: "cancel", id: 1 }]);
  assert.deepEqual(queued.state.draws, {});
  // Running, alone on its Worker: the Worker restarts with the newer draw.
  const running = play([{ type: "start", slot: 0, gen: 1, id: 1 }, draw(2, "a")], base).state;
  const alone = chartPool(running, { type: "cancel", id: 1 });
  assert.deepEqual(types(alone.effects), [
    "clear",
    "terminate",
    "clear",
    "spawn",
    "timer",
    "data",
    "data",
    "post",
  ]);
  assert.deepEqual(posted(alone.effects), [{ type: "draw", id: 2, key: "a" }]);
  assert.equal(alone.state.slots[0].gen, 2);
  // Running, with another chart's draw queued behind: it runs out, abandoned.
  const shared = play([{ type: "start", slot: 0, gen: 1, id: 1 }, draw(3, "d")], base).state;
  const abandoned = chartPool(shared, { type: "cancel", id: 1 });
  assert.deepEqual(abandoned.effects, []);
  assert.equal(abandoned.state.draws[1].phase, "abandoned");
  // Its answer is dropped, not delivered.
  const late = chartPool(abandoned.state, { type: "answer", slot: 0, gen: 1, id: 1, result: {} });
  assert.deepEqual(late.effects, [{ type: "clear", name: "draw:1" }]);
  // Cancelling an abandoned or unknown draw does nothing.
  assert.equal(chartPool(abandoned.state, { type: "cancel", id: 1 }).state, abandoned.state);
  assert.equal(chartPool(base, { type: "cancel", id: 99 }).state, base);
  // Held: dropped with no message.
  const hidden = play([{ type: "hide" }, draw(4, "b")], base).state;
  const held = chartPool(hidden, { type: "cancel", id: 4 });
  assert.deepEqual(held.effects, []);
  assert.equal(held.state.draws[4], undefined);
});

test("a timeout fails only its chart; the Worker is replaced and the others draw there", () => {
  const { state } = play([
    { type: "attach", key: "a" },
    { type: "attach", key: "b" },
    { type: "attach", key: "c" },
    { type: "attach", key: "d" },
    draw(1, "a"),
    draw(2, "d"),
    { type: "ready", slot: 0, gen: 1 },
    { type: "start", slot: 0, gen: 1, id: 1 },
  ]);
  const step = chartPool(state, { type: "drawTimeout", id: 1 });
  assert.deepEqual(step.effects[0], {
    type: "deliver",
    id: 1,
    result: { error: { message: TIMED_OUT, refusal: true }, timedOut: true },
  });
  assert.deepEqual(types(step.effects.slice(1)), [
    "terminate",
    "clear",
    "spawn",
    "timer",
    "data",
    "data",
    "post",
  ]);
  assert.deepEqual(posted(step.effects), [{ type: "draw", id: 2, key: "d" }]);
  assert.equal(step.state.draws[2].phase, "queued");
  assert.equal(step.state.slots[0].gen, 2);
  // Late messages from the old Worker are ignored.
  assert.equal(
    chartPool(step.state, { type: "answer", slot: 0, gen: 1, id: 2, result: {} }).state,
    step.state,
  );
  // A timeout for a draw that already answered does nothing.
  assert.equal(chartPool(step.state, { type: "drawTimeout", id: 1 }).state, step.state);
  // An abandoned draw's timeout restarts the Worker and delivers nothing.
  const abandoned = play([{ type: "cancel", id: 1 }], state).state;
  const quiet = chartPool(abandoned, { type: "drawTimeout", id: 1 });
  assert.ok(!types(quiet.effects).includes("deliver"));
  assert.ok(types(quiet.effects).includes("spawn"));
  // A chart alone on its Worker: the Worker stops, and its next draw starts
  // another.
  const alone = play([
    { type: "attach", key: "a" },
    draw(1, "a"),
    { type: "ready", slot: 0, gen: 1 },
    { type: "start", slot: 0, gen: 1, id: 1 },
    { type: "drawTimeout", id: 1 },
  ]);
  assert.deepEqual(types(alone.effects).slice(-3), ["deliver", "terminate", "clear"]);
  assert.equal(alone.state.slots[0].phase, "down");
  assert.deepEqual(chartPool(alone.state, draw(2, "a")).effects[0], {
    type: "spawn",
    slot: 0,
    gen: 2,
  });
});

for (const size of [1, 2]) {
  test(`at size ${size}, charts pin, a hung Worker is replaced, and the others send their data again`, () => {
    const keys = ["a", "b", "c", "d"];
    const { state, effects } = play(
      [
        ...keys.map((key) => ({ type: "attach", key })),
        ...keys.map((key, index) => draw(index + 1, key)),
      ],
      initialPool(size),
    );
    // Round-robin over `size` Workers, each started by its first draw.
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
    // "a" hangs on Worker 0; "c" (or every chart, at size 1) waits behind it.
    const hung = play(
      [
        ...state.slots.map((_, slot) => ({ type: "ready", slot, gen: 1 })),
        { type: "start", slot: 0, gen: 1, id: 1 },
        { type: "drawTimeout", id: 1 },
      ],
      state,
    );
    const delivered = hung.effects.filter((effect) => effect.type === "deliver");
    assert.deepEqual(
      delivered.map((effect) => effect.id),
      [1],
    );
    const spawned = hung.effects.filter((effect) => effect.type === "spawn");
    assert.deepEqual(spawned, [{ type: "spawn", slot: 0, gen: 2 }]);
    const pinned = state.slots[0].keys;
    assert.deepEqual(
      hung.effects.filter((effect) => effect.type === "data").map((effect) => effect.key),
      pinned,
      "every chart pinned there sends its data to the replacement",
    );
    assert.deepEqual(
      posted(hung.effects).map((message) => message.id),
      pinned.filter((key) => key !== "a").map((key) => keys.indexOf(key) + 1),
      "and its waiting draws",
    );
    // The other Worker, at size 2, is untouched.
    if (size === 2) assert.equal(hung.state.slots[1].gen, 1);
  });
}

test("a Worker that fails or never says ready fails every draw on it, and the next draw starts another", () => {
  const { state } = play([
    { type: "attach", key: "a" },
    { type: "attach", key: "b" },
    { type: "attach", key: "c" },
    { type: "attach", key: "d" },
    draw(1, "a"),
    draw(2, "d"),
  ]);
  for (const event of [
    { type: "readyTimeout", slot: 0, gen: 1 },
    { type: "failed", slot: 0, gen: 1, message: "" },
  ]) {
    const step = chartPool(state, event);
    const delivered = step.effects.filter((effect) => effect.type === "deliver");
    assert.deepEqual(
      delivered.map((effect) => [effect.id, effect.result.error.message]),
      [
        [1, WORKER_DIDNT_START],
        [2, WORKER_DIDNT_START],
      ],
    );
    assert.equal(step.state.slots[0].phase, "down");
    assert.deepEqual(step.state.draws, {});
    const again = chartPool(step.state, draw(3, "a"));
    assert.deepEqual(again.effects[0], { type: "spawn", slot: 0, gen: 2 });
  }
  // A failure names its cause; a readyTimeout after ready, or from an old
  // Worker, does nothing.
  const named = chartPool(state, { type: "failed", slot: 0, gen: 1, message: "Script failed." });
  assert.equal(
    named.effects.find((effect) => effect.type === "deliver").result.error.message,
    "Script failed.",
  );
  const ready = play([{ type: "ready", slot: 0, gen: 1 }], state).state;
  assert.equal(chartPool(ready, { type: "readyTimeout", slot: 0, gen: 1 }).state, ready);
  assert.equal(chartPool(state, { type: "failed", slot: 0, gen: 0 }).state, state);
});

test("hide terminates busy Workers and holds their draws; show starts them again", () => {
  const { state } = play([
    { type: "attach", key: "a" },
    { type: "attach", key: "b" },
    draw(1, "a"),
    { type: "ready", slot: 0, gen: 1 },
    { type: "start", slot: 0, gen: 1, id: 1 },
    draw(2, "b"),
    { type: "ready", slot: 1, gen: 1 },
    { type: "start", slot: 1, gen: 1, id: 2 },
    { type: "answer", slot: 1, gen: 1, id: 2, result: {} },
  ]);
  const hidden = chartPool(state, { type: "hide" });
  // Only the busy Worker stops; the idle one keeps its data.
  assert.deepEqual(types(hidden.effects), ["terminate", "clear", "clear"]);
  assert.equal(hidden.state.slots[0].phase, "down");
  assert.equal(hidden.state.slots[1].phase, "ready");
  assert.equal(hidden.state.draws[1].phase, "held");
  assert.equal(chartPool(hidden.state, { type: "hide" }).state, hidden.state);
  // A draw while hidden is held without a message.
  const more = chartPool(hidden.state, draw(3, "b"));
  assert.deepEqual(more.effects, []);
  const shown = chartPool(more.state, { type: "show" });
  assert.deepEqual(posted(shown.effects), [
    { type: "draw", id: 1, key: "a" },
    { type: "draw", id: 3, key: "b" },
  ]);
  assert.deepEqual(types(shown.effects).slice(0, 3), ["spawn", "timer", "data"]);
  assert.equal(chartPool(shown.state, { type: "show" }).state, shown.state);
  // An abandoned draw is dropped on hide.
  const abandoned = play(
    [
      { type: "attach", key: "a" },
      { type: "attach", key: "b" },
      draw(1, "a"),
      draw(2, "b"),
      { type: "ready", slot: 0, gen: 1 },
      { type: "start", slot: 0, gen: 1, id: 1 },
      { type: "cancel", id: 1 },
    ],
    initialPool(1),
  ).state;
  assert.equal(abandoned.draws[1].phase, "abandoned");
  const dropped = chartPool(abandoned, { type: "hide" }).state;
  assert.equal(dropped.draws[1], undefined);
  assert.equal(dropped.draws[2].phase, "held");
});

test("detach drops a chart's draws and data; the last chart on a Worker terminates it", () => {
  const { state } = play([
    { type: "attach", key: "a" },
    { type: "attach", key: "b" },
    { type: "attach", key: "c" },
    { type: "attach", key: "d" },
    draw(1, "a"),
    draw(2, "d"),
    { type: "ready", slot: 0, gen: 1 },
    { type: "start", slot: 0, gen: 1, id: 1 },
  ]);
  // "d" leaves with a queued draw: cancel it and drop its data.
  const d = chartPool(state, { type: "detach", key: "d" });
  assert.deepEqual(posted(d.effects), [
    { type: "cancel", id: 2 },
    { type: "drop", key: "d" },
  ]);
  assert.deepEqual(d.state.slots[0].keys, ["a"]);
  // "a" leaves with a running draw, the last on its Worker: terminated.
  const a = chartPool(d.state, { type: "detach", key: "a" });
  assert.deepEqual(types(a.effects), ["post", "terminate", "clear", "clear"]);
  assert.equal(a.state.slots[0].phase, "down");
  assert.deepEqual(a.state.draws, {});
  assert.equal(chartPool(a.state, { type: "detach", key: "a" }).state, a.state);
  // A held draw leaves with its chart.
  const hidden = play([{ type: "hide" }, draw(3, "b"), { type: "detach", key: "b" }], state).state;
  assert.equal(hidden.draws[3], undefined);
  assert.throws(() => chartPool(state, { type: "nonsense" }), /unknown chart pool event/);
});

/** A Worker the interpreter drives, recording what it's sent. */
class FakeWorker extends EventTarget {
  constructor(log) {
    super();
    this.log = log;
    this.sent = [];
    this.terminated = false;
    log.push(this);
  }
  postMessage(message, transfer) {
    this.sent.push({ message, transfer });
  }
  reply(data) {
    this.dispatchEvent(Object.assign(new Event("message"), { data }));
  }
  terminate() {
    this.terminated = true;
  }
}

test("the interpreter times a draw from its start, with one grace beat when the page ran late", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const log = [];
    const pool = createChartPool({ create: () => new FakeWorker(log), size: 1, timeoutMs: 1000 });
    const client = pool.attach(() => ({ datasets: { d: { rows: [] } }, transfer: [] }));
    const results = [];
    client.draw({ spec: {} }).subscribe((result) => results.push(result));
    const [worker] = log;
    assert.deepEqual(
      worker.sent.map(({ message }) => message.type),
      ["data", "draw"],
    );
    worker.reply({ type: "ready" });
    // Queued for a long time: no timer runs until the Worker starts the draw.
    mock.timers.tick(5000);
    assert.deepEqual(results, []);
    const id = worker.sent[1].message.id;
    worker.reply({ type: "start", id });
    mock.timers.tick(999);
    assert.deepEqual(results, []);
    mock.timers.tick(1);
    assert.equal(results[0].error.message, TIMED_OUT);
    assert.equal(worker.terminated, true);
    assert.equal(log.length, 1, "no replacement waits for a chart alone");
    // Its next draw starts a Worker with its data.
    client.draw({ spec: {} }).subscribe(() => {});
    assert.deepEqual(
      log[1].sent.map(({ message }) => message.type),
      ["data", "draw"],
    );
    client.detach();
    assert.equal(log[1].terminated, true);
  } finally {
    mock.timers.reset();
  }
  // The grace beat: a timer that fires LATE_MS late waits GRACE_MS once more.
  assert.ok(LATE_MS > GRACE_MS);
});

test("the interpreter fails a Worker that never says ready, and sends a copy of data that can't cross as a failure", () => {
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
    assert.deepEqual(log[0].sent[0].message, {
      type: "data",
      key: "chart-1",
      failed: "Function object could not be cloned.",
    });
    mock.timers.tick(300);
    assert.equal(results[0].error.message, WORKER_DIDNT_START);
    assert.equal(log[0].terminated, true);
    client.detach();
  } finally {
    mock.timers.reset();
  }
});
