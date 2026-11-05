import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutMargin, marginFits } from "./comment-margin-layout.mjs";

const items = [
  { id: "c", anchorTop: 120, height: 50 },
  { id: "a", anchorTop: 0, height: 80 },
  { id: "b", anchorTop: 40, height: 40 },
];

test("cards keep their anchors when there's room", () => {
  assert.deepEqual(
    layoutMargin([
      { id: "a", anchorTop: 0, height: 20 },
      { id: "b", anchorTop: 100, height: 20 },
    ]),
    [
      { id: "a", top: 0 },
      { id: "b", top: 100 },
    ],
  );
});

test("overlapping cards push down in document order", () => {
  assert.deepEqual(layoutMargin(items, { gap: 10 }), [
    { id: "a", top: 0 },
    { id: "b", top: 90 },
    { id: "c", top: 140 },
  ]);
});

test("the active card aligns with its passage and neighbours move around it", () => {
  assert.deepEqual(layoutMargin(items, { gap: 10, activeId: "b" }), [
    { id: "a", top: -50 },
    { id: "b", top: 40 },
    { id: "c", top: 120 },
  ]);
});

test("an unknown active id lays out as if none were active; no cards is fine", () => {
  assert.deepEqual(
    layoutMargin(items, { gap: 10, activeId: "zz" }),
    layoutMargin(items, { gap: 10 }),
  );
  assert.deepEqual(layoutMargin([]), []);
});

test("layout never overlaps cards", () => {
  for (let seed = 1; seed < 40; seed++) {
    const random = (n) => ((seed * 9301 + n * 49297) % 233280) / 233280;
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `t${i}`,
      anchorTop: Math.floor(random(i) * 400),
      height: 20 + Math.floor(random(i + 50) * 60),
    }));
    const height = Object.fromEntries(many.map((m) => [m.id, m.height]));
    for (const activeId of [null, "t3"]) {
      const laid = layoutMargin(many, { gap: 6, activeId });
      for (let i = 1; i < laid.length; i++)
        assert.ok(laid[i].top >= laid[i - 1].top + height[laid[i - 1].id] + 6 - 1e-9);
    }
  }
});

test("marginFits needs room for the card and both gutters", () => {
  assert.equal(marginFits({ viewportWidth: 1600, contentRight: 1250, cardWidth: 260 }), true);
  assert.equal(marginFits({ viewportWidth: 1440, contentRight: 1248, cardWidth: 260 }), false);
});
