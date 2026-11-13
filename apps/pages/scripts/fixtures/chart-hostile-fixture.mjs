// Charts whose spec or data carries a CSS url() in every position that could
// reach a style, drawn three ways, for scripts/chart-smoke.mjs to hover while
// it watches the network:
// - "mount": the full renderer, spec checks and the chart Worker included.
// - "draw": the Worker's run in this page with the spec check off, then the
//   page's drawing, so the compiled-dataflow check and the cleaning SVG
//   renderer are what stand.
// - "raw": Vega with the interpreter, the denied loader and its stock SVG
//   renderer, as the renderer drew before it cleaned items. Its requests are
//   the baseline: what each engine fetches when nothing cleans a style.
// Every probe URL names its layer and position, so a request says which one
// leaked. Built by the smoke; never part of the viewer build.
import "../../../../src/styles/notebook-tokens.css";
import "../../viewer/wordgard.css";
import "../../viewer/style.css";

const PROBE = "https://probe.invalid";
const probe = (layer, position) => `url(${PROBE}/${layer}/${position}.svg#paint)`;
const base = {
  data: { name: "d" },
  mark: "bar",
  encoding: {
    y: { field: "tool", type: "nominal" },
    x: { field: "calls", type: "quantitative" },
  },
  width: 220,
};
const text = (font) => ({
  ...base,
  mark: { type: "text", font },
  encoding: { ...base.encoding, text: { field: "tool" } },
});

// Each position: the spec, and the extra fields its rows carry.
const POSITIONS = {
  "fill-literal": (u) => ({ ...base, mark: { type: "bar", fill: u } }),
  "stroke-literal": (u) => ({ ...base, mark: { type: "bar", stroke: u, strokeWidth: 4 } }),
  "color-value": (u) => ({ ...base, encoding: { ...base.encoding, color: { value: u } } }),
  "gradient-stop": (u) => ({
    ...base,
    mark: {
      type: "bar",
      fill: {
        gradient: "linear",
        stops: [
          { offset: 0, color: u },
          { offset: 1, color: "red" },
        ],
      },
    },
  }),
  "cursor-literal": (u) => ({ ...base, mark: { type: "bar", cursor: `${u}, auto` } }),
  "cursor-expr": (u) => ({ ...base, mark: { type: "bar", cursor: { expr: `'${u}, auto'` } } }),
  "font-literal": (u) => text(u),
  "config-style": (u) => ({
    ...base,
    mark: { type: "bar", style: "hostile" },
    config: { style: { hostile: { fill: u } } },
  }),
  background: (u) => ({ ...base, background: u }),
  "view-stroke": (u) => ({ ...base, config: { view: { stroke: u, strokeWidth: 3 } } }),
  "axis-color": (u) => ({ ...base, config: { axis: { domainColor: u, gridColor: u } } }),
  "title-color": (u) => ({
    ...base,
    title: { text: "Calls", color: u, subtitle: "by tool", subtitleColor: u },
  }),
  "legend-colors": (u) => ({
    ...base,
    encoding: {
      ...base.encoding,
      color: {
        field: "tool",
        type: "nominal",
        legend: {
          fillColor: u,
          strokeColor: u,
          labelColor: u,
          titleColor: u,
          symbolStrokeColor: u,
        },
      },
    },
  }),
  "header-color": (u) => ({
    data: { name: "d" },
    facet: { row: { field: "tool", type: "nominal", header: { labelColor: u, titleColor: u } } },
    spec: { mark: "bar", encoding: base.encoding, width: 220 },
  }),
  "axis-text-color": (u) => ({
    ...base,
    config: { axis: { labelColor: u, titleColor: u, tickColor: u } },
  }),
  "scale-range": (u) => ({
    ...base,
    encoding: {
      ...base.encoding,
      color: { field: "tool", type: "nominal", scale: { range: [u, "red"] } },
    },
  }),
  "rule-stroke": (u) => ({ ...base, mark: { type: "rule", stroke: u, strokeWidth: 4 } }),
  "text-fill-literal": (u) => ({
    ...base,
    mark: { type: "text", color: u },
    encoding: { ...base.encoding, text: { field: "tool" } },
  }),
  "view-fill": (u) => ({ ...base, config: { view: { fill: u } } }),
  "config-mark": (u) => ({ ...base, config: { mark: { color: u }, bar: { fill: u } } }),
  "fill-data": () => ({
    ...base,
    encoding: { ...base.encoding, fill: { field: "paint", type: "nominal", scale: null } },
  }),
  "stroke-data": () => ({
    ...base,
    mark: { type: "bar", strokeWidth: 4 },
    encoding: { ...base.encoding, stroke: { field: "paint", type: "nominal", scale: null } },
  }),
  "gradient-data": () => ({
    ...base,
    encoding: { ...base.encoding, fill: { field: "grad", type: "nominal", scale: null } },
  }),
  "text-fill-data": () => ({
    ...base,
    mark: "text",
    encoding: {
      ...base.encoding,
      text: { field: "tool" },
      fill: { field: "paint", type: "nominal", scale: null },
    },
  }),
  "cursor-data": () => ({ ...base, mark: { type: "bar", cursor: { expr: "data('d')[0].cur" } } }),
  "font-data": () => text({ expr: "data('d')[0].paint" }),
  "background-data": () => ({ ...base, background: { expr: "data('d')[0].paint" } }),
};

const rowsFor = (u) =>
  ["read_page", "patch_page"].map((tool, i) => ({
    tool,
    calls: 10 + i * 5,
    paint: u,
    cur: `${u}, auto`,
    grad: {
      gradient: "linear",
      stops: [
        { offset: 0, color: u },
        { offset: 1, color: "red" },
      ],
    },
  }));

const { mount, drawScene, pageTheme } = await import("../../viewer/vega-chart.mjs");
const { runChart, deniedLoader } = await import("../../viewer/chart-dataflow.mjs");
const { datasetRows } = await import("../../viewer/chart-data.mjs");
const [vega, vl, { expressionInterpreter }] = await Promise.all([
  import("vega"),
  import("vega-lite"),
  import("vega-interpreter"),
]);

const root = document.querySelector("#charts");
const outcomes = [];
for (const layer of ["mount", "draw", "raw"])
  for (const [position, make] of Object.entries(POSITIONS)) {
    const u = probe(layer, position);
    const spec = make(u);
    const rows = rowsFor(u);
    const cell = root.appendChild(document.createElement("section"));
    cell.dataset.layer = layer;
    cell.dataset.position = position;
    const outcome = { layer, position, status: "drawn" };
    try {
      if (layer === "mount") {
        mount(cell, { spec, datasets: { d: rows }, title: `${layer} ${position}` });
        const figure = cell.querySelector("figure");
        for (let i = 0; i < 500 && figure.dataset.chartStatus === "drawing"; i++)
          await new Promise((resolve) => setTimeout(resolve, 20));
        outcome.status = figure.dataset.chartStatus;
      } else if (layer === "draw") {
        const target = cell.appendChild(document.createElement("div"));
        const result = await runChart(
          { spec, data: { d: datasetRows(rows) }, theme: pageTheme(cell), width: 220 },
          { checkSpec: false },
        );
        drawScene(target, result, () => {});
      } else {
        const target = cell.appendChild(document.createElement("div"));
        const view = new vega.View(vega.parse(vl.compile(spec).spec, null, { ast: true }), {
          expr: expressionInterpreter,
          loader: deniedLoader,
          renderer: "svg",
          container: target,
          hover: true,
        });
        view.data("d", rows);
        await view.runAsync();
      }
    } catch (error) {
      outcome.status = `refused: ${error.message}`;
    }
    cell.dataset.status = outcome.status;
    outcomes.push(outcome);
  }
document.body.dataset.outcomes = JSON.stringify(outcomes);
document.body.dataset.fixture = "ready";
