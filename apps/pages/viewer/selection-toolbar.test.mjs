import test from "node:test";
import assert from "node:assert/strict";
import { selectionToolbarPosition } from "./selection-toolbar.mjs";

const fixture = {
  start: { left: 400, right: 400, top: 300, bottom: 324 },
  end: { left: 600, right: 600, top: 300, bottom: 324 },
  width: 480,
  height: 48,
  viewport: { left: 0, top: 64, right: 1200, bottom: 800 },
};

test("selection toolbar centers above text without overlapping it", () => {
  const result = selectionToolbarPosition(fixture);
  assert.deepEqual(result, { left: 260, top: 242 });
  assert.ok(result.top + fixture.height < fixture.start.top);
});

test("selection near the page bar places the toolbar below the entire range", () => {
  const result = selectionToolbarPosition({
    ...fixture,
    start: { ...fixture.start, top: 80, bottom: 104 },
    end: { ...fixture.end, top: 128, bottom: 152 },
  });
  assert.deepEqual(result, { left: 260, top: 162 });
});

test("selection at either horizontal edge keeps all controls in the viewport", () => {
  for (const x of [-40, 30, 1190, 1300]) {
    const result = selectionToolbarPosition({
      ...fixture,
      start: { ...fixture.start, left: x },
      end: { ...fixture.end, right: x + 10 },
    });
    assert.ok(result.left >= 12);
    assert.ok(result.left + fixture.width <= 1188);
  }
});

test("partially offscreen or viewport-filling selections retain the regular toolbar", () => {
  assert.equal(
    selectionToolbarPosition({ ...fixture, start: { ...fixture.start, top: 40 } }),
    null,
  );
  assert.equal(
    selectionToolbarPosition({ ...fixture, end: { ...fixture.end, bottom: 820 } }),
    null,
  );
  assert.equal(
    selectionToolbarPosition({
      ...fixture,
      start: { ...fixture.start, top: 80 },
      end: { ...fixture.end, bottom: 780 },
    }),
    null,
  );
});

test("narrow or unavailable geometry retains keyboard-accessible regular toolbar", () => {
  assert.equal(selectionToolbarPosition({ ...fixture, width: 1400 }), null);
  assert.equal(selectionToolbarPosition({ ...fixture, height: 0 }), null);
  assert.equal(
    selectionToolbarPosition({ ...fixture, start: { ...fixture.start, top: NaN } }),
    null,
  );
});

test("visual viewport offsets still constrain the entire toolbar", () => {
  const viewport = { left: 100, top: 150, right: 900, bottom: 650 };
  const result = selectionToolbarPosition({ ...fixture, viewport });
  assert.ok(result.left >= viewport.left + 12);
  assert.ok(result.left + fixture.width <= viewport.right - 12);
  assert.ok(result.top >= viewport.top + 12);
  assert.ok(result.top + fixture.height <= viewport.bottom - 12);
});

// A selection inside a code block: lines 24px tall, the block from 280 to 520.
const inCode = (line, block = { top: 280, bottom: 520 }) => ({
  ...fixture,
  start: { ...fixture.start, top: line, bottom: line + 24 },
  end: { ...fixture.end, top: line, bottom: line + 24 },
  block,
});

test("a selection in a code block puts the toolbar outside the block, at the nearer edge", () => {
  // Near the top: above the block, clear of its first lines and its controls.
  const upper = selectionToolbarPosition(inCode(330));
  assert.deepEqual(upper, { left: 260, top: 222 });
  assert.ok(upper.top + fixture.height < 280);
  // Near the bottom: below the block.
  assert.deepEqual(selectionToolbarPosition(inCode(480)), { left: 260, top: 530 });
});

test("a code block edge without room gives way to the other edge, then to the selection", () => {
  // The block starts under the page bar: no room above it, so below.
  assert.deepEqual(selectionToolbarPosition(inCode(120, { top: 90, bottom: 400 })), {
    left: 260,
    top: 410,
  });
  // The block runs past the viewport's end: the nearer edge is out of reach.
  assert.deepEqual(selectionToolbarPosition(inCode(600, { top: 280, bottom: 1400 })), {
    left: 260,
    top: 222,
  });
  // Neither edge is in view: beside the selection, as in prose.
  assert.deepEqual(
    selectionToolbarPosition(inCode(400, { top: -300, bottom: 1400 })),
    selectionToolbarPosition({ ...inCode(400), block: undefined }),
  );
  // A box that couldn't be measured changes nothing.
  assert.deepEqual(
    selectionToolbarPosition(inCode(400, { top: NaN, bottom: NaN })),
    selectionToolbarPosition({ ...inCode(400), block: undefined }),
  );
});
