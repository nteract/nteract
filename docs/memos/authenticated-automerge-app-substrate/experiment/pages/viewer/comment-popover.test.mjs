import test from "node:test";
import assert from "node:assert/strict";
import { commentPopoverPosition, passageRect } from "./comment-popover.mjs";

const viewport = { left: 0, top: 60, right: 1200, bottom: 800 };
const place = (anchor, size = {}) =>
  commentPopoverPosition({ anchor, width: 380, height: 200, viewport, ...size });

test("the popover opens below the passage, aligned with its first character", () => {
  assert.deepEqual(place({ left: 300, top: 200, right: 420, bottom: 220 }), {
    left: 300,
    top: 228,
    placement: "below",
  });
});

test("it flips above when the space below is too short", () => {
  assert.deepEqual(place({ left: 300, top: 640, right: 420, bottom: 660 }), {
    left: 300,
    top: 432,
    placement: "above",
  });
});

test("when neither side fits it takes the roomier side and stays inside the viewport", () => {
  const tall = { height: 700 };
  const nearTop = place({ left: 300, top: 120, right: 420, bottom: 140 }, tall);
  assert.equal(nearTop.placement, "below");
  assert.equal(nearTop.top, 88, "clamped so the bottom edge keeps its margin");
  const nearBottom = place({ left: 300, top: 700, right: 420, bottom: 720 }, tall);
  assert.equal(nearBottom.placement, "above");
  assert.equal(nearBottom.top, 72, "clamped below the header");
});

test("it clamps horizontally at both edges", () => {
  assert.equal(place({ left: 1100, top: 200, right: 1150, bottom: 220 }).left, 808);
  assert.equal(place({ left: -40, top: 200, right: 20, bottom: 220 }).left, 12);
  assert.equal(
    place({ left: 100, top: 200, right: 200, bottom: 220 }, { width: 1300 }).left,
    12,
    "a popover wider than the viewport starts at the margin",
  );
});

test("a passage scrolled out of view pins the popover to the nearest edge", () => {
  const above = place({ left: 300, top: -400, right: 420, bottom: -380 });
  assert.equal(above.top, 72);
  const below = place({ left: 300, top: 1400, right: 420, bottom: 1420 });
  assert.equal(below.top, 588);
});

test("missing measurements place nothing", () => {
  assert.equal(place(null), null);
  assert.equal(place({ left: 0, top: 0, right: 1, bottom: 1 }, { width: 0 }), null);
  assert.equal(place({ left: Number.NaN, top: 0, right: 1, bottom: 1 }), null);
});

test("passageRect spans every line and starts at the first visible segment", () => {
  assert.deepEqual(
    passageRect([
      { left: 400, top: 100, right: 700, bottom: 120 },
      { left: 0, top: 0, right: 0, bottom: 0 },
      { left: 80, top: 124, right: 260, bottom: 144 },
    ]),
    { left: 400, top: 100, right: 700, bottom: 144 },
  );
  assert.equal(passageRect([]), null);
  assert.equal(passageRect([{ left: 1, top: 5, right: 1, bottom: 5 }]), null);
});
