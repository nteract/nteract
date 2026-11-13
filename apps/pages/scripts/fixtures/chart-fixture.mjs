// The page scripts/chart-smoke.mjs draws: one Vega-Lite chart over a small
// dataset, in the Page's own stylesheets, with the renderer loaded as its own
// chunk the way a Page would load it. Built by the smoke into its output
// directory; never part of the viewer build.
import "../../../../src/styles/notebook-tokens.css";
import "../../viewer/wordgard.css";
import "../../viewer/style.css";

const calls = [
  { tool: "read_page", client: "Claude", calls: 312 },
  { tool: "read_page", client: "Codex", calls: 141 },
  { tool: "read_page", client: "ChatGPT", calls: 88 },
  { tool: "patch_page", client: "Claude", calls: 96 },
  { tool: "patch_page", client: "Codex", calls: 54 },
  { tool: "patch_page", client: "ChatGPT", calls: 12 },
  { tool: "list_pages", client: "Claude", calls: 61 },
  { tool: "list_pages", client: "Codex", calls: 40 },
  { tool: "list_pages", client: "ChatGPT", calls: 35 },
  { tool: "move_page", client: "Claude", calls: 18 },
  { tool: "move_page", client: "ChatGPT", calls: 6 },
];

const spec = {
  $schema: "https://vega.github.io/schema/vega-lite/v6.json",
  data: { name: "calls" },
  mark: "bar",
  encoding: {
    y: { field: "tool", type: "nominal", title: "Tool", sort: "-x" },
    x: { field: "calls", type: "quantitative", aggregate: "sum", title: "Calls" },
    color: { field: "client", type: "nominal", title: "Client" },
  },
};

const column = document.querySelector("#chart");
const { mount } = await import("../../viewer/vega-chart.mjs");
mount(column, { spec, datasets: { calls }, title: "Tool calls by client" });
document.body.dataset.fixture = "ready";
