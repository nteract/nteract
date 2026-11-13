import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tableFromJSON } from "apache-arrow";
import { JSDOM } from "jsdom";
import * as vega from "vega";

const {
  mount,
  drawChart,
  datasetRows,
  sizedSpec,
  themeConfig,
  deniedLoader,
  formatTooltip,
  RESIZE_SETTLE_MS,
} = await import("./vega-chart.mjs");

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
    assert.deepEqual(datasetRows(table), calls);
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
  assert.deepEqual(copy, [{ a: 1, n: 2, nested: { big: 3 } }]);
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
      assert.equal(views.live.size, 0);
      assert.equal(element.children.length, 0);
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
        /can't call modify\(\)/,
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

test("Vega's loader refuses every URL, even past the spec checks", () =>
  withWindow(async (window) => {
    const fetched = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => (fetched.push(String(url)), new Response(""));
    try {
      const view = await drawChart(window.document.createElement("div"), {
        spec: {
          data: { name: "pics" },
          mark: { type: "image", width: 20, height: 20 },
          encoding: {
            x: { field: "n", type: "ordinal" },
            url: { field: "src", type: "nominal" },
            href: { field: "src", type: "nominal" },
          },
        },
        data: { pics: [{ n: 1, src: "https://tracker.example/pixel.png" }] },
        theme,
        width: 300,
      });
      await settle(20);
      assert.deepEqual(fetched, []);
      view.finalize();
    } finally {
      globalThis.fetch = realFetch;
    }
    for (const method of ["load", "sanitize", "http", "file"])
      await assert.rejects(deniedLoader[method]("https://tracker.example/pixel.png", {}));
  }));

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
