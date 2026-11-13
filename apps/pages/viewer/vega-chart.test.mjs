import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tableFromJSON } from "apache-arrow";
import { JSDOM } from "jsdom";
import * as vega from "vega";
globalThis.__vega = vega;

const {
  mount,
  drawChart,
  datasetRows,
  sizedSpec,
  themeConfig,
  deniedLoader,
  formatTooltip,
  runtimeProblem,
  safePaint,
  cleanItem,
  VEGA_LITE_FUNCTIONS,
  STATIC_OPERATORS,
  RESIZE_SETTLE_MS,
  tooltipText,
} = await import("./vega-chart.mjs");
const { checkChartSpec, CHART_MAX_ROWS, CHART_MAX_CELLS, CHART_EXPRESSION_FUNCTIONS } =
  await import("../shared/chart-spec.mjs");
const vl = await import("vega-lite");

const theme = { dark: false, text: "#111", muted: "#555", line: "#ddd", font: "sans-serif" };
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

/** Count Vega views created and finalized while `run` runs. */
async function countViews(run) {
  const { initialize, finalize } = vega.View.prototype;
  const views = { live: new Set(), created: 0 };
  vega.View.prototype.initialize = function (...args) {
    views.live.add(this);
    views.created++;
    return initialize.apply(this, args);
  };
  vega.View.prototype.finalize = function (...args) {
    views.live.delete(this);
    return finalize.apply(this, args);
  };
  try {
    return await run(views);
  } finally {
    Object.assign(vega.View.prototype, { initialize, finalize });
  }
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

test("mount draws a stacked bar chart from rows, with the title above one frame", () =>
  withWindow(async (window) => {
    const { element } = container(window);
    const chart = mount(element, { spec: stacked, datasets: { calls }, title: "Calls by tool" });
    await settle();
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
    await settle();
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
    await settle();
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

test("mount redraws at a new width once a resize settles, and finalizes the old view", () =>
  withWindow((window, { observers }) =>
    countViews(async (views) => {
      const { element, resize } = container(window, 600);
      const chart = mount(element, { spec: stacked, datasets: { calls } });
      await settle();
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
      await settle(RESIZE_SETTLE_MS + 80);
      assert.ok(svgWidth() < wide && svgWidth() <= 340, `${wide} -> ${svgWidth()}`);
      assert.equal(views.created, 2);
      assert.equal(views.live.size, 1);
      assert.equal(element.querySelectorAll(".pages-chart-canvas svg").length, 1);
      chart.destroy();
      assert.equal(views.live.size, 0);
    }),
  ));

test("a Page theme change redraws with the dark palette", () =>
  withWindow((window) =>
    countViews(async (views) => {
      const { element } = container(window);
      const chart = mount(element, { spec: stacked, datasets: { calls } });
      await settle();
      const fills = () => new Set([...bars(element)].map((bar) => bar.getAttribute("fill")));
      assert.ok(fills().has(themeConfig(theme).range.category[0]));
      window.document.documentElement.classList.add("dark");
      await settle();
      assert.ok(fills().has(themeConfig({ ...theme, dark: true }).range.category[0]));
      assert.equal(views.created, 2);
      assert.equal(views.live.size, 1);
      // A class change that keeps the theme draws nothing new.
      window.document.documentElement.classList.add("unrelated");
      await settle();
      assert.equal(views.created, 2);
      chart.destroy();
    }),
  ));

test("destroy leaves no listeners, observers, views, tooltip or viewer behind", () =>
  withWindow((window, { listeners, observers }) =>
    countViews(async (views) => {
      const before = listeners();
      const { element } = container(window);
      const chart = mount(element, { spec: stacked, datasets: { calls }, title: "Calls" });
      await settle();
      // Show Vega's tooltip and open the expanded viewer, then tear down.
      const [view] = views.live;
      view.tooltip()(view, { clientX: 10, clientY: 10 }, null, { tool: "read_page" });
      assert.ok(window.document.querySelector(".vg-tooltip.visible"));
      element.querySelector(".wordgard-diagram-maximize").click();
      assert.ok(window.document.querySelector("dialog.diagram-viewer"));
      assert.ok(listeners() > before);
      chart.destroy();
      assert.equal(views.live.size, 0);
      assert.equal(listeners(), before);
      assert.equal(observers.mutation, 0);
      assert.ok(observers.resize.every((observer) => !observer.connected));
      assert.equal(window.document.querySelector(".vg-tooltip"), null);
      assert.equal(window.document.querySelector("dialog.diagram-viewer"), null);
      assert.equal(element.children.length, 0);
    }),
  ));

test("destroy during the first draw finalizes the view that draw makes", () =>
  withWindow((window) =>
    countViews(async (views) => {
      const { element } = container(window);
      const chart = mount(element, { spec: stacked, datasets: { calls } });
      chart.destroy();
      await settle();
      assert.equal(views.created, 1, "the draw ran to its end");
      assert.equal(views.live.size, 0);
      assert.equal(element.children.length, 0);
      // Finalizing the late view hides its tooltip; that must not leave an
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
    await settle();
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
      await settle();
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
  await settle();
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
        'The dataset "calls" must be rows or an Arrow table.',
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

test("a drawn chart listens for nothing; hovering a mark only shows its tooltip", () =>
  withWindow(async (window) => {
    const shown = [];
    const target = window.document.body.appendChild(window.document.createElement("div"));
    const view = await drawChart(target, {
      spec: stacked,
      data: { calls: datasetRows(calls) },
      theme,
      width: 400,
      tooltip: (_handler, _event, _item, value) => shown.push(value),
    });
    assert.equal(view._eventListeners.length, 0);
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
    view.finalize();
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
    await settle();
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
const CORPUS = (() => {
  const d = { name: "c" };
  const enc = { x: { field: "a", type: "nominal" }, y: { field: "n", type: "quantitative" } };
  const xy = { x: { field: "n", type: "quantitative" }, y: { field: "m", type: "quantitative" } };
  const time = {
    x: { field: "t", type: "temporal", timeUnit: "yearmonth" },
    y: { field: "n", type: "quantitative", aggregate: "sum" },
    color: { field: "a", type: "nominal" },
  };
  return [
    { data: d, mark: "bar", encoding: enc },
    {
      data: d,
      mark: "bar",
      encoding: {
        y: { field: "a", type: "nominal" },
        x: { field: "n", type: "quantitative", aggregate: "sum" },
        color: { field: "b" },
      },
    },
    {
      data: d,
      mark: "bar",
      encoding: {
        ...enc,
        y: { ...enc.y, stack: "normalize", axis: { format: "%" } },
        color: { field: "b" },
      },
    },
    { data: d, mark: "line", encoding: time },
    { data: d, mark: { type: "area", interpolate: "monotone" }, encoding: time },
    {
      data: d,
      mark: { type: "line", point: true },
      encoding: { ...time, strokeDash: { field: "a" } },
    },
    {
      data: d,
      mark: "point",
      encoding: {
        ...xy,
        color: { field: "a" },
        size: { field: "m", type: "quantitative" },
        shape: { field: "a" },
      },
    },
    {
      data: d,
      mark: "bar",
      encoding: {
        x: { field: "n", bin: { maxbins: 30 }, type: "quantitative" },
        y: { aggregate: "count" },
      },
    },
    {
      data: d,
      mark: "rect",
      encoding: {
        x: { field: "n", bin: true },
        y: { field: "m", bin: true },
        color: { aggregate: "count" },
      },
    },
    {
      data: d,
      mark: "bar",
      encoding: {
        x: { field: "n", bin: { step: 5, extent: [0, 100] }, type: "quantitative" },
        y: { aggregate: "count" },
      },
    },
    { data: d, mark: "bar", encoding: { ...enc, facet: { field: "b", columns: 2 } } },
    { data: d, facet: { row: { field: "b" } }, spec: { mark: "bar", encoding: enc } },
    { data: d, mark: "bar", encoding: { ...enc, row: { field: "b" }, column: { field: "c" } } },
    {
      data: d,
      repeat: ["n", "m"],
      spec: {
        mark: "bar",
        encoding: { x: { field: "a" }, y: { field: { repeat: "repeat" }, type: "quantitative" } },
      },
    },
    {
      data: d,
      hconcat: [
        { mark: "bar", encoding: enc },
        { mark: "point", encoding: enc },
      ],
    },
    {
      data: d,
      vconcat: [
        { mark: "bar", encoding: enc },
        { mark: "point", encoding: enc },
      ],
    },
    {
      data: d,
      layer: [
        { mark: "bar", encoding: enc },
        {
          mark: { type: "text", dy: -4 },
          encoding: { ...enc, text: { field: "n", format: ",.1f" } },
        },
        { mark: "rule", encoding: { y: { aggregate: "mean", field: "n" } } },
      ],
    },
    { data: d, mark: "boxplot", encoding: enc },
    { data: d, mark: "errorbar", encoding: enc },
    {
      data: d,
      mark: { type: "errorband", extent: "ci" },
      encoding: { x: { field: "t", type: "temporal" }, y: { field: "n", type: "quantitative" } },
    },
    {
      data: d,
      mark: { type: "arc", innerRadius: 40 },
      encoding: { theta: { field: "n", type: "quantitative", stack: true }, color: { field: "a" } },
    },
    {
      data: d,
      transform: [
        { window: [{ op: "rank", as: "r" }], sort: [{ field: "n", order: "descending" }] },
        { filter: "datum.r <= 5" },
        { joinaggregate: [{ op: "sum", field: "n", as: "tot" }] },
        { calculate: "datum.n/datum.tot", as: "p" },
      ],
      mark: "bar",
      encoding: {
        x: { field: "a" },
        y: { field: "p", type: "quantitative", axis: { format: ".0%" } },
      },
    },
    {
      data: d,
      layer: [
        { mark: "point", encoding: xy },
        { mark: "line", transform: [{ regression: "m", on: "n" }], encoding: xy },
      ],
    },
    {
      data: d,
      transform: [{ density: "n", groupby: ["a"] }],
      mark: "area",
      encoding: {
        x: { field: "value", type: "quantitative" },
        y: { field: "density", type: "quantitative" },
        color: { field: "a" },
      },
    },
    {
      data: d,
      transform: [{ quantile: "n", step: 0.01 }],
      mark: "point",
      encoding: {
        x: { field: "prob", type: "quantitative" },
        y: { field: "value", type: "quantitative" },
      },
    },
    {
      data: d,
      transform: [{ fold: ["n", "m"] }],
      mark: "bar",
      encoding: { x: { field: "key" }, y: { field: "value", type: "quantitative" } },
    },
    {
      data: d,
      transform: [{ pivot: "a", value: "n", groupby: ["t"], limit: 10 }],
      mark: "point",
      encoding: { x: { field: "t", type: "temporal" } },
    },
    {
      data: d,
      transform: [{ sample: 500 }, { extent: "n", param: "ext" }],
      mark: "point",
      encoding: xy,
    },
    {
      data: d,
      mark: "bar",
      encoding: {
        x: { field: "a", sort: "-y" },
        y: { field: "n", aggregate: "argmax", type: "quantitative" },
        tooltip: [
          { field: "a" },
          { field: "n", format: ".2f" },
          { field: "t", type: "temporal", timeUnit: "yearmonthdate" },
        ],
      },
    },
    {
      data: d,
      mark: { type: "bar", tooltip: true },
      encoding: {
        ...enc,
        x: { ...enc.x, axis: { labelExpr: "upper(datum.label)", labelAngle: -45 } },
        color: { field: "b", legend: { labelExpr: "datum.label + '!'", orient: "bottom" } },
      },
    },
    {
      data: d,
      mark: "tick",
      encoding: {
        x: { field: "n", type: "quantitative", scale: { type: "log" } },
        y: { field: "a" },
      },
    },
    {
      data: d,
      mark: "point",
      encoding: {
        x: { field: "t", type: "temporal", scale: { type: "utc" }, axis: { format: "%b %Y" } },
        y: { field: "n", type: "quantitative", scale: { zero: false } },
      },
    },
    {
      data: d,
      mark: "text",
      encoding: { text: { field: "t", type: "temporal", format: "%Y" }, x: { field: "a" } },
    },
    {
      data: d,
      params: [{ name: "cut", value: 5 }],
      transform: [{ filter: "datum.n > cut" }],
      mark: "bar",
      encoding: enc,
    },
    {
      data: d,
      params: [{ name: "k", expr: "2 * 3" }],
      mark: "bar",
      encoding: { ...enc, opacity: { value: { expr: "k / 10" } } },
    },
    {
      data: d,
      mark: "rect",
      encoding: {
        x: { field: "t", timeUnit: "date", type: "ordinal" },
        y: { field: "t", timeUnit: "month", type: "ordinal" },
        color: { field: "n", aggregate: "max", type: "quantitative", scale: { scheme: "viridis" } },
      },
    },
    {
      data: d,
      mark: "geoshape",
      projection: { type: "albersUsa" },
      encoding: { color: { field: "n", type: "quantitative" } },
    },
    {
      data: d,
      mark: "trail",
      encoding: {
        x: { field: "t", type: "temporal" },
        y: { field: "n", type: "quantitative" },
        size: { field: "m", type: "quantitative" },
      },
    },
    {
      data: d,
      transform: [
        { timeUnit: "yearmonth", field: "t", as: "ym" },
        { aggregate: [{ op: "mean", field: "n", as: "mn" }], groupby: ["ym"] },
        { lookup: "ym", from: { data: { name: "e" }, key: "ym", fields: ["x"] } },
      ],
      mark: "line",
      encoding: { x: { field: "ym", type: "temporal" }, y: { field: "mn", type: "quantitative" } },
    },
    {
      data: d,
      mark: "bar",
      encoding: { ...enc, color: { field: "a", type: "nominal", scale: null } },
    },
    {
      data: d,
      mark: "bar",
      encoding: {
        ...enc,
        color: { condition: { test: "datum.n > 3", value: "red" }, value: "grey" },
      },
    },
    { data: d, title: { text: "T", subtitle: "S" }, mark: "bar", encoding: enc },
    { data: d, mark: "bar", encoding: { ...enc, color: { field: "n", type: "quantitative" } } },
    { data: d, mark: "bar", encoding: { ...enc, x: { ...enc.x, title: ["Two", "lines"] } } },
  ];
})();

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
    await settle(120);
    const figure = element.querySelector("figure");
    assert.equal(figure.dataset.chartStatus, "rendered", figure.textContent);
    assert.deepEqual(references(figure.querySelector(".pages-chart-canvas svg")), []);
    const target = figure.querySelector(".pages-chart-canvas > div");
    target.style.cursor = `${probe}, auto`;
    assert.equal(target.style.cursor, "");
    target.style.cursor = "pointer";
    assert.equal(target.style.cursor, "pointer");
    chart.destroy();
    // Past the spec check, Vega-Lite's own data() can carry a row's value into
    // a font, a background or a cursor; the renderer still cleans them.
    const target2 = window.document.body.appendChild(window.document.createElement("div"));
    const view = await drawChart(target2, {
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
    view.finalize();
  }));

test("an expression that throws while the chart runs shows an error, not a drawn chart", () =>
  withWindow(async (window) => {
    const { element } = container(window);
    const chart = mount(element, {
      spec: { ...stacked, transform: [{ calculate: "datum.missing.x", as: "v" }] },
      datasets: { calls },
    });
    await settle(120);
    const figure = element.querySelector("figure");
    assert.equal(figure.dataset.chartStatus, "error");
    const message = figure.querySelector(".pages-chart-message").textContent;
    assert.match(message, /^This chart couldn't be drawn: .+\.$/);
    assert.doesNotMatch(message.slice(0, -1), /\.\s/);
    assert.equal(figure.querySelector(".pages-chart-canvas svg"), null);
    chart.destroy();
  }));

test("an error in a later run moves a drawn chart to its error state", () =>
  withWindow((window) =>
    countViews(async (views) => {
      const { element } = container(window);
      const chart = mount(element, {
        spec: {
          ...stacked,
          transform: [{ calculate: "datum.calls > 1000 ? datum.missing.x : 0", as: "v" }],
        },
        datasets: { calls },
      });
      await settle(120);
      const figure = element.querySelector("figure");
      assert.equal(figure.dataset.chartStatus, "rendered");
      const [view] = views.live;
      await view.insert("calls", [{ tool: "read_page", client: "Claude", calls: 5000 }]).runAsync();
      await settle(10);
      assert.equal(figure.dataset.chartStatus, "error");
      assert.match(
        figure.querySelector(".pages-chart-message").textContent,
        /^This chart couldn't be drawn: /,
      );
      assert.equal(figure.querySelector(".pages-chart-canvas svg"), null);
      assert.equal(views.live.size, 0);
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
  const script = `
    import { JSDOM } from "jsdom";
    const { window } = new JSDOM("<!doctype html><body></body>");
    globalThis.document = window.document;
    // jsdom's own selector engine compiles with Function: keep its
    // getComputedStyle and querySelector out of this process.
    window.getComputedStyle = () => ({ getPropertyValue: () => "", paddingLeft: "0" });
    const { mount } = await import(${JSON.stringify(chart)});
    const element = window.document.body.appendChild(window.document.createElement("div"));
    mount(element, {
      spec: ${JSON.stringify({ ...stacked, transform: [{ calculate: "datum.calls * 2", as: "double" }] })},
      datasets: { calls: ${JSON.stringify(calls)} },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const figure = element.firstElementChild;
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
    await settle();
    const figure = element.querySelector("figure");
    const point = element.querySelector(".pages-chart-canvas path[role='graphics-symbol']");
    point.dispatchEvent(
      new window.MouseEvent("pointermove", { bubbles: true, clientX: 5, clientY: 5 }),
    );
    await settle();
    assert.equal(figure.dataset.chartStatus, "rendered");
    assert.match(window.document.querySelector(".vg-tooltip")?.innerHTML ?? "", /toString/);
    chart.destroy();
  }));

// A draw that never returns blocks the event loop, so each runs in its own
// process with a timeout.
function drawInProcess(cases, timeout) {
  const chart = fileURLToPath(new URL("./vega-chart.mjs", import.meta.url));
  const script = `
    import { JSDOM } from "jsdom";
    const { window } = new JSDOM("<!doctype html><body></body>");
    globalThis.document = window.document;
    Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { get: () => 400 });
    const { mount } = await import(${JSON.stringify(chart)});
    const results = [];
    for (const { spec, rows } of ${JSON.stringify(cases)}) {
      const element = window.document.body.appendChild(window.document.createElement("div"));
      const chart = mount(element, { spec, datasets: { d: rows } });
      const figure = element.firstElementChild;
      for (let i = 0; i < 200 && figure.dataset.chartStatus === "drawing"; i++)
        await new Promise((resolve) => setTimeout(resolve, 25));
      results.push(figure.dataset.chartStatus);
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
    ],
  ];
  const run = drawInProcess(
    cases.map(([spec, data]) => ({ spec, rows: data })),
    30_000,
  );
  assert.equal(run.signal, null, `a draw hung: ${run.stderr.slice(-400)}`);
  assert.equal(run.status, 0, run.stderr.slice(-400));
  assert.deepEqual(
    JSON.parse(run.stdout),
    cases.map(([, , status]) => status),
  );
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
    await settle(200);
    assert.equal(element.querySelector("figure").dataset.chartStatus, "rendered");
    chart.destroy();
  }));

test("destroy empties the container even when Vega's finalize throws", () =>
  withWindow(async (window) => {
    const vega = globalThis.__vega;
    const { element } = container(window);
    const chart = mount(element, {
      spec: { ...stacked, mark: { type: "bar", tooltip: { content: "data" } } },
      datasets: { calls },
    });
    await settle();
    bars(element)[0].dispatchEvent(
      new window.MouseEvent("pointermove", { bubbles: true, clientX: 5, clientY: 5 }),
    );
    await settle();
    assert.ok(window.document.querySelector(".vg-tooltip"), "the tooltip exists before destroy");
    const { finalize } = vega.View.prototype;
    const reported = [];
    const { reportError } = window;
    window.reportError = (error) => reported.push(error);
    vega.View.prototype.finalize = () => {
      throw new Error("finalize broke");
    };
    try {
      chart.destroy();
    } finally {
      vega.View.prototype.finalize = finalize;
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

test("nested values count against the dataset's cell budget", () =>
  withWindow(async (window) => {
    const payload = Array(1_000_000).fill(1);
    const shared = Array.from({ length: 3 }, (_, i) => ({ ...calls[i], payload }));
    assert.match(
      await refusalIn(window, stacked, { calls: shared }),
      /has more than 2,000,000 cells \(rows × columns, nested values included\)/,
    );
    // One such row fits, and its tooltip stays bounded.
    const { element } = container(window);
    const chart = mount(element, {
      spec: { ...stacked, mark: { type: "bar", tooltip: { content: "data" } } },
      datasets: { calls: [{ ...calls[0], payload }] },
    });
    await settle(200);
    assert.equal(element.querySelector("figure").dataset.chartStatus, "rendered");
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
  }));

test("bin, kde and regression refuse derived values a chart can't draw", () =>
  withWindow(async (window) => {
    const rows = [
      { x: 0, g: "a" },
      { x: 1, g: "a" },
    ];
    const tiny = { calculate: "datum.x / 1e150 / 1e150 / 1e23", as: "tiny" };
    for (const spec of [
      {
        data: { name: "d" },
        transform: [tiny, { bin: { base: 2 }, field: "tiny", as: "b" }],
        mark: "point",
        encoding: { x: { field: "b", type: "quantitative" } },
      },
      {
        data: { name: "d" },
        transform: [tiny],
        mark: "bar",
        encoding: {
          x: { field: "tiny", type: "quantitative", bin: true },
          y: { aggregate: "count" },
        },
      },
      {
        data: { name: "d" },
        transform: [tiny, { density: "tiny" }],
        mark: "line",
        encoding: {
          x: { field: "value", type: "quantitative" },
          y: { field: "density", type: "quantitative" },
        },
      },
      {
        data: { name: "d" },
        transform: [
          tiny,
          { calculate: "datum.x", as: "y" },
          { regression: "y", on: "tiny", method: "poly" },
        ],
        mark: "line",
        encoding: {
          x: { field: "tiny", type: "quantitative" },
          y: { field: "y", type: "quantitative" },
        },
      },
    ]) {
      const { element } = container(window);
      const chart = mount(element, { spec, datasets: { d: rows } });
      await settle(100);
      const figure = element.querySelector("figure");
      assert.equal(figure.dataset.chartStatus, "error", JSON.stringify(spec.transform));
      assert.match(
        figure.querySelector(".pages-chart-message").textContent,
        /outside what a chart can draw/,
      );
      chart.destroy();
    }
  }));
