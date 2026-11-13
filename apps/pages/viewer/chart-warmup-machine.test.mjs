// The chart warm-up's machine over every state and event, and its
// interpreter (wordgard-views.mjs chartWarmup) through document moves.
import assert from "node:assert/strict";
import test from "node:test";
import { runTable } from "../shared/machine-test.mjs";
import { WARMUP_REJECT, chartWarmupMachine } from "./chart-warmup-machine.mjs";
import { chartWarmup } from "./wordgard-views.mjs";

const idle = { name: "idle" };
const loading = (holds) => ({ name: "loading", holds });
const failed = (holds) => ({ name: "failed", holds });
const ready = (holds, warm = null, settling = false) => ({ name: "ready", holds, warm, settling });
const hold = (doc) => ({ type: "hold", doc });
const release = (doc) => ({ type: "release", doc });
const LOADED = { type: "loaded" };
const LOAD_FAILED = { type: "loadFailed" };
const SETTLE = { type: "settle" };
const warm = (doc) => ({ type: "warm", doc });
const cool = (doc) => ({ type: "cool", doc });
const ok = (state, ...effects) => ({ state, effects });
const no = (state, reason) => ({ state, effects: [], rejected: reason });

const row = (label, state, event, expect, extra = {}) => ({
  label,
  state,
  event,
  expect,
  ...extra,
});

const ROWS = [
  row("the first embed loads the chunk", idle, hold("A"), ok(loading({ A: 1 }), { type: "load" })),
  row("nothing to release", idle, release("A"), no(idle, WARMUP_REJECT.notHeld)),
  row("no load runs", idle, LOADED, no(idle, WARMUP_REJECT.noLoad)),
  row("no load runs to fail", idle, LOAD_FAILED, no(idle, WARMUP_REJECT.noLoad)),
  row("no settle is deferred", idle, SETTLE, no(idle, WARMUP_REJECT.noSettle)),

  row(
    "another document holds while loading",
    loading({ A: 1 }),
    hold("B"),
    ok(loading({ A: 1, B: 1 })),
  ),
  row("an embed leaves while loading", loading({ A: 1 }), release("A"), ok(loading({})), {
    case: "held",
  }),
  row(
    "a document that holds nothing",
    loading({ A: 1 }),
    release("B"),
    no(loading({ A: 1 }), WARMUP_REJECT.notHeld),
    {
      case: "not-held",
    },
  ),
  row(
    "the chunk loads for the document still held: the loading-time move",
    loading({ B: 1 }),
    LOADED,
    ok(ready({ B: 1 }, "B"), warm("B")),
    {
      case: "held",
    },
  ),
  row("the chunk loads with nothing held: nothing warms", loading({}), LOADED, ok(ready({})), {
    case: "empty",
  }),
  row("the chunk fails while held", loading({ A: 1 }), LOAD_FAILED, ok(failed({ A: 1 })), {
    case: "held",
  }),
  row("the chunk fails with nothing held", loading({}), LOAD_FAILED, ok(idle), { case: "empty" }),
  row(
    "no settle while loading",
    loading({ A: 1 }),
    SETTLE,
    no(loading({ A: 1 }), WARMUP_REJECT.noSettle),
  ),

  row(
    "a failed chunk counts a new embed and loads nothing",
    failed({ A: 1 }),
    hold("B"),
    ok(failed({ A: 1, B: 1 })),
  ),
  row("one embed of several leaves", failed({ A: 1, B: 1 }), release("A"), ok(failed({ B: 1 })), {
    case: "others-held",
  }),
  row("the last embed leaves: a later one tries again", failed({ A: 1 }), release("A"), ok(idle), {
    case: "last",
  }),
  row(
    "a failed chunk, a document that holds nothing",
    failed({ A: 1 }),
    release("B"),
    no(failed({ A: 1 }), WARMUP_REJECT.notHeld),
    {
      case: "not-held",
    },
  ),
  row(
    "no load after a failure",
    failed({ A: 1 }),
    LOADED,
    no(failed({ A: 1 }), WARMUP_REJECT.noLoad),
  ),
  row(
    "no second failure",
    failed({ A: 1 }),
    LOAD_FAILED,
    no(failed({ A: 1 }), WARMUP_REJECT.noLoad),
  ),
  row(
    "no settle after a failure",
    failed({ A: 1 }),
    SETTLE,
    no(failed({ A: 1 }), WARMUP_REJECT.noSettle),
  ),

  row(
    "a loaded chunk warms the first document held",
    ready({}),
    hold("A"),
    ok(ready({ A: 1 }, "A"), warm("A")),
    {
      case: "first",
    },
  ),
  row(
    "the already-warm move: the warm document's embeds left, another document holds",
    ready({}, "A", true),
    hold("B"),
    ok(ready({ B: 1 }, "B", true), cool("A"), warm("B")),
    {
      case: "move",
    },
  ),
  row(
    "another embed in the warm document",
    ready({ A: 1 }, "A"),
    hold("A"),
    ok(ready({ A: 2 }, "A")),
    {
      case: "same",
    },
  ),
  row(
    "another document while the warm one is held",
    ready({ A: 1 }, "A"),
    hold("B"),
    ok(ready({ A: 1, B: 1 }, "A")),
    {
      case: "other",
    },
  ),
  row(
    "the warm document's last embed leaves: settle later",
    ready({ A: 1 }, "A"),
    release("A"),
    ok(ready({}, "A", true), { type: "defer" }),
    {
      case: "warm-left",
    },
  ),
  row(
    "the warm document is still held",
    ready({ A: 2 }, "A"),
    release("A"),
    ok(ready({ A: 1 }, "A")),
    {
      case: "still-held",
    },
  ),
  row(
    "a settle is already deferred",
    ready({ A: 1 }, "A", true),
    release("A"),
    ok(ready({}, "A", true)),
    {
      case: "settling",
    },
  ),
  row(
    "an embed leaves a document that isn't warm",
    ready({ A: 1, B: 1 }, "A"),
    release("B"),
    ok(ready({ A: 1 }, "A")),
    {
      case: "other",
    },
  ),
  row(
    "a loaded chunk, a document that holds nothing",
    ready({ A: 1 }, "A"),
    release("B"),
    no(ready({ A: 1 }, "A"), WARMUP_REJECT.notHeld),
    {
      case: "not-held",
    },
  ),
  row(
    "no load after loading",
    ready({ A: 1 }, "A"),
    LOADED,
    no(ready({ A: 1 }, "A"), WARMUP_REJECT.noLoad),
  ),
  row(
    "no failure after loading",
    ready({ A: 1 }, "A"),
    LOAD_FAILED,
    no(ready({ A: 1 }, "A"), WARMUP_REJECT.noLoad),
  ),
  row(
    "the embed came back in the same turn: the pool stays warm",
    ready({ A: 1 }, "A", true),
    SETTLE,
    ok(ready({ A: 1 }, "A")),
    {
      case: "kept",
    },
  ),
  row(
    "the warm document left and another holds: the warm-up moves",
    ready({ B: 1 }, "A", true),
    SETTLE,
    ok(ready({ B: 1 }, "B"), cool("A"), warm("B")),
    {
      case: "move",
    },
  ),
  row("nothing holds: the pool cools", ready({}, "A", true), SETTLE, ok(ready({}), cool("A")), {
    case: "cool",
  }),
  row(
    "a settle with none deferred",
    ready({ A: 1 }, "A"),
    SETTLE,
    no(ready({ A: 1 }, "A"), WARMUP_REJECT.noSettle),
    {
      case: "not-settling",
    },
  ),
];

test("the chart warm-up machine answers every state and event", async () => {
  const result = await runTable(chartWarmupMachine, ROWS);
  assert.equal(result.rows, ROWS.length);
  assert.equal(result.pairs, 20);
});

/** A chunk whose `warm` records each document it warmed and each release;
 * `settle()` resolves the load. */
function harness() {
  const warms = [];
  const deferred = [];
  let resolve;
  let reject;
  const loads = [];
  const warmup = chartWarmup({
    load: () => {
      loads.push(1);
      return new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
    },
    defer: (run) => deferred.push(run),
  });
  const chunk = {
    warm: (doc) => {
      const entry = { doc, released: 0 };
      warms.push(entry);
      return () => entry.released++;
    },
  };
  const flush = () => new Promise((done) => setImmediate(done));
  return {
    warmup,
    warms,
    loads,
    load: async () => (await flush(), resolve(chunk), flush()),
    fail: async () => (await flush(), reject(Error("chunk failed")), flush()),
    settle: () => deferred.splice(0).forEach((run) => run()),
  };
}

test("an embed that moves to another document while the chunk loads warms only the new one", async () => {
  const h = harness();
  const [a, b] = [{ name: "A" }, { name: "B" }];
  h.warmup.hold(a)();
  const releaseB = h.warmup.hold(b);
  await h.load();
  assert.equal(h.loads.length, 1);
  assert.deepEqual(
    h.warms.map((entry) => entry.doc),
    [b],
  );
  releaseB();
  h.settle();
  assert.equal(h.warms[0].released, 1);
});

test("an embed that moves after the chunk loaded moves the warm pool with it", async () => {
  const h = harness();
  const [a, b] = [{ name: "A" }, { name: "B" }];
  const releaseA = h.warmup.hold(a);
  await h.load();
  releaseA();
  // Inside the deferred release, the embed connects in B.
  const releaseB = h.warmup.hold(b);
  assert.deepEqual(
    h.warms.map((entry) => [entry.doc, entry.released]),
    [
      [a, 1],
      [b, 0],
    ],
  );
  h.settle();
  assert.equal(h.warms[1].released, 0, "B stays warm");
  releaseB();
  h.settle();
  assert.equal(h.warms[1].released, 1);
});

test("a chunk that fails warms nothing and loads again for a later embed", async () => {
  const h = harness();
  const release = h.warmup.hold({});
  await h.fail();
  assert.deepEqual(h.warms, []);
  release();
  h.warmup.hold({});
  await new Promise((done) => setImmediate(done));
  assert.equal(h.loads.length, 2);
});
