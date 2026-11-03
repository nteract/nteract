import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";

const { DATAFRAME_RENDERERS, dataframeFrame, dataframeLifecycle } =
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

function lifecycleFixture() {
  const loads = [],
    mounts = [];
  const status = { hidden: false, textContent: "" };
  const canvas = { dataset: {} };
  const lifecycle = dataframeLifecycle({
    canvas,
    status,
    attrs: { src },
    delay: 0,
    park: 0,
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
  return { lifecycle, loads, mounts, status, module, canvas };
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
