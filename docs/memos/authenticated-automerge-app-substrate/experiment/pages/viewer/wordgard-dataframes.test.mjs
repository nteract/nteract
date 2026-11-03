import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";

const {
  DATAFRAME_RENDERERS,
  DATAFRAME_STATUS,
  PRELOAD_MARGIN,
  dataframeFrame,
  dataframeLifecycle,
  viewportWatcher,
} = await import("./wordgard-dataframes.mjs");
const { dataframeTableMachine } = await import("./dataframe-table-machine.mjs");
const { loadTable, runTable } = await import("../shared/machine-test.mjs");
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
// Lets settled promises run their callbacks.
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Virtual timers: `advance(ms)` fires every timer due by then, in order. */
function virtualTimers() {
  let now = 0,
    next = 1;
  const pending = new Map();
  return {
    set(run, ms) {
      pending.set(next, { at: now + ms, run });
      return next++;
    },
    clear: (id) => pending.delete(id),
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort(([, a], [, b]) => a.at - b.at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = until;
    },
    get armed() {
      return pending.size;
    },
  };
}

const DELAY = 50,
  PARK = 1000;

/** A lifecycle with virtual timers and a controllable viewport watcher:
 * `near(true|false)` answers through the newest registration. */
function lifecycleFixture() {
  const loads = [],
    mounts = [];
  const status = { hidden: false, textContent: "" };
  const canvas = { dataset: {} };
  const timers = virtualTimers();
  const watch = { callback: null, watching: 0, stopped: 0 };
  const lifecycle = dataframeLifecycle({
    canvas,
    status,
    attrs: { src },
    delay: DELAY,
    park: PARK,
    timers,
    observe: (_element, callback) => {
      watch.callback = callback;
      watch.watching++;
      return () => watch.stopped++;
    },
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
  const near = (value) => watch.callback(value);
  return { lifecycle, loads, mounts, status, module, canvas, watch, near, timers };
}

const TABLE = new URL("../test/fixtures/machines/dataframe-table.json", import.meta.url);

test("the dataframe-table table runs through the pure machine", async () => {
  assert.deepEqual(await runTable(dataframeTableMachine, loadTable(TABLE)), {
    rows: 48,
    pairs: 44,
    unreachable: 12,
    cases: 8,
  });
});

test("a table loads only after it nears the viewport and the delay passes", async () => {
  const f = lifecycleFixture();
  f.lifecycle.connect();
  assert.equal(f.lifecycle.state, "waiting");
  assert.equal(f.status.textContent, DATAFRAME_STATUS.waiting);
  f.timers.advance(10_000);
  assert.equal(f.loads.length, 0, "no chunk or dataset for an offscreen table");
  f.near(true);
  f.timers.advance(DELAY - 1);
  assert.equal(f.loads.length, 0);
  f.timers.advance(1);
  assert.equal(f.loads.length, 1);
  assert.equal(f.lifecycle.state, "loading");
  assert.equal(f.status.textContent, DATAFRAME_STATUS.loading);
  assert.equal(f.watch.stopped, 1, "loading stops watching");
  f.loads[0].resolve(f.module);
  await flush();
  assert.equal(f.lifecycle.state, "mounted");
  assert.equal(f.status.hidden, true);
  // Scrolling away: the watcher's stale callback is ignored and the table,
  // with the reader's view of it, stays.
  f.near(false);
  assert.equal(f.lifecycle.state, "mounted");
  assert.equal(f.mounts[0].destroyed, false);
});

test("scrolling past before the delay cancels the load", () => {
  const f = lifecycleFixture();
  f.lifecycle.connect();
  f.near(true);
  f.timers.advance(DELAY - 1);
  f.near(false);
  assert.equal(f.lifecycle.state, "waiting");
  assert.equal(f.timers.armed, 0);
  f.timers.advance(10_000);
  assert.equal(f.loads.length, 0);
  // Disconnecting a waiting table stops watching; a reconnect watches again.
  f.lifecycle.disconnect();
  assert.equal(f.watch.stopped, 1);
  f.lifecycle.connect();
  assert.equal(f.watch.watching, 2);
  f.near(true);
  f.timers.advance(DELAY);
  assert.equal(f.loads.length, 1);
});

test("a reconnect while loading mounts only the newest table", async () => {
  const f = lifecycleFixture();
  f.lifecycle.connect();
  f.near(true);
  f.timers.advance(DELAY);
  assert.equal(f.lifecycle.state, "loading");
  f.lifecycle.disconnect();
  f.lifecycle.connect();
  f.near(true);
  f.timers.advance(DELAY);
  assert.equal(f.loads.length, 2);
  // The first load resolves late, for a generation that's gone.
  f.loads[0].resolve(f.module);
  await flush();
  assert.equal(f.mounts.length, 0);
  f.loads[1].resolve(f.module);
  await flush();
  assert.equal(f.lifecycle.state, "mounted");
  assert.equal(f.mounts.length, 1);
});

test("a selection move parks the table; it's destroyed only after the park time", async () => {
  const f = lifecycleFixture();
  f.lifecycle.connect();
  f.near(true);
  f.timers.advance(DELAY);
  f.loads[0].resolve(f.module);
  await flush();
  // Wordgard moves the DOM into a selection wrapper: disconnect, connect.
  f.lifecycle.disconnect();
  f.timers.advance(PARK - 1);
  f.lifecycle.connect();
  assert.equal(f.lifecycle.state, "mounted");
  assert.equal(f.mounts[0].destroyed, false);
  assert.equal(f.loads.length, 1);
  assert.equal(f.timers.armed, 0);
  // The move replays CSS animations; the canvas is marked so they're off.
  assert.equal(f.canvas.dataset.moved, "");
  f.lifecycle.disconnect();
  f.timers.advance(PARK - 1);
  assert.equal(f.lifecycle.state, "parked");
  f.timers.advance(1);
  assert.equal(f.lifecycle.state, "idle");
  assert.equal(f.mounts[0].destroyed, true);
});

test("a failed load says so", async () => {
  const f = lifecycleFixture();
  f.lifecycle.connect();
  f.near(true);
  f.timers.advance(DELAY);
  f.loads[0].reject(Error("chunk gone"));
  await flush();
  assert.equal(f.lifecycle.state, "failed");
  assert.equal(f.status.textContent, "Table unavailable.");
  assert.equal(f.status.hidden, false);
});

test("a media type with no renderer never connects", () => {
  const status = { hidden: false, textContent: "can't show" };
  const lifecycle = dataframeLifecycle({
    canvas: { dataset: {} },
    status,
    attrs: { src },
    observe: () => assert.fail("watched a table it can't draw"),
  });
  lifecycle.connect();
  lifecycle.disconnect();
  assert.equal(lifecycle.state, "idle");
  assert.equal(status.textContent, "can't show");
});

/** A stub IntersectionObserver that records what it watches. */
function stubObserver() {
  const instances = [];
  class Observer {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.targets = new Set();
      instances.push(this);
    }
    observe(element) {
      this.targets.add(element);
    }
    unobserve(element) {
      this.targets.delete(element);
    }
    report(element, isIntersecting) {
      this.callback([{ target: element, isIntersecting }]);
    }
  }
  return { Observer, instances };
}

test("the viewport watcher shares one observer and routes each entry to its table", () => {
  const { Observer, instances } = stubObserver();
  const listeners = {};
  const watch = viewportWatcher({
    Observer,
    target: { addEventListener: (type, run) => (listeners[type] = run) },
  });
  const a = {},
    b = {};
  const seen = [];
  const stopA = watch(a, (near) => seen.push(["a", near]));
  watch(b, (near) => seen.push(["b", near]));
  assert.equal(instances.length, 1);
  assert.deepEqual(instances[0].options, { rootMargin: PRELOAD_MARGIN });
  instances[0].report(b, true);
  instances[0].report(a, false);
  assert.deepEqual(seen, [
    ["b", true],
    ["a", false],
  ]);
  // Stopping one table leaves the other watched; a late entry for the
  // stopped one goes nowhere.
  stopA();
  assert.deepEqual([...instances[0].targets], [b]);
  instances[0].report(a, true);
  assert.equal(seen.length, 2);
  // Printing counts every watched table as near.
  listeners.beforeprint();
  assert.deepEqual(seen.at(-1), ["b", true]);
  // A re-observe of one element replaces its callback, and the old stop
  // function doesn't remove the new one.
  const stopOld = watch(b, () => seen.push(["old", true]));
  const stopNew = watch(b, (near) => seen.push(["new", near]));
  stopOld();
  assert.ok(instances[0].targets.has(b), "an old stop doesn't unwatch the new registration");
  instances[0].report(b, true);
  assert.deepEqual(seen.at(-1), ["new", true]);
  stopNew();
  assert.equal(instances[0].targets.has(b), false);
});

test("without IntersectionObserver every table counts as near", () => {
  const watch = viewportWatcher({});
  const seen = [];
  const stop = watch({}, (near) => seen.push(near));
  assert.deepEqual(seen, [true]);
  stop();
});
