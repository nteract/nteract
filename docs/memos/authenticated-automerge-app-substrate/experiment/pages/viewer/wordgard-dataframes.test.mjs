import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";

const { DATAFRAME_RENDERERS, DATAFRAME_STATES, dataframeFrame, dataframeLifecycle, dataframeStep } =
  await import("./wordgard-dataframes.mjs");
const src = `/api/pages/33333333-3333-4333-8333-333333333333/assets/${"e".repeat(64)}`;

function withDocument(run) {
  const { window } = new JSDOM("<!doctype html><body></body>");
  const previous = globalThis.document;
  globalThis.document = window.document;
  try {
    return run(window.document);
  } finally {
    globalThis.document = previous;
    window.close();
  }
}

test("each dataframe media type has a lazily loaded renderer", () => {
  assert.deepEqual(Object.keys(DATAFRAME_RENDERERS), [PARQUET_MEDIA_TYPE]);
  for (const load of Object.values(DATAFRAME_RENDERERS)) assert.equal(typeof load, "function");
});

test("a titled dataframe is named and captioned by its title, as text", () =>
  withDocument(() => {
    const { dom, canvas, load } = dataframeFrame({
      src,
      media_type: PARQUET_MEDIA_TYPE,
      title: "<b>Usage</b> by day",
    });
    assert.equal(dom.getAttribute("aria-label"), "<b>Usage</b> by day");
    assert.equal(dom.querySelector(".wordgard-dataframe-title").textContent, "<b>Usage</b> by day");
    assert.equal(dom.querySelector("b"), null);
    assert.equal(canvas.hidden, false);
    assert.equal(load, DATAFRAME_RENDERERS[PARQUET_MEDIA_TYPE]);
  }));

test('an untitled dataframe is named and captioned "Table", muted', () =>
  withDocument(() => {
    const { dom } = dataframeFrame({ src, media_type: PARQUET_MEDIA_TYPE, title: null });
    assert.equal(dom.getAttribute("aria-label"), "Table");
    const caption = dom.querySelector(".wordgard-dataframe-title");
    assert.equal(caption.textContent, "Table");
    assert.ok(caption.classList.contains("is-untitled"));
    assert.equal(dom.querySelector("button"), null);
  }));

test("a media type this build can't render says so instead of loading", () =>
  withDocument(() => {
    const { status, canvas, load } = dataframeFrame({ src, media_type: "text/csv", title: null });
    assert.equal(load, undefined);
    assert.equal(canvas.hidden, true);
    assert.match(status.textContent, /can't show text\/csv/);
  }));

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A lifecycle with a controllable observer when `observer` is given (call
 * `near(true|false)`), or the default, which counts every table as near. */
function lifecycleFixture({ observer = false } = {}) {
  const loads = [],
    mounts = [];
  const status = { hidden: false, textContent: "" };
  const canvas = { dataset: {} };
  const watch = { callback: null, watching: 0, stopped: 0 };
  const lifecycle = dataframeLifecycle({
    canvas,
    status,
    attrs: { src },
    delay: 0,
    park: 0,
    ...(observer && {
      observe: (_element, callback) => {
        watch.callback = callback;
        watch.watching++;
        return () => {
          watch.stopped++;
          watch.callback = null;
        };
      },
    }),
    load: () => {
      const load = deferred();
      loads.push(load);
      return load.promise;
    },
  });
  const module = {
    mount: () => {
      const instance = { destroyed: false, destroy: () => (instance.destroyed = true) };
      mounts.push(instance);
      return instance;
    },
  };
  const near = (value) => watch.callback?.(value);
  return { lifecycle, loads, mounts, status, module, canvas, watch, near };
}

test("a reconnect while loading mounts only the newest table", async () => {
  const f = lifecycleFixture();
  f.lifecycle.connect();
  await tick();
  assert.equal(f.lifecycle.state, "loading");
  f.lifecycle.disconnect();
  f.lifecycle.connect();
  await tick();
  assert.equal(f.loads.length, 2);
  // The first load resolves late, for a generation that's gone.
  f.loads[0].resolve(f.module);
  await tick();
  assert.equal(f.mounts.length, 0);
  f.loads[1].resolve(f.module);
  await tick();
  assert.equal(f.lifecycle.state, "mounted");
  assert.equal(f.mounts.length, 1);
  f.lifecycle.connect();
  await tick();
  assert.equal(f.loads.length, 2, "connect while mounted is a no-op");
  f.lifecycle.disconnect();
  assert.equal(f.lifecycle.state, "parked");
  await tick();
  assert.equal(f.mounts[0].destroyed, true);
  assert.equal(f.lifecycle.state, "idle");
});

test("a reconnect while parked keeps the mounted table without reloading", async () => {
  const f = lifecycleFixture();
  f.lifecycle.connect();
  await tick();
  f.loads[0].resolve(f.module);
  await tick();
  assert.equal(f.lifecycle.state, "mounted");
  // Wordgard moves the DOM into a selection wrapper: disconnect, connect.
  f.lifecycle.disconnect();
  f.lifecycle.connect();
  await tick();
  assert.equal(f.lifecycle.state, "mounted");
  assert.equal(f.mounts.length, 1);
  assert.equal(f.mounts[0].destroyed, false);
  assert.equal(f.loads.length, 1);
  // The move replays CSS animations; the canvas is marked so they're off.
  assert.equal(f.canvas.dataset.moved, "");
});

test("disconnect before the timer fires never loads; a failed load says so", async () => {
  const f = lifecycleFixture();
  f.lifecycle.connect();
  f.lifecycle.disconnect();
  await tick();
  assert.equal(f.loads.length, 0);
  f.lifecycle.connect();
  await tick();
  f.loads[0].reject(Error("chunk gone"));
  await tick();
  assert.equal(f.lifecycle.state, "failed");
  assert.equal(f.status.textContent, "Table unavailable.");
  assert.equal(f.status.hidden, false);
});

const EVENTS = [
  { type: "connect" },
  { type: "disconnect" },
  { type: "visible" },
  { type: "hidden" },
  { type: "timer", generation: 1 },
  { type: "loaded", generation: 1, module: "m" },
  { type: "failed", generation: 1 },
  { type: "parkExpired", generation: 1 },
];
// Every state and event, at the current generation (1). Each cell is the next
// state and the effect types, in order; a missing cell means no change.
const TABLE = {
  idle: { connect: ["waiting", "observe"] },
  waiting: {
    visible: ["scheduled", "startTimer"],
    disconnect: ["idle", "clearTimer", "unobserve", "destroy"],
  },
  scheduled: {
    hidden: ["waiting", "clearTimer"],
    timer: ["loading", "unobserve", "load"],
    disconnect: ["idle", "clearTimer", "unobserve", "destroy"],
  },
  loading: {
    loaded: ["mounted", "mount"],
    failed: ["failed", "fail"],
    disconnect: ["idle", "clearTimer", "unobserve", "destroy"],
  },
  mounted: { disconnect: ["parked", "startTimer"] },
  parked: {
    connect: ["mounted", "clearTimer", "markMoved"],
    parkExpired: ["idle", "destroy"],
    disconnect: ["idle", "clearTimer", "unobserve", "destroy"],
  },
  failed: { disconnect: ["idle", "clearTimer", "unobserve", "destroy"] },
};

test("dataframeStep covers every state and event", () => {
  assert.deepEqual(Object.keys(TABLE), [...DATAFRAME_STATES]);
  const effectType = (effect) => (typeof effect === "string" ? effect : effect.type);
  for (const state of DATAFRAME_STATES)
    for (const event of EVENTS) {
      const model = { state, generation: 1 };
      const { model: next, effects } = dataframeStep(model, event);
      const [expected = state, ...expectedEffects] = TABLE[state][event.type] ?? [];
      const label = `${state} + ${event.type}`;
      assert.equal(next.state, expected, label);
      assert.deepEqual(effects.map(effectType), expectedEffects, label);
      if (!effects.length) assert.equal(next, model, `${label} keeps the model`);
      // A new generation starts on connect from idle and whenever a table is
      // torn down, so anything still pending for the old one is dropped.
      const bumps =
        (state === "idle" && event.type === "connect") || (expected === "idle" && state !== "idle");
      assert.equal(next.generation, bumps ? 2 : 1, `${label} generation`);
    }
});

test("dataframeStep drops a timer, load or park expiry from an older generation", () => {
  for (const [state, type] of [
    ["scheduled", "timer"],
    ["loading", "loaded"],
    ["loading", "failed"],
    ["parked", "parkExpired"],
  ]) {
    const model = { state, generation: 2 };
    const result = dataframeStep(model, { type, generation: 1 });
    assert.equal(result.model, model, `${state} + stale ${type}`);
    assert.deepEqual(result.effects, []);
  }
  // A media type with no renderer never leaves idle.
  const idle = { state: "idle", generation: 0 };
  assert.equal(dataframeStep(idle, { type: "connect" }, { canLoad: false }).model, idle);
});

test("a table loads only once it nears the viewport, and stays loaded offscreen", async () => {
  const f = lifecycleFixture({ observer: true });
  f.lifecycle.connect();
  await tick();
  assert.equal(f.lifecycle.state, "waiting");
  assert.equal(f.loads.length, 0, "no chunk or dataset fetch for an offscreen table");
  f.near(false);
  await tick();
  assert.equal(f.loads.length, 0);
  f.near(true);
  await tick();
  assert.equal(f.lifecycle.state, "loading");
  assert.equal(f.watch.stopped, 1, "loading stops watching");
  f.loads[0].resolve(f.module);
  await tick();
  assert.equal(f.lifecycle.state, "mounted");
  // Scrolling away keeps the table and the reader's view of it.
  f.near(false);
  assert.equal(f.lifecycle.state, "mounted");
  assert.equal(f.mounts[0].destroyed, false);
});

test("scrolling past before the delay fires cancels the load", async () => {
  const f = lifecycleFixture({ observer: true });
  f.lifecycle.connect();
  f.near(true);
  assert.equal(f.lifecycle.state, "scheduled");
  f.near(false);
  assert.equal(f.lifecycle.state, "waiting");
  await tick();
  assert.equal(f.loads.length, 0);
  // Disconnecting a waiting table stops watching it.
  f.lifecycle.disconnect();
  assert.equal(f.lifecycle.state, "idle");
  assert.equal(f.watch.stopped, 1);
  // A reconnect watches again, once.
  f.lifecycle.connect();
  assert.equal(f.watch.watching, 2);
  f.near(true);
  await tick();
  assert.equal(f.loads.length, 1);
});
