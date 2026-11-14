import assert from "node:assert/strict";
import { test } from "node:test";
import {
  previewCoverRect,
  previewTextLines,
  renderPublishedPreview,
} from "./published-preview-image.mjs";

const context = { measureText: (text) => ({ width: Array.from(text).length }) };

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

test("portrait and wide covers fill the card with a centered crop and no stretching", () => {
  for (const [width, height] of [
    [800, 1200],
    [2400, 800],
    [1200, 630],
  ]) {
    const rect = previewCoverRect(width, height);
    assert.ok(rect.width >= 1200 && rect.height >= 630);
    assert.equal(rect.x + rect.width / 2, 600);
    assert.equal(rect.y + rect.height / 2, 315);
    assert.equal(rect.width / rect.height, width / height);
  }
});

test("an uploaded cover fills the canvas beneath a dark gradient and white text", async (t) => {
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
    { title: "A cover", description: "A description", visual: "upload", file: {} },
    [],
    new AbortController().signal,
  );
  assert.deepEqual(paints[0], [bitmap, 0, -585, 1200, 1800]);
  assert.deepEqual(gradients.at(-1).at(-1), [1, "rgba(0, 0, 0, 0.86)"]);
  assert.ok(text.every((entry) => entry.color === "#ffffff"));
  assert.ok(text.every((entry) => entry.y < 630));
  assert.equal(bitmap.close.mock.callCount(), 1);
  text.length = 0;
  await renderPublishedPreview(
    { title: "Title alone", description: "", visual: "upload", file: {} },
    [],
    new AbortController().signal,
  );
  assert.deepEqual(
    text.map((entry) => entry.value),
    ["Pages", "Title alone"],
    "an empty description adds no placeholder or extra text",
  );
});
