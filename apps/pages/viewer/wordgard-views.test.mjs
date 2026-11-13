// A view embed's lifecycle: away from the viewport it holds nothing and
// loads nothing; near it, the chart chunk loads and the embed holds its view
// while the chart is mounted. A moved embed keeps its chart through the park.
// Without views or sources, it says the chart isn't on this Page. Over the
// real view replicas: a mounted embed keeps asking for a missing view, and
// embeds scrolled past or removed don't keep a real chart from its slot.
// The warm-up the embeds share loads the chunk and starts the Worker once,
// quietly, and makes no lookup.
import test from "node:test";
import assert from "node:assert/strict";
import { VirtualTimeScheduler } from "rxjs";
import { LOOK_AGAIN_MS, MISSING_ATTEMPTS, retryDelay } from "./host-doc-open-machine.mjs";
import { MAX_VIEWS, VIEW_CLOSE_DELAY_MS, ViewReplicas } from "./view-replicas.mjs";
import { VIEW_MEDIA_TYPE } from "./view-store.mjs";
import {
  VIEW_EMBED_STATUS,
  VIEW_EMBED_UNAVAILABLE,
  VIEW_NOT_HERE,
  chartWarmup,
  viewLifecycle,
  warmupFor,
} from "./wordgard-views.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const PAGE = "0b9f2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const DELAY = 10;
const PARK = 100;

const frameStub = () => ({
  dom: {},
  canvas: { dataset: {}, textContent: "" },
  status: { hidden: false, textContent: "" },
  announce: { textContent: "" },
});

/** The chart chunk: each mount records its view$ and what it last read. */
function chunkStub({ throwOnDestroy = false } = {}) {
  const mounts = [];
  const loads = [];
  return {
    mounts,
    loads,
    load: async () => {
      loads.push(1);
      return {
        mount: (canvas, attrs) => {
          const instance = { canvas, attrs, destroyed: false, view: null };
          const subscription = attrs.view$.subscribe?.((view) => (instance.view = view));
          instance.destroy = () => {
            subscription?.unsubscribe();
            instance.destroyed = true;
            if (throwOnDestroy) throw Error("destroy threw");
          };
          mounts.push(instance);
          return instance;
        },
      };
    },
  };
}

function clock() {
  const scheduler = new VirtualTimeScheduler();
  const advance = (ms) => {
    const target = scheduler.frame + ms;
    scheduler.maxFrames = target;
    scheduler.flush();
    scheduler.frame = target;
    scheduler.maxFrames = Infinity;
  };
  return { scheduler, advance };
}

/** One embed of `viewId`, with its own viewport watcher. */
function embed({ viewId = "sales", views, sources = {}, scheduler, chunk }) {
  let near = null;
  const frame = frameStub();
  const lifecycle = viewLifecycle({
    viewId,
    views,
    sources,
    frame,
    scheduler,
    delay: DELAY,
    park: PARK,
    observe: (_element, callback) => {
      near = callback;
      return () => {};
    },
    load: chunk.load,
  });
  return { lifecycle, frame, near: (value) => near?.(value) };
}

function fixture({ views = true, sources = {} } = {}) {
  const { scheduler, advance } = clock();
  const holds = [];
  const chunk = chunkStub();
  const viewStub = views && {
    hold(viewId) {
      const held = { viewId, view$: { viewId }, released: false };
      held.release = () => (held.released = true);
      holds.push(held);
      return held;
    },
  };
  const one = embed({ views: viewStub, sources, scheduler, chunk });
  return {
    ...one,
    holds,
    mounts: chunk.mounts,
    chunkLoads: chunk.loads,
    advance,
  };
}

/** Real view replicas over a host holding `existing` view ids. */
function page({ existing = new Set(), throwOnDestroy = false } = {}) {
  const { scheduler, advance } = clock();
  const calls = [];
  const views = new ViewReplicas({
    pageId: PAGE,
    viewDocumentId: async (pageId, viewId) => `${pageId}/${viewId}`,
    find: (id, { signal } = {}) =>
      new Promise((resolve, reject) => {
        const call = { id, settled: false };
        call.resolve = (value) => ((call.settled = true), resolve(value));
        call.reject = (error) => ((call.settled = true), reject(error));
        calls.push(call);
        signal?.addEventListener("abort", () => call.reject(signal.reason ?? Error("aborted")));
      }),
    link: () => 1,
    linked: () => true,
    scheduler,
    closeDelay: VIEW_CLOSE_DELAY_MS,
  });
  const chunk = chunkStub({ throwOnDestroy });
  const answer = async () => {
    for (const call of calls.filter((each) => !each.settled)) {
      const viewId = call.id.slice(PAGE.length + 1);
      if (existing.has(viewId))
        call.resolve({
          doc: () => ({
            title: viewId,
            media_type: VIEW_MEDIA_TYPE,
            spec: JSON.stringify({ mark: "bar" }),
            data: {},
            revision: "1",
            producer: { kind: "edit_page", at: "2026-11-12T00:00:00.000Z", by: { principal: "a" } },
          }),
          on() {},
          off() {},
        });
      else call.reject(Error(`Document ${call.id} is unavailable`));
    }
    await flush();
  };
  /** Bring an embed of `viewId` near the viewport and mount its chart. */
  const show = async (viewId) => {
    const one = embed({ viewId, views, scheduler, chunk });
    one.lifecycle.connect();
    one.near(true);
    advance(DELAY);
    await flush();
    return one;
  };
  /** Answer lookups and let `ms` pass, `rounds` times. */
  const run = async (rounds, ms = 1_000) => {
    for (let round = 0; round < rounds; round++) {
      await answer();
      advance(ms);
      await flush();
    }
  };
  return { views, calls, chunk, advance, show, run, existing };
}

const mountOf = (p, viewId) =>
  p.chunk.mounts.find((mount) => mount.view?.view?.view_id === viewId) ?? null;

test("an offscreen embed holds nothing; near the viewport it holds its view while drawn", async () => {
  const f = fixture();
  f.lifecycle.connect();
  assert.equal(f.holds.length, 0, "no view opens for an embed nobody scrolled to");
  assert.equal(f.chunkLoads.length, 0, "no chart code loads away from the viewport");
  assert.equal(f.frame.status.textContent, VIEW_EMBED_STATUS.waiting);
  f.near(true);
  f.advance(DELAY);
  await flush();
  assert.equal(f.chunkLoads.length, 1);
  assert.equal(f.holds.length, 1);
  assert.equal(f.mounts[0].attrs.view$, f.holds[0].view$);
  assert.equal(f.frame.status.hidden, true);
  f.lifecycle.disconnect();
  assert.equal(f.holds[0].released, false, "parked, it still holds its view");
  f.advance(PARK);
  assert.equal(f.mounts[0].destroyed, true, "the park timer unmounts it");
  assert.equal(f.holds[0].released, true, "and lets the view go");
});

test("a moved embed reconnects within the park and keeps its chart and its view", async () => {
  const f = fixture();
  f.lifecycle.connect();
  f.near(true);
  f.advance(DELAY);
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
  f.advance(DELAY);
  await flush();
  assert.equal(f.mounts.length, 0);
  assert.equal(f.frame.canvas.textContent, VIEW_NOT_HERE);
});

test("a mounted embed of a missing view asks once per window, and draws once the host makes it", async () => {
  const p = page();
  const one = await p.show("sales");
  for (let attempt = 1; attempt <= MISSING_ATTEMPTS; attempt++) await p.run(1, retryDelay(attempt));
  assert.equal(p.calls.length, MISSING_ATTEMPTS);
  const [mount] = p.chunk.mounts;
  assert.equal(mount.view.reason, "missing");
  for (const [index, window] of LOOK_AGAIN_MS.entries()) {
    p.advance(window);
    await flush();
    assert.equal(p.calls.length, MISSING_ATTEMPTS + index + 1, `one lookup after ${window} ms`);
    await p.run(1, 0);
  }
  // The host makes the view; the next window's lookup finds it.
  p.existing.add("sales");
  p.advance(60_000);
  await flush();
  await p.run(1, 0);
  assert.equal(mount.view.status, "ready", "the mounted chart draws without a reload");

  // Removed, the embed lets go after its park; nothing asks after the close.
  p.existing.delete("sales");
  one.lifecycle.disconnect();
  p.advance(PARK + VIEW_CLOSE_DELAY_MS);
  await flush();
  const asked = p.calls.length;
  p.advance(600_000);
  await flush();
  assert.equal(p.calls.length, asked);
  assert.deepEqual(p.views.open, []);
});

test("embeds scrolled past for missing views don't keep a real chart from drawing", async () => {
  const p = page({ existing: new Set(["sales"]) });
  // Ten embeds of views that aren't on this Page come near, mount, and are
  // scrolled past: their charts stay mounted offscreen.
  const passed = [];
  for (let i = 0; i < MAX_VIEWS; i++) {
    const one = await p.show(`gone-${i}`);
    one.near(false);
    passed.push(one);
  }
  for (let attempt = 1; attempt <= MISSING_ATTEMPTS; attempt++) await p.run(1, retryDelay(attempt));
  assert.equal(p.views.open.length, MAX_VIEWS);
  // A real chart further down comes near.
  await p.show("sales");
  await p.run(2);
  assert.equal(mountOf(p, "sales")?.view.status, "ready", "the real chart draws");
  assert.ok(p.views.open.includes("sales"));
});

test("a real chart reached while missing views are still being looked up draws once they settle", async () => {
  const p = page({ existing: new Set(["sales"]) });
  for (let i = 0; i < MAX_VIEWS; i++) await p.show(`gone-${i}`);
  const real = await p.show("sales");
  const mount = p.chunk.mounts.at(-1);
  assert.equal(mount.view.reason, "limit", "every slot is busy");
  for (let attempt = 1; attempt <= MISSING_ATTEMPTS; attempt++) await p.run(1, retryDelay(attempt));
  await p.run(1);
  assert.equal(mount.view.status, "ready", "admitted without a reload");
  real.lifecycle.disconnect();
});

test("an embed replaced by another frees its slot during its close delay", async () => {
  const ids = Array.from({ length: MAX_VIEWS }, (_, i) => `real-${i}`);
  const p = page({ existing: new Set([...ids, "sales"]) });
  const shown = [];
  for (const id of ids) shown.push(await p.show(id));
  await p.run(1);
  assert.equal(p.views.open.length, MAX_VIEWS);
  // The last embed is deleted and a new view's embed is inserted in its
  // place, inside the old one's close delay.
  shown.at(-1).lifecycle.disconnect();
  p.advance(PARK);
  await flush();
  await p.show("sales");
  await p.run(1);
  assert.equal(mountOf(p, "sales")?.view.status, "ready");
  assert.ok(!p.views.open.includes(ids.at(-1)));
});

test("a chart that throws while tearing down still lets go of its view", async () => {
  const p = page({ existing: new Set(["sales"]), throwOnDestroy: true });
  const one = await p.show("sales");
  await p.run(1);
  assert.deepEqual(p.views.open, ["sales"]);
  one.lifecycle.disconnect();
  assert.doesNotThrow(() => p.advance(PARK));
  assert.equal(p.chunk.mounts[0].destroyed, true);
  p.advance(VIEW_CLOSE_DELAY_MS);
  await flush();
  assert.deepEqual(p.views.open, [], "the slot freed");
});

/** A chart chunk whose `warm` records each start and release. */
function warmChunk() {
  const loads = [];
  const warms = [];
  return {
    loads,
    warms,
    load: async () => {
      loads.push(1);
      return {
        warm: (doc) => {
          const warm = { doc, released: 0 };
          warms.push(warm);
          return () => warm.released++;
        },
      };
    },
  };
}

test("a Page without views or sources warms nothing", () => {
  assert.equal(warmupFor({ views: null, sources: {} }), null);
  assert.equal(warmupFor({ views: {}, sources: null }), null);
  assert.ok(warmupFor({ views: {}, sources: {} }));
});

test("every embed on a Page shares one warm-up: one chunk load, one Worker start", async () => {
  const chunk = warmChunk();
  const warmup = chartWarmup({ load: chunk.load });
  const doc = {};
  assert.deepEqual(chunk.loads, [], "nothing loads before an embed connects");
  const releases = [warmup.hold(doc), warmup.hold(doc), warmup.hold(doc)];
  await flush();
  assert.equal(chunk.loads.length, 1);
  assert.equal(chunk.warms.length, 1);
  assert.equal(chunk.warms[0].doc, doc);
  // Wordgard disconnects an embed and connects it again in one turn: the
  // Worker stays.
  releases[0]();
  releases[0] = warmup.hold(doc);
  releases[0]();
  releases[0]();
  await flush();
  assert.equal(chunk.warms[0].released, 0, "two embeds still hold it");
  releases[1]();
  releases[2]();
  await flush();
  assert.equal(chunk.warms[0].released, 1, "the last embed lets it go, once");
  // An embed that connects later warms it again, from the loaded chunk.
  const again = warmup.hold(doc);
  await flush();
  assert.equal(chunk.warms.length, 2);
  again();
  await flush();
  assert.equal(chunk.warms[1].released, 1);
});

test("a warm-up whose chunk fails says nothing; the embed's own load reports it", async () => {
  const failing = {
    load: async () => {
      throw Error("chunk failed");
    },
  };
  const warmup = chartWarmup({ load: failing.load });
  const release = warmup.hold({});
  await flush();
  release();
  await flush();
  const { scheduler, advance } = clock();
  const frame = frameStub();
  let near = null;
  let reported = 0;
  const lifecycle = viewLifecycle({
    viewId: "sales",
    views: { hold: () => assert.fail("no view without a chunk") },
    sources: {},
    frame,
    scheduler,
    delay: DELAY,
    park: PARK,
    observe: (_element, callback) => {
      near = callback;
      return () => {};
    },
    load: failing.load,
    onUnavailable: () => reported++,
  });
  lifecycle.connect();
  near(true);
  advance(DELAY);
  await flush();
  assert.equal(lifecycle.state, "failed");
  assert.equal(frame.status.textContent, VIEW_EMBED_UNAVAILABLE);
  assert.equal(reported, 1);
});

test("a warm Page's embed away from the viewport looks nothing up, holds no slot and arms no timer", async () => {
  const p = page({ existing: new Set(["sales"]) });
  const chunk = warmChunk();
  const warmup = chartWarmup({ load: chunk.load });
  const { scheduler } = clock();
  const one = embed({ views: p.views, scheduler, chunk: p.chunk });
  one.lifecycle.connect();
  const release = warmup.hold({});
  await flush();
  assert.equal(chunk.warms.length, 1, "the chart path is warm");
  assert.equal(p.calls.length, 0, "no view document is looked up");
  assert.equal(p.chunk.mounts.length, 0, "no chart mounts, so no view is held");
  assert.equal(scheduler.actions.length, 0, "the embed armed no timer");
  release();
  one.lifecycle.disconnect();
});
