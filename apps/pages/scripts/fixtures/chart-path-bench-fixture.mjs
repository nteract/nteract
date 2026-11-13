// Draws one scene through the page's renderer (vega-chart.mjs drawScene) and
// records how long it held the page, to first paint, in `window.benched`.
// The scene is chosen by the URL's `case`: the largest legitimate charts the
// budgets admit, and adversarial paths at the path command budgets
// (chart-scene.mjs). A case the budgets refuse records its error. Built by
// scripts/chart-path-bench.mjs; never part of the viewer build.
import { SCENE_PATH_COMMANDS } from "../../viewer/chart-scene.mjs";
import { drawScene } from "../../viewer/vega-chart.mjs";

const PER_PATH = SCENE_PATH_COMMANDS;

const frameOf = (marks) => ({
  marktype: "group",
  items: [{ x: 0, y: 0, width: 800, height: 500, items: marks }],
});
const path = (d, count = 1) =>
  frameOf([
    {
      marktype: "path",
      items: Array.from({ length: count }, () => ({ path: d, stroke: "black", strokeWidth: 1 })),
    },
  ]);
const vertex = (i) => `L${((i * 7.919) % 800).toFixed(2)},${((i * 1.04729) % 500).toFixed(2)}`;

export const CASES = {
  // Legitimate: the largest the budgets admit.
  points: () =>
    frameOf([
      {
        marktype: "symbol",
        items: Array.from({ length: 100_000 }, (_, i) => ({
          x: (i * 7.919) % 800,
          y: (i * 1.04729) % 500,
          size: 30,
          shape: "circle",
          fill: "steelblue",
        })),
      },
    ]),
  line: () =>
    frameOf([
      {
        marktype: "line",
        items: Array.from({ length: 100_000 }, (_, i) => ({
          x: (i / 100_000) * 800,
          y: 250 + 200 * Math.sin(i / 50),
          stroke: "black",
        })),
      },
    ]),
  geoshape: () => path(`M0,0${Array.from({ length: 100_000 }, (_, i) => vertex(i)).join("")}Z`),
  // Adversarial, at the command budgets: two paths at SCENE_PATH_COMMANDS
  // each, which together spend SCENE_BUDGET.pathCommands.
  lines: () => path(`M0,0L${".1.1".repeat(PER_PATH - 1)}`, 2),
  cubics: () => path(`M0,0C${".1.1.1.1.1.1".repeat(Math.floor((PER_PATH - 1) / 2))}`, 2),
  arcs: () => path(`M0,0${"a1 1 0 0 1 1 1".repeat(Math.floor((PER_PATH - 1) / 8))}`, 2),
  closes: () => path(`M0,0${"z".repeat(PER_PATH - 1)}`, 2),
  moves: () => path(`M${".1.1".repeat(PER_PATH)}`, 2),
};

const name = new URL(location.href).searchParams.get("case");
const scene = CASES[name]();
const target = document.querySelector("#chart");
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
await frame();
const started = performance.now();
let error = null;
try {
  drawScene(target, { scene, width: 800, height: 500, origin: [0, 0] });
} catch (caught) {
  error = caught.message;
}
const drawn = performance.now() - started;
await frame();
await frame();
window.benched = {
  error,
  drawMs: Math.round(drawn),
  paintMs: Math.round(performance.now() - started),
};
document.body.dataset.fixture = "ready";
