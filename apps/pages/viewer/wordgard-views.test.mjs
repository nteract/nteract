// A view embed's lifecycle: away from the viewport it holds nothing and
// loads nothing; near it, the chart chunk loads and the embed holds its view
// while the chart is mounted. A moved embed keeps its chart through the park.
// Without views or sources, it says the chart isn't on this Page.
import test from "node:test";
import assert from "node:assert/strict";
import { VirtualTimeScheduler } from "rxjs";
import { VIEW_EMBED_STATUS, VIEW_NOT_HERE, viewLifecycle } from "./wordgard-views.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture({ views = true, sources = {} } = {}) {
  const scheduler = new VirtualTimeScheduler();
  const holds = [];
  const mounts = [];
  const chunkLoads = [];
  let near = null;
  const viewStub = views && {
    hold(viewId) {
      const held = { viewId, view$: { viewId }, wants: 0, released: false };
      held.want = () => held.wants++;
      held.release = () => (held.released = true);
      holds.push(held);
      return held;
    },
  };
  const frame = {
    dom: {},
    canvas: { dataset: {}, textContent: "" },
    status: { hidden: false, textContent: "" },
    announce: { textContent: "" },
  };
  const lifecycle = viewLifecycle({
    viewId: "sales",
    views: viewStub,
    sources,
    frame,
    scheduler,
    delay: 10,
    park: 100,
    observe: (_element, callback) => {
      near = callback;
      return () => {};
    },
    load: async () => {
      chunkLoads.push(1);
      return {
        mount: (canvas, attrs) => {
          const instance = { canvas, attrs, destroyed: false };
          instance.destroy = () => (instance.destroyed = true);
          mounts.push(instance);
          return instance;
        },
      };
    },
  });
  const advance = (ms) => {
    const target = scheduler.frame + ms;
    scheduler.maxFrames = target;
    scheduler.flush();
    scheduler.frame = target;
    scheduler.maxFrames = Infinity;
  };
  return { lifecycle, holds, mounts, chunkLoads, frame, advance, near: (value) => near(value) };
}

test("an offscreen embed holds nothing; near the viewport it holds its view while drawn", async () => {
  const f = fixture();
  f.lifecycle.connect();
  assert.equal(f.holds.length, 0, "no view opens for an embed nobody scrolled to");
  assert.equal(f.chunkLoads.length, 0, "no chart code loads away from the viewport");
  assert.equal(f.frame.status.textContent, VIEW_EMBED_STATUS.waiting);
  f.near(true);
  f.advance(10);
  await flush();
  assert.equal(f.chunkLoads.length, 1);
  assert.equal(f.holds.length, 1);
  assert.equal(f.holds[0].wants, 1, "a new embed asks for its view");
  assert.equal(f.mounts[0].attrs.view$, f.holds[0].view$);
  assert.equal(f.frame.status.hidden, true);
  f.lifecycle.disconnect();
  assert.equal(f.holds[0].released, false, "parked, it still holds its view");
  f.advance(100);
  assert.equal(f.mounts[0].destroyed, true, "the park timer unmounts it");
  assert.equal(f.holds[0].released, true, "and lets the view go");
});

test("a moved embed reconnects within the park and keeps its chart and its view", async () => {
  const f = fixture();
  f.lifecycle.connect();
  f.near(true);
  f.advance(10);
  await flush();
  f.lifecycle.disconnect();
  f.lifecycle.connect();
  f.advance(1000);
  assert.equal(f.mounts.length, 1);
  assert.equal(f.mounts[0].destroyed, false);
  assert.equal(f.holds.length, 1);
  assert.equal(f.holds[0].released, false);
});

test("a Page without views says its chart isn't on this Page", async () => {
  const f = fixture({ views: false });
  f.lifecycle.connect();
  f.near(true);
  f.advance(10);
  await flush();
  assert.equal(f.mounts.length, 0);
  assert.equal(f.frame.canvas.textContent, VIEW_NOT_HERE);
});
