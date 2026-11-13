// A view embed's reserved height: the section carries the height this
// browser last drew the chart at, records a new one only while the chart is
// drawn and nothing is maximized, and stops watching when disconnected. A
// chart chunk that fails marks the section so the reserve lets go.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { VirtualTimeScheduler } from "rxjs";
import {
  VIEW_RESERVE_PROPERTY,
  heightRecorder,
  viewFrame,
  viewLifecycle,
} from "./wordgard-views.mjs";

let window;
before(() => {
  ({ window } = new JSDOM("<!doctype html><body></body>"));
  globalThis.document = window.document;
});
after(() => {
  delete globalThis.document;
  window.close();
});

/** A heights store over a plain map, counting writes. */
function heightsStub(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    values,
    writes,
    read: (viewId) => values.get(viewId) ?? null,
    write(viewId, px) {
      const height = Math.round(px);
      writes.push([viewId, height]);
      values.set(viewId, height);
      return height;
    },
  };
}

/** A ResizeObserver whose callback the test calls. */
function observerStub() {
  const made = [];
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      this.disconnected = false;
      made.push(this);
    }
    observe(target) {
      this.targets.push(target);
    }
    disconnect() {
      this.disconnected = true;
    }
    resize(blockSize) {
      this.callback([{ target: this.targets[0], borderBoxSize: [{ blockSize, inlineSize: 600 }] }]);
    }
  }
  return { made, Observer: FakeResizeObserver };
}

/** The embed's DOM as view-embed.mjs and vega-chart.mjs leave it in
 * `viewState`, with the chart's figure in `chartStatus`. */
function embedDom({ viewState, chartStatus = "rendered" }) {
  const { dom } = viewFrame({ viewId: "view_sales" });
  dom.querySelector(".wordgard-view-canvas").innerHTML = `
    <div class="pages-view" data-view-state="${viewState}">
      <div class="pages-view-chart"${viewState === "drawn" ? "" : " hidden"}>
        <figure class="pages-chart" data-chart-status="${chartStatus}"></figure>
      </div>
      <figure class="pages-chart pages-view-placeholder"${viewState === "drawn" ? " hidden" : ""}></figure>
    </div>`;
  document.body.append(dom);
  return dom;
}

const setState = (dom, viewState, chartStatus = "rendered") => {
  const root = dom.querySelector(".pages-view");
  root.dataset.viewState = viewState;
  dom.querySelector(".pages-view-chart").hidden = viewState !== "drawn";
  dom.querySelector(".pages-view-chart .pages-chart").dataset.chartStatus = chartStatus;
};

test("the embed reserves the remembered height at render, and only that", () => {
  const remembered = viewFrame({
    viewId: "view_sales",
    heights: heightsStub({ view_sales: 412 }),
  });
  assert.equal(remembered.dom.style.getPropertyValue(VIEW_RESERVE_PROPERTY), "412px");
  assert.equal(remembered.dom.dataset.viewId, "view_sales");

  // No memory of this view, or no store at all: the CSS default applies.
  const unknown = viewFrame({ viewId: "view_costs", heights: heightsStub({ view_sales: 412 }) });
  assert.equal(unknown.dom.style.getPropertyValue(VIEW_RESERVE_PROPERTY), "");
  const bare = viewFrame({ viewId: "view_sales" });
  assert.equal(bare.dom.style.getPropertyValue(VIEW_RESERVE_PROPERTY), "");
});

test("a height is recorded only while the chart is drawn, in whole px, when it changed", () => {
  const heights = heightsStub();
  const { made, Observer } = observerStub();
  const dom = embedDom({ viewState: "waiting" });
  const recorder = heightRecorder({ dom, viewId: "view_sales", heights, Observer });
  recorder.connect();
  const [observer] = made;
  assert.deepEqual(observer.targets, [dom]);

  // Waiting for the view, and loading its data: still reserved, not recorded.
  observer.resize(372);
  setState(dom, "loading");
  observer.resize(372);
  // Drawn, but Vega hasn't finished.
  setState(dom, "drawn", "drawing");
  observer.resize(120);
  assert.deepEqual(heights.writes, []);

  setState(dom, "drawn", "rendered");
  observer.resize(388.4);
  assert.deepEqual(heights.writes, [["view_sales", 388]]);
  observer.resize(388.2);
  assert.deepEqual(heights.writes, [["view_sales", 388]], "the same whole px writes once");
  observer.resize(402);
  assert.deepEqual(heights.writes.at(-1), ["view_sales", 402]);

  // A sentence that stays, or a chart in its error state, isn't a chart's height.
  setState(dom, "blocked");
  observer.resize(60);
  setState(dom, "drawn", "error");
  observer.resize(80);
  assert.equal(heights.writes.length, 2);
  dom.remove();
});

test("a remembered height that the chart draws at again isn't rewritten", () => {
  const heights = heightsStub({ view_sales: 388 });
  const { made, Observer } = observerStub();
  const dom = embedDom({ viewState: "drawn" });
  heightRecorder({ dom, viewId: "view_sales", heights, Observer }).connect();
  made[0].resize(388);
  assert.deepEqual(heights.writes, []);
  dom.remove();
});

test("nothing is recorded while a chart is maximized", () => {
  const heights = heightsStub();
  const { made, Observer } = observerStub();
  const dom = embedDom({ viewState: "drawn" });
  heightRecorder({ dom, viewId: "view_sales", heights, Observer }).connect();
  const viewer = document.body.appendChild(document.createElement("dialog"));
  viewer.className = "diagram-viewer";
  viewer.setAttribute("open", "");
  made[0].resize(900);
  assert.deepEqual(heights.writes, []);
  viewer.removeAttribute("open");
  made[0].resize(390);
  assert.deepEqual(heights.writes, [["view_sales", 390]]);
  viewer.remove();
  dom.remove();
});

test("disconnect stops watching; connect watches again with one observer", () => {
  const heights = heightsStub();
  const { made, Observer } = observerStub();
  const dom = embedDom({ viewState: "drawn" });
  const recorder = heightRecorder({ dom, viewId: "view_sales", heights, Observer });
  recorder.connect();
  recorder.connect();
  assert.equal(made.length, 1);
  recorder.disconnect();
  assert.equal(made[0].disconnected, true);
  recorder.disconnect();
  recorder.connect();
  assert.equal(made.length, 2);
  recorder.disconnect();
  assert.equal(made[1].disconnected, true);
  dom.remove();
});

test("without a store or a ResizeObserver the recorder does nothing", () => {
  const { made, Observer } = observerStub();
  const dom = embedDom({ viewState: "drawn" });
  const bare = heightRecorder({ dom, viewId: "view_sales", heights: null, Observer });
  bare.connect();
  bare.disconnect();
  assert.equal(made.length, 0);
  const noObserver = heightRecorder({
    dom,
    viewId: "view_sales",
    heights: heightsStub(),
    Observer: undefined,
  });
  noObserver.connect();
  noObserver.disconnect();
  dom.remove();
});

test("a chart chunk that fails marks the section until a reconnect leaves failed", async () => {
  const scheduler = new VirtualTimeScheduler();
  const advance = (ms) => {
    const target = scheduler.frame + ms;
    scheduler.maxFrames = target;
    scheduler.flush();
    scheduler.frame = target;
    scheduler.maxFrames = Infinity;
  };
  const frame = viewFrame({ viewId: "view_sales" });
  let reports = 0;
  let attempt = 0;
  const lifecycle = viewLifecycle({
    viewId: "view_sales",
    views: null,
    sources: null,
    frame,
    scheduler,
    delay: 10,
    park: 100,
    observe: (_element, near) => {
      near(true);
      return () => {};
    },
    onUnavailable: () => reports++,
    load: () =>
      ++attempt === 1
        ? Promise.reject(Error("chunk failed"))
        : Promise.resolve({ mount: () => ({ destroy() {} }) }),
  });
  lifecycle.connect();
  assert.equal(frame.dom.dataset.embedState, undefined);
  advance(10);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lifecycle.state, "failed");
  assert.equal(frame.dom.dataset.embedState, "failed");
  assert.equal(reports, 1);

  lifecycle.disconnect();
  assert.equal(frame.dom.dataset.embedState, undefined);
  lifecycle.connect();
  assert.equal(lifecycle.state, "scheduled");
  assert.equal(frame.dom.dataset.embedState, undefined);
  advance(10);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lifecycle.state, "mounted");
  assert.equal(frame.dom.dataset.embedState, undefined);
  assert.equal(reports, 1);
});

test("a Page without views marks its sentence as one that stays", async () => {
  const frame = viewFrame({ viewId: "view_sales" });
  const lifecycle = viewLifecycle({
    viewId: "view_sales",
    views: null,
    sources: null,
    frame,
    delay: 0,
    observe: (_element, near) => {
      near(true);
      return () => {};
    },
    load: async () => ({ mount: () => ({ destroy() {} }) }),
  });
  lifecycle.connect();
  const until = Date.now() + 2000;
  while (lifecycle.state !== "mounted" && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(lifecycle.state, "mounted");
  assert.equal(frame.canvas.dataset.viewState, "blocked");
  assert.match(frame.canvas.textContent, /isn't on this Page/);
  lifecycle.disconnect();
});
