import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const {
  drawChart,
  mount,
  sourceRows,
  sizedSpec,
  themeConfig,
  deniedLoader,
  chartTooltip,
  RESIZE_SETTLE_MS,
} = await import("./vega-chart.mjs");

const theme = { dark: false, text: "#111", muted: "#555", line: "#ddd", font: "sans-serif" };
const usage = {
  columns: ["client", "tool", "calls", "refused"],
  rows: [
    { client: "Claude", tool: "patch_page", calls: 80, refused: 20 },
    { client: "Codex", tool: "patch_page", calls: 20, refused: 2 },
    { client: "Claude", tool: "read_page", calls: 300, refused: 3 },
    { client: "Claude", tool: "move_page", calls: 30, refused: 11 },
  ],
};
const refusalRate = {
  data: { name: "usage_by_tool" },
  transform: [
    {
      aggregate: [
        { op: "sum", field: "calls", as: "calls" },
        { op: "sum", field: "refused", as: "refused" },
      ],
      groupby: ["tool"],
    },
    { calculate: "datum.refused / datum.calls", as: "refusal_rate" },
  ],
  mark: { type: "bar" },
  encoding: {
    x: { field: "tool", type: "nominal", sort: "-y" },
    y: { field: "refusal_rate", type: "quantitative" },
  },
};

function withWindow(run) {
  // Vega's SVG renderer creates elements through the global document.
  const { window } = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
  const previous = globalThis.document;
  globalThis.document = window.document;
  return Promise.resolve(run(window)).finally(() => {
    globalThis.document = previous;
    window.close();
  });
}

test("a spec over a named source draws one mark per group and reports its sources", () =>
  withWindow(async (window) => {
    const element = window.document.createElement("div");
    const asked = [];
    const report = await drawChart(element, {
      spec: refusalRate,
      theme,
      width: 480,
      resolveSource: async (name) => (asked.push(name), usage),
    });
    assert.equal(report.status, "rendered", report.error);
    assert.deepEqual(asked, ["usage_by_tool"]);
    assert.deepEqual(report.sources, { usage_by_tool: { rows: 4, columns: usage.columns } });
    assert.deepEqual(report.warnings, []);
    assert.equal(element.querySelectorAll("path[role='graphics-symbol']").length, 3);
    report.view.finalize();
  }));

test("the report carries the source version the resolver drew from", () =>
  withWindow(async (window) => {
    const version = { source_id: "src_usage", asset_id: "a".repeat(64), source_revision: "r3" };
    const report = await drawChart(window.document.createElement("div"), {
      spec: refusalRate,
      theme,
      resolveSource: async () => ({ table: usage, ...version }),
    });
    assert.deepEqual(report.sources.usage_by_tool, { ...version, rows: 4, columns: usage.columns });
    report.view.finalize();
  }));

test("a chart reads a resolver's table, releases it, and leaves freeing it to the resolver", () =>
  withWindow(async (window) => {
    let freed = 0;
    let released = 0;
    const table = {
      columns: usage.columns.map((key) => ({ key })),
      rowCount: usage.rows.length,
      getCellRaw: (r, c) => usage.rows[r][usage.columns[c]],
      dispose: () => freed++,
    };
    const report = await drawChart(window.document.createElement("div"), {
      spec: refusalRate,
      theme,
      resolveSource: async () => ({ table, asset_id: "a".repeat(64), release: () => released++ }),
    });
    assert.equal(report.status, "rendered", report.error);
    assert.equal(freed, 0);
    assert.equal(released, 1);
    report.view.finalize();
  }));

test("mount redraws at a new width once a resize settles", () =>
  withWindow(async (window) => {
    let width = 600;
    let notify;
    window.ResizeObserver = class {
      constructor(callback) {
        notify = callback;
      }
      observe() {}
      disconnect() {}
    };
    const container = window.document.body.appendChild(window.document.createElement("div"));
    Object.defineProperty(container, "clientWidth", { get: () => width });
    const reports = [];
    const chart = mount(container, {
      spec: refusalRate,
      resolveSource: async () => usage,
      onReport: (report) => reports.push(report),
    });
    const svgWidth = () => Number(container.querySelector("svg").getAttribute("width"));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const wide = svgWidth();
    width = 340;
    notify();
    width = 320;
    notify();
    await new Promise((resolve) => setTimeout(resolve, RESIZE_SETTLE_MS + 120));
    assert.equal(reports.length, 2);
    assert.ok(svgWidth() < wide && svgWidth() <= 330, `${wide} -> ${svgWidth()}`);
    chart.destroy();
  }));

test("a misspelled field still draws, with a warning that names it", () =>
  withWindow(async (window) => {
    const spec = structuredClone(refusalRate);
    spec.encoding.x.field = "misspelled_field";
    const report = await drawChart(window.document.createElement("div"), {
      spec,
      theme,
      resolveSource: async () => usage,
    });
    assert.equal(report.status, "rendered");
    assert.ok(
      report.warnings.some((w) => w.includes('"misspelled_field"')),
      report.warnings.join("\n"),
    );
    report.view.finalize();
  }));

test("a spec with a URL is refused before any source is read", () =>
  withWindow(async (window) => {
    let read = false;
    const report = await drawChart(window.document.createElement("div"), {
      spec: { data: { url: "https://example.com/x.csv" }, mark: "bar" },
      theme,
      resolveSource: async () => ((read = true), usage),
    });
    assert.equal(report.status, "error");
    assert.equal(read, false);
    assert.match(report.problems.join(" "), /not a URL/);
  }));

test("an image mark's URLs go to the denied loader, never the network", () =>
  withWindow(async (window) => {
    const fetched = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => (fetched.push(String(url)), new Response(""));
    try {
      const report = await drawChart(window.document.createElement("div"), {
        spec: {
          data: { name: "pics" },
          mark: { type: "image", width: 20, height: 20 },
          encoding: {
            x: { field: "n", type: "ordinal" },
            url: { field: "src", type: "nominal" },
            href: { field: "src", type: "nominal" },
          },
        },
        theme,
        resolveSource: async () => ({
          columns: ["n", "src"],
          rows: [{ n: 1, src: "https://tracker.example/pixel.png" }],
        }),
      });
      assert.equal(report.status, "rendered", report.error);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(fetched, []);
      report.view.finalize();
    } finally {
      globalThis.fetch = realFetch;
    }
    await assert.rejects(deniedLoader.sanitize("https://tracker.example/pixel.png", {}));
  }));

test("a source that fails reports the error", () =>
  withWindow(async (window) => {
    const report = await drawChart(window.document.createElement("div"), {
      spec: refusalRate,
      theme,
      resolveSource: async () => {
        throw Error("This dataset isn't stored on this Page.");
      },
    });
    assert.deepEqual(
      { status: report.status, error: report.error },
      { status: "error", error: "This dataset isn't stored on this Page." },
    );
  }));

test("sourceRows reads a Sift table in prefetched batches", () => {
  const prefetched = [];
  const table = {
    columns: [{ key: "tool" }, { key: "calls" }],
    rowCount: 3,
    prefetchViewport: (rows) => prefetched.push(rows),
    getCellRaw: (r, c) => (c === 0 ? `t${r}` : r * 10),
  };
  assert.deepEqual(sourceRows(table), {
    columns: ["tool", "calls"],
    rows: [
      { tool: "t0", calls: 0 },
      { tool: "t1", calls: 10 },
      { tool: "t2", calls: 20 },
    ],
  });
  assert.deepEqual(prefetched, [[0, 1, 2]]);
});

test("a single view fills the width it's given; a composite sizes itself", () => {
  assert.deepEqual(sizedSpec({ mark: "bar" }, 500), {
    mark: "bar",
    width: 500,
    height: 260,
    autosize: { type: "fit-x", contains: "padding" },
  });
  const composite = { hconcat: [{ mark: "bar" }] };
  assert.equal(sizedSpec(composite, 500), composite);
  assert.equal(sizedSpec({ mark: "bar", width: 200 }, 500).width, 200);
});

test("every mark shows its encoded fields on hover unless the spec turns it off", () => {
  assert.deepEqual(themeConfig(theme).mark.tooltip, { content: "encoding" });
});

test("the tooltip lists each field as text and hides when the pointer leaves", () =>
  withWindow((window) => {
    const doc = window.document;
    const tooltip = chartTooltip(doc);
    const event = { clientX: 10, clientY: 20 };
    tooltip.handler(null, event, {}, { tool: "<b>patch_page</b>", "Refusal rate": "22%" });
    const tip = doc.querySelector(".pages-chart-tooltip");
    assert.equal(tip.hidden, false);
    assert.equal(tip.getAttribute("role"), "tooltip");
    assert.deepEqual(
      [...tip.querySelectorAll(".pages-chart-tooltip-row")].map((row) => row.textContent),
      ["tool<b>patch_page</b>", "Refusal rate22%"],
    );
    assert.equal(tip.querySelector("b"), null);
    tooltip.handler(null, event, {}, null);
    assert.equal(tip.hidden, true);
    tooltip.destroy();
    assert.equal(doc.querySelector(".pages-chart-tooltip"), null);
  }));

test("dark and light themes use the same hues, stepped for their surface", () => {
  const light = themeConfig(theme).range.category;
  const dark = themeConfig({ ...theme, dark: true }).range.category;
  assert.equal(light.length, 8);
  assert.equal(dark.length, 8);
  assert.notDeepEqual(light, dark);
});

test("mount drops a slow earlier render when a newer spec arrives", () =>
  withWindow(async (window) => {
    const container = window.document.body.appendChild(window.document.createElement("div"));
    let releaseFirst;
    const first = new Promise((resolve) => (releaseFirst = resolve));
    let calls = 0;
    const reports = [];
    const chart = mount(container, {
      spec: refusalRate,
      resolveSource: () => (++calls === 1 ? first : Promise.resolve(usage)),
      onReport: (report) => reports.push(report),
    });
    const titled = { ...refusalRate, title: "Refusal rate by tool" };
    chart.update(titled);
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseFirst(usage);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(reports.length, 1);
    assert.equal(reports[0].status, "rendered");
    assert.equal(container.dataset.chartStatus, "rendered");
    assert.ok(container.textContent.includes("Refusal rate by tool"));
    chart.destroy();
    assert.equal(container.children.length, 0);
  }));

test("Vega draws with string code generation disabled, as under the viewer CSP", () => {
  const chart = fileURLToPath(new URL("./vega-chart.mjs", import.meta.url));
  const script = `
    import { JSDOM } from "jsdom";
    const { drawChart } = await import(${JSON.stringify(chart)});
    const { window } = new JSDOM("<!doctype html><body></body>");
    globalThis.document = window.document;
    const report = await drawChart(window.document.createElement("div"), {
      spec: ${JSON.stringify(refusalRate)},
      theme: ${JSON.stringify(theme)},
      resolveSource: async () => (${JSON.stringify(usage)}),
    });
    process.stdout.write(JSON.stringify({ status: report.status, error: report.error }));
  `;
  const run = spawnSync(
    process.execPath,
    ["--disallow-code-generation-from-strings", "--input-type=module", "-e", script],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { status: "rendered" });
});
