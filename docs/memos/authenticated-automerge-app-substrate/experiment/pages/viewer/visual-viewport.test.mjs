import test from "node:test";
import assert from "node:assert/strict";
import { trackVisualViewport, viewportInsets } from "./visual-viewport.mjs";

test("insets are the keyboard below and the scrolled offset above", () => {
  // iPhone 13: 844px layout, keyboard and accessory bar take 380px.
  assert.deepEqual(
    viewportInsets({ visualViewport: { offsetTop: 0, height: 464 }, layoutHeight: 844 }),
    { top: 0, bottom: 380, height: 464 },
  );
  // Safari scrolled the visual viewport 120px down to show the caret.
  assert.deepEqual(
    viewportInsets({ visualViewport: { offsetTop: 120, height: 464 }, layoutHeight: 844 }),
    { top: 120, bottom: 260, height: 464 },
  );
  // No keyboard.
  assert.deepEqual(
    viewportInsets({ visualViewport: { offsetTop: 0, height: 844 }, layoutHeight: 844 }),
    { top: 0, bottom: 0, height: 844 },
  );
  // Missing or broken values never produce negative or NaN insets.
  for (const input of [
    {},
    { visualViewport: null, layoutHeight: 844 },
    { visualViewport: { offsetTop: NaN, height: 464 }, layoutHeight: 844 },
    { visualViewport: { offsetTop: 0, height: 0 }, layoutHeight: 844 },
    { visualViewport: { offsetTop: 0, height: 900 }, layoutHeight: 844 },
  ])
    assert.deepEqual(
      { top: viewportInsets(input).top, bottom: viewportInsets(input).bottom },
      { top: 0, bottom: 0 },
    );
});

class FakeViewport extends EventTarget {
  offsetTop = 0;
  height = 844;
}

test("the tracker keeps CSS variables current and cleans up", async () => {
  globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(Date.now()), 0);
  globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);
  const props = new Map();
  const root = {
    clientHeight: 844,
    style: {
      setProperty: (name, value) => props.set(name, value),
      removeProperty: (name) => props.delete(name),
    },
  };
  const viewport = new FakeViewport();
  const stop = trackVisualViewport({ visualViewport: viewport, document: {} }, root);
  assert.equal(props.get("--vv-bottom"), "0px");
  viewport.height = 464;
  viewport.offsetTop = 40;
  viewport.dispatchEvent(new Event("resize"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(props.get("--vv-top"), "40px");
  assert.equal(props.get("--vv-bottom"), "340px");
  assert.equal(props.get("--vv-height"), "464px");
  stop();
  assert.equal(props.has("--vv-top"), false);
  assert.equal(props.has("--vv-bottom"), false);
  assert.equal(props.has("--vv-height"), false);
});
