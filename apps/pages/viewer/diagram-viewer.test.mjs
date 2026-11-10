import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { cloneDiagram, isolateIds, openDiagramViewer, svgSize } from "./diagram-viewer.mjs";

// jsdom has no layout or modal dialogs: the viewer falls back to an open
// attribute and a zero-sized stage. Pan, zoom and fit geometry are covered by
// diagram-viewer-machine.test.mjs; the real-browser check covers rendering.
function withDocument(run) {
  const { window } = new JSDOM(
    `<!doctype html><body><button id="opener">Maximize</button><div id="canvas"></div></body>`,
  );
  const previous = globalThis.document;
  globalThis.document = window.document;
  try {
    return run(window.document);
  } finally {
    globalThis.document = previous;
    window.close();
  }
}

const DIAGRAM = `<svg xmlns="http://www.w3.org/2000/svg" class="pele" width="2400" height="300"
  viewBox="120 40 600 75" role="img" aria-labelledby="d-title" tabindex="0"
  style="--_fg: var(--pele-fg); width: 640px; max-width: none; cursor: grab">
  <title id="d-title">Storage flow</title>
  <defs><marker id="d-arrow"><path d="M0 0L10 5L0 10z"/></marker></defs>
  <path d="M0 0H100" marker-end="url(#d-arrow)" style="stroke: url('#d-arrow')"/>
  <path d="M0 0H100" fill="url(#elsewhere)"/>
</svg>`;

function diagram(doc) {
  const canvas = doc.getElementById("canvas");
  canvas.innerHTML = DIAGRAM;
  return canvas.firstElementChild;
}

const key = (doc, target, init) =>
  target.dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", { bubbles: true, ...init }));

test("an SVG's natural size comes from its attributes, then its viewBox", () =>
  withDocument((doc) => {
    const svg = diagram(doc);
    assert.deepEqual(svgSize(svg), { width: 2400, height: 300 });
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    assert.deepEqual(svgSize(svg), { width: 600, height: 75 });
  }));

test("the copy keeps the diagram's ids apart from the inline original", () =>
  withDocument((doc) => {
    const svg = diagram(doc);
    const { svg: copy } = cloneDiagram(svg, "v1");
    assert.equal(copy.querySelector("title").id, "d-title-v1");
    assert.equal(copy.getAttribute("aria-labelledby"), "d-title-v1");
    assert.equal(copy.querySelector("marker").id, "d-arrow-v1");
    const [arrow, other] = copy.querySelectorAll(":scope > path");
    assert.equal(arrow.getAttribute("marker-end"), "url(#d-arrow-v1)");
    assert.match(arrow.getAttribute("style"), /url\(['"]#d-arrow-v1['"]\)/);
    assert.equal(other.getAttribute("fill"), "url(#elsewhere)");
    // The original is untouched.
    assert.equal(svg.querySelector("title").id, "d-title");
    assert.equal(isolateIds(doc.createElement("div"), "x").childElementCount, 0);
  }));

test("the copy starts from the natural frame, not the inline zoom", () =>
  withDocument((doc) => {
    const { svg: copy, width, height } = cloneDiagram(diagram(doc), "v2");
    assert.deepEqual({ width, height }, { width: 2400, height: 300 });
    assert.equal(copy.getAttribute("viewBox"), "0 0 2400 300");
    assert.equal(copy.hasAttribute("tabindex"), false);
    assert.equal(copy.style.width, "");
    assert.equal(copy.style.maxWidth, "");
    assert.equal(copy.style.cursor, "");
    assert.equal(copy.style.getPropertyValue("--_fg").trim(), "var(--pele-fg)");
  }));

test("opening shows a labelled dialog with zoom, fit and close controls, focused on the diagram", () =>
  withDocument((doc) => {
    const opener = doc.getElementById("opener");
    opener.focus();
    const viewer = openDiagramViewer({ svg: diagram(doc), label: "Storage flow", opener });
    const { dialog } = viewer;
    assert.equal(dialog.parentElement, doc.body);
    assert.equal(dialog.hasAttribute("open"), true);
    assert.equal(
      doc.getElementById(dialog.getAttribute("aria-labelledby")).textContent,
      "Storage flow",
    );
    assert.match(doc.getElementById(dialog.getAttribute("aria-describedby")).textContent, /Escape/);
    const labels = Array.from(dialog.querySelectorAll("button"), (b) =>
      b.getAttribute("aria-label"),
    );
    assert.deepEqual(labels, ["Zoom out", "Zoom in", "Fit diagram to screen", "Close"]);
    assert.equal(doc.activeElement, dialog.querySelector(".diagram-viewer-stage"));
    assert.equal(dialog.querySelectorAll("svg.pele").length, 1);
    assert.equal(viewer.state.name, "idle");
    viewer.close();
  }));

test("the close button closes the viewer and returns focus to the opener", () =>
  withDocument((doc) => {
    const opener = doc.getElementById("opener");
    const viewer = openDiagramViewer({ svg: diagram(doc), opener });
    viewer.dialog.querySelector(".diagram-viewer-close").click();
    assert.equal(viewer.state.name, "closed");
    assert.equal(viewer.dialog.isConnected, false);
    assert.equal(doc.activeElement, opener);
  }));

test("Escape closes the viewer and returns focus to the opener", () =>
  withDocument((doc) => {
    const opener = doc.getElementById("opener");
    const viewer = openDiagramViewer({ svg: diagram(doc), opener });
    key(doc, viewer.dialog.querySelector(".diagram-viewer-stage"), { key: "Escape" });
    assert.equal(viewer.state.name, "closed");
    assert.equal(doc.querySelector(".diagram-viewer"), null);
    assert.equal(doc.activeElement, opener);
  }));

test("Tab and Shift+Tab cycle inside the dialog", () =>
  withDocument((doc) => {
    const viewer = openDiagramViewer({ svg: diagram(doc) });
    const stage = viewer.dialog.querySelector(".diagram-viewer-stage");
    const zoomOut = viewer.dialog.querySelector(".diagram-viewer-out");
    assert.equal(doc.activeElement, stage);
    key(doc, stage, { key: "Tab" });
    assert.equal(doc.activeElement, zoomOut);
    key(doc, zoomOut, { key: "Tab", shiftKey: true });
    assert.equal(doc.activeElement, stage);
    viewer.close();
  }));

test("keys on the diagram zoom and fit; the scale readout and controls follow", () =>
  withDocument((doc) => {
    const viewer = openDiagramViewer({ svg: diagram(doc) });
    const stage = viewer.dialog.querySelector(".diagram-viewer-stage");
    const scale = viewer.dialog.querySelector(".diagram-viewer-scale");
    const zoomOut = viewer.dialog.querySelector(".diagram-viewer-out");
    // A zero-sized stage fits at 1.
    assert.equal(scale.textContent, "100%");
    assert.equal(zoomOut.getAttribute("aria-disabled"), "true");
    key(doc, stage, { key: "+" });
    assert.equal(scale.textContent, "150%");
    assert.equal(zoomOut.getAttribute("aria-disabled"), "false");
    assert.equal(viewer.dialog.querySelector("svg.pele").style.width, "3600px");
    key(doc, stage, { key: "0" });
    assert.equal(scale.textContent, "100%");
    // Browser zoom shortcuts pass through.
    key(doc, stage, { key: "+", ctrlKey: true });
    assert.equal(scale.textContent, "100%");
    // A disabled control does nothing.
    zoomOut.click();
    assert.equal(scale.textContent, "100%");
    viewer.close();
  }));

test("opening a second viewer closes the first", () =>
  withDocument((doc) => {
    const first = openDiagramViewer({ svg: diagram(doc) });
    const second = openDiagramViewer({ svg: diagram(doc) });
    assert.equal(first.state.name, "closed");
    assert.equal(doc.querySelectorAll(".diagram-viewer").length, 1);
    second.close();
  }));
