import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHART_FALLBACK_FONT,
  PROBE_STYLES,
  PROBE_TEXTS,
  chooseChartFont,
  probeCount,
  probeItems,
  usableFont,
} from "./chart-font.mjs";

const STACKS = ['Inter, system-ui, "Segoe UI", sans-serif', CHART_FALLBACK_FONT];
const widths = (shift = () => 0) =>
  Array.from({ length: probeCount(STACKS) }, (_, i) => 100 + i * 10 + shift(i));

test("a probe measures each stack in each style and string, in order", () => {
  const items = probeItems(STACKS);
  assert.equal(items.length, probeCount(STACKS));
  assert.equal(items.length, 2 * PROBE_STYLES.length * PROBE_TEXTS.length);
  assert.deepEqual(items[0], { item: { fontSize: 11, font: STACKS[0] }, text: PROBE_TEXTS[0] });
  assert.equal(items.at(-1).item.font, CHART_FALLBACK_FONT);
  assert.equal(items.at(-1).item.fontWeight, 600);
});

test("charts keep the Page's stack when every width agrees within 1 px or 1 percent", () => {
  assert.equal(chooseChartFont(STACKS, widths(), widths()), STACKS[0]);
  assert.equal(
    chooseChartFont(
      STACKS,
      widths(),
      widths(() => 0.9),
    ),
    STACKS[0],
  );
  // 1 percent of a long string's width.
  const wide = widths((i) => (i === 2 ? 1_000 : 0));
  assert.equal(
    chooseChartFont(
      STACKS,
      wide,
      wide.map((w, i) => (i === 2 ? w * 1.009 : w)),
    ),
    STACKS[0],
  );
});

test("charts draw in the fallback when the Page's stack measures differently in the Worker", () => {
  // Firefox on macOS: system-ui about 12 percent narrower in a Worker.
  assert.equal(
    chooseChartFont(
      STACKS,
      widths(),
      widths((i) => -0.12 * (100 + i * 10)),
    ),
    CHART_FALLBACK_FONT,
  );
  // One width off is enough.
  assert.equal(
    chooseChartFont(
      STACKS,
      widths(),
      widths((i) => (i === 5 ? 3 : 0)),
    ),
    CHART_FALLBACK_FONT,
  );
  // Only the Page's stack decides; the fallback's widths are recorded, not compared.
  const fallbackOff = widths((i) => (i >= 6 ? 50 : 0));
  assert.equal(chooseChartFont(STACKS, widths(), fallbackOff), STACKS[0]);
  // No page measure, a stack that isn't usable, or the fallback itself.
  assert.equal(chooseChartFont(STACKS, null, widths()), CHART_FALLBACK_FONT);
  assert.equal(
    chooseChartFont(["url(x.woff)", CHART_FALLBACK_FONT], widths(), widths()),
    CHART_FALLBACK_FONT,
  );
  assert.equal(
    chooseChartFont([CHART_FALLBACK_FONT, CHART_FALLBACK_FONT], widths(), widths()),
    CHART_FALLBACK_FONT,
  );
});

test("a usable font stack is a short string that loads nothing", () => {
  for (const font of [STACKS[0], CHART_FALLBACK_FONT, "sans-serif"])
    assert.equal(usableFont(font), true);
  for (const font of [
    "",
    null,
    42,
    "x".repeat(257),
    "url(https://x.example/f.woff)",
    "a; b",
    "a {}",
    "a\\62",
    "image-set(x)",
  ])
    assert.equal(usableFont(font), false, String(font));
});
