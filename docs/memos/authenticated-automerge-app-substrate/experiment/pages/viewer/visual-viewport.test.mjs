import test from "node:test";
import assert from "node:assert/strict";
import { KEYBOARD_MIN_HEIGHT, trackVisualViewport, viewportInsets } from "./visual-viewport.mjs";

// iPhone 13: 844px layout viewport. The keyboard and its accessory row cover
// 380px, leaving a 464px visual viewport.
const L = 844;
const docked = { top: 0, bottom: 0, keyboard: 0, height: L };

// Every visual viewport shape a phone produces, and where the bars go.
const shapes = [
  ["no keyboard", { offsetTop: 0, height: L }, docked],
  [
    "keyboard up",
    { offsetTop: 0, height: 464 },
    { top: 0, bottom: 380, keyboard: 380, height: 464 },
  ],
  [
    "keyboard up, Safari panned 120px to show the caret",
    { offsetTop: 120, height: 464 },
    { top: 120, bottom: 260, keyboard: 380, height: 464 },
  ],
  [
    "keyboard up, panned to the layout viewport's bottom",
    { offsetTop: 380, height: 464 },
    { top: 380, bottom: 0, keyboard: 380, height: 464 },
  ],
  [
    "keyboard up, fractional pan offset",
    { offsetTop: 120.33, height: 464 },
    { top: 120, bottom: 260, keyboard: 380, height: 464 },
  ],
  ["Safari's toolbars collapsed (visual viewport taller)", { offsetTop: 0, height: 914 }, docked],
  ["Chrome's URL bar showing", { offsetTop: 0, height: L - 56 }, docked],
  ["a stale offset after the keyboard closed", { offsetTop: 24, height: L - 24 }, docked],
  ["rubber-band overscroll", { offsetTop: -40, height: L }, docked],
  ["pinch zoom, no keyboard", { offsetTop: 300, height: L / 2, scale: 2 }, docked],
  [
    "pinch zoom with the keyboard up",
    { offsetTop: 100, height: 232, scale: 2 },
    { top: 100, bottom: 512, keyboard: 380, height: 232 },
  ],
  [
    "the smallest keyboard",
    { offsetTop: 0, height: L - KEYBOARD_MIN_HEIGHT },
    { top: 0, bottom: KEYBOARD_MIN_HEIGHT, keyboard: KEYBOARD_MIN_HEIGHT, height: L - 120 },
  ],
  ["just short of a keyboard", { offsetTop: 0, height: L - KEYBOARD_MIN_HEIGHT + 1 }, docked],
  ["missing offset", { height: 464 }, docked],
  ["NaN offset", { offsetTop: NaN, height: 464 }, docked],
  ["zero height", { offsetTop: 0, height: 0 }, docked],
  ["zero scale", { offsetTop: 0, height: 464, scale: 0 }, docked],
];

for (const [name, visualViewport, expected] of shapes)
  test(`insets: ${name}`, () => {
    assert.deepEqual(viewportInsets({ visualViewport, layoutHeight: L }), expected);
  });

test("insets without a visual viewport or layout height stay at zero", () => {
  assert.deepEqual(viewportInsets({ visualViewport: null, layoutHeight: L }), docked);
  assert.deepEqual(viewportInsets({}), { top: 0, bottom: 0, keyboard: 0, height: 0 });
});

test("panning with the keyboard up moves the edges but not the keyboard height", () => {
  const pans = [0, 60.5, 190, 379.7, 380].map((offsetTop) =>
    viewportInsets({ visualViewport: { offsetTop, height: 464 }, layoutHeight: L }),
  );
  assert.deepEqual(new Set(pans.map((insets) => insets.keyboard)), new Set([380]));
  for (const insets of pans) assert.equal(insets.top + insets.bottom + insets.height, L);
});

class FakeViewport extends EventTarget {
  offsetTop = 0;
  height = L;
}

function fakeRoot() {
  const props = new Map();
  const writes = [];
  return {
    props,
    writes,
    root: {
      clientHeight: L,
      style: {
        setProperty: (name, value) => {
          writes.push(name);
          props.set(name, value);
        },
        removeProperty: (name) => props.delete(name),
      },
    },
  };
}
const frame = () => new Promise((resolve) => setTimeout(resolve, 50));

test("the tracker keeps CSS variables current and cleans up", async () => {
  globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(Date.now()), 0);
  globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);
  const { props, root } = fakeRoot();
  const viewport = new FakeViewport();
  const stop = trackVisualViewport({ visualViewport: viewport, document: {} }, root);
  assert.equal(props.get("--vv-bottom"), "0px");
  assert.equal(props.get("--vv-keyboard"), "0px");
  viewport.height = 464;
  viewport.offsetTop = 40;
  viewport.dispatchEvent(new Event("resize"));
  await frame();
  assert.equal(props.get("--vv-top"), "40px");
  assert.equal(props.get("--vv-bottom"), "340px");
  assert.equal(props.get("--vv-keyboard"), "380px");
  assert.equal(props.get("--vv-height"), "464px");
  stop();
  for (const name of ["--vv-top", "--vv-bottom", "--vv-keyboard", "--vv-height"])
    assert.equal(props.has(name), false, name);
});

test("without a keyboard, scrolling the visual viewport writes nothing", async () => {
  globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(Date.now()), 0);
  globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);
  const { props, writes, root } = fakeRoot();
  const viewport = new FakeViewport();
  const stop = trackVisualViewport({ visualViewport: viewport, document: {} }, root);
  const initial = writes.length;
  // Safari's toolbars collapse and come back, then a stale offset arrives.
  for (const [offsetTop, height] of [
    [0, 880],
    [0, 914],
    [0, L],
    [24, L - 24],
    [0, L],
  ]) {
    viewport.offsetTop = offsetTop;
    viewport.height = height;
    viewport.dispatchEvent(new Event("scroll"));
    await frame();
  }
  assert.equal(writes.length, initial);
  assert.equal(props.get("--vv-top"), "0px");
  assert.equal(props.get("--vv-bottom"), "0px");
  stop();
});

test("while iOS pans with the keyboard up, only the edges change", async () => {
  globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(Date.now()), 0);
  globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);
  const { writes, root } = fakeRoot();
  const viewport = new FakeViewport();
  viewport.height = 464;
  const stop = trackVisualViewport({ visualViewport: viewport, document: {} }, root);
  writes.length = 0;
  for (const offsetTop of [40, 80, 120]) {
    viewport.offsetTop = offsetTop;
    viewport.dispatchEvent(new Event("scroll"));
    await frame();
  }
  assert.deepEqual(new Set(writes), new Set(["--vv-top", "--vv-bottom"]));
  stop();
});

test("without a visual viewport the height falls back to CSS", () => {
  const { props, root } = fakeRoot();
  const stop = trackVisualViewport({ visualViewport: undefined, document: {} }, root);
  assert.equal(props.has("--vv-height"), false);
  assert.equal(props.get("--vv-bottom"), "0px");
  stop();
});
