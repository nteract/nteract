// The largest chart the budgets admit, for scripts/chart-smoke.mjs to time
// through the real chart Worker: 100,000 rows of 20 columns (2,000,000
// cells) aggregated into bars, and drawn as 100,000 points. The bars go first:
// laying out 100,000 SVG points holds the page's thread for seconds in some
// engines, which would land on the next chart's time.
// Built by the smoke; never part of the viewer build.
import "../../../../src/styles/notebook-tokens.css";
import "../../viewer/wordgard.css";
import "../../viewer/style.css";

const rows = Array.from({ length: 100_000 }, (_, i) => {
  const row = { x: (i * 7919) % 1000, y: (i * 104729) % 977, group: `g${i % 12}` };
  for (let c = 0; c < 17; c++) row[`c${c}`] = (i + c) % 101;
  return row;
});
const SPECS = {
  bars: {
    data: { name: "d" },
    mark: "bar",
    encoding: {
      x: { field: "group", type: "nominal" },
      y: { field: "y", type: "quantitative", aggregate: "mean" },
    },
  },
  points: {
    data: { name: "d" },
    mark: "point",
    encoding: {
      x: { field: "x", type: "quantitative" },
      y: { field: "y", type: "quantitative" },
      color: { field: "group", type: "nominal" },
    },
  },
};

const { mount } = await import("../../viewer/vega-chart.mjs");
const root = document.querySelector("#charts");
window.chartTimes = {};
for (const [name, spec] of Object.entries(SPECS)) {
  const cell = root.appendChild(document.createElement("section"));
  cell.dataset.case = name;
  const started = performance.now();
  mount(cell, { spec, datasets: { d: rows }, title: name });
  const figure = cell.querySelector("figure");
  await new Promise((resolve) => {
    const done = () => {
      if (figure.dataset.chartStatus === "drawing") return;
      window.chartTimes[name] = {
        status: figure.dataset.chartStatus,
        ms: Math.round(performance.now() - started),
        message: figure.querySelector(".pages-chart-message")?.textContent ?? "",
      };
      observer.disconnect();
      resolve();
    };
    const observer = new MutationObserver(done);
    observer.observe(figure, { attributes: true, attributeFilter: ["data-chart-status"] });
    done();
  });
}

// A chart whose long left-axis labels and title push Vega's layout origin
// off the padding: every label and title must land inside the SVG.
const labels = root.appendChild(document.createElement("section"));
labels.dataset.case = "labels";
mount(labels, {
  spec: {
    data: { name: "d" },
    title: "Calls by tool, with a title wide enough to need its own room",
    mark: "bar",
    encoding: {
      y: { field: "tool", type: "nominal", title: "A left axis title" },
      x: { field: "n", type: "quantitative", title: "Calls" },
    },
  },
  datasets: {
    d: [
      { tool: "a fairly long tool name, number one", n: 3 },
      { tool: "another quite long tool name", n: 5 },
    ],
  },
  title: "labels",
});
const labelFigure = labels.querySelector("figure");
while (labelFigure.dataset.chartStatus === "drawing") await new Promise((r) => setTimeout(r, 25));
const svg = labels.querySelector(".pages-chart-canvas svg");
const box = svg?.getBoundingClientRect();
const texts = svg ? [...svg.querySelectorAll("text")] : [];
window.chartLabels = {
  status: labelFigure.dataset.chartStatus,
  count: texts.length,
  outside: texts
    .filter((text) => {
      const rect = text.getBoundingClientRect();
      return (
        rect.width > 0 &&
        (rect.left < box.left - 1 ||
          rect.right > box.right + 1 ||
          rect.top < box.top - 1 ||
          rect.bottom > box.bottom + 1)
      );
    })
    .map((text) => text.textContent),
};
document.body.dataset.fixture = "ready";
