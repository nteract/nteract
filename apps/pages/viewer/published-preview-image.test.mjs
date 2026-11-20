import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  previewVisuals,
  previewVisualNode,
  previewCoverRect,
  previewFillRect,
  previewSourceSize,
  previewCaptureScale,
  previewTextLines,
  renderPublishedPreview,
} from "./published-preview-image.mjs";

const context = { measureText: (text) => ({ width: Array.from(text).length }) };

test("extreme aspect ratios survive the capture library's dimension rounding", () => {
  for (const [width, height] of [
    [1, 8192],
    [8192, 1],
    [700, 700 / 8192],
    [0.25, 2048],
  ]) {
    const scale = previewCaptureScale(width, height);
    assert.ok(Math.floor(width * scale) >= 1);
    assert.ok(Math.floor(height * scale) >= 1);
    const size = previewSourceSize(Math.floor(width * scale), Math.floor(height * scale));
    assert.ok(size.width <= 1152 && size.height <= 390);
  }
});

test("retained visual sources fit the card and upload budget even for oversized captures", () => {
  for (const [width, height] of [
    [16000, 12000],
    [64, 10000],
    [20000, 2],
    [1, 1],
    [800, 600],
  ]) {
    const size = previewSourceSize(width, height);
    assert.ok(size.width >= 1 && size.width <= 1152);
    assert.ok(size.height >= 1 && size.height <= 390);
    assert.ok(size.width <= width && size.height <= height);
    assert.ok(
      size.width * size.height * 4 < 2 * 1024 * 1024,
      "even raw RGBA fits below the 5 MiB upload limit",
    );
  }
});

test("cover choices include rendered chart content, never toolbar icons or pending charts", () => {
  const { window } = new JSDOM(`
    <div class="rich-editor">
      <figure class="pages-chart" data-chart-status="rendered" aria-label="Events by day">
        <button aria-label="Maximize chart"><svg id="maximize"></svg></button>
        <div class="pages-chart-canvas"><div><svg id="chart"></svg></div></div>
      </figure>
      <figure class="pages-chart" data-chart-status="drawing">
        <div class="pages-chart-canvas"><svg id="pending"></svg></div>
      </figure>
      <div class="wordgard-diagram-canvas"><div class="pele-zoom"><button><svg id="zoom"></svg></button></div><svg id="diagram"><svg id="nested"></svg></svg></div>
      <div class="wordgard-diagram-canvas"><div class="pele-zoom"><button><svg id="zoom-only"></svg></button></div></div>
      <img id="photo" alt="A cover photo">
    </div>
    <svg id="outside"></svg>
  `);
  window.Element.prototype.getBoundingClientRect = () => ({ width: 400, height: 200 });
  const choices = previewVisuals(window.document);
  assert.deepEqual(
    choices.map((choice) => previewVisualNode(choice).id),
    ["chart", "diagram", "photo"],
  );
  assert.deepEqual(
    choices.map(({ label }) => label),
    ["Events by day", "Diagram 2", "A cover photo"],
  );
  const previousChart = previewVisualNode(choices[0]);
  const redrawnChart = window.document.createElementNS("http://www.w3.org/2000/svg", "svg");
  redrawnChart.id = "redrawn-chart";
  choices[0].node.replaceChildren(redrawnChart);
  assert.equal(previousChart.isConnected, false);
  assert.equal(
    previewVisualNode(choices[0]),
    redrawnChart,
    "text edits use the resized or refreshed chart",
  );
  choices[0].node.replaceChildren();
  assert.equal(
    previewVisualNode(choices[0]),
    null,
    "an empty canvas never falls back to its toolbar",
  );
  choices[0].node.remove();
  assert.equal(previewVisualNode(choices[0]), null);
  window.close();
});

test("preview cards wrap at word boundaries and fit truncated lines", () => {
  assert.deepEqual(previewTextLines(context, "A lovely little Page", 14, 3), [
    "A lovely",
    "little Page",
  ]);
  assert.deepEqual(previewTextLines(context, "A lovely little Page", 14, 1), ["A lovely…"]);
  assert.deepEqual(previewTextLines(context, "abcdefghij more words", 5, 2), ["abcde", "fghi…"]);
  assert.deepEqual(previewTextLines(context, "🦀🦀🦀🦀", 2, 3), ["🦀🦀", "🦀🦀"]);
  assert.deepEqual(previewTextLines(context, "", 14, 3), []);
});

test("portrait and wide covers fit entirely above the caption without cropping or stretching", () => {
  for (const [width, height] of [
    [800, 1200],
    [2400, 800],
    [1200, 630],
  ]) {
    const rect = previewCoverRect(width, height);
    assert.ok(rect.width <= 1152 && rect.height <= 390);
    assert.ok(rect.x >= 24 && rect.y >= 24);
    assert.ok(rect.y + rect.height <= 414);
    assert.equal(rect.x + rect.width / 2, 600);
    assert.equal(rect.y + rect.height / 2, 219);
    assert.ok(Math.abs(rect.width / rect.height - width / height) < 1e-12);
  }
});

test("a filling cover covers the whole card, centred, at its own aspect ratio", () => {
  const cases = [
    [[2400, 630], { x: -600, y: 0, width: 2400, height: 630 }],
    [[1200, 630], { x: 0, y: 0, width: 1200, height: 630 }],
    [[600, 1200], { x: 0, y: -885, width: 1200, height: 2400 }],
    [[3, 2], { x: 0, y: -85, width: 1200, height: 800 }],
  ];
  for (const [[width, height], expected] of cases) {
    const rect = previewFillRect(width, height);
    assert.deepEqual(rect, expected, `${width}x${height}`);
    assert.ok(rect.x <= 0 && rect.y <= 0);
    assert.ok(rect.x + rect.width >= 1200 && rect.y + rect.height >= 630);
    assert.equal(rect.x + rect.width / 2, 600);
    assert.equal(rect.y + rect.height / 2, 315);
    assert.ok(Math.abs(rect.width / rect.height - width / height) < 1e-12);
  }
});

test("an uploaded cover filling the card draws no caption, title, byline or product name", async (t) => {
  const paints = [],
    text = [],
    rects = [];
  const context = {
    measureText: (value) => ({ width: value.length * 20 }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    fillRect: (...args) => rects.push(args),
    drawImage: (...args) => paints.push(args),
    fillText: (value) => text.push(value),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    toBlob: (done) => done(new Blob(["png"])),
  };
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const oldBitmap = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
  t.after(() => {
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
    else delete globalThis.document;
    if (oldBitmap) Object.defineProperty(globalThis, "createImageBitmap", oldBitmap);
    else delete globalThis.createImageBitmap;
  });
  const bitmap = { width: 600, height: 1200, close: t.mock.fn() };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => canvas },
  });
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: async () => bitmap,
  });
  const draft = {
    title: "A finished card",
    author: "Ada",
    description: "Kept in metadata",
    visual: "upload",
    layout: "fill",
    file: {},
  };
  const result = await renderPublishedPreview(draft, [], new AbortController().signal);
  assert.ok(result.blob);
  assert.deepEqual([canvas.width, canvas.height], [1200, 630]);
  assert.deepEqual(paints, [[bitmap, 0, -885, 1200, 2400]]);
  assert.deepEqual(text, [], "no text is drawn on a filled card");
  assert.deepEqual(rects, [[0, 0, 1200, 630]], "only the background under the image");
  assert.equal(bitmap.close.mock.callCount(), 1);
  paints.length = 0;
  await renderPublishedPreview({ ...draft, layout: "caption" }, [], new AbortController().signal);
  assert.deepEqual(paints, [[bitmap, 502.5, 24, 195, 390]], "caption keeps the fitted cover");
  assert.ok(text.includes("A finished card"));
});

test("an uploaded cover stays fully visible with a separate title and byline", async (t) => {
  const paints = [],
    text = [],
    gradients = [];
  const context = {
    measureText: (value) => ({ width: value.length * 20 }),
    createLinearGradient: () => {
      const stops = [];
      gradients.push(stops);
      return { addColorStop: (offset, color) => stops.push([offset, color]) };
    },
    fillRect: () => {},
    drawImage: (...args) => paints.push(args),
    fillText(value, x, y) {
      text.push({ value, x, y, color: this.fillStyle });
    },
  };
  const canvas = { getContext: () => context, toBlob: (done) => done(new Blob(["png"])) };
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const oldBitmap = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
  t.after(() => {
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
    else delete globalThis.document;
    if (oldBitmap) Object.defineProperty(globalThis, "createImageBitmap", oldBitmap);
    else delete globalThis.createImageBitmap;
  });
  const bitmap = { width: 800, height: 1200, close: t.mock.fn() };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => canvas },
  });
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: async () => bitmap,
  });
  await renderPublishedPreview(
    {
      title: "A cover",
      author: "Kyle Kelley",
      description: "A description",
      visual: "upload",
      file: {},
    },
    [],
    new AbortController().signal,
  );
  assert.deepEqual(paints[0], [bitmap, 470, 24, 260, 390]);
  assert.ok(gradients.flat().every(([, color]) => !color.startsWith("rgba(0, 0, 0")));
  assert.ok(text.some((entry) => entry.value === "by Kyle Kelley"));
  assert.ok(text.every((entry) => entry.y > 438));
  assert.ok(text.every((entry) => entry.y < 630));
  assert.equal(bitmap.close.mock.callCount(), 1);
  const source = new Blob(["original pixels"], { type: "image/png" });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, `/api/pages/page-id/assets/${"a".repeat(64)}`);
    assert.equal(options.credentials, "same-origin");
    assert.ok(options.signal);
    return new Response(source);
  });
  await renderPublishedPreview(
    {
      title: "Reopened",
      description: "Changed",
      visual: "upload",
      cover: { asset_id: "a".repeat(64), name: "cover.png" },
    },
    [],
    new AbortController().signal,
    "page-id",
  );
  assert.equal(paints.length, 2, "a reopened cover is drawn from its private source asset");
  text.length = 0;
  await renderPublishedPreview(
    { title: "Title alone", description: "", visual: "upload", file: {} },
    [],
    new AbortController().signal,
  );
  assert.deepEqual(
    text.map((entry) => entry.value),
    ["Title alone", "Pages"],
    "an empty description adds no placeholder or extra text",
  );
});
