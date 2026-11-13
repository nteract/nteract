// Charts whose text Vega lays out by measured width: a long title, axis
// titles longer than their axes, long axis labels it truncates on a crowded
// band axis, a continuous axis whose labels it thins, and a legend whose
// labels it truncates. For each
// drawn chart, in light and dark and at a wide and a phone width, the page
// records each text's drawn width and the width the chart Worker's own text
// metrics give for it (chart-worker-metrics.mjs), in `window.chartMetrics`.
// Built by scripts/chart-smoke.mjs; never part of the viewer build.
import "../../../../src/styles/notebook-tokens.css";
import "../../viewer/wordgard.css";
import "../../viewer/style.css";

const { mount } = await import("../../viewer/vega-chart.mjs");
const SPECS = {
  title: {
    spec: {
      data: { name: "d" },
      title: "Calls by tool, with a title wide enough to need its own room",
      mark: "bar",
      encoding: {
        y: { field: "tool", type: "nominal", title: "A left axis title" },
        x: { field: "n", type: "quantitative", title: "Calls" },
      },
    },
    rows: [
      { tool: "a fairly long tool name, number one", n: 3 },
      { tool: "another quite long tool name", n: 5 },
    ],
  },
  crowded: {
    spec: {
      data: { name: "d" },
      mark: "bar",
      encoding: {
        x: { field: "tool", type: "nominal" },
        y: { field: "n", type: "quantitative" },
      },
    },
    rows: Array.from({ length: 40 }, (_, i) => ({
      tool: `a long category name that runs past the axis label limit, number ${i}`,
      n: (i * 7) % 13,
    })),
  },
  // A y-axis title longer than the chart is tall, and an x-axis title
  // longer than it is wide.
  axisTitles: {
    spec: {
      data: { name: "d" },
      mark: "bar",
      encoding: {
        y: {
          field: "tool",
          type: "nominal",
          title: "A y-axis title much longer than this short chart is tall, by a wide margin",
        },
        x: {
          field: "n",
          type: "quantitative",
          title:
            "An x-axis title that runs well past the width of a phone, and keeps going past a wide chart too, on and on",
        },
      },
    },
    rows: [
      { tool: "read", n: 3 },
      { tool: "edit", n: 5 },
    ],
  },
  // A continuous axis whose labels Vega thins by their measured width.
  thinned: {
    spec: {
      data: { name: "d" },
      mark: "point",
      encoding: {
        x: { field: "n", type: "quantitative", axis: { format: ",.4f", tickCount: 30 } },
        y: { field: "m", type: "quantitative" },
      },
    },
    rows: Array.from({ length: 20 }, (_, i) => ({ n: i * 52_631_579, m: i })),
  },
  legend: {
    spec: {
      data: { name: "d" },
      mark: "bar",
      encoding: {
        x: { field: "tool", type: "nominal" },
        y: { field: "n", type: "quantitative" },
        color: { field: "client", type: "nominal" },
      },
    },
    rows: Array.from({ length: 6 }, (_, i) => ({
      tool: `t${i}`,
      n: i + 1,
      client: `a client name long enough for the legend to cut it short, ${i}`,
    })),
  },
};

const metrics = new Worker("/metrics-worker.js");
const measure = (items) =>
  new Promise((resolve) => {
    const answer = ({ data }) => {
      if (data?.type !== "measured") return;
      metrics.removeEventListener("message", answer);
      resolve(data.widths);
    };
    metrics.addEventListener("message", answer);
    metrics.postMessage({ type: "measure", items });
  });

const root = document.querySelector("#charts");
const until = async (check) => {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
};
/** Each text of `role` in `svg`, as Vega's text item and its drawn width. */
const texts = (svg, role) =>
  [...svg.querySelectorAll(`.role-${role} text`)]
    // Vega's overlap pass hides a label by its opacity.
    .filter((text) => text.textContent && text.getAttribute("opacity") !== "0")
    .map((text) => {
      const box = text.getBoundingClientRect();
      return {
        role,
        text: text.textContent,
        item: {
          font: text.getAttribute("font-family"),
          fontSize: Number.parseFloat(text.getAttribute("font-size")),
          fontWeight: text.getAttribute("font-weight") ?? undefined,
          fontStyle: text.getAttribute("font-style") ?? undefined,
        },
        drawn: text.getComputedTextLength(),
        box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
      };
    });

const charts = [];
for (const width of [480, 340])
  for (const [name, { spec, rows }] of Object.entries(SPECS)) {
    const cell = root.appendChild(document.createElement("section"));
    cell.style.width = `${width}px`;
    mount(cell, { spec, datasets: { d: rows }, title: name });
    charts.push({ name, width, cell });
  }

const labelFill = (cell) =>
  cell.querySelector(".pages-chart-canvas svg .role-axis-label text")?.getAttribute("fill");
window.chartMetrics = [];
for (const dark of [false, true]) {
  document.documentElement.classList.toggle("dark", dark);
  for (const chart of charts) {
    const { name, width, cell } = chart;
    const figure = cell.querySelector("figure");
    // A theme change redraws: wait for labels in a new color.
    await until(
      () =>
        figure.dataset.chartStatus !== "drawing" &&
        labelFill(cell) &&
        labelFill(cell) !== chart.lightFill,
    );
    if (!dark) chart.lightFill = labelFill(cell);
    const svg = cell.querySelector(".pages-chart-canvas svg");
    const box = svg.getBoundingClientRect();
    const found = [
      ...texts(svg, "title-text"),
      ...texts(svg, "axis-label"),
      ...texts(svg, "axis-title"),
      ...texts(svg, "legend-label"),
    ];
    const widths = await measure(found.map(({ item, text }) => ({ item, text })));
    window.chartMetrics.push({
      name,
      width,
      dark,
      status: figure.dataset.chartStatus,
      pageFont: getComputedStyle(document.body).fontFamily,
      fonts: [
        ...new Set(
          [...svg.querySelectorAll("text")].map((text) => text.getAttribute("font-family")),
        ),
      ],
      svg: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
      texts: found.map((found, index) => ({ ...found, measured: widths[index] })),
    });
  }
}
document.body.dataset.fixture = "ready";
