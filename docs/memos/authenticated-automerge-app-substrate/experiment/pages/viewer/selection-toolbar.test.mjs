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
