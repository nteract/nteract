// Which font a chart draws its text in. Vega lays text out by widths the chart
// Worker measures on an OffscreenCanvas, and the page then draws the text as
// SVG, so the two must agree. A Worker can't see the page's fonts and loads
// none, and a system alias can resolve to another face in one: in Firefox on
// macOS, a Worker measures `system-ui` and `-apple-system` about 12 percent
// narrower than the page draws them. In WebKit on macOS the face is the same,
// but SVG draws its digits 2 to 5 percent wider than any canvas measures them.
//
// So the page probes each new Worker: the Worker measures the same strings in
// the Page's own stack that the page draws as SVG text, and the charts on that
// Worker keep the Page's stack when every width agrees, or draw in
// CHART_FALLBACK_FONT when one doesn't. Measured in Chromium, Firefox and
// WebKit on macOS and on Linux with the CI runner's fonts, the fallback is
// drawn within 0.25 px of what the Worker measures (Linux reaches Liberation
// Sans, which has Arial's metrics). No DOM, no Vega.

export const CHART_FALLBACK_FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';

/** The strings a probe measures, and the text styles it measures them in:
 * the theme's label and title styles (chart-dataflow.mjs themeConfig). */
export const PROBE_TEXTS = Object.freeze([
  "Calls by tool, with a title",
  "0.0 0.5 1.0 1.5 2.0 2.5 3.0",
  "abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ",
]);
export const PROBE_STYLES = Object.freeze([
  Object.freeze({ fontSize: 11 }),
  Object.freeze({ fontSize: 14, fontWeight: 600 }),
]);
/** Widths one probe answers: each stack, style and string. */
export const probeCount = (stacks) => stacks.length * PROBE_STYLES.length * PROBE_TEXTS.length;
/** The largest width a probe answer may hold. */
export const PROBE_MAX_WIDTH = 100_000;

/** Vega text items and strings to measure for `stacks`, in answer order. */
export const probeItems = (stacks) =>
  stacks.flatMap((font) =>
    PROBE_STYLES.flatMap((style) =>
      PROBE_TEXTS.map((text) => ({ item: { ...style, font }, text })),
    ),
  );

/** Whether two widths agree: within 1 px, or 1 percent of the larger. */
const agrees = (a, b) => Math.abs(a - b) <= Math.max(1, 0.01 * Math.max(a, b));

/** A font stack a chart may name: a short string that loads nothing and
 * can't break out of a CSS font shorthand. */
export const usableFont = (font) =>
  typeof font === "string" &&
  font.length > 0 &&
  font.length <= 256 &&
  !/[\\();{}]/.test(font) &&
  !/url|src|image-set/i.test(font);

/**
 * The stack charts on a Worker draw in, from a probe of `stacks` (the Page's
 * stack, then the fallback): the Page's when the widths the page draws and
 * the Worker measures for it all agree, otherwise the fallback. `page` and
 * `worker` hold widths in probeItems order; `page` is null when the page
 * can't lay text out.
 */
export function chooseChartFont(stacks, page, worker) {
  const [own] = stacks;
  if (!usableFont(own) || own === CHART_FALLBACK_FONT || !page) return CHART_FALLBACK_FONT;
  const per = PROBE_STYLES.length * PROBE_TEXTS.length;
  for (let i = 0; i < per; i++) if (!agrees(page[i], worker[i])) return CHART_FALLBACK_FONT;
  return own;
}
