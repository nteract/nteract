// The scenegraph that crosses from the chart Worker to the page, and the
// page's check of it. The page treats a returned scene as untrusted input to
// its SVG renderer, whoever built it: `pageScene` rebuilds it from known mark
// types and item keys, each value of its expected type and size, and refuses
// a scene over the mark or nesting bounds, or over the cumulative budgets for
// path text, label text, other strings, gradient stops and tooltip payload,
// with one sentence. Structured clone keeps an item referenced many times as one
// object; the budgets count every reference, before anything is copied, so a
// small message can't expand into a large drawing. The renderer's own
// cleaning (vega-chart.mjs cleanItem) still runs on every item it writes. No
// DOM.

/** The mark types the page draws. A Worker's shape mark arrives as a path
 * mark (chart-dataflow.mjs plainScene); an image would load a URL. */
export const SCENE_MARKS = Object.freeze(
  new Set(["group", "rect", "symbol", "path", "line", "area", "rule", "text", "arc", "trail"]),
);

/** Most items a scene may hold, across every mark: the row budget's points
 * with room for axes, legends and a layered second mark. */
export const SCENE_MAX_ITEMS = 250_000;
/** Deepest group nesting: Vega-Lite's facets, concats and layers in the
 * spec's 32-view bound nest far less. */
export const SCENE_MAX_DEPTH = 32;
const MAX_TEXT = 10_000;
/** A line or area through 100,000 points is one path string of a few MB. */
const MAX_PATH = 8_000_000;
const MAX_STOPS = 256;
const MAX_DASH = 64;

/** Cumulative budgets across a whole scene, every reference counted: path
 * and symbol-shape characters (two lines or areas through the row budget's
 * points), label characters, other strings (names, roles, fonts and aria
 * descriptions, about 100 characters for each of SCENE_MAX_ITEMS), gradient
 * stops, and tooltip payload (strings and keys by length, any other value as
 * 8; 100,000 points with a 40-field tooltip each fit). */
export const SCENE_BUDGET = Object.freeze({
  path: 16_000_000,
  text: 1_000_000,
  strings: 24_000_000,
  stops: 4_096,
  tooltip: 32_000_000,
});
// The string keys that may run to 1,000 characters (Vega-Lite writes an
// aria description for each mark); the others stop at 256.
const LONG_STRINGS = new Set(["description", "ariaRoleDescription"]);
/** The largest magnitude a number in a scene may have; a coordinate past it,
 * or NaN or an infinity, is left out. */
export const SCENE_MAX_NUMBER = 1e7;

const STRING_KEYS = [
  "name",
  "role",
  "align",
  "baseline",
  "blend",
  "strokeCap",
  "interpolate",
  "orient",
  "dir",
  "ellipsis",
  "lineBreak",
  "font",
  "fontStyle",
  "fontVariant",
  "description",
  "ariaRole",
  "ariaRoleDescription",
  "cursor",
];
const BOOLEAN_KEYS = ["interactive", "clip", "defined", "aria", "strokeForeground"];
const NUMBER_KEYS = [
  "zindex",
  "x",
  "y",
  "width",
  "height",
  "fillOpacity",
  "opacity",
  "strokeOpacity",
  "strokeWidth",
  "strokeDashOffset",
  "strokeOffset",
  "startAngle",
  "endAngle",
  "innerRadius",
  "outerRadius",
  "cornerRadius",
  "padAngle",
  "cornerRadiusTopLeft",
  "cornerRadiusTopRight",
  "cornerRadiusBottomLeft",
  "cornerRadiusBottomRight",
  "tension",
  "scaleX",
  "scaleY",
  "x2",
  "y2",
  "size",
  "angle",
  "theta",
  "radius",
  "dx",
  "dy",
  "limit",
  "lineHeight",
  "fontSize",
];
/** Every key a scene node may carry across the Worker boundary: Vega's own
 * serialization keys, less image and link keys, plus the tooltip and cursor
 * it leaves out. */
export const SCENE_KEYS = Object.freeze([
  "marktype",
  "items",
  ...STRING_KEYS,
  ...BOOLEAN_KEYS,
  ...NUMBER_KEYS,
  "fill",
  "stroke",
  "strokeDash",
  "fontWeight",
  "path",
  "shape",
  "text",
  "tooltip",
]);

export const SCENE_TOO_BIG = `This chart has more than ${SCENE_MAX_ITEMS.toLocaleString("en-US")} marks; a chart draws at most that many.`;
export const SCENE_MALFORMED = "This chart's drawing couldn't be read.";
export const SCENE_TOO_LARGE = "This chart's drawing is too large to show.";

/** Thrown by `pageScene`; its message is the sentence the chart shows. */
export class SceneRefusal extends Error {
  get refusal() {
    return true;
  }
}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const shortString = (value, max = MAX_TEXT) =>
  typeof value === "string" && value.length <= max ? value : undefined;
const number = (value) =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= SCENE_MAX_NUMBER
    ? value
    : undefined;

/** Spend `amount` of `budget`'s `kind`, or refuse the scene. */
function spend(budget, kind, amount) {
  budget[kind] -= amount;
  if (budget[kind] < 0) throw new SceneRefusal(SCENE_TOO_LARGE);
}

/** Spend a tooltip value's size from the budget, walking it iteratively and
 * stopping as soon as the budget runs out. Strings and keys count their
 * length, anything else 8; a nested value 64 levels down is malformed. */
function spendTooltip(budget, value) {
  const stack = [[value, 0]];
  while (stack.length) {
    const [next, depth] = stack.pop();
    if (typeof next === "string") spend(budget, "tooltip", next.length);
    else if (next === null || typeof next !== "object") spend(budget, "tooltip", 8);
    else {
      if (depth >= 64) throw new SceneRefusal(SCENE_MALFORMED);
      spend(budget, "tooltip", 8);
      if (Array.isArray(next)) for (const item of next) stack.push([item, depth + 1]);
      else
        for (const key of Object.keys(next)) {
          spend(budget, "tooltip", key.length);
          stack.push([next[key], depth + 1]);
        }
    }
  }
}

let gradients = 0;

/**
 * `scene` rebuilt as the page draws it: null-free plain objects holding only
 * SCENE_KEYS, each value of its type and size, gradients renamed to ids
 * unique in this document. Throws SceneRefusal for a scene over
 * SCENE_MAX_ITEMS items or SCENE_MAX_DEPTH nesting, or one that isn't a
 * scene at all. Iterative, so a deep scene can't overflow the stack.
 */
export function pageScene(scene) {
  if (!isRecord(scene) || !SCENE_MARKS.has(scene.marktype)) throw new SceneRefusal(SCENE_MALFORMED);
  const renamed = new Map();
  const budget = { ...SCENE_BUDGET };
  let items = 0;
  const root = {};
  // Each entry copies one mark from `from` into `into` at `depth` groups deep.
  const stack = [{ from: scene, into: root, depth: 0 }];
  while (stack.length) {
    const { from, into, depth } = stack.pop();
    if (!isRecord(from) || !SCENE_MARKS.has(from.marktype)) throw new SceneRefusal(SCENE_MALFORMED);
    if (depth > SCENE_MAX_DEPTH) throw new SceneRefusal(SCENE_MALFORMED);
    copyFields(from, into, renamed, budget);
    into.marktype = from.marktype;
    const list = own(from, "items") && Array.isArray(from.items) ? from.items : [];
    items += list.length;
    if (items > SCENE_MAX_ITEMS) throw new SceneRefusal(SCENE_TOO_BIG);
    into.items = new Array(list.length);
    for (let index = 0; index < list.length; index++) {
      const item = list[index];
      if (!isRecord(item)) throw new SceneRefusal(SCENE_MALFORMED);
      const copy = {};
      copyFields(item, copy, renamed, budget);
      into.items[index] = copy;
      // A group item holds marks of its own.
      if (from.marktype === "group") {
        const marks = own(item, "items") && Array.isArray(item.items) ? item.items : [];
        items += marks.length;
        if (items > SCENE_MAX_ITEMS) throw new SceneRefusal(SCENE_TOO_BIG);
        copy.items = new Array(marks.length);
        for (let mark = 0; mark < marks.length; mark++) {
          copy.items[mark] = {};
          stack.push({ from: marks[mark], into: copy.items[mark], depth: depth + 1 });
        }
      }
    }
  }
  return root;
}

/** Copy the keys the page draws from `from` into `into`, each checked, and
 * spend what they cost from `budget`. */
function copyFields(from, into, renamed, budget) {
  for (const key of STRING_KEYS) {
    const value = own(from, key)
      ? shortString(from[key], LONG_STRINGS.has(key) ? 1_000 : 256)
      : undefined;
    if (value === undefined) continue;
    spend(budget, "strings", value.length);
    into[key] = value;
  }
  for (const key of BOOLEAN_KEYS)
    if (own(from, key) && typeof from[key] === "boolean") into[key] = from[key];
  for (const key of NUMBER_KEYS) {
    const value = own(from, key) ? number(from[key]) : undefined;
    if (value !== undefined) into[key] = value;
  }
  for (const key of ["fill", "stroke"]) {
    if (!own(from, key)) continue;
    const paint = scenePaint(from[key], renamed, budget);
    if (paint !== undefined) into[key] = paint;
  }
  if (own(from, "fontWeight")) {
    const weight = number(from.fontWeight) ?? shortString(from.fontWeight, 32);
    if (weight !== undefined) into.fontWeight = weight;
  }
  if (own(from, "strokeDash")) {
    const dash = from.strokeDash;
    if (
      Array.isArray(dash) &&
      dash.length <= MAX_DASH &&
      dash.every((n) => number(n) !== undefined)
    )
      into.strokeDash = [...dash];
    else if (shortString(dash, 256) !== undefined) {
      spend(budget, "strings", dash.length);
      into.strokeDash = dash;
    }
  }
  // A path, or a symbol's shape (a name or an SVG path string).
  for (const key of ["path", "shape"]) {
    const path = own(from, key) ? shortString(from[key], MAX_PATH) : undefined;
    if (path === undefined) continue;
    spend(budget, "path", path.length);
    into[key] = path;
  }
  if (own(from, "text")) {
    const text = from.text;
    if (shortString(text) !== undefined) {
      spend(budget, "text", text.length);
      into.text = text;
    } else if (number(text) !== undefined) into.text = text;
    else if (
      Array.isArray(text) &&
      text.length <= 64 &&
      text.every((line) => shortString(line) !== undefined)
    ) {
      spend(
        budget,
        "text",
        text.reduce((sum, line) => sum + line.length, 0),
      );
      into.text = [...text];
    }
  }
  // The tooltip's value reaches the reader only through the bounded
  // formatter (vega-chart.mjs formatTooltip), as text; its size is spent
  // here, since the page holds it.
  if (own(from, "tooltip") && from.tooltip !== undefined && typeof from.tooltip !== "function") {
    spendTooltip(budget, from.tooltip);
    into.tooltip = from.tooltip;
  }
}

/** A fill or stroke: a color string, or a gradient with its stops, renamed
 * to an id unique in this document. The renderer cleans the colors. */
function scenePaint(value, renamed, budget) {
  const color = shortString(value, 256);
  if (color !== undefined) return color;
  if (!isRecord(value) || (value.gradient !== "linear" && value.gradient !== "radial"))
    return undefined;
  const stops = Array.isArray(value.stops) ? value.stops.slice(0, MAX_STOPS) : [];
  spend(budget, "stops", stops.length);
  const key = shortString(value.id, 256) ?? value;
  if (!renamed.has(key)) renamed.set(key, `pages-chart-gradient-${++gradients}`);
  const out = { gradient: value.gradient, id: renamed.get(key) };
  for (const field of ["x1", "y1", "x2", "y2", "r1", "r2"])
    if (number(value[field]) !== undefined) out[field] = value[field];
  out.stops = stops.map((stop) => ({
    offset: isRecord(stop) && number(stop.offset) !== undefined ? stop.offset : 0,
    color: isRecord(stop) ? (shortString(stop.color, 256) ?? "transparent") : "transparent",
  }));
  return out;
}
