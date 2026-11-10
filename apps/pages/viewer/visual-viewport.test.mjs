import test from "node:test";
import assert from "node:assert/strict";
import {
  KEYBOARD_MIN_HEIGHT,
  isEditable,
  trackVisualViewport,
  viewportInsets,
} from "./visual-viewport.mjs";

// iPhone 13: 844px layout viewport. The keyboard and its accessory row cover
// 380px, leaving a 464px visual viewport.
const L = 844;
const docked = { top: 0, bottom: 0, keyboard: 0, height: L };
const follows = (top, bottom, keyboard, height) => ({ top, bottom, keyboard, height });

// Every visual viewport shape a phone produces, and where the bars go while
// reading (nothing editable focused) and while editing.
const shapes = [
  ["no keyboard", { offsetTop: 0, height: L }, docked, docked],
  ["keyboard up", { offsetTop: 0, height: 464 }, follows(0, 380, 380, 464)],
  [
    "keyboard up, Safari panned 120px to show the caret",
    { offsetTop: 120, height: 464 },
    follows(120, 260, 380, 464),
  ],
  [
    "keyboard up, panned to the layout viewport's bottom",
    { offsetTop: 380, height: 464 },
    follows(380, 0, 380, 464),
  ],
  [
    "keyboard up, fractional pan offset",
    { offsetTop: 120.33, height: 464 },
    follows(120, 260, 380, 464),
  ],
  [
    "Safari's toolbars collapsed (visual viewport taller)",
    { offsetTop: 0, height: 914 },
    docked,
    docked,
  ],
  ["Chrome's URL bar showing", { offsetTop: 0, height: L - 56 }, docked, follows(0, 56, 56, 788)],
  [
    "a stale offset after the keyboard closed",
    { offsetTop: 24, height: L - 24 },
    docked,
    follows(24, 0, 24, 820),
  ],
  [
    "a hardware keyboard's shortcut strip",
    { offsetTop: 0, height: L - 54 },
    docked,
    follows(0, 54, 54, 790),
  ],
  ["rubber-band overscroll", { offsetTop: -40, height: L }, docked, docked],
  ["scale drift while unzoomed", { offsetTop: 0, height: L / 1.004, scale: 1.004 }, docked, docked],
  [
    "pinch zoom, no keyboard",
    { offsetTop: 300, height: L / 2, scale: 2 },
    follows(300, 122, 0, 422),
  ],
  [
    "pinch zoom, panned to the top",
    { offsetTop: 0, height: L / 2, scale: 2 },
    follows(0, 422, 0, 422),
  ],
  [
    "pinch zoom with the keyboard up",
    { offsetTop: 100, height: 232, scale: 2 },
    follows(100, 512, 380, 232),
  ],
  [
    "the smallest keyboard",
    { offsetTop: 0, height: L - KEYBOARD_MIN_HEIGHT },
    follows(0, KEYBOARD_MIN_HEIGHT, KEYBOARD_MIN_HEIGHT, L - KEYBOARD_MIN_HEIGHT),
  ],
  [
    "just short of a keyboard",
    { offsetTop: 0, height: L - KEYBOARD_MIN_HEIGHT + 1 },
    docked,
    follows(0, KEYBOARD_MIN_HEIGHT - 1, KEYBOARD_MIN_HEIGHT - 1, L - KEYBOARD_MIN_HEIGHT + 1),
  ],
  ["missing offset", { height: 464 }, docked, docked],
  ["NaN offset", { offsetTop: NaN, height: 464 }, docked, docked],
  ["zero height", { offsetTop: 0, height: 0 }, docked, docked],
  ["zero scale", { offsetTop: 0, height: 464, scale: 0 }, docked, docked],
];

for (const [name, visualViewport, reading, editing = reading] of shapes) {
  test(`insets while reading: ${name}`, () => {
    assert.deepEqual(viewportInsets({ visualViewport, layoutHeight: L }), reading);
  });
  test(`insets while editing: ${name}`, () => {
    assert.deepEqual(viewportInsets({ visualViewport, layoutHeight: L, editing: true }), editing);
  });
}

test("zoomed in, the bar and menus stay inside the visual viewport", () => {
  for (const editing of [false, true])
    for (const [offsetTop, scale] of [
      [300, 2],
      [0, 2],
      [422, 2],
      [150.5, 1.5],
      [30, 1.1],
    ]) {
      const visualViewport = { offsetTop, height: L / scale, scale };
      const insets = viewportInsets({ visualViewport, layoutHeight: L, editing });
      const shown = { top: offsetTop, bottom: offsetTop + L / scale };
      // The header hangs from --vv-top, the bar sits on L - --vv-bottom, and
      // menus cap their height at --vv-height.
      assert.ok(Math.abs(insets.top - shown.top) <= 0.5, JSON.stringify({ insets, shown }));
      assert.ok(Math.abs(L - insets.bottom - shown.bottom) <= 1, JSON.stringify({ insets, shown }));
      assert.ok(insets.height <= Math.round(L / scale), JSON.stringify({ insets, shown }));
      assert.equal(insets.top + insets.height + insets.bottom, L);
    }
});

test("editable elements are content, text fields and selects", () => {
  const el = (tagName, extra = {}) => ({ tagName, matches: () => false, ...extra });
  const button = { tagName: "INPUT", matches: () => true };
  assert.equal(isEditable(null), false);
  assert.equal(isEditable(el("DIV")), false);
  assert.equal(isEditable(el("BUTTON")), false);
  assert.equal(isEditable(button), false);
  assert.equal(isEditable(el("DIV", { isContentEditable: true })), true);
  assert.equal(isEditable(el("TEXTAREA")), true);
  assert.equal(isEditable(el("SELECT")), true);
  assert.equal(isEditable(el("INPUT")), true);
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

class FakeDocument extends EventTarget {
  activeElement = null;
}

test("focus decides whether a short strip moves the bar", async () => {
  globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(Date.now()), 0);
  globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);
  const { props, root } = fakeRoot();
  const viewport = new FakeViewport();
  const doc = new FakeDocument();
  // A hardware keyboard's shortcut strip covers 54px.
  viewport.height = L - 54;
  const stop = trackVisualViewport({ visualViewport: viewport, document: doc }, root);
  assert.equal(props.get("--vv-bottom"), "0px");
  doc.activeElement = { tagName: "DIV", isContentEditable: true };
  doc.dispatchEvent(new Event("focusin"));
  await frame();
  assert.equal(props.get("--vv-bottom"), "54px");
  assert.equal(props.get("--vv-keyboard"), "54px");
  assert.equal(props.get("--vv-height"), "790px");
  doc.activeElement = null;
  doc.dispatchEvent(new Event("focusout"));
  await frame();
  assert.equal(props.get("--vv-bottom"), "0px");
  assert.equal(props.get("--vv-height"), `${L}px`);
  stop();
});

test("pinch zoom keeps the bar and menus inside the visual viewport", async () => {
  globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(Date.now()), 0);
  globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);
  const { props, root } = fakeRoot();
  const viewport = new FakeViewport();
  const stop = trackVisualViewport(
    { visualViewport: viewport, document: new FakeDocument() },
    root,
  );
  Object.assign(viewport, { offsetTop: 300, height: L / 2, scale: 2 });
  viewport.dispatchEvent(new Event("resize"));
  await frame();
  // Visible from 300px to 722px: the header at 300, the bar's bottom at 722.
  assert.equal(props.get("--vv-top"), "300px");
  assert.equal(L - parseInt(props.get("--vv-bottom")), 722);
  assert.equal(props.get("--vv-height"), "422px");
  stop();
});

test("without a visual viewport the height falls back to CSS", () => {
  const { props, root } = fakeRoot();
  const stop = trackVisualViewport({ visualViewport: undefined, document: {} }, root);
  assert.equal(props.has("--vv-height"), false);
  assert.equal(props.get("--vv-bottom"), "0px");
  stop();
});
