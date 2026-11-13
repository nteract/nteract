// Charts that never finish drawing, for scripts/chart-smoke.mjs: the
// round-four log-scale spec and a bin over a derived value, run in a Worker
// with every check and guard off (chart-worker-unguarded.mjs) and with the
// page's spec check skipped. Each must end in its error state within the
// timer while the page keeps painting. Built by the smoke; never part of the
// viewer build.
import "../../../../src/styles/notebook-tokens.css";
import "../../viewer/wordgard.css";
import "../../viewer/style.css";

const SPECS = {
  "log-base": {
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
  "derived-bin": {
    data: { name: "d" },
    transform: [
      { calculate: "datum.x / 1e150 / 1e150 / 1e23", as: "tiny" },
      { bin: { base: 2 }, field: "tiny", as: "b" },
    ],
    mark: "point",
    encoding: { x: { field: "b", type: "quantitative" } },
  },
};
const ROWS = { "log-base": [{ x: -1 }], "derived-bin": [{ x: 0 }, { x: 1 }] };

const { mount, setChartWorker, CHART_TIMEOUT_MS } = await import("../../viewer/vega-chart.mjs");
// Count the Workers the charts start and terminate.
window.chartWorkers = { started: 0, terminated: 0 };
setChartWorker(
  () => {
    const worker = new Worker("/unguarded-worker.js", { name: "chart" });
    window.chartWorkers.started++;
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => {
      window.chartWorkers.terminated++;
      terminate();
    };
    return worker;
  },
  { checkSpec: false },
);

// Frames painted while the Workers hang: the page's own thread stays free.
let frames = 0;
const tick = () => {
  frames++;
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
window.chartFrames = () => frames;
window.chartTimeout = CHART_TIMEOUT_MS;

const root = document.querySelector("#charts");
for (const [name, spec] of Object.entries(SPECS)) {
  const cell = root.appendChild(document.createElement("section"));
  cell.dataset.case = name;
  mount(cell, { spec, datasets: { d: ROWS[name] }, title: name });
}
document.body.dataset.started = String(performance.now());
document.body.dataset.fixture = "ready";
