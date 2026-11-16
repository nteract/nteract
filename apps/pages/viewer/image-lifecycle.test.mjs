import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { VirtualTimeScheduler } from "rxjs";
import { IMAGE_INITIAL, imageTransition, imageLifecycle } from "./image-lifecycle.mjs";

const source = {
  type: "source",
  src: "https://example.com/light.png",
  dark_src: "https://example.com/dark.png",
  theme: "dark",
};
test("image transition table ignores stale events in every phase and falls back once", () => {
  const preferred = imageTransition(IMAGE_INITIAL, source);
  const fallback = imageTransition(preferred, { type: "error", request: preferred.request });
  const ready = imageTransition(preferred, { type: "load", request: preferred.request });
  const failed = imageTransition(fallback, { type: "error", request: fallback.request });
  assert.equal(fallback.url, source.src);
  assert.equal(failed.phase, "failed");
  for (const state of [IMAGE_INITIAL, preferred, fallback, ready, failed]) {
    for (const type of ["load", "error", "unknown"])
      assert.equal(imageTransition(state, { type, request: {} }), state);
    assert.equal(imageTransition(state, { ...source, theme: "light" }).phase, "preferred");
  }
  // The same source again is the attempt already drawn, whatever its phase.
  for (const state of [preferred, fallback, ready, failed])
    assert.equal(imageTransition(state, source), state);
  assert.equal(imageTransition(IMAGE_INITIAL, source).phase, "preferred");
  assert.equal(imageTransition(ready, { type: "error", request: ready.request }), ready);
  assert.equal(imageTransition(failed, { type: "load", request: failed.request }), failed);
  const same = imageTransition(IMAGE_INITIAL, { ...source, dark_src: source.src });
  assert.equal(imageTransition(same, { type: "error", request: same.request }).phase, "failed");
});

test("app theme overrides OS; fresh attempts reject old callbacks and offscreen waits have no deadline", () => {
  const dom = new JSDOM("<span></span>");
  const container = dom.window.document.querySelector("span");
  let theme = "dark",
    listener;
  const store = {
    getSnapshot: () => ({ resolved: theme }),
    subscribe: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  };
  const lifecycle = imageLifecycle(container, { ...source, alt: "" }, { store });
  lifecycle.connect();
  const first = container.firstChild;
  assert.equal(first.src, source.dark_src);
  assert.equal(first.alt, "");
  const oldLoad = first.onload;
  first.onerror();
  const second = container.firstChild;
  assert.notEqual(first, second);
  assert.equal(second.src, source.src);
  oldLoad();
  assert.equal(container.dataset.imageState, "fallback");
  const clock = new VirtualTimeScheduler();
  clock.schedule(() => assert.equal(container.dataset.imageState, "fallback"), 1_000_000);
  clock.flush();
  theme = "light";
  listener();
  const third = container.firstChild;
  assert.notEqual(third, second);
  second.onerror();
  assert.equal(container.firstChild, third);
  third.onload();
  assert.equal(container.dataset.imageState, "ready");
  assert.equal(lifecycle.image, third);
  lifecycle.disconnect();
  assert.equal(listener, null);
  dom.window.close();
});

// Wordgard disconnects and reconnects the widget when it draws or clears a
// node selection around it. A new img would have no height until it decoded,
// and the Page would jump.
test("a reconnect keeps the drawn image; a theme change while disconnected redraws", () => {
  const dom = new JSDOM("<span></span>");
  const container = dom.window.document.querySelector("span");
  let theme = "light",
    listener;
  const store = {
    getSnapshot: () => ({ resolved: theme }),
    subscribe: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  };
  const lifecycle = imageLifecycle(container, { ...source, alt: "Cat" }, { store });
  lifecycle.connect();
  const drawn = container.firstChild;
  drawn.onload();
  lifecycle.disconnect();
  assert.equal(container.firstChild, drawn, "disconnecting leaves the img in place");
  lifecycle.connect();
  assert.equal(container.firstChild, drawn);
  assert.equal(container.dataset.imageState, "ready");
  assert.equal(lifecycle.image, drawn);
  lifecycle.disconnect();
  theme = "dark";
  lifecycle.connect();
  assert.notEqual(container.firstChild, drawn);
  assert.equal(container.firstChild.src, source.dark_src);
  assert.equal(lifecycle.image, null, "the new attempt hasn't loaded");
  assert.equal(typeof listener, "function");
  dom.window.close();
});
