// Draws every corpus spec, plus an Arrow IPC dataset, a tooltip, a gradient
// legend, a geoshape, a refusal and a bad dataset, through the recording
// Worker (chart-worker-recorder.mjs), and keeps the names it read in
// `window.recorded`. Built by the smoke; never part of the viewer build.
import { tableFromJSON, tableToIPC } from "apache-arrow";
import { checkChartSpec } from "../../shared/chart-spec.mjs";
import { CORPUS, corpusRows } from "../../test/chart-corpus.mjs";

const worker = new Worker("/recorder-worker.js", { name: "recorder" });
const answers = new Map();
worker.addEventListener("message", ({ data }) => answers.get(data?.id ?? data?.type)?.(data));
const ask = (key, message) =>
  new Promise((resolve) => {
    answers.set(key, resolve);
    worker.postMessage(message);
  });
await new Promise((resolve) => answers.set("ready", resolve));

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
const extra = [
  [
    {
      data: { name: "d" },
      mark: { type: "point", tooltip: { content: "data" } },
      encoding: { x: { field: "n", type: "quantitative" } },
    },
    { d: { rows: corpusRows } },
  ],
  [
    {
      data: { name: "d" },
      mark: "rect",
      encoding: { x: { field: "a", type: "nominal" }, color: { field: "n", type: "quantitative" } },
    },
    { d: { ipc: tableToIPC(tableFromJSON(corpusRows)) } },
  ],
  [
    {
      data: { name: "d" },
      mark: "geoshape",
      projection: { type: "mercator" },
      encoding: { color: { field: "properties.n", type: "quantitative" } },
    },
    { d: { rows: [square(0), square(2)] } },
  ],
  [
    {
      data: { name: "d" },
      mark: "bar",
      params: [{ name: "p", select: "point" }],
      encoding: { x: { field: "a", type: "nominal" } },
    },
    { d: { rows: corpusRows } },
  ],
  [
    { data: { name: "d" }, mark: "bar", encoding: { x: { field: "a", type: "nominal" } } },
    { d: { rows: [{ payload: Array(3_000_000).fill(1) }] } },
  ],
];
let id = 0;
const statuses = [];
for (const spec of CORPUS) {
  const { names } = checkChartSpec(spec);
  const datasets = Object.fromEntries(names.map((name) => [name, { rows: corpusRows }]));
  for (const theme of ["light", "dark"]) {
    const answer = await ask(++id, {
      type: "draw",
      id,
      key: `c${id}`,
      spec,
      theme,
      width: 400,
      datasets,
    });
    statuses.push(answer.error ? `error: ${answer.error.message}` : "drawn");
  }
}
for (const [spec, datasets] of extra) {
  const answer = await ask(++id, {
    type: "draw",
    id,
    key: `x${id}`,
    spec,
    theme: "light",
    width: 400,
    datasets,
  });
  statuses.push(answer.error ? `error: ${answer.error.message}` : "drawn");
}
window.recorded = { names: (await ask("recorded", { type: "recorded" })).names, statuses };
document.body.dataset.fixture = "ready";
