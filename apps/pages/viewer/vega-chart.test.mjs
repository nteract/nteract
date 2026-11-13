import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Vector, tableFromIPC, tableFromJSON, tableToIPC } from "apache-arrow";
import { JSDOM } from "jsdom";
import * as vega from "vega";
import { SVGHandler } from "vega-scenegraph";
globalThis.__vega = vega;

const {
  mount,
  drawScene,
  setChartWorker,
  formatTooltip,
  safePaint,
  cleanItem,
  RESIZE_SETTLE_MS,
  TIMED_OUT,
  tooltipText,
  drawnWidths,
} = await import("./vega-chart.mjs");
const {
  runChart,
  serveCharts,
  sizedSpec,
  themeConfig,
  textLimits,
  deniedLoader,
  runtimeProblem,
  VEGA_LITE_FUNCTIONS,
  STATIC_OPERATORS,
} = await import("./chart-dataflow.mjs");
const { datasetRows, ownRows } = await import("./chart-data.mjs");
const { plainScene, readDatasets } = await import("./chart-dataflow.mjs");
const {
  SCENE_PATH_COMMANDS,
  pathCost,
  SCENE_BUDGET,
  SCENE_MALFORMED,
  SCENE_MAX_ITEMS,
  SCENE_TOO_BIG,
  SCENE_TOO_LARGE,
  pageScene,
} = await import("./chart-scene.mjs");
const { WORKER_DIDNT_START } = await import("./chart-pool.mjs");
const { CHART_FALLBACK_FONT, probeCount, probeItems } = await import("./chart-font.mjs");
const { checkChartSpec, CHART_MAX_ROWS, CHART_MAX_CELLS, CHART_EXPRESSION_FUNCTIONS } =
  await import("../shared/chart-spec.mjs");
const vl = await import("vega-lite");
const { pathParse } = await import("vega-scenegraph");

const theme = { dark: false, text: "#111", muted: "#555", line: "#ddd" };
const calls = [
  { tool: "read_page", client: "Claude", calls: 300 },
  { tool: "read_page", client: "Codex", calls: 120 },
  { tool: "patch_page", client: "Claude", calls: 80 },
  { tool: "patch_page", client: "Codex", calls: 20 },
  { tool: "move_page", client: "Claude", calls: 30 },
];
const stacked = {
  data: { name: "calls" },
  mark: "bar",
  encoding: {
    y: { field: "tool", type: "nominal" },
    x: { field: "calls", type: "quantitative", aggregate: "sum" },
    color: { field: "client", type: "nominal" },
  },
};
const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
/** Wait until `check()` is true, up to `ms` (five seconds). */
async function until(check, ms = 5_000) {
  for (let i = 0; i < ms / 20 && !check(); i++) await settle(20);
  return check();
}
/** Wait until `element`'s chart has drawn or failed, up to five seconds. */
async function drawn(element) {
  for (let i = 0; i < 250; i++) {
    const status = element.querySelector("figure")?.dataset.chartStatus;
    if (status && status !== "drawing") return status;
    await settle(20);
  }
  return "drawing";
}
const bars = (root) => root.querySelectorAll("path[role='graphics-symbol']");

/**
 * A jsdom window with Vega's globals, a controllable ResizeObserver, and a
 * ledger of live event listeners and observers so a test can check that
 * destroy leaves none behind.
 */
function withWindow(run) {
  const { window } = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    pretendToBeVisual: true,
  });
  // Every listener added and not yet removed, on any target.
  const live = new Set();
  const key = (target, type, listener, options) => [
    target,
    type,
    listener,
    typeof options === "boolean" ? options : !!options?.capture,
  ];
  const find = (entry) =>
    [...live].find((other) => other.every((part, index) => part === entry[index]));
  const { addEventListener, removeEventListener } = window.EventTarget.prototype;
  window.EventTarget.prototype.addEventListener = function (type, listener, options) {
    const entry = key(this, type, listener, options);
    if (listener && !find(entry)) live.add(entry);
    return addEventListener.call(this, type, listener, options);
  };
  window.EventTarget.prototype.removeEventListener = function (type, listener, options) {
    const entry = find(key(this, type, listener, options));
    if (entry) live.delete(entry);
    return removeEventListener.call(this, type, listener, options);
  };
  // Listeners that outlive a chart: on the window, the document or anything
  // still in it. A detached element takes its own listeners with it.
  const listeners = () =>
    [...live].filter(([target]) => target === window || target.nodeType === 9 || target.isConnected)
      .length;
  // jsdom's selector engine adds its own document listeners the first time it
  // runs; start it before anything is counted.
  window.document.querySelector("body");
  window.getComputedStyle(window.document.body);

  const observers = { resize: [], mutation: 0 };
  window.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.connected = false;
      observers.resize.push(this);
    }
    observe() {
      this.connected = true;
    }
    disconnect() {
      this.connected = false;
    }
  };
  const NativeMutationObserver = window.MutationObserver;
  window.MutationObserver = class extends NativeMutationObserver {
    observe(...args) {
      observers.mutation++;
      return super.observe(...args);
    }
    disconnect() {
      observers.mutation--;
      return super.disconnect();
    }
  };

  // Vega's SVG renderer and vega-tooltip create elements through the global
  // document.
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
  };
  Object.assign(globalThis, { window, document: window.document, location: window.location });
  return Promise.resolve(run(window, { listeners, observers })).finally(() => {
    Object.assign(globalThis, previous);
    window.close();
  });
}

/** Count Vega views that run, and those not yet finalized, while `run` runs. */
async function countViews(run) {
  const { runAsync, finalize } = vega.View.prototype;
  const views = { live: new Set(), created: 0 };
  vega.View.prototype.runAsync = function (...args) {
    if (!views.live.has(this)) views.created++;
    views.live.add(this);
    return runAsync.apply(this, args);
  };
  vega.View.prototype.finalize = function (...args) {
    views.live.delete(this);
    return finalize.apply(this, args);
  };
  try {
    return await run(views);
  } finally {
    Object.assign(vega.View.prototype, { runAsync, finalize });
  }
}

const { InProcessWorker, workers } = await import("../test/chart-worker-in-process.mjs");
setChartWorker(() => new InProcessWorker());

/** Count chart Workers and draws while `run` runs. */
async function countWorkers(run) {
  Object.assign(workers, { created: 0, draws: 0, hang: null, silent: false, answered: null });
  workers.live.clear();
  return run(workers);
}

/**
 * Draw `spec` over `data` (name → rows) into `target` the way a chart does,
 * in this process: the Worker's run, then the page's drawing. The spec check
 * is off, so the compiled-dataflow check and the guards are what stand.
 * Resolves with the drawing; rejects with the run's error.
 */
async function drawChart(target, { spec, data, theme, width, tooltip, checkSpec = false }) {
  const rows = Object.fromEntries(
    Object.entries(data).map(([name, set]) => [name, datasetRows(set)]),
  );
  const result = await runChart({ spec, data: rows, theme, width }, { checkSpec });
  // The scene crosses from the Worker by structured clone.
  return drawScene(target, structuredClone(result), tooltip);
}

function container(window, width = 640) {
  const element = window.document.body.appendChild(window.document.createElement("div"));
  // jsdom has no layout; the frame reports the width a Page column would.
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return this.classList.contains("pages-chart-frame") ? width : 0;
    },
  });
  return {
    element,
    resize(next) {
      width = next;
    },
  };
}

test("a probe measures the page's widths as SVG text, the way a chart's text is drawn", () => {
  const { window } = new JSDOM("<!doctype html><html><body></body></html>");
  const items = probeItems(["Inter, sans-serif"]);
  // jsdom lays out no text: the page can't measure, so the Worker gets the fallback.
  assert.equal(drawnWidths(window.document, items), null);
  assert.equal(window.document.querySelector("svg"), null);

  const drawn = [];
  window.SVGElement.prototype.getComputedTextLength = function () {
    assert.ok(this.isConnected);
    drawn.push({
      text: this.textContent,
      family: this.getAttribute("font-family"),
      size: this.getAttribute("font-size"),
      weight: this.getAttribute("font-weight"),
    });
    return this.textContent.length;
  };
  assert.deepEqual(
    drawnWidths(window.document, items),
    items.map(({ text }) => text.length),
  );
  assert.deepEqual(
    drawn,
    items.map(({ item, text }) => ({
      text,
      family: "Inter, sans-serif",
      size: `${item.fontSize}px`,
      weight: item.fontWeight === undefined ? null : String(item.fontWeight),
    })),
  );
  assert.equal(window.document.querySelector("svg"), null);
});

test("mount draws a stacked bar chart from rows, with the title above one frame", () =>
  withWindow(async (window) => {
    const { element } = container(window);
    const chart = mount(element, { spec: stacked, datasets: { calls }, title: "Calls by tool" });
    await drawn(element);
    const figure = element.querySelector("figure.pages-chart");
    assert.equal(figure.dataset.chartStatus, "rendered");
    assert.equal(figure.getAttribute("aria-label"), "Calls by tool");
    assert.equal(figure.querySelector(".pages-chart-title").textContent, "Calls by tool");
    // One bar per (tool, client) pair, stacked along x.
    assert.equal(bars(figure.querySelector(".pages-chart-frame")).length, 5);
    assert.equal(figure.querySelector(".pages-chart-message").hidden, true);
    // Vega-Lite's own legend names the clients.
    assert.match(figure.querySelector(".pages-chart-frame").textContent, /Claude.*Codex/s);
    assert.equal(figure.querySelector(".wordgard-diagram-maximize").hidden, false);
    chart.destroy();
    assert.equal(element.children.length, 0);
  }));

test("an untitled chart shows a title row only to hold Maximize", () =>
  withWindow(async (window) => {
    const { element } = container(window);
    const refused = mount(element, { spec: { ...stacked, data: { values: [] } }, datasets: {} });
    assert.equal(element.querySelector(".pages-chart-header").hidden, true);
    refused.destroy();
    const chart = mount(element, { spec: stacked, datasets: { calls } });
    assert.equal(await drawn(element), "rendered");
    assert.equal(element.querySelector(".pages-chart-header").hidden, false);
    assert.equal(element.querySelector(".pages-chart-title"), null);
    assert.equal(element.querySelector("figure").getAttribute("aria-label"), "Chart");
    chart.destroy();
  }));

test("an Arrow table is a dataset; 64-bit integers become numbers", () =>
  withWindow(async (window) => {
    const table = tableFromJSON(calls.map((row) => ({ ...row, calls: BigInt(row.calls) })));
    assert.deepEqual(
      datasetRows(table).map((row) => ({ ...row })),
      calls,
    );
    const { element } = container(window);
    const chart = mount(element, { spec: stacked, datasets: { calls: table } });
    await drawn(element);
    assert.equal(element.querySelector("figure").dataset.chartStatus, "rendered");
    assert.equal(bars(element).length, 5);
    chart.destroy();
  }));

test("rows are copied, so Vega never tags the caller's objects", () => {
  const rows = [{ a: 1, n: 2n, nested: { big: 3n } }];
  const copy = datasetRows(rows);
  assert.notEqual(copy[0], rows[0]);
  assert.deepEqual({ ...copy[0] }, { a: 1, n: 2, nested: { big: 3 } });
  assert.equal(datasetRows("calls"), null);
  assert.equal(datasetRows({ rows: [] }), null);
});

test("mount redraws at a new width once a resize settles, in the same Worker", () =>
  withWindow((window, { observers }) =>
    countWorkers(async (workers) => {
      const { element, resize } = container(window, 600);
      const chart = mount(element, { spec: stacked, datasets: { calls } });
      await drawn(element);
      const svgWidth = () =>
        Number(element.querySelector(".pages-chart-canvas svg").getAttribute("width"));
      const wide = svgWidth();
      const [observer] = observers.resize;
      resize(340);
      observer.callback();
      resize(320);
      observer.callback();
      await settle(RESIZE_SETTLE_MS / 2);
      assert.equal(svgWidth(), wide, "a resize still in motion doesn't redraw");
      assert.ok(await until(() => svgWidth() <= 340), `${wide} -> ${svgWidth()}`);
      assert.equal(workers.draws, 2);
      assert.equal(workers.created, 1);
      assert.equal(workers.live.size, 1);
      assert.equal(element.querySelectorAll(".pages-chart-canvas svg").length, 1);
      chart.destroy();
      assert.equal(workers.live.size, 0);
    }),
  ));

test("a frame with no width at mount draws once, at the first width it gets", () =>
  withWindow((window, { observers }) =>
    countWorkers(async (workers) => {
      // Not laid out yet, or in a background tab: no width, and nothing posted.
      const { element, resize } = container(window, 0);
      const chart = mount(element, { spec: stacked, datasets: { calls } });
      await settle(RESIZE_SETTLE_MS + 60);
      assert.equal(workers.draws, 0);
      assert.equal(element.querySelector("figure").dataset.chartStatus, "drawing");
      // An observer entry still at zero posts nothing either.
      observers.resize[0].callback();
      await settle(RESIZE_SETTLE_MS + 60);
      assert.equal(workers.draws, 0);
      resize(500);
      observers.resize[0].callback();
      assert.equal(await drawn(element), "rendered");
      await settle(RESIZE_SETTLE_MS + 60);
      assert.equal(workers.draws, 1, "exactly one draw");
      const width = Number(element.querySelector(".pages-chart-canvas svg").getAttribute("width"));
      assert.ok(width > 400 && width <= 500, `drawn at the frame's width, not a default: ${width}`);
      chart.destroy();
    }),
  ));

test("a Page theme change redraws with the dark palette", () =>
  withWindow((window) =>
    countWorkers(async (workers) => {
      const { element } = container(window);
      const chart = mount(element, { spec: stacked, datasets: { calls } });
      await drawn(element);
      const fills = () => new Set([...bars(element)].map((bar) => bar.getAttribute("fill")));
      assert.ok(fills().has(themeConfig(theme).range.category[0]));
      window.document.documentElement.classList.add("dark");
      assert.ok(
        await until(() => fills().has(themeConfig({ ...theme, dark: true }).range.category[0])),
      );
      assert.equal(workers.draws, 2);
      assert.equal(workers.live.size, 1);
      // A class change that keeps the theme draws nothing new.
      window.document.documentElement.classList.add("unrelated");
      await settle();
      assert.equal(workers.draws, 2);
      chart.destroy();
    }),
  ));

test("destroy leaves no listeners, observers, Workers, tooltip or viewer behind", () =>
  withWindow((window, { listeners, observers }) =>
    countWorkers(async (workers) => {
      const before = listeners();
      const { element } = container(window);
      const chart = mount(element, { spec: stacked, datasets: { calls }, title: "Calls" });
      await drawn(element);
      // Show Vega's tooltip and open the expanded viewer, then tear down.
      bars(element)[0].dispatchEvent(
        new window.MouseEvent("pointermove", { bubbles: true, clientX: 10, clientY: 10 }),
      );
      assert.ok(window.document.querySelector(".vg-tooltip.visible"));
      element.querySelector(".wordgard-diagram-maximize").click();
      assert.ok(window.document.querySelector("dialog.diagram-viewer"));
      assert.ok(listeners() > before);
      chart.destroy();
      assert.equal(workers.live.size, 0);
      assert.equal(listeners(), before);
      assert.equal(observers.mutation, 0);
      assert.ok(observers.resize.every((observer) => !observer.connected));
      assert.equal(window.document.querySelector(".vg-tooltip"), null);
      assert.equal(window.document.querySelector("dialog.diagram-viewer"), null);
      assert.equal(element.children.length, 0);
    }),
  ));

test("destroy during the first draw leaves no Worker and draws nothing", () =>
  withWindow((window) =>
    countWorkers(async (workers) => {
      const { element } = container(window);
      const chart = mount(element, { spec: stacked, datasets: { calls } });
      chart.destroy();
      await settle();
      assert.equal(workers.live.size, 0);
      // Destroyed after the draw was posted: the Worker is terminated and its
      // answer is dropped.
      const { element: later } = container(window);
      const second = mount(later, { spec: stacked, datasets: { calls } });
      assert.ok(await until(() => workers.draws === 1));
      second.destroy();
      await settle();
      assert.equal(workers.live.size, 0);
      assert.equal(later.children.length, 0);
      assert.equal(element.children.length, 0);
      // A late answer from the terminated Worker must not leave a tooltip
      // element behind.
      assert.equal(
        window.document.body.querySelectorAll(".vg-tooltip, [id^='pages-chart-tooltip']").length,
        0,
      );
    }),
  ));

test("Maximize opens the chart in the diagram viewer, titled by the chart", () =>
  withWindow(async (window) => {
    const { element } = container(window);
    const chart = mount(element, { spec: stacked, datasets: { calls }, title: "Calls by tool" });
    await drawn(element);
    const button = element.querySelector(".wordgard-diagram-maximize");
    assert.equal(button.getAttribute("aria-label"), "Maximize chart");
    assert.equal(button.getAttribute("aria-haspopup"), "dialog");
    button.click();
    const dialog = window.document.querySelector("dialog.diagram-viewer");
    assert.equal(dialog.querySelector(".diagram-viewer-title").textContent, "Calls by tool");
    assert.equal(bars(dialog).length, 5);
    chart.destroy();
  }));

/** Mount `spec` and return the sentence shown inside the frame. */
const RESERVED = ["__proto__", "constructor", "toString"];

test("columns named like Object.prototype stay columns, in rows and in Arrow tables", () =>
  withWindow(async (window) => {
    // JSON.parse makes "__proto__" an own key, as data from a host would.
    const odd = JSON.parse(
      JSON.stringify(
        calls.map((row) => ({
          ...row,
          ...Object.fromEntries(RESERVED.map((name) => [name, "x"])),
        })),
      ),
    );
    for (const dataset of [odd, tableFromJSON(odd)]) {
      const rows = datasetRows(dataset);
      assert.equal(Object.getPrototypeOf(rows[0]), null);
      for (const name of RESERVED)
        assert.equal(Object.hasOwn(rows[0], name) && rows[0][name], "x", name);
      const { element } = container(window);
      const chart = mount(element, { spec: stacked, datasets: { calls: dataset } });
      await drawn(element);
      assert.equal(element.querySelector("figure").dataset.chartStatus, "rendered");
      assert.equal(bars(element).length, 5);
      chart.destroy();
      element.remove();
    }
    // A missing column reads as undefined, never as Object.prototype's own.
    assert.equal(datasetRows([{ a: 1 }])[0].toString, undefined);
  }));

test("a dataset or field named like Object.prototype is refused with one sentence", () =>
  withWindow(async (window) => {
    for (const name of RESERVED) {
      const datasets = Object.fromEntries([[name, calls]]);
      assert.match(
        await refusalIn(window, { ...stacked, data: { name } }, datasets),
        new RegExp(`can't use "${name}" as a name`),
        `dataset ${name}`,
      );
      assert.match(
        await refusalIn(window, {
          ...stacked,
          encoding: { ...stacked.encoding, x: { field: name, type: "quantitative" } },
        }),
        new RegExp(`can't use "${name}" as a name`),
        `field ${name}`,
      );
    }
    // A name the caller didn't give is missing, not read from the prototype.
    assert.match(await refusalIn(window, { ...stacked, data: { name: "calls" } }, {}), /calls/);
  }));

async function refusalIn(window, spec, datasets = { calls }) {
  const { element } = container(window);
  const chart = mount(element, { spec, datasets, title: "Refused" });
  await drawn(element);
  const figure = element.querySelector("figure");
  const message = figure.querySelector(".pages-chart-frame > .pages-chart-message");
  assert.equal(figure.dataset.chartStatus, "error");
  assert.equal(message.hidden, false);
  assert.equal(figure.querySelector(".pages-chart-canvas svg"), null);
  assert.equal(figure.querySelector(".wordgard-diagram-maximize").hidden, true);
  chart.destroy();
  return message.textContent;
}

test("each refusal shows one sentence inside the frame and draws nothing", () =>
  withWindow((window) =>
    countViews(async (views) => {
      assert.equal(
        await refusalIn(window, { ...stacked, data: { values: calls } }),
        "A chart reads named data, not inline values (at data).",
      );
      assert.equal(
        await refusalIn(window, { ...stacked, data: { name: "usage" } }),
        'This chart reads "usage", but no dataset has that name.',
      );
      assert.equal(
        await refusalIn(window, { ...stacked, data: { url: "https://x.test/a.csv" } }),
        "A chart can't load data from a URL (at data).",
      );
      assert.match(await refusalIn(window, { ...stacked, mark: "image" }), /image marks/);
      assert.match(
        await refusalIn(window, {
          ...stacked,
          encoding: { ...stacked.encoding, href: { field: "tool" } },
        }),
        /link anywhere/,
      );
      assert.match(
        await refusalIn(window, { ...stacked, transform: [{ calculate: "modify(1)", as: "m" }] }),
        /calls modify\(\)/,
      );
      assert.equal(
        await refusalIn(window, stacked, { calls: new Array(CHART_MAX_ROWS + 1).fill({}) }),
        'The dataset "calls" has 100,001 rows; a chart reads at most 100,000.',
      );
      assert.equal(
        await refusalIn(window, stacked, { calls: "not rows" }),
        'The dataset "calls" must be rows, Arrow IPC bytes or an Arrow table.',
      );
      assert.equal(views.created, 0);
    }),
  ));

test("a spec Vega-Lite can't compile shows its error as one sentence", () =>
  withWindow(async (window) => {
    const text = await refusalIn(window, { data: { name: "calls" }, mark: "nonsense" });
    assert.match(text, /^This chart couldn't be drawn: .+\.$/);
    assert.doesNotMatch(text.slice(0, -1), /\.\s/);
  }));

test("Vega's loader refuses every URL, and the compiled check refuses image marks", () =>
  withWindow(async (window) =>
    countViews(async (views) => {
      const fetched = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (url) => (fetched.push(String(url)), new Response(""));
      try {
        await assert.rejects(
          drawChart(window.document.createElement("div"), {
            spec: {
              data: { name: "pics" },
              mark: { type: "image", width: 20, height: 20 },
              encoding: {
                x: { field: "n", type: "ordinal" },
                url: { field: "src", type: "nominal" },
              },
            },
            data: { pics: [{ n: 1, src: "https://tracker.example/pixel.png" }] },
            theme,
            width: 300,
          }),
          /can't draw image marks/,
        );
        // An href channel draws, and its link goes nowhere.
        const view = await drawChart(window.document.createElement("div"), {
          spec: { ...stacked, encoding: { ...stacked.encoding, href: { field: "tool" } } },
          data: { calls },
          theme,
          width: 300,
        });
        await settle(20);
        assert.deepEqual(fetched, []);
        view.finalize();
        assert.equal(views.created, 1);
      } finally {
        globalThis.fetch = realFetch;
      }
      for (const method of ["load", "sanitize", "http", "file"])
        await assert.rejects(deniedLoader[method]("https://tracker.example/pixel.png", {}));
    }),
  ));

const draws = (window, spec, extra = {}) =>
  drawChart(window.document.createElement("div"), {
    spec,
    data: { calls },
    theme,
    width: 300,
    ...extra,
  });

test("the compiled check refuses what static charts don't compile to, before it runs", () =>
  withWindow((window) =>
    countViews(async (views) => {
      // drawChart skips the spec check, so each of these is the compiled
      // check alone.
      const labelled = {
        ...stacked,
        encoding: {
          ...stacked.encoding,
          y: { ...stacked.encoding.y, axis: { labelExpr: "warn(datum.label)" } },
        },
      };
      assert.equal(checkChartSpec(labelled).ok, false);
      await assert.rejects(draws(window, labelled), {
        message: "This chart's compiled code calls warn().",
      });
      for (const [calculate, sentence] of [
        ["sequence(0, 1e9)", /calls sequence\(\)/],
        ["pluck(datum, 'constructor.constructor')", /calls pluck\(\)/],
        ["datum['__proto__']", /uses "__proto__"/],
        ["replace(datum.tool, /a+/, '')", /uses a regular expression/],
        ["format(datum.calls, '1000000000')", /pads a number/],
      ])
        await assert.rejects(
          draws(window, { ...stacked, transform: [{ calculate, as: "v" }] }),
          sentence,
        );
      // A selection compiles to event streams: refused whole.
      for (const select of [
        { type: "point", toggle: "modify('calls', null, true)" },
        { type: "point", on: "window:keydown!" },
        { type: "interval", bind: "scales" },
      ])
        await assert.rejects(draws(window, { ...stacked, params: [{ name: "p", select }] }), {
          message: "This chart listens for events; charts are static, with hover tooltips.",
        });
      assert.equal(views.created, 0, "no refused dataflow ever ran");
    }),
  ));

test("a hand-built dataflow with a stream, an unlisted operator or call is refused", () => {
  const vega = globalThis.__vega;
  const runtime = () =>
    vega.parse(vl.compile(stacked, { config: themeConfig(theme) }).spec, null, { ast: true });
  assert.equal(runtimeProblem(runtime()), null);
  const streamed = runtime();
  streamed.streams.push({ id: 999, source: "window", type: "keydown" });
  assert.match(runtimeProblem(streamed), /listens for events/);
  const updated = runtime();
  updated.updates.push({
    source: 999,
    target: 1,
    update: { $expr: { code: "1", ast: { type: "Literal", value: 1 } } },
  });
  assert.match(runtimeProblem(updated), /listens for events/);
  const bound = runtime();
  bound.bindings.push({ signal: "x", input: "range" });
  assert.match(runtimeProblem(bound), /listens for events/);
  const voronoi = runtime();
  voronoi.operators.push({ id: 998, type: "voronoi", params: {} });
  assert.match(runtimeProblem(voronoi), /uses a voronoi operator/);
  const plucked = runtime();
  const formula = {
    id: 997,
    type: "formula",
    params: {
      expr: {
        $expr: {
          code: "",
          ast: {
            type: "CallExpression",
            callee: { type: "Identifier", name: "pluck" },
            arguments: [],
          },
        },
      },
    },
  };
  plucked.operators.push(formula);
  assert.match(runtimeProblem(plucked), /calls pluck\(\)/);
});

test("the structural checks reach every subflow, and hover encodings anywhere", () => {
  const vega = globalThis.__vega;
  const faceted = {
    data: { name: "calls" },
    facet: { row: { field: "client", type: "nominal" } },
    spec: { mark: "bar", encoding: stacked.encoding },
  };
  const runtime = () =>
    vega.parse(vl.compile(faceted, { config: themeConfig(theme) }).spec, null, { ast: true });
  const subflow = (parsed) => {
    const stack = [parsed];
    while (stack.length) {
      const node = stack.pop();
      if (node?.$subflow) return node.$subflow;
      if (node && typeof node === "object") stack.push(...Object.values(node));
    }
    throw new Error("no subflow");
  };
  assert.equal(runtimeProblem(runtime()), null);
  const streamed = runtime();
  subflow(streamed).streams.push({ id: 999, source: "window", type: "keydown" });
  assert.match(runtimeProblem(streamed), /listens for events/);
  const updated = runtime();
  subflow(updated).updates.push({ source: 999, target: 1, update: 1 });
  assert.match(runtimeProblem(updated), /listens for events/);
  const bound = runtime();
  subflow(bound).bindings = [{ signal: "x", input: "range" }];
  assert.match(runtimeProblem(bound), /listens for events/);
  const voronoi = runtime();
  subflow(voronoi).operators.push({ id: 998, type: "voronoi", params: {} });
  assert.match(runtimeProblem(voronoi), /uses a voronoi operator/);
  const hovered = runtime();
  subflow(hovered).operators.push({
    id: 997,
    type: "encode",
    params: { encoders: { $encode: { hover: { $expr: { code: "", ast: { type: "Literal" } } } } } },
  });
  assert.match(runtimeProblem(hovered), /changes on hover/);
});

test("a title and axis titles are cut short with an ellipsis to the room they have", () =>
  withWindow(async (window) => {
    // Vega-Lite's padding is 5 on each side of the width a chart draws at.
    assert.deepEqual(textLimits(stacked, 300), {
      title: { limit: 290 },
      axisX: { titleLimit: { expr: "width" } },
      axisY: { titleLimit: { expr: "height" } },
    });
    const config = themeConfig(theme, textLimits(stacked, 300));
    assert.equal(config.title.limit, 290);
    assert.equal(config.title.fontSize, 14);
    assert.equal(themeConfig(theme).title.limit, undefined);
    assert.equal(themeConfig(theme).axisX, undefined);

    const long = "a title far longer than any chart this narrow has room to draw ".repeat(3);
    const titled = (spec) => ({
      ...spec,
      title: long,
      encoding: {
        ...stacked.encoding,
        x: { ...stacked.encoding.x, title: long },
        y: { ...stacked.encoding.y, title: long },
      },
    });
    const titles = async (spec) => {
      const target = window.document.body.appendChild(window.document.createElement("div"));
      const drawing = await drawChart(target, { spec, data: { calls }, theme, width: 300 });
      const texts = (role) =>
        [...target.querySelectorAll(`.role-${role} text`)].map((text) => text.textContent);
      const found = { title: texts("title-text"), axes: texts("axis-title") };
      drawing.finalize();
      target.remove();
      return found;
    };
    const cut = (text) => text.endsWith("\u2026");

    const sized = await titles(titled(stacked));
    assert.equal(sized.title.length + sized.axes.length, 3, JSON.stringify(sized));
    assert.ok([...sized.title, ...sized.axes].every(cut), JSON.stringify(sized));

    // A limit of the spec's own wins, generic or directional.
    for (const own of [{ axis: { titleLimit: 0 } }, { axisY: { titleLimit: 50 } }]) {
      const limits = textLimits({ ...stacked, config: own }, 300);
      assert.equal(limits.axisX, undefined, JSON.stringify(own));
      assert.equal(limits.axisY, undefined, JSON.stringify(own));
      assert.deepEqual(limits.title, { limit: 290 });
    }
    assert.equal(textLimits({ ...stacked, config: { title: { limit: 0 } } }, 300).title, undefined);
    const ownAxis = await titles({ ...titled(stacked), config: { axis: { titleLimit: 0 } } });
    assert.ok(cut(ownAxis.title[0]));
    assert.deepEqual(ownAxis.axes, [long.trim(), long.trim()]);

    // A chart with its own width, or a composed one, draws as Vega-Lite draws it.
    assert.deepEqual(textLimits({ ...stacked, width: 1000 }, 300), {});
    const composed = { hconcat: [titled(stacked), stacked], data: stacked.data };
    assert.deepEqual(textLimits(composed, 300), {});
    const drawnComposed = await titles({ ...composed, title: long });
    assert.ok(!cut(drawnComposed.title[0]), drawnComposed.title[0]);
    assert.ok(drawnComposed.axes.includes(long.trim()), JSON.stringify(drawnComposed.axes));
  }));

test("hovering a drawn chart only shows its tooltip", () =>
  withWindow(async (window) => {
    const shown = [];
    const target = window.document.body.appendChild(window.document.createElement("div"));
    const drawing = await drawChart(target, {
      spec: stacked,
      data: { calls },
      theme,
      width: 400,
      tooltip: (_handler, _event, _item, value) => shown.push(value),
    });
    const svg = target.querySelector("svg");
    const before = svg.outerHTML;
    const bar = bars(target)[0];
    for (const type of ["pointerover", "pointermove", "mouseover", "mousemove", "pointerout"])
      bar.dispatchEvent(new window.MouseEvent(type, { bubbles: true, clientX: 10, clientY: 10 }));
    await settle();
    assert.equal(svg.outerHTML, before);
    assert.ok(
      shown.some((value) => value && typeof value === "object"),
      JSON.stringify(shown),
    );
    drawing.finalize();
  }));

test("tooltip text is total: no toString, cycles, depth and length", () => {
  const hostile = { toString: 0, valueOf: 0 };
  const cyclic = { name: "loop" };
  cyclic.self = cyclic;
  const escape = (value) => String(value).replace(/</g, "&lt;");
  assert.equal(tooltipText(hostile), '{"toString":0,"valueOf":0}');
  assert.equal(tooltipText(cyclic), '{"name":"loop","self":"[Circular]"}');
  assert.equal(tooltipText({ a: { b: { c: { d: 1 } } } }), '{"a":{"b":{"c":"[Object]"}}}');
  assert.equal(tooltipText(10n), "10");
  assert.equal(tooltipText(new Date(Number.NaN)), "Invalid date");
  assert.equal(tooltipText("x".repeat(5000)).length, 400);
  const throwing = {
    get boom() {
      throw new Error("boom");
    },
  };
  assert.equal(tooltipText(throwing), '{"boom":"[Value]"}');
  for (const value of [
    hostile,
    { title: hostile, x: hostile },
    [hostile, cyclic],
    throwing,
    cyclic,
  ])
    assert.equal(typeof formatTooltip(value, escape, 2, ""), "string");
  const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`c${i}`, i]));
  assert.match(formatTooltip(wide, escape, 2, ""), /more fields/);
  assert.equal((formatTooltip(wide, escape, 2, "").match(/<tr>/g) ?? []).length, 41);
});

test("a tooltip that can't show moves the chart to its error state", () =>
  withWindow(async (window) => {
    const { element } = container(window);
    const chart = mount(element, {
      spec: { ...stacked, mark: { type: "bar", tooltip: { content: "data" } } },
      datasets: { calls },
    });
    await drawn(element);
    const figure = element.querySelector("figure");
    assert.equal(figure.dataset.chartStatus, "rendered");
    // Make the handler itself throw, as vega-tooltip does on a value it
    // can't render.
    const { getElementById } = window.document;
    window.document.getElementById = () => {
      throw new Error("The tooltip broke.");
    };
    bars(element)[0].dispatchEvent(
      new window.MouseEvent("pointermove", { bubbles: true, clientX: 5, clientY: 5 }),
    );
    window.document.getElementById = getElementById;
    await settle();
    assert.equal(figure.dataset.chartStatus, "error");
    assert.match(figure.querySelector(".pages-chart-message").textContent, /tooltip broke/);
    assert.equal(figure.querySelector(".pages-chart-canvas svg"), null);
    chart.destroy();
  }));

// Static specs across marks, transforms and composition. Every operator type
// and call Vega-Lite generates for them must be in STATIC_OPERATORS and
// VEGA_LITE_FUNCTIONS, with no event stream; a new Vega-Lite version that
// emits more fails here, not in a reader's tab.
const { CORPUS, corpusRows } = await import("../test/chart-corpus.mjs");

/** Operator types and called functions in a parsed runtime, subflows
 * included. */
function usedIn(runtime) {
  const operators = new Set();
  const calls = new Set();
  const seen = new Set();
  const stack = [runtime];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node.operators))
      for (const operator of node.operators) operators.add(operator.type);
    if (node.type === "CallExpression" && node.callee?.type === "Identifier")
      calls.add(node.callee.name);
    stack.push(...Object.values(node));
  }
  return { operators, calls };
}

test("every static spec in the corpus passes both checks, and uses every listed entry", () => {
  const vega = globalThis.__vega;
  const operators = new Set();
  const calls = new Set();
  for (const [index, spec] of CORPUS.entries()) {
    const checked = checkChartSpec(spec);
    assert.equal(checked.ok, true, `${index}: ${checked.error}`);
    const runtime = vega.parse(
      vl.compile(sizedSpec(spec, 400), { config: themeConfig(theme) }).spec,
      null,
      { ast: true },
    );
    assert.equal(runtimeProblem(runtime), null, `${index}: ${JSON.stringify(spec).slice(0, 160)}`);
    const used = usedIn(runtime);
    for (const type of used.operators) operators.add(type);
    for (const name of used.calls) calls.add(name);
  }
  // The lists hold what the corpus needs and nothing more: an entry no
  // static chart compiles to fails here.
  assert.deepEqual([...operators].sort(), [...STATIC_OPERATORS].sort());
  const generated = [...VEGA_LITE_FUNCTIONS].filter(
    (name) => !CHART_EXPRESSION_FUNCTIONS.has(name),
  );
  assert.deepEqual(
    [...calls].filter((name) => !CHART_EXPRESSION_FUNCTIONS.has(name)).sort(),
    generated.sort(),
  );
});

test("paint is a color or a gradient of colors; anything else is dropped", () => {
  for (const paint of [
    "#2a78d6",
    "steelblue",
    "transparent",
    "rgb(1, 2, 3)",
    "hsl(10 50% 50% / 0.5)",
    "oklch(0.7 0.1 250)",
  ])
    assert.equal(safePaint(paint), paint);
  for (const paint of [
    "url(https://x.example/p.svg#g)",
    "URL(https://x.example/p.svg#g)",
    "u\\72l(https://x.example/p.svg#g)",
    "rgb(1, 2, 3) url(https://x.example/p.svg#g)",
    "var(--x)",
    "image-set('https://x.example/p.png' 1x)",
    "context-fill url(#x)",
    42,
  ])
    assert.equal(safePaint(paint), null, String(paint));
  const gradient = {
    gradient: "linear",
    stops: [
      { offset: 0, color: "url(https://x.example/a)" },
      { offset: 1, color: "red" },
    ],
  };
  assert.deepEqual(
    safePaint(gradient).stops.map((stop) => stop.color),
    ["transparent", "red"],
  );
  const item = {
    fill: "url(https://x.example/a)",
    stroke: "#000",
    font: "url(https://x.example/f.woff)",
    blend: "url(x)",
    cursor: "url(https://x.example/c.png), auto",
  };
  cleanItem(item);
  assert.deepEqual(item, { fill: null, stroke: "#000", font: null, blend: null, cursor: null });
  const fine = { fill: "red", font: "Inter, sans-serif", blend: "multiply", cursor: "pointer" };
  cleanItem(fine);
  assert.deepEqual(fine, {
    fill: "red",
    font: "Inter, sans-serif",
    blend: "multiply",
    cursor: "pointer",
  });
});

test("data that carries url() never reaches a drawn attribute or the cursor", () =>
  withWindow(async (window) => {
    const probe = "url(https://x.example/p.svg#g)";
    const rows = calls.map((row) => ({
      ...row,
      paint: probe,
      grad: {
        gradient: "linear",
        stops: [
          { offset: 0, color: probe },
          { offset: 1, color: "red" },
        ],
      },
    }));
    const byField = {
      data: { name: "calls" },
      layer: [
        {
          mark: { type: "bar", cursor: "pointer" },
          encoding: {
            ...stacked.encoding,
            fill: { field: "paint", type: "nominal", scale: null },
            stroke: { field: "paint", type: "nominal", scale: null },
          },
        },
        {
          mark: "point",
          encoding: { ...stacked.encoding, fill: { field: "grad", type: "nominal", scale: null } },
        },
        {
          mark: { type: "text" },
          encoding: {
            ...stacked.encoding,
            text: { field: "tool" },
            fill: { field: "paint", type: "nominal", scale: null },
          },
        },
      ],
    };
    assert.equal(checkChartSpec(byField).ok, true, checkChartSpec(byField).error);
    // Attributes that take CSS. Vega's own gradients are url(<this document>#id).
    const own = new RegExp(
      `url\\((?:#|${window.location.href.split("#")[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}#)`,
      "gi",
    );
    const references = (svg) =>
      [svg, ...svg.querySelectorAll("*")].flatMap((node) =>
        [...node.attributes]
          .filter(
            (attr) => !attr.name.startsWith("aria-") && /url\(/i.test(attr.value.replace(own, "")),
          )
          .map((attr) => `${node.tagName} ${attr.name}=${attr.value}`),
      );
    const { element } = container(window);
    const chart = mount(element, { spec: byField, datasets: { calls: rows } });
    await drawn(element);
    const figure = element.querySelector("figure");
    assert.equal(figure.dataset.chartStatus, "rendered", figure.textContent);
    assert.deepEqual(references(figure.querySelector(".pages-chart-canvas svg")), []);
    chart.destroy();
    // Past the spec check, Vega-Lite's own data() can carry a row's value into
    // a font, a background or a cursor; the renderer still cleans them.
    const target2 = window.document.body.appendChild(window.document.createElement("div"));
    const drawing = await drawChart(target2, {
      spec: {
        data: { name: "calls" },
        background: { expr: "data('calls')[0].paint" },
        layer: [
          {
            mark: { type: "bar", cursor: { expr: "data('calls')[0].paint" } },
            encoding: stacked.encoding,
          },
          {
            mark: { type: "text", font: { expr: "data('calls')[0].paint" } },
            encoding: { ...stacked.encoding, text: { field: "tool" } },
          },
        ],
      },
      data: { calls: rows },
      theme,
      width: 300,
    });
    assert.deepEqual(references(target2.querySelector("svg")), []);
    assert.doesNotMatch(target2.querySelector("svg").getAttribute("style") ?? "", /url\(/);
    drawing.finalize();
  }));

test("an expression that throws while the chart runs shows an error, not a drawn chart", () =>
  withWindow(async (window) => {
    const { element } = container(window);
    const chart = mount(element, {
      spec: { ...stacked, transform: [{ calculate: "datum.missing.x", as: "v" }] },
      datasets: { calls },
    });
    await drawn(element);
    const figure = element.querySelector("figure");
    assert.equal(figure.dataset.chartStatus, "error");
    const message = figure.querySelector(".pages-chart-message").textContent;
    assert.match(message, /^This chart couldn't be drawn: .+\.$/);
    assert.doesNotMatch(message.slice(0, -1), /\.\s/);
    assert.equal(figure.querySelector(".pages-chart-canvas svg"), null);
    chart.destroy();
  }));

test("a draw that outlasts the timer ends in the error state, terminates its Worker and isn't retried", () =>
  withWindow((window, { observers }) =>
    countWorkers(async (workers) => {
      let restore = setChartWorker(() => new InProcessWorker(), { timeoutMs: 60 });
      try {
        const { element, resize } = container(window, 600);
        workers.hang = () => true;
        const chart = mount(element, { spec: stacked, datasets: { calls } });
        await settle(30);
        const figure = element.querySelector("figure");
        assert.equal(figure.dataset.chartStatus, "drawing");
        assert.ok(await until(() => figure.dataset.chartStatus === "error"));
        assert.equal(figure.querySelector(".pages-chart-message").textContent, TIMED_OUT);
        // The hung Worker is gone, and nothing replaces it for this chart.
        assert.equal(workers.created, 1);
        assert.equal(workers.live.size, 0);
        // A resize or a theme change doesn't run it again.
        workers.hang = null;
        resize(400);
        observers.resize[0].callback();
        window.document.documentElement.classList.add("dark");
        await settle(RESIZE_SETTLE_MS + 60);
        assert.equal(figure.dataset.chartStatus, "error");
        assert.equal(workers.draws, 1);
        assert.equal(workers.created, 1);
        chart.destroy();
        // A new revision mounts the chart again, and it draws, under the
        // normal timer: a real draw in this process can outlast 60 ms.
        restore();
        restore = setChartWorker(() => new InProcessWorker());
        const { element: next } = container(window, 600);
        const again = mount(next, { spec: stacked, datasets: { calls } });
        assert.equal(await drawn(next), "rendered");
        assert.equal(workers.created, 2);
        again.destroy();
        assert.equal(workers.live.size, 0);
      } finally {
        restore();
      }
    }),
  ));

test("a timer the busy page held past its time waits for an answer already queued", () =>
  withWindow((window) =>
    countWorkers(async () => {
      const timeoutMs = 1_000;
      const restore = setChartWorker(() => new InProcessWorker(), { timeoutMs });
      // Once the Worker's answer is queued, hold this thread past the timer,
      // as a page laying out a large chart does.
      workers.answered = () => {
        const deadline = workers.posted + timeoutMs + 100;
        while (performance.now() < deadline);
      };
      try {
        const { element } = container(window);
        const chart = mount(element, { spec: stacked, datasets: { calls } });
        assert.equal(await drawn(element), "rendered");
        chart.destroy();
      } finally {
        restore();
      }
    }),
  ));

test("a Worker that fails to start or errors shows the error state", () =>
  withWindow(async (window) => {
    for (const create of [
      () => {
        throw new Error("Workers are off.");
      },
      () => {
        const worker = new InProcessWorker();
        worker.postMessage = () =>
          setTimeout(() =>
            worker.dispatchEvent(Object.assign(new Event("error"), { message: "Script failed." })),
          );
        return worker;
      },
    ]) {
      const restore = setChartWorker(create);
      try {
        const { element } = container(window);
        const chart = mount(element, { spec: stacked, datasets: { calls } });
        assert.equal(await drawn(element), "error");
        const figure = element.querySelector("figure");
        assert.match(
          figure.querySelector(".pages-chart-message").textContent,
          /^This chart couldn't be drawn: /,
        );
        chart.destroy();
        element.remove();
      } finally {
        restore();
      }
    }
  }));

test("a newer draw cuts off a running one and its Worker", () =>
  withWindow((window, { observers }) =>
    countWorkers(async (workers) => {
      const { element, resize } = container(window, 600);
      workers.hang = () => true;
      const chart = mount(element, { spec: stacked, datasets: { calls } });
      // The Worker is probed before it takes the draw.
      assert.ok(await until(() => workers.draws === 1), "the first draw reached its Worker");
      workers.hang = null;
      resize(400);
      observers.resize[0].callback();
      await until(() => element.querySelector("figure").dataset.chartStatus === "rendered");
      assert.equal(workers.created, 2, "the held Worker was replaced");
      assert.equal(workers.live.size, 1);
      assert.equal(element.querySelector("figure").dataset.chartStatus, "rendered");
      assert.ok(
        Number(element.querySelector(".pages-chart-canvas svg").getAttribute("width")) <= 400,
      );
      chart.destroy();
    }),
  ));

test("the tooltip shows fields and drops an image URL", () => {
  const html = formatTooltip(
    { tool: "<b>read_page</b>", image: "https://tracker.example/p.png" },
    (value) => String(value).replace(/</g, "&lt;"),
    2,
    "",
  );
  assert.doesNotMatch(html, /<img|tracker/);
  assert.match(html, /&lt;b>read_page/);
});

test("every mark shows its encoded fields on hover unless the spec turns it off", () => {
  assert.deepEqual(themeConfig(theme).mark.tooltip, { content: "encoding" });
});

test("a single view fills the width it's given; a composite sizes itself", () => {
  assert.deepEqual(sizedSpec({ mark: "line" }, 500), {
    mark: "line",
    width: 500,
    height: 260,
    autosize: { type: "fit-x", contains: "padding" },
  });
  // A discrete y axis keeps Vega-Lite's step height.
  assert.equal(sizedSpec(stacked, 500).height, undefined);
  const composite = { hconcat: [{ mark: "bar" }] };
  assert.equal(sizedSpec(composite, 500), composite);
  assert.equal(sizedSpec({ mark: "bar", width: 200 }, 500).width, 200);
});

test("Vega draws with string code generation disabled, as under the viewer CSP", () => {
  const chart = fileURLToPath(new URL("./vega-chart.mjs", import.meta.url));
  const dataflow = fileURLToPath(new URL("./chart-dataflow.mjs", import.meta.url));
  const script = `
    import { JSDOM } from "jsdom";
    const { window } = new JSDOM("<!doctype html><body></body>");
    globalThis.document = window.document;
    // jsdom's own selector engine compiles with Function: keep its
    // getComputedStyle and querySelector out of this process.
    window.getComputedStyle = () => ({ getPropertyValue: () => "", paddingLeft: "0" });
    const { serveCharts } = await import(${JSON.stringify(dataflow)});
    const { setChartWorker } = await import(${JSON.stringify(chart)});
    setChartWorker(() => {
      const worker = new EventTarget();
      const scope = new EventTarget();
      scope.postMessage = (data) =>
        setTimeout(() => worker.dispatchEvent(new MessageEvent("message", { data })));
      serveCharts(scope);
      worker.postMessage = (message) => {
        const data = structuredClone(message);
        setTimeout(() => scope.dispatchEvent(new MessageEvent("message", { data })));
      };
      worker.terminate = () => {};
      return worker;
    });
    const { mount } = await import(${JSON.stringify(chart)});
    const element = window.document.body.appendChild(window.document.createElement("div"));
    mount(element, {
      spec: ${JSON.stringify({ ...stacked, transform: [{ calculate: "datum.calls * 2", as: "double" }] })},
      datasets: { calls: ${JSON.stringify(calls)} },
    });
    const figure = element.firstElementChild;
    for (let i = 0; i < 400 && figure.dataset.chartStatus === "drawing"; i++)
      await new Promise((resolve) => setTimeout(resolve, 25));
    process.stdout.write(JSON.stringify({
      status: figure.dataset.chartStatus,
      message: figure.lastElementChild.lastElementChild.textContent,
    }));
  `;
  const run = spawnSync(
    process.execPath,
    ["--disallow-code-generation-from-strings", "--input-type=module", "-e", script],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { status: "rendered", message: "" });
});

test("hovering a value with no usable toString shows a tooltip, and the chart stays drawn", () =>
  withWindow(async (window) => {
    const { element } = container(window);
    const rows = calls.map((row) => ({
      ...row,
      title: { toString: 0, valueOf: 0 },
      meta: { toString: 0 },
    }));
    const chart = mount(element, {
      spec: {
        data: { name: "calls" },
        mark: { type: "point", tooltip: { content: "data" } },
        encoding: {
          x: { field: "calls", type: "quantitative" },
          y: { field: "tool", type: "nominal" },
        },
      },
      datasets: { calls: rows },
    });
    assert.equal(await drawn(element), "rendered");
    const figure = element.querySelector("figure");
    const point = element.querySelector(".pages-chart-canvas path[role='graphics-symbol']");
    point.dispatchEvent(
      new window.MouseEvent("pointermove", { bubbles: true, clientX: 5, clientY: 5 }),
    );
    await until(() => window.document.querySelector(".vg-tooltip")?.innerHTML);
    assert.equal(figure.dataset.chartStatus, "rendered");
    assert.match(window.document.querySelector(".vg-tooltip")?.innerHTML ?? "", /toString/);
    chart.destroy();
  }));

// A draw that never returns blocks the event loop, so each runs in its own
// process with a timeout.
function drawInProcess(cases, timeout) {
  const chart = fileURLToPath(new URL("./vega-chart.mjs", import.meta.url));
  const dataflow = fileURLToPath(new URL("./chart-dataflow.mjs", import.meta.url));
  const script = `
    import { JSDOM } from "jsdom";
    const { window } = new JSDOM("<!doctype html><body></body>");
    globalThis.document = window.document;
    Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { get: () => 400 });
    const { serveCharts } = await import(${JSON.stringify(dataflow)});
    const { setChartWorker } = await import(${JSON.stringify(chart)});
    setChartWorker(() => {
      const worker = new EventTarget();
      const scope = new EventTarget();
      scope.postMessage = (data) =>
        setTimeout(() => worker.dispatchEvent(new MessageEvent("message", { data })));
      serveCharts(scope);
      worker.postMessage = (message) => {
        const data = structuredClone(message);
        setTimeout(() => scope.dispatchEvent(new MessageEvent("message", { data })));
      };
      worker.terminate = () => {};
      return worker;
    });
    const { mount } = await import(${JSON.stringify(chart)});
    const results = [];
    for (const { spec, rows } of ${JSON.stringify(cases)}) {
      const element = window.document.body.appendChild(window.document.createElement("div"));
      const chart = mount(element, { spec, datasets: { d: rows } });
      const figure = element.firstElementChild;
      for (let i = 0; i < 200 && figure.dataset.chartStatus === "drawing"; i++)
        await new Promise((resolve) => setTimeout(resolve, 25));
      results.push({
        status: figure.dataset.chartStatus,
        message: figure.querySelector(".pages-chart-message")?.textContent ?? "",
      });
      chart.destroy();
    }
    process.stdout.write(JSON.stringify(results));
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    timeout,
  });
}

test("bin and time-unit extremes in the data or the spec never hang a draw", () => {
  // Vega's own bin never returns for an extent like [0, 5e-324]: its step
  // underflows to 0 and the loop multiplies 0 forever. Without the checks and
  // the data normalization, each case here would hang the child process.
  const x = (bin) => ({
    data: { name: "d" },
    mark: "bar",
    encoding: { x: { field: "x", type: "quantitative", bin }, y: { aggregate: "count" } },
  });
  const t = (timeUnit) => ({
    data: { name: "d" },
    mark: "bar",
    encoding: { x: { field: "x", type: "temporal", timeUnit }, y: { aggregate: "count" } },
  });
  const binned = (bin) => ({
    data: { name: "d" },
    transform: [{ bin, field: "x", as: "b" }],
    mark: "bar",
    encoding: { x: { field: "b", type: "quantitative" }, y: { aggregate: "count" } },
  });
  const rows = (...values) => values.map((value) => ({ x: value }));
  const tiny = rows(0, 5e-324);
  const near = rows(1e-150, 1.0000000000000002e-150);
  const huge = rows(-1e308, 1e308, 1);
  const strings = rows("0", "5e-324");
  const cases = [
    // Literal parameters: refused before Vega sees them.
    [binned({ base: 2, extent: [0, 5e-324] }), tiny, "error"],
    [x({ extent: [0, 1e-200] }), tiny, "error"],
    [x({ step: 1e-300 }), rows(0, 1), "error"],
    // Data: normalized, so an inferred extent is 0 or wide enough.
    [binned({ base: 2 }), tiny, "rendered"],
    [binned(true), near, "rendered"],
    [x(true), tiny, "rendered"],
    [x({ base: 2, maxbins: 1000 }), near, "rendered"],
    [x(true), huge, "rendered"],
    [x(true), strings, "rendered"],
    [t("yearmonth"), tiny, "rendered"],
    [t({ unit: "hours", maxbins: 1000 }), tiny, "rendered"],
    [t({ unit: "milliseconds", step: 1 }), rows(-8.64e15, 8.64e15), "rendered"],
    [t("utcyearmonthdate"), huge, "rendered"],
    [{ ...t("hours"), transform: [{ timeUnit: "hours", field: "x", as: "h" }] }, tiny, "rendered"],
    // Derived values: a formula, an aggregate, a window and a joinaggregate
    // each produce about 1e-323 from in-range inputs; the bin guard refuses.
    ...[
      [],
      [{ aggregate: [{ op: "mean", field: "tiny", as: "v" }] }],
      [{ window: [{ op: "sum", field: "tiny", as: "v" }] }],
      [{ joinaggregate: [{ op: "mean", field: "tiny", as: "v" }] }],
    ].map((then) => [
      {
        data: { name: "d" },
        transform: [
          { calculate: "datum.x / 1e150 / 1e150 / 1e23", as: "tiny" },
          ...then,
          { bin: { base: 2 }, field: then.length ? "v" : "tiny", as: "b" },
        ],
        mark: "point",
        encoding: { x: { field: "b", type: "quantitative" } },
      },
      rows(0, 1),
      "error",
      "guard",
    ]),
    // d3's negative-domain log ticks count down from base - 1, which 1e20 - 1
    // never leaves; the spec check refuses the base.
    [
      {
        data: { name: "d" },
        mark: "point",
        encoding: {
          x: {
            field: "x",
            type: "quantitative",
            scale: { type: "log", base: 1e20, domain: [-2, -1], nice: false },
          },
        },
      },
      rows(-1),
      "error",
    ],
    [
      {
        data: { name: "d" },
        mark: "point",
        encoding: {
          x: {
            field: "x",
            type: "quantitative",
            scale: { type: "log", base: 100, domain: [-2, -1], nice: false },
          },
        },
      },
      rows(-1),
      "rendered",
    ],
    [
      {
        data: { name: "d" },
        transform: [{ calculate: "datum.x / 1e150 / 1e150 / 1e23", as: "tiny" }],
        mark: "bar",
        encoding: {
          x: { field: "tiny", type: "quantitative", bin: true },
          y: { aggregate: "count" },
        },
      },
      rows(0, 1),
      "error",
      "guard",
    ],
    // kde and regression sample a curve over the derived extent.
    [
      {
        data: { name: "d" },
        transform: [
          { calculate: "datum.x / 1e150 / 1e150 / 1e23", as: "tiny" },
          { density: "tiny" },
        ],
        mark: "line",
        encoding: {
          x: { field: "value", type: "quantitative" },
          y: { field: "density", type: "quantitative" },
        },
      },
      rows(0, 1),
      "error",
      "guard",
    ],
    [
      {
        data: { name: "d" },
        transform: [
          { calculate: "datum.x / 1e150 / 1e150 / 1e23", as: "tiny" },
          { calculate: "datum.x", as: "y" },
          { regression: "y", on: "tiny", method: "poly" },
        ],
        mark: "line",
        encoding: {
          x: { field: "tiny", type: "quantitative" },
          y: { field: "y", type: "quantitative" },
        },
      },
      rows(0, 1),
      "error",
      "guard",
    ],
  ];
  const run = drawInProcess(
    cases.map(([spec, data]) => ({ spec, rows: data })),
    30_000,
  );
  assert.equal(run.signal, null, `a draw hung: ${run.stderr.slice(-400)}`);
  assert.equal(run.status, 0, run.stderr.slice(-400));
  const results = JSON.parse(run.stdout);
  assert.deepEqual(
    results.map(({ status }) => status),
    cases.map(([, , status]) => status),
  );
  // A derived value is refused by a guard, not by something else.
  cases.forEach(([, , , guard], index) => {
    if (guard)
      assert.match(results[index].message, /outside what a chart can draw/, `case ${index}`);
  });
});

test("a dataset over the cell budget is refused before any row is copied", () =>
  withWindow(async (window) => {
    const columns = 21;
    const rows = Math.ceil(CHART_MAX_CELLS / columns) + 1;
    const wide = Array.from({ length: rows }, (_, r) => {
      const row = { tool: "t", calls: r };
      for (let c = 0; c < columns - 2; c++) row[`c${c}`] = c;
      return row;
    });
    // A Proxy row would show a copy; the count reads only keys.
    let copied = false;
    wide[rows - 1] = new Proxy(wide[rows - 1], {
      get(target, key) {
        copied = true;
        return target[key];
      },
    });
    const limit = CHART_MAX_CELLS.toLocaleString("en-US");
    assert.equal(
      await refusalIn(window, stacked, { calls: wide }),
      `The dataset "calls" has more than ${limit} cells (rows × columns, nested values included); a chart reads at most that many.`,
    );
    assert.equal(copied, false);
    // An Arrow table's cells are rows × fields, known before any row.
    const table = tableFromJSON([wide[0]]);
    const fake = Object.create(table, { numRows: { value: CHART_MAX_ROWS } });
    assert.match(await refusalIn(window, stacked, { calls: fake }), /more than 2,000,000 cells/);
    // At the budget, a chart draws.
    const { element } = container(window);
    const narrow = wide.slice(0, Math.floor(CHART_MAX_CELLS / columns));
    narrow[narrow.length - 1] = { tool: "t", calls: 1 };
    const chart = mount(element, { spec: stacked, datasets: { calls: narrow } });
    assert.equal(await drawn(element), "rendered");
    chart.destroy();
  }));

test("destroy empties the container even when the drawing's finalize throws", () =>
  withWindow(async (window) => {
    const { element } = container(window);
    const chart = mount(element, {
      spec: { ...stacked, mark: { type: "bar", tooltip: { content: "data" } } },
      datasets: { calls },
    });
    await drawn(element);
    bars(element)[0].dispatchEvent(
      new window.MouseEvent("pointermove", { bubbles: true, clientX: 5, clientY: 5 }),
    );
    await settle();
    assert.ok(window.document.querySelector(".vg-tooltip"), "the tooltip exists before destroy");
    const { initialize } = SVGHandler.prototype;
    const reported = [];
    const { reportError } = window;
    window.reportError = (error) => reported.push(error);
    SVGHandler.prototype.initialize = function (el, ...rest) {
      if (!el) throw new Error("finalize broke");
      return initialize.call(this, el, ...rest);
    };
    try {
      chart.destroy();
    } finally {
      SVGHandler.prototype.initialize = initialize;
      window.reportError = reportError;
    }
    assert.equal(element.children.length, 0);
    assert.equal(window.document.querySelector(".vg-tooltip"), null);
    assert.deepEqual(
      reported.map((error) => error.message),
      ["finalize broke"],
    );
  }));

test("tooltip work stops when its text is full, however big the value", () => {
  let reads = 0;
  const huge = new Proxy(Array(1_000_000).fill(1), {
    get(target, key) {
      if (key !== "length") reads++;
      return target[key];
    },
  });
  const text = tooltipText({ payload: huge });
  assert.ok(text.length <= 400, text.length);
  assert.ok(reads < 400, `${reads} array reads`);
  // Keys are enumerated only as far as the table goes.
  let getterReads = 0;
  const wide = {};
  for (let i = 0; i < 10_000; i++)
    Object.defineProperty(wide, `c${i}`, {
      enumerable: true,
      get() {
        getterReads++;
        return i;
      },
    });
  const escape = (value) => String(value).replace(/</g, "&lt;");
  assert.match(formatTooltip(wide, escape, 2, ""), /more fields/);
  assert.ok(getterReads <= 41, `${getterReads} key reads`);
  assert.equal(tooltipText("x".repeat(1_000_000)).length, 400);
});

test("nested values count against the dataset's cell budget, in the page, before anything is posted", () =>
  withWindow((window) =>
    countWorkers(async (workers) => {
      const payload = Array(1_000_000).fill(1);
      const shared = Array.from({ length: 3 }, (_, i) => ({ ...calls[i], payload }));
      assert.match(
        await refusalIn(window, stacked, { calls: shared }),
        /has more than 2,000,000 cells \(rows × columns, nested values included\)/,
      );
      assert.match(
        await refusalIn(window, stacked, { calls: [{ payload: Array(3_000_000).fill(1) }] }),
        /has more than 2,000,000 cells/,
      );
      let nested = {};
      for (let i = 0; i < 31; i++) nested = { a: nested, b: Array(70_000).fill(0) };
      assert.match(
        await refusalIn(window, stacked, { calls: [{ nested }] }),
        /has more than 2,000,000 cells/,
      );
      assert.equal(workers.created, 0, "an oversized dataset never reaches a Worker");
      // One such row fits, and its tooltip stays bounded.
      const { element } = container(window);
      const chart = mount(element, {
        spec: { ...stacked, mark: { type: "bar", tooltip: { content: "data" } } },
        datasets: { calls: [{ ...calls[0], payload }] },
      });
      assert.equal(await drawn(element), "rendered");
      bars(element)[0].dispatchEvent(
        new window.MouseEvent("pointermove", { bubbles: true, clientX: 5, clientY: 5 }),
      );
      await settle();
      assert.ok((window.document.querySelector(".vg-tooltip")?.textContent.length ?? 0) < 2000);
      chart.destroy();
      // Deep nesting stops at 32 levels instead of overflowing.
      let deep = 1;
      for (let i = 0; i < 100_000; i++) deep = [deep];
      const [row] = datasetRows([{ deep }]);
      let depth = 0;
      for (let node = row.deep; Array.isArray(node); node = node[0]) depth++;
      assert.equal(depth, 32);
    }),
  ));

test("a dataset the page can't fully count is refused before anything is posted", () =>
  withWindow((window) =>
    countWorkers(async (workers) => {
      let deep = 1;
      for (let i = 0; i < 40; i++) deep = [deep];
      class Point {
        x = 1;
      }
      const unreadable = [
        ["nesting past 32 levels", { deep }],
        ["a Map", { m: new Map([[1, 2]]) }],
        ["a Set", { s: new Set([1]) }],
        ["a class instance", { p: new Point() }],
        ["a RegExp", { r: /x/ }],
        ["an ArrayBuffer", { b: new ArrayBuffer(8) }],
        ["a DataView", { v: new DataView(new ArrayBuffer(8)) }],
        ["a Blob", { b: new Blob(["x"]) }],
        ["an Error", { e: new Error("x") }],
        ["a boxed string", { s: new String("x") }],
        ["a function", { f: () => 1 }],
        ["a symbol", { s: Symbol("x") }],
        [
          "an array with a property past its entries",
          { a: Object.assign([1, 2], { hidden: new Map([[1, 2]]) }) },
        ],
        ["an array with a property only", { a: Object.assign([], { n: 1 }) }],
      ];
      for (const [what, row] of unreadable)
        assert.match(
          await refusalIn(window, stacked, { calls: [{ ...calls[0], ...row }] }),
          /The dataset "calls" holds a value a chart can't read/,
          what,
        );
      // The dataset itself is an array too; structured clone would carry its
      // extra properties.
      assert.match(
        await refusalIn(window, stacked, { calls: Object.assign([...calls], { extra: 1 }) }),
        /The dataset "calls" holds a value a chart can't read/,
      );
      assert.equal(workers.created, 0, "an unreadable dataset never reaches a Worker");
      // Plain data, dates, typed arrays, bigints and 32 levels of nesting
      // are read.
      let fits = 1;
      for (let i = 0; i < 31; i++) fits = [fits];
      const { element } = container(window);
      const chart = mount(element, {
        spec: stacked,
        datasets: {
          calls: calls.map((row) => ({
            ...row,
            when: new Date(0),
            xs: new Float64Array([1, 2]),
            big: 10n,
            none: null,
            missing: undefined,
            bare: Object.assign(Object.create(null), { a: 1 }),
            fits,
          })),
        },
      });
      assert.equal(await drawn(element), "rendered");
      chart.destroy();
    }),
  ));

test("Arrow lists, structs and maps are charged before they are read", () =>
  withWindow(async (window) => {
    const reads = { toJSON: 0, get: 0 };
    const { toJSON, get } = Vector.prototype;
    Vector.prototype.toJSON = function (...args) {
      reads.toJSON++;
      return toJSON.apply(this, args);
    };
    try {
      const big = tableFromJSON([{ tool: "a", calls: 1, xs: Array(3_000_000).fill(1) }]);
      Vector.prototype.get = function (...args) {
        reads.get++;
        return get.apply(this, args);
      };
      assert.match(
        await refusalIn(window, stacked, { calls: big }),
        /has more than 2,000,000 cells \(rows × columns, nested values included\)/,
      );
      assert.equal(reads.toJSON, 0);
      assert.ok(reads.get < 10, `${reads.get} element reads`);
    } finally {
      Vector.prototype.toJSON = toJSON;
      Vector.prototype.get = get;
    }
    const nested = tableFromJSON([{ tool: "a", calls: 1, xs: [1, 2], s: { a: 1, b: "two" } }]);
    const [row] = datasetRows(nested);
    assert.deepEqual(row.xs, [1, 2]);
    assert.deepEqual({ ...row.s }, { a: 1, b: "two" });
    assert.equal(reads.toJSON, 0);
  }));

test("every corpus chart draws through the guards", () =>
  withWindow(async (window) => {
    const rows = corpusRows;
    for (const [index, spec] of CORPUS.entries()) {
      const { names } = checkChartSpec(spec);
      const target = window.document.body.appendChild(window.document.createElement("div"));
      const errors = [];
      let view;
      try {
        view = await drawChart(target, {
          spec,
          data: Object.fromEntries(names.map((name) => [name, datasetRows(rows)])),
          theme,
          width: 400,
          onError: (error) => errors.push(error),
        });
      } catch (error) {
        assert.fail(`${index}: ${error.message} in ${JSON.stringify(spec).slice(0, 160)}`);
      }
      assert.deepEqual(errors, [], `${index}`);
      assert.ok(target.querySelector("svg"), `${index} drew`);
      view.finalize();
      target.remove();
    }
  }));

test("the Worker normalizes the rows it receives in place, under the cell budget", () => {
  const rows = [{ x: 5e-324, big: 1e300, s: "1e-200" }, null];
  const first = rows[0];
  ownRows(rows);
  assert.equal(rows[0], first, "the same object, not a copy");
  assert.equal(Object.getPrototypeOf(rows[0]), null);
  assert.deepEqual({ ...rows[0] }, { x: 0, big: null, s: 0 });
  assert.equal(Object.getPrototypeOf(rows[1]), null);
  assert.throws(() => ownRows([{ payload: Array(3_000_000).fill(1) }]));
  // A dataset that can't be read refuses with its sentence.
  assert.throws(() => readDatasets({ d: { rows: [{ payload: Array(3_000_000).fill(1) }] } }), {
    message: /The dataset "d" has more than 2,000,000 cells/,
  });
  assert.throws(() => readDatasets({ d: { neither: true } }), {
    message: 'The dataset "d" must be rows, Arrow IPC bytes or an Arrow table.',
  });
});

test("the Worker's message loop says ready, takes a chart's data with its first job, and answers each job by id", async () => {
  const posted = [];
  const scope = new EventTarget();
  scope.postMessage = (data) => posted.push(data);
  serveCharts(scope);
  assert.deepEqual(posted, [{ type: "ready" }]);
  const send = (data) => scope.dispatchEvent(new MessageEvent("message", { data }));
  const answers = () => posted.filter((message) => message.type === "answer");
  const wait = async (count) => {
    for (let i = 0; i < 300 && answers().length < count; i++) await settle(10);
  };
  const job = (id, key, more = {}) => ({
    type: "draw",
    id,
    key,
    spec: stacked,
    theme,
    width: 300,
    ...more,
  });
  send(job(1, "a"));
  await wait(1);
  assert.deepEqual(answers()[0], {
    type: "answer",
    id: 1,
    error: { message: "This chart has no data yet.", refusal: true },
  });
  // Data comes with a chart's first job and stays for its later ones; a
  // dataset over the budget fails that chart's jobs with its sentence.
  send(job(2, "a", { datasets: { calls: { rows: structuredClone(calls) } } }));
  send(job(3, "b", { datasets: { calls: { rows: [{ payload: Array(3_000_000).fill(1) }] } } }));
  send(job(4, "a"));
  await wait(4);
  assert.deepEqual(
    answers().map((answer) => answer.id),
    [1, 2, 3, 4],
  );
  const [, drawnA, refusedB, againA] = answers();
  assert.ok(drawnA.scene && drawnA.width > 0 && drawnA.height > 0);
  assert.ok(againA.scene, "the second job reads the data the first one brought");
  assert.equal(refusedB.error.refusal, true);
  assert.match(refusedB.error.message, /more than 2,000,000 cells/);
  // Dropped data draws nothing; data the page couldn't send fails with why.
  send({ type: "drop", key: "a" });
  send(job(5, "a"));
  send(job(6, "c", { failed: "Function object could not be cloned." }));
  await wait(6);
  assert.equal(answers()[4].error.message, "This chart has no data yet.");
  assert.deepEqual(answers()[5].error, {
    message: "Function object could not be cloned.",
    refusal: false,
  });
  // The font probe: each stack in each style and string, measured as the
  // Worker's layout measures text; a stack the page may not name measures
  // as the fallback.
  const probes = () => posted.filter((message) => message.type === "probed");
  send({ type: "probe", fonts: ["Inter, sans-serif", CHART_FALLBACK_FONT] });
  send({ type: "probe", fonts: ["url(https://x.example/f.woff)", CHART_FALLBACK_FONT] });
  send({ type: "probe", fonts: "nonsense" });
  const [own, unusable, missing] = probes().map((message) => message.widths);
  assert.equal(own.length, probeCount(["Inter, sans-serif", CHART_FALLBACK_FONT]));
  assert.ok(own.every((width) => Number.isFinite(width) && width > 0));
  const half = own.length / 2;
  assert.deepEqual(unusable.slice(0, half), unusable.slice(half));
  assert.deepEqual(missing, unusable);
});

test("the scene that crosses to the page keeps tooltips and cursors, and nothing that links or loads", () => {
  const scene = plainScene({
    marktype: "group",
    items: [
      {
        items: [
          {
            marktype: "rect",
            items: [
              {
                x: 1,
                fill: "red",
                tooltip: { tool: "read_page" },
                cursor: "pointer",
                href: "https://example.com",
                url: "https://example.com/p.png",
                datum: { secret: 1 },
                mark: {},
              },
            ],
          },
        ],
      },
    ],
  });
  const item = scene.items[0].items[0].items[0];
  assert.deepEqual(item, { x: 1, fill: "red", tooltip: { tool: "read_page" }, cursor: "pointer" });
});

test("a gradient legend and a geoshape cross to the page and draw", () =>
  withWindow(async (window) => {
    const target = window.document.body.appendChild(window.document.createElement("div"));
    const heat = await drawChart(target, {
      spec: {
        data: { name: "d" },
        mark: "rect",
        encoding: {
          x: { field: "a", type: "nominal" },
          color: { field: "n", type: "quantitative" },
        },
      },
      data: {
        d: [
          { a: "x", n: 1 },
          { a: "y", n: 9 },
        ],
      },
      theme,
      width: 400,
    });
    const gradient = target.querySelector("linearGradient");
    assert.ok(gradient, "the legend's gradient is drawn");
    assert.ok(gradient.querySelectorAll("stop").length >= 2);
    heat.finalize();
    target.replaceChildren();

    const square = (x) => ({
      type: "Feature",
      properties: { n: x },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [x, 0],
            [x + 1, 0],
            [x + 1, 1],
            [x, 1],
            [x, 0],
          ],
        ],
      },
    });
    const map = await drawChart(target, {
      spec: {
        data: { name: "d" },
        mark: "geoshape",
        projection: { type: "mercator" },
        encoding: { color: { field: "properties.n", type: "quantitative" } },
      },
      data: { d: [square(0), square(2)] },
      theme,
      width: 400,
    });
    const shapes = [...target.querySelectorAll("path[role='graphics-symbol'], g.mark-path path")]
      .map((path) => path.getAttribute("d") ?? "")
      .filter((d) => d.startsWith("M"));
    assert.equal(shapes.length, 2, "each feature draws as a path");
    map.finalize();
  }));

test("Arrow IPC bytes are a dataset; two views and a table over the same bytes all draw", () =>
  withWindow((window) =>
    countWorkers(async () => {
      const bytes = tableToIPC(tableFromJSON(calls));
      const length = bytes.byteLength;
      // A table embed decodes the same bytes and keeps reading them.
      const table = tableFromIPC(bytes);
      const views = [container(window), container(window)].map(({ element }) => ({
        element,
        chart: mount(element, { spec: stacked, datasets: { calls: bytes } }),
      }));
      for (const { element } of views) {
        assert.equal(await drawn(element), "rendered");
        assert.equal(bars(element).length, 5);
      }
      // Each chart sent its own copy: the caller's bytes are still whole.
      assert.equal(bytes.byteLength, length);
      assert.equal(table.numRows, calls.length);
      assert.equal(table.getChild("tool").get(4), "move_page");
      for (const { chart } of views) chart.destroy();
    }),
  ));

test("a dataset that only looks like an Arrow table is refused with one sentence", () =>
  withWindow(async (window) => {
    const table = tableFromJSON(calls);
    const wrapper = Object.freeze({
      schema: table.schema,
      numRows: table.numRows,
      numCols: table.numCols,
      getChildAt: (index) => table.getChildAt(index),
    });
    assert.equal(
      await refusalIn(window, stacked, { calls: wrapper }),
      'The dataset "calls" must be rows, Arrow IPC bytes or an Arrow table.',
    );
  }));

for (const size of [1, 2]) {
  test(`ten charts on ${size} Worker(s): a hung chart fails alone and its Worker is replaced`, () =>
    withWindow(async (window) => {
      // The in-process Worker draws on this thread, so a timer that a loaded
      // test run could outlast with an ordinary draw would fail a good chart.
      const restore = setChartWorker(() => new InProcessWorker(), { timeoutMs: 1_500, size });
      try {
        await countWorkers(async (workers) => {
          // Chart 3 hangs; at both sizes, others are pinned to its Worker and
          // wait behind it.
          const HUNG = 3;
          workers.hang = (message) => message.spec.description === "hang";
          const charts = Array.from({ length: 10 }, (_, index) => {
            const { element } = container(window);
            const spec = index === HUNG ? { ...stacked, description: "hang" } : stacked;
            return { element, chart: mount(element, { spec, datasets: { calls } }) };
          });
          const statuses = () =>
            charts.map(({ element }) => element.querySelector("figure").dataset.chartStatus);
          assert.ok(await until(() => !statuses().includes("drawing"), 30_000), statuses().join());
          statuses().forEach((status, index) =>
            assert.equal(status, index === HUNG ? "error" : "rendered", `chart ${index}`),
          );
          assert.equal(
            charts[HUNG].element.querySelector(".pages-chart-message").textContent,
            TIMED_OUT,
          );
          // `size` Workers, and one replacement for the hung chart's.
          assert.equal(workers.created, size + 1);
          assert.equal(workers.live.size, size);
          for (const { chart } of charts) chart.destroy();
          assert.equal(workers.live.size, 0, "no Worker outlives its last chart");
        });
      } finally {
        restore();
      }
    }));
}

test("a hidden document holds its draws: the running Worker is terminated, and the draw runs again on show", () =>
  withWindow((window) =>
    countWorkers(async (workers) => {
      let state = "visible";
      Object.defineProperty(window.document, "visibilityState", {
        configurable: true,
        get: () => state,
      });
      const toggle = (next) => {
        state = next;
        window.document.dispatchEvent(new window.Event("visibilitychange"));
      };
      const { element } = container(window);
      workers.hang = () => true;
      const chart = mount(element, { spec: stacked, datasets: { calls } });
      assert.ok(await until(() => workers.draws === 1));
      await settle(20);
      toggle("hidden");
      assert.equal(workers.live.size, 0, "the draw in flight is terminated");
      assert.equal(element.querySelector("figure").dataset.chartStatus, "drawing");
      workers.hang = null;
      toggle("visible");
      assert.equal(await drawn(element), "rendered");
      assert.equal(workers.created, 2);
      chart.destroy();
      assert.equal(workers.live.size, 0);
    }),
  ));

test("a Worker that never says ready fails its chart; the page never draws without one", () =>
  withWindow((window) =>
    countViews(async (views) => {
      for (const [create, options, before] of [
        [() => new InProcessWorker(), { readyMs: 50 }, () => (workers.silent = true)],
        [
          () => {
            throw new Error("Workers are off.");
          },
          {},
          () => {},
        ],
      ]) {
        const restore = setChartWorker(create, options);
        try {
          await countWorkers(async () => {
            before();
            const { element } = container(window);
            const chart = mount(element, { spec: stacked, datasets: { calls } });
            assert.notEqual(await drawn(element), "drawing");
            const figure = element.querySelector("figure");
            assert.equal(figure.dataset.chartStatus, "error");
            assert.match(
              figure.querySelector(".pages-chart-message").textContent,
              /^This chart couldn't be drawn: (The chart Worker didn't start|Workers are off)\.$/,
            );
            assert.equal(workers.live.size, 0);
            chart.destroy();
          });
        } finally {
          restore();
        }
      }
      assert.equal(views.created, 0, "no View ran in the page");
      assert.ok(WORKER_DIDNT_START);
    }),
  ));

/** A Worker that answers every draw with `answer()`, as a compromised or
 * buggy Worker could. */
class SceneWorker extends EventTarget {
  constructor(answer) {
    super();
    this.answer = answer;
    setTimeout(() => this.emit({ type: "ready" }));
  }
  emit(data) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  postMessage(message) {
    if (message.type === "probe") {
      const widths = Array(probeCount(message.fonts)).fill(10);
      setTimeout(() => this.emit({ type: "probed", widths }));
      return;
    }
    if (message.type !== "draw") return;
    setTimeout(() => {
      this.emit({ type: "answer", id: message.id, ...this.answer() });
    });
  }
  terminate() {}
}

/** A scene whose one `marktype` mark holds the same `item` `count` times. */
const shared = (marktype, item, count) => ({
  scene: frameOf([{ marktype, items: Array.from({ length: count }, () => item) }]),
  width: 200,
  height: 100,
  origin: [0, 0],
});

const frameOf = (marks) => ({
  marktype: "group",
  items: [{ x: 0, y: 0, width: 200, height: 100, items: marks }],
});

/** `value` behind a Proxy that counts, in `reads.count`, every array entry
 * or object field read through it, nested values included. */
function counted(value, reads, seen = new Map()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  const proxy = new Proxy(value, {
    get(target, key, receiver) {
      if (typeof key === "string" && Object.hasOwn(target, key) && key !== "length") {
        reads.count++;
        return counted(target[key], reads, seen);
      }
      return Reflect.get(target, key, receiver);
    },
  });
  seen.set(value, proxy);
  return proxy;
}

test("paths are charged by the commands they draw, read as Vega reads them", () => {
  const COST = { m: 1, l: 1, h: 1, v: 1, t: 1, z: 1, c: 2, s: 2, q: 2, a: 8 };
  const vegaCost = (path) =>
    pathParse(path).reduce((sum, [command]) => sum + COST[command.toLowerCase()], 0);
  // Implicit repeats, relative forms, packed arc flags and numbers that run
  // together, each costed as Vega's own parser splits them.
  for (const path of [
    "M1e2,3L4-5h6v7Z",
    "M0 0L1 1 2 2 3 3",
    "m.1.1.1.1",
    "M0,0a1 1 0 0 1 1 1 1 1 0 0 1 2 2",
    "M0 0a1 1 0 011 1",
    "M0 0a1 1 0 0,1 1 1",
    "m0 0a1 1 0 11.5.5 2 2 0 00-1-1",
    "M0 0A1 1 0 1 0 2 2a1,1,0,1,1,3,3",
    "M0,0C1,1,2,2,3,3S4,4,5,5zzz",
    "M0 0c1 1 2 2 3 3 4 4 5 5 6 6s1 1 2 2q1 1 2 2t1 1 2 2",
    "M1.5.5L2.e3 1E-2Z",
    "M 0 , 0 l 1 , 1",
    "",
  ])
    assert.equal(pathCost(path), vegaCost(path), path);
  // Packed flags: 80,000 arcs cost 640,001, over one path's budget.
  const packed = `M0 0a${"1 1 0 011 1 ".repeat(80_000)}`;
  assert.equal(pathCost(packed), 640_001);
  // Anything Vega's parser or the browser's wouldn't read the same way.
  for (const path of [
    "M0 0a1 1 0 2 1 1 1",
    "M0 0L1",
    "M0 0x1 1",
    "M1e",
    "junkM0 0",
    "M0 0z5",
    "M0 0L1,,1",
    "M0 0a1 1 0 0 1 1",
  ])
    assert.equal(pathCost(path), null, path);
  const fill = (start, unit, chars) =>
    start + unit.repeat(Math.floor((chars - start.length) / unit.length));
  const sceneOf = (marktype, key, value, count = 1) =>
    frameOf([{ marktype, items: Array.from({ length: count }, () => ({ [key]: value })) }]);
  const refused = (scene, message = SCENE_TOO_LARGE) =>
    assert.throws(
      () => pageScene(scene),
      (error) => error.message === message,
    );
  // Under the character budgets, each of these was seconds of drawing.
  refused(sceneOf("path", "path", fill("M0,0L", ".1.1", 8_000_000)));
  refused(sceneOf("path", "path", fill("M0,0", "z", 8_000_000)));
  refused(sceneOf("path", "path", fill("M0,0", "a1 1 0 0 1 1 1", 1_000_000)));
  refused(sceneOf("path", "path", packed));
  refused(sceneOf("path", "path", "M0 0a1 1 0 2 1 1 1"), SCENE_MALFORMED);
  // One path at the per-path budget fits; two exceed none; three exceed the total.
  const full = `M0,0L${"1,1 ".repeat(SCENE_PATH_COMMANDS - 1)}`;
  assert.equal(pathCost(full), SCENE_PATH_COMMANDS);
  pageScene(sceneOf("path", "path", full, 2));
  refused(sceneOf("path", "path", full, 3));
  refused(sceneOf("path", "path", `${full}L1,1`));
  // A 100,000-vertex geoshape fits.
  const vertex = (i) => `L${(i % 800).toFixed(2)},${(i % 500).toFixed(2)}`;
  pageScene(
    sceneOf(
      "path",
      "path",
      `M0,0${Array.from({ length: 100_000 }, (_, i) => vertex(i)).join("")}Z`,
    ),
  );
});

test("a symbol draws one of Vega's own shapes, never a custom path", () => {
  const sceneOf = (shape, count = 1) =>
    frameOf([{ marktype: "symbol", items: Array.from({ length: count }, () => ({ shape })) }]);
  const drawn = pageScene(sceneOf("triangle-up", 100_000)).items[0].items[0].items;
  assert.equal(drawn.length, 100_000);
  assert.equal(drawn[0].shape, "triangle-up");
  for (const shape of ["M-1,-1H1V1H-1Z", "M0 0a1 1 0 0 1 1 1", "circle ", "Circle"])
    assert.equal(
      Object.hasOwn(pageScene(sceneOf(shape)).items[0].items[0].items[0], "shape"),
      false,
    );
});

test("the page keeps a copy of each tooltip built from what it charged", () => {
  const received = Object.assign(["a", { b: [1, 2] }], { hidden: new Map([[1, 2]]) });
  const polluting = JSON.parse('{"__proto__": {"polluted": true}, "n": 1}');
  const scene = frameOf([
    { marktype: "rect", items: [{ tooltip: received }, { tooltip: polluting }, { tooltip: "t" }] },
  ]);
  const [first, second, third] = pageScene(scene).items[0].items[0].items.map(
    (item) => item.tooltip,
  );
  assert.notEqual(first, received);
  assert.notEqual(first[1], received[1]);
  assert.deepEqual(first, ["a", { b: [1, 2] }]);
  assert.equal(Object.hasOwn(first, "hidden"), false);
  assert.equal(Object.getPrototypeOf(second), Object.prototype);
  assert.equal(second.n, 1);
  assert.equal({}.polluted, undefined);
  assert.equal(third, "t");
});

test("a tooltip walk reads no more entries than it has charged", () => {
  const sceneOf = (tooltip, count = 1) =>
    frameOf([{ marktype: "rect", items: Array.from({ length: count }, () => ({ tooltip })) }]);
  const refused = (scene) => {
    const started = performance.now();
    assert.throws(
      () => pageScene(scene),
      (error) => error.message === SCENE_TOO_LARGE,
    );
    return performance.now() - started;
  };
  // One shared array of 100,000 empty strings, 1,000 times over: 100 million
  // entries that cost nothing by length.
  const reads = { count: 0 };
  const inner = Array(100_000).fill("");
  const ms = refused(sceneOf(counted(Array(1_000).fill(inner), reads)));
  assert.ok(reads.count <= 1, `${reads.count} entries read`);
  assert.ok(ms < 250, `${ms} ms`);
  // Empty strings and empty arrays, shared across items: every entry costs
  // at least one, so the walk stops at the entry budget.
  const wide = { count: 0 };
  refused(sceneOf(counted(Array(10_000).fill([]), wide), 1_000));
  assert.ok(wide.count <= SCENE_BUDGET.tooltipEntries, `${wide.count} entries read`);
  // A sparse array that claims billions of entries is refused unread.
  const sparse = { count: 0 };
  refused(sceneOf(counted(new Array(4_000_000_000), sparse)));
  assert.equal(sparse.count, 0);
  // A typed array or a Map isn't a tooltip.
  for (const tooltip of [new Float64Array(10_000_000), new Map([[1, 2]])])
    assert.throws(
      () => pageScene(sceneOf(tooltip)),
      (error) => error.message === SCENE_MALFORMED,
    );
  // 100,000 points with a 16-field tooltip each, names and values of 8
  // characters, fit; 20 fields each don't.
  const fields = (count) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`field_${i}`.padEnd(8, "_"), "12345678"]),
    );
  assert.equal(pageScene(sceneOf(fields(16), 100_000)).items[0].items[0].items.length, 100_000);
  refused(sceneOf(fields(20), 100_000));
});

test("the page draws a Worker's scene as untrusted: known marks and keys, cleaned, bounded", () =>
  withWindow(async (window) => {
    const polluting = JSON.parse(
      '{"__proto__": {"polluted": true}, "x": 30, "y": 1, "width": 5, "height": 5}',
    );
    const hostile = frameOf([
      {
        marktype: "rect",
        role: "mark",
        items: [
          {
            x: 1,
            y: 1,
            width: 10,
            height: 10,
            fill: "url(https://evil.test/fill)",
            stroke: {
              gradient: "linear",
              id: 'g") url(https://evil.test/id',
              stops: [
                { offset: 0, color: "url(https://evil.test/stop)" },
                { offset: 1, color: "red" },
              ],
            },
            cursor: "url(https://evil.test/cursor), auto",
            font: "12px url(https://evil.test/font)",
            href: "https://evil.test/href",
            url: "https://evil.test/image.png",
            onload: "alert(1)",
            tooltip: { note: "x".repeat(100_000) },
          },
          { x: 15, y: 1, width: 5, height: 5, fill: () => "red", text: { toString: () => "x" } },
          { x: 1e300, y: Number.NaN, width: Infinity, height: 5, fill: "red" },
          polluting,
        ],
      },
    ]);
    const cases = [
      [
        () => ({
          scene: hostile,
          width: 1e12,
          height: -5,
          origin: "nope",
          background: "url(https://evil.test/bg)",
        }),
        "rendered",
      ],
      [
        () => ({
          scene: frameOf([{ marktype: "image", items: [{ url: "https://evil.test/i.png" }] }]),
          width: 200,
          height: 100,
          origin: [0, 0],
        }),
        SCENE_MALFORMED,
      ],
      [
        () => ({
          scene: frameOf([
            {
              marktype: "symbol",
              items: Array.from({ length: SCENE_MAX_ITEMS + 1 }, () => ({ x: 1, y: 1 })),
            },
          ]),
          width: 200,
          height: 100,
          origin: [0, 0],
        }),
        SCENE_TOO_BIG,
      ],
      [
        () => {
          let scene = { marktype: "rect", items: [] };
          for (let i = 0; i < 10_000; i++) scene = frameOf([scene]);
          return { scene, width: 200, height: 100, origin: [0, 0] };
        },
        SCENE_MALFORMED,
      ],
      [
        () => ({ scene: "<svg onload=alert(1)>", width: 200, height: 100, origin: [0, 0] }),
        SCENE_MALFORMED,
      ],
      // One item referenced many times: structured clone keeps one copy, so
      // the budgets count every reference before anything is copied.
      [() => shared("path", { path: `M0,0${"L1,1".repeat(1_999_999)}` }, 3), SCENE_TOO_LARGE],
      [() => shared("text", { text: "x".repeat(10_000) }, 200), SCENE_TOO_LARGE],
      [() => shared("rect", { description: "x".repeat(1_000) }, 30_000), SCENE_TOO_LARGE],
      [() => shared("rect", { tooltip: { note: "x".repeat(1_000_000) } }, 40), SCENE_TOO_LARGE],
      [
        () =>
          shared(
            "rect",
            {
              fill: {
                gradient: "linear",
                stops: Array.from({ length: 256 }, (_, i) => ({ offset: i / 255, color: "red" })),
              },
            },
            20,
          ),
        SCENE_TOO_LARGE,
      ],
      // An error a Worker forges is bounded like any other answer.
      [
        () => ({ error: { refusal: true, message: "x".repeat(10_000_000) } }),
        "This chart couldn't be drawn.",
      ],
    ];
    for (const [answer, expected] of cases) {
      const restore = setChartWorker(() => new SceneWorker(answer));
      try {
        const { element } = container(window);
        const chart = mount(element, { spec: stacked, datasets: { calls } });
        const status = await drawn(element);
        if (expected === "rendered") {
          assert.equal(status, "rendered");
          const html = element.innerHTML;
          assert.doesNotMatch(html, /evil\.test|onload|href=/);
          assert.doesNotMatch(html, /NaN|Infinity|e\+300/, "numbers are finite and in range");
          const gradient = element.querySelector("linearGradient");
          assert.match(gradient.id, /^pages-chart-gradient-\d+$/);
          assert.equal({}.polluted, undefined);
          assert.equal(element.querySelectorAll("path, rect").length > 0, true);
          // The tooltip shows bounded text.
          element
            .querySelector(".mark-rect path")
            .dispatchEvent(
              new window.MouseEvent("pointermove", { bubbles: true, clientX: 2, clientY: 2 }),
            );
          const tip = window.document.querySelector(".vg-tooltip.visible");
          assert.ok(tip && tip.textContent.length < 1_000, tip?.textContent.length);
        } else {
          assert.equal(status, "error");
          assert.equal(element.querySelector(".pages-chart-message").textContent, expected);
        }
        chart.destroy();
        element.remove();
      } finally {
        restore();
      }
    }
  }));
