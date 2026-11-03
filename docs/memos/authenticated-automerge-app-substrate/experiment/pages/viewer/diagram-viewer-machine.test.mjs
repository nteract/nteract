import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_FIT,
  MAX_SCALE,
  NAMES,
  ZOOM_STEP,
  fitScale,
  initialViewer,
  scaleLimits,
  transition,
  viewerEffects,
  wheelFactor,
  zoomAvailability,
} from "./diagram-viewer-machine.mjs";

const deepFreeze = (value) => {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};
const step = (state, event) => transition(deepFreeze(state), deepFreeze(event));
const run = (state, ...events) => events.reduce(step, state);
const close = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} ≠ ${expected}`);

// A wide flowchart in a desktop viewport: width decides the fit.
const WIDE = { content: { width: 2400, height: 300 }, viewport: { width: 1200, height: 800 } };
const open = (spec = WIDE, padding = 0) => step(initialViewer, { type: "open", ...spec, padding });

const EVENTS = {
  open: { type: "open", ...WIDE, padding: 0 },
  close: { type: "close" },
  resize: { type: "resize", viewport: { width: 600, height: 800 } },
  pointerDown: { type: "pointerDown", id: 9, x: 400, y: 400 },
  pointerMove: { type: "pointerMove", id: 1, x: 150, y: 120 },
  pointerUp: { type: "pointerUp", id: 1 },
  wheel: { type: "wheel", deltaY: -100, deltaMode: 0, ctrlKey: false, x: 600, y: 400 },
  zoom: { type: "zoom", factor: ZOOM_STEP },
  pan: { type: "pan", dx: -48, dy: 0 },
  fit: { type: "fit" },
  unknown: { type: "unknown" },
};

// One representative state per name. Pointer 1 is down when panning; 1 and 2
// when pinching. The view is zoomed so pans and fits change something.
const STATES = {
  closed: initialViewer,
  idle: run(open(), EVENTS.zoom),
  panning: run(open(), EVENTS.zoom, { type: "pointerDown", id: 1, x: 100, y: 100 }),
  pinching: run(
    open(),
    EVENTS.zoom,
    { type: "pointerDown", id: 1, x: 100, y: 100 },
    { type: "pointerDown", id: 2, x: 300, y: 100 },
  ),
};

// The state name after each event, by starting name.
const NEXT = {
  closed: {
    open: "idle",
    close: "closed",
    resize: "closed",
    pointerDown: "closed",
    pointerMove: "closed",
    pointerUp: "closed",
    wheel: "closed",
    zoom: "closed",
    pan: "closed",
    fit: "closed",
    unknown: "closed",
  },
  idle: {
    open: "idle",
    close: "closed",
    resize: "idle",
    pointerDown: "panning",
    pointerMove: "idle",
    pointerUp: "idle",
    wheel: "idle",
    zoom: "idle",
    pan: "idle",
    fit: "idle",
    unknown: "idle",
  },
  panning: {
    open: "panning",
    close: "closed",
    resize: "panning",
    pointerDown: "pinching",
    pointerMove: "panning",
    pointerUp: "idle",
    wheel: "panning",
    zoom: "panning",
    pan: "panning",
    fit: "panning",
    unknown: "panning",
  },
  pinching: {
    open: "pinching",
    close: "closed",
    resize: "pinching",
    pointerDown: "pinching",
    pointerMove: "pinching",
    pointerUp: "panning",
    wheel: "pinching",
    zoom: "pinching",
    pan: "pinching",
    fit: "pinching",
    unknown: "pinching",
  },
};

test("every state handles every event", () => {
  assert.deepEqual(Object.keys(STATES), NAMES);
  for (const name of NAMES) {
    assert.equal(STATES[name].name, name);
    for (const [type, event] of Object.entries(EVENTS)) {
      const next = step(STATES[name], event);
      assert.equal(next.name, NEXT[name][type], `${name} + ${type}`);
      assert.deepEqual(step(STATES[name], event), next, `${name} + ${type} is deterministic`);
    }
  }
});

test("events that change nothing return the same state", () => {
  for (const type of ["close", "resize", "pointerMove", "wheel", "zoom", "pan", "fit", "unknown"])
    assert.equal(step(initialViewer, EVENTS[type]), initialViewer, type);
  const idle = open();
  for (const event of [
    EVENTS.open,
    EVENTS.unknown,
    EVENTS.fit, // already fitted
    { type: "pointerMove", id: 1, x: 1, y: 1 }, // no pointer down
    { type: "pointerUp", id: 1 },
    { type: "resize", viewport: WIDE.viewport },
    { type: "zoom", factor: 1 / ZOOM_STEP }, // already at the smallest scale
  ])
    assert.equal(step(idle, event), idle, event.type);
  const pinching = STATES.pinching;
  assert.equal(step(pinching, { type: "pointerDown", id: 3, x: 0, y: 0 }), pinching);
});

test("a fit is the largest scale that shows the whole diagram, capped for small diagrams", () => {
  assert.equal(fitScale({ width: 2400, height: 300 }, { width: 1200, height: 800 }), 0.5);
  assert.equal(fitScale({ width: 300, height: 2400 }, { width: 1200, height: 800 }), 1 / 3);
  assert.equal(fitScale({ width: 2400, height: 300 }, { width: 1264, height: 800 }, 32), 0.5);
  assert.equal(fitScale({ width: 100, height: 50 }, { width: 1200, height: 800 }), MAX_FIT);
  assert.equal(fitScale({ width: 0, height: 50 }, { width: 1200, height: 800 }), 1);
  assert.equal(fitScale({ width: 100, height: 50 }, { width: 0, height: 0 }), 1);
  assert.equal(fitScale({ width: 100, height: 50 }, { width: 40, height: 40 }, 32), 1);
  assert.deepEqual(scaleLimits(0.25), { min: 0.25, max: MAX_SCALE });
  assert.deepEqual(scaleLimits(MAX_FIT), { min: 1, max: MAX_SCALE });
});

test("opening fits and centers the diagram, and shows, focuses and renders", () => {
  const state = open(WIDE, 0);
  assert.equal(state.fit, 0.5);
  assert.equal(state.fitted, true);
  assert.deepEqual(state.view, { scale: 0.5, x: 0, y: (800 - 150) / 2 });
  assert.deepEqual(viewerEffects(initialViewer, state), ["show", "focusStage", "render"]);
  assert.deepEqual(zoomAvailability(state), { zoomIn: true, zoomOut: false });
  assert.deepEqual(zoomAvailability(initialViewer), { zoomIn: false, zoomOut: false });
});

test("closing from any open state hides the viewer and returns focus", () => {
  for (const name of ["idle", "panning", "pinching"]) {
    const next = step(STATES[name], EVENTS.close);
    assert.equal(next, initialViewer);
    assert.deepEqual(viewerEffects(STATES[name], next), ["hide", "returnFocus"], name);
  }
  assert.deepEqual(viewerEffects(initialViewer, initialViewer), []);
});

test("a view or gesture change renders; anything else runs nothing", () => {
  const idle = open();
  assert.deepEqual(viewerEffects(idle, step(idle, EVENTS.zoom)), ["render"]);
  assert.deepEqual(viewerEffects(idle, step(idle, EVENTS.pointerDown)), ["render"]);
  assert.deepEqual(viewerEffects(idle, idle), []);
});

test("zooming keeps the point under the cursor in place", () => {
  const idle = open();
  const zoomed = step(idle, { type: "zoom", factor: 2, x: 300, y: 400 });
  assert.equal(zoomed.view.scale, 1);
  assert.equal(zoomed.fitted, false);
  // Diagram x under the cursor before: (300 - 0) / 0.5 = 600; after: (300 - x) / 1.
  close((300 - zoomed.view.x) / zoomed.view.scale, 600, "x");
  close((400 - zoomed.view.y) / zoomed.view.scale, (400 - idle.view.y) / idle.view.scale, "y");
  // Without a point, buttons and keys zoom at the center.
  const centered = step(idle, { type: "zoom", factor: 2 });
  close((600 - centered.view.x) / centered.view.scale, 1200, "center");
});

test("zoom stops at the fit and at MAX_SCALE", () => {
  const idle = open();
  const most = step(idle, { type: "zoom", factor: 1000 });
  assert.equal(most.view.scale, MAX_SCALE);
  assert.deepEqual(zoomAvailability(most), { zoomIn: false, zoomOut: true });
  const least = step(most, { type: "zoom", factor: 1 / 1000 });
  assert.equal(least.view.scale, idle.fit);
  assert.deepEqual(least.view, idle.view);
});

test("the wheel zooms: up zooms in, a trackpad pinch (ctrlKey) faster per pixel", () => {
  assert.ok(wheelFactor(-100) > 1);
  assert.ok(wheelFactor(100) < 1);
  assert.equal(wheelFactor(0), 1);
  assert.ok(wheelFactor(-10, 0, true) > wheelFactor(-10, 0, false));
  assert.equal(wheelFactor(-3, 1), wheelFactor(-48, 0));
  assert.equal(wheelFactor(-10_000), wheelFactor(-120));
  assert.equal(wheelFactor("nonsense"), 1);
  const zoomed = step(open(), EVENTS.wheel);
  close(zoomed.view.scale, 0.5 * wheelFactor(-100), "scale");
});

test("dragging pans a zoomed diagram until its edge reaches the padding", () => {
  const frame = { ...WIDE, padding: 20 };
  let state = run(open(frame, 20), { type: "zoom", factor: 6 }); // both axes overflow
  state = run(state, { type: "pointerDown", id: 1, x: 500, y: 500 });
  const before = state.view;
  state = step(state, { type: "pointerMove", id: 1, x: 450, y: 480 });
  assert.equal(state.view.x, before.x - 50);
  assert.equal(state.view.y, before.y - 20);
  assert.equal(state.fitted, false);
  // Far left: the diagram's right edge stops at the padding.
  state = step(state, { type: "pointerMove", id: 1, x: -100_000, y: 480 });
  assert.equal(state.view.x, 1200 - 2400 * state.view.scale - 20);
  // Far right: its left edge stops at the padding.
  state = step(state, { type: "pointerMove", id: 1, x: 100_000, y: 480 });
  assert.equal(state.view.x, 20);
  state = step(state, { type: "pointerUp", id: 1 });
  assert.equal(state.name, "idle");
  assert.deepEqual(state.pointers, []);
});

test("an axis that fits stays centered while the other pans", () => {
  const state = run(
    open(),
    { type: "zoom", factor: 2 }, // scale 1: 2400 × 300, taller room than diagram
    { type: "pointerDown", id: 1, x: 0, y: 0 },
    { type: "pointerMove", id: 1, x: -100, y: 200 },
  );
  assert.equal(state.view.y, (800 - 300) / 2);
  assert.ok(state.view.x < 0);
  const pan = step(state, { type: "pan", dx: 0, dy: 48 });
  assert.equal(pan, state);
});

test("pinching zooms around the midpoint and follows it", () => {
  let state = run(
    open(),
    { type: "pointerDown", id: 1, x: 500, y: 400 },
    { type: "pointerDown", id: 2, x: 700, y: 400 },
  );
  assert.equal(state.name, "pinching");
  const before = state.view;
  // Spread to twice the distance, ending on the same midpoint.
  state = step(state, { type: "pointerMove", id: 2, x: 800, y: 400 });
  state = step(state, { type: "pointerMove", id: 1, x: 400, y: 400 });
  close(state.view.scale, before.scale * 2, "scale");
  close((600 - state.view.x) / state.view.scale, (600 - before.x) / before.scale, "anchor");
  // Lifting one finger leaves a pan with the other.
  state = step(state, { type: "pointerUp", id: 1 });
  assert.equal(state.name, "panning");
  assert.deepEqual(
    state.pointers.map((pointer) => pointer.id),
    [2],
  );
  // A repeated pointerdown for a known pointer only moves it.
  const again = step(state, { type: "pointerDown", id: 2, x: 10, y: 10 });
  assert.equal(again.name, "panning");
  assert.deepEqual(again.pointers, [{ id: 2, x: 10, y: 10 }]);
});

test("fit restores the whole diagram after zooming and panning", () => {
  const idle = open();
  const moved = run(idle, { type: "zoom", factor: 3 }, { type: "pan", dx: -200, dy: 0 });
  const fitted = step(moved, EVENTS.fit);
  assert.deepEqual(fitted.view, idle.view);
  assert.equal(fitted.fitted, true);
});

test("a resize refits a fitted diagram and keeps a zoomed one on screen", () => {
  const phone = { type: "resize", viewport: { width: 390, height: 700 } };
  const refit = step(open(), phone);
  close(refit.fit, 390 / 2400, "fit");
  assert.equal(refit.view.scale, refit.fit);
  assert.equal(refit.fitted, true);

  const zoomed = run(open(), { type: "zoom", factor: 2 }, phone);
  assert.equal(zoomed.view.scale, 1);
  assert.equal(zoomed.fitted, false);
  assert.ok(zoomed.view.x >= 390 - 2400 && zoomed.view.x <= 0);
});
