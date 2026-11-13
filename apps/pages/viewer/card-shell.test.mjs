import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { JSDOM } from "jsdom";
import { createPageData, initializePage } from "../model/page.mjs";
import { firstScreenSpans, shellBlocks, viewSettled } from "./card-shell.mjs";
import { VIEW_EMBED_STATUS, VIEW_EMBED_UNAVAILABLE } from "./wordgard-views.mjs";

const page = (markdown) =>
  A.change(
    A.from(createPageData({ pageId: "11111111-1111-4111-8111-111111111111", title: "T" })),
    (d) => initializePage(d, markdown),
  );
const topLevel = (spans) =>
  spans.filter((span) => span.type === "block" && !(span.value?.parents?.length > 0)).length;

test("the shell renders the card's blocks, cut to the first screen's nodes", () => {
  const doc = page(Array.from({ length: 60 }, (_, i) => `Paragraph ${i}`).join("\n\n"));
  const blocks = shellBlocks(doc);
  assert.equal(blocks.length, 1);
  // Every node opens with its marker: 24 markers are 24 nodes.
  assert.equal(topLevel(blocks[0].spans), 24);
  assert.match(String(blocks[0].spans.at(-1).value), /Paragraph 23/);
});

test("a long text cuts at the next node boundary, and one huge node in its text", () => {
  const spans = [
    { type: "block", value: { type: "paragraph", parents: [] } },
    { type: "text", value: "x".repeat(3_000) },
    { type: "block", value: { type: "paragraph", parents: [] } },
    { type: "text", value: "y".repeat(3_000) },
    { type: "block", value: { type: "paragraph", parents: [] } },
    { type: "text", value: "never" },
  ];
  const kept = firstScreenSpans(spans);
  assert.equal(topLevel(kept), 2);
  assert.equal(
    kept.some((span) => span.value === "never"),
    false,
  );
  const huge = firstScreenSpans([
    { type: "block", value: { type: "code-block", parents: [] } },
    { type: "text", value: "z".repeat(50_000) },
  ]);
  assert.equal(huge[1].value.length, 12_000);
});

test("an empty Page has no shell blocks", () => {
  assert.deepEqual(shellBlocks(page("")), []);
});

/** A view embed's DOM as wordgard-views.mjs, view-embed.mjs and
 * vega-chart.mjs build it: `state` is view-draw's, `chart` the figure's
 * `data-chart-status`, `status` the lifecycle's sentence. */
function embed({ state = null, chart = null, chartHidden = false, status = null } = {}) {
  const { document } = new JSDOM("<!doctype html><body></body>").window;
  const section = document.body.appendChild(document.createElement("section"));
  section.className = "wordgard-widget wordgard-view-embed";
  const canvas = section.appendChild(document.createElement("div"));
  canvas.className = "wordgard-view-canvas";
  const line = section.appendChild(document.createElement("p"));
  line.className = "wordgard-view-status";
  line.textContent = status ?? VIEW_EMBED_STATUS.waiting;
  if (state !== null) {
    const view = canvas.appendChild(document.createElement("div"));
    view.className = "pages-view";
    view.dataset.viewState = state;
    const holder = view.appendChild(document.createElement("div"));
    holder.className = "pages-view-chart";
    holder.hidden = chartHidden;
    if (chart !== null) {
      const figure = holder.appendChild(document.createElement("figure"));
      figure.className = "pages-chart";
      figure.dataset.chartStatus = chart;
    }
  }
  return section;
}

test("a chart on the first screen holds the capture until Vega finishes or a sentence stays", () => {
  // The chunk or the view is still on its way.
  assert.equal(viewSettled(embed()), false);
  assert.equal(viewSettled(embed({ status: VIEW_EMBED_STATUS.loading })), false);
  assert.equal(viewSettled(embed({ state: "waiting" })), false);
  assert.equal(viewSettled(embed({ state: "loading" })), false);
  // Drawn, but Vega hasn't finished, or the chart isn't the one shown.
  assert.equal(viewSettled(embed({ state: "drawn" })), false);
  assert.equal(viewSettled(embed({ state: "drawn", chart: "drawing" })), false);
  assert.equal(viewSettled(embed({ state: "drawn", chart: "rendered", chartHidden: true })), false);
  // Finished: a chart, a chart's error state, or a sentence that stays.
  assert.equal(viewSettled(embed({ state: "drawn", chart: "rendered" })), true);
  assert.equal(viewSettled(embed({ state: "drawn", chart: "error" })), true);
  assert.equal(viewSettled(embed({ state: "blocked" })), true);
  assert.equal(viewSettled(embed({ state: "failed" })), true);
  assert.equal(viewSettled(embed({ status: VIEW_EMBED_UNAVAILABLE })), true);
});
