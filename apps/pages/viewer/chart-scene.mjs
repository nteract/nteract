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

import { CHART_SYMBOL_SHAPES } from "../shared/chart-spec.mjs";

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
/** Most path commands one path may hold, weighted by PATH_COMMAND_COST: a
 * 100,000-vertex geoshape costs 100,000. */
export const SCENE_PATH_COMMANDS = 500_000;
/** What one path command costs against the command budgets, from the
 * renderer benchmark (scripts/chart-path-bench.mjs) in its slowest engine:
 * a line, move or close about 0.1 to 0.45 µs each, a cubic or quadratic
 * curve about 0.8 µs, an arc about 2.2 µs. */
const PATH_COMMAND_COST = { m: 1, l: 1, h: 1, v: 1, t: 1, z: 1, c: 2, s: 2, q: 2, a: 8 };
/** Parameters each command takes, as Vega's path parser counts them
 * (vega-scenegraph path/parse.js); a multiple repeats the command. */
const PATH_ARITY = { m: 2, l: 2, h: 1, v: 1, t: 2, z: 0, c: 6, s: 4, q: 4, a: 7 };
const MAX_STOPS = 256;
const MAX_DASH = 64;

/** Cumulative budgets across a whole scene, every reference counted: path
 * characters (two lines or areas through the row budget's
 * points), label characters, other strings (names, roles, fonts and aria
 * descriptions, about 100 characters for each of SCENE_MAX_ITEMS), gradient
 * stops, weighted path commands (SCENE_PATH_COMMANDS, twice over), tooltip payload (strings and keys by length, at least 1, any other
 * value as 8) and tooltip entries (each tooltip, array entry and object
 * field). 100,000 points with a 16-field tooltip each, names and values of 8
 * characters, fit both. */
export const SCENE_BUDGET = Object.freeze({
  path: 16_000_000,
  pathCommands: 1_000_000,
  text: 1_000_000,
  strings: 24_000_000,
  stops: 4_096,
  tooltip: 32_000_000,
  tooltipEntries: 2_000_000,
});
/** Most entries one tooltip array or object may hold. */
export const TOOLTIP_MAX_ENTRIES = 10_000;
/** Deepest tooltip nesting. */
const TOOLTIP_MAX_DEPTH = 64;
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

/** A tooltip container the walk may enter: a plain array, or an object
 * with no prototype but Object's. Structured clone and the Worker's JSON copy
 * (chart-dataflow.mjs plainTooltip) make nothing else. */
const plainContainer = (value) =>
  Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** An empty copy of a tooltip container. */
const emptyLike = (container) => (Array.isArray(container) ? [] : {});
/** Put `value` at `key` in `copy` as an own property, `__proto__` too. */
const put = (copy, key, value) =>
  Object.defineProperty(copy, key, { value, enumerable: true, writable: true, configurable: true });

/**
 * A copy of a tooltip value built from what the walk charged, or a refusal
 * of the scene. Every entry is charged before it's read: the tooltip itself
 * on entry, and an array's entries (indices below its length) or an object's
 * own enumerable keys all at once, before the walk descends. Nothing else on
 * a received value, such as a property set on an array past its entries,
 * is read or kept. Each frame on the stack walks one container by index, so
 * the stack holds at most TOOLTIP_MAX_DEPTH frames whatever the width. An
 * object's keys are listed before they're charged; a container over
 * TOOLTIP_MAX_ENTRIES is refused on its first visit, so that listing is
 * never repeated past what was charged.
 */
function copyTooltip(budget, value) {
  spend(budget, "tooltipEntries", 1);
  const frames = [];
  const root = { value: undefined };
  // Where the value being visited goes: a container copy and its key.
  let into = root;
  let key = "value";
  let next = value;
  for (;;) {
    if (typeof next === "string") {
      spend(budget, "tooltip", Math.max(1, next.length));
      put(into, key, next);
    } else if (next === null || typeof next !== "object") {
      spend(budget, "tooltip", 8);
      put(into, key, next);
    } else {
      if (!plainContainer(next)) throw new SceneRefusal(SCENE_MALFORMED);
      if (frames.length >= TOOLTIP_MAX_DEPTH) throw new SceneRefusal(SCENE_MALFORMED);
      const keys = Array.isArray(next) ? null : Object.keys(next);
      const length = keys ? keys.length : next.length;
      if (length > TOOLTIP_MAX_ENTRIES) throw new SceneRefusal(SCENE_TOO_LARGE);
      spend(budget, "tooltipEntries", length);
      spend(budget, "tooltip", 8);
      const copy = emptyLike(next);
      put(into, key, copy);
      frames.push({ container: next, copy, keys, index: 0, length });
    }
    // Step to the next entry, leaving each finished container.
    for (;;) {
      const frame = frames.at(-1);
      if (!frame) return root.value;
      if (frame.index < frame.length) {
        const index = frame.index++;
        into = frame.copy;
        if (frame.keys) {
          key = frame.keys[index];
          spend(budget, "tooltip", Math.max(1, key.length));
        } else key = String(index);
        next = frame.container[key];
        break;
      }
      frames.pop();
    }
  }
}

const isDigit = (code) => code >= 48 && code <= 57;
const isSpace = (code) => code === 32 || (code >= 9 && code <= 13);
/** The command `path` holds at `index`, lowercase, or undefined. */
const commandAt = (path, index) => {
  const code = path.charCodeAt(index);
  if (code >= 128) return undefined;
  const type = String.fromCharCode(code | 32);
  return Object.hasOwn(PATH_ARITY, type) ? type : undefined;
};
const skipSpace = (path, index) => {
  while (isSpace(path.charCodeAt(index))) index++;
  return index;
};
/** Where a number starting at `index` ends, or -1: Vega's
 * `[+-]?(\d*\.\d+|\d+\.|\d+)([eE][+-]?\d+)?`. */
function numberEnd(path, index) {
  if (path.charCodeAt(index) === 43 || path.charCodeAt(index) === 45) index++;
  let digits = 0;
  while (isDigit(path.charCodeAt(index))) (index++, digits++);
  if (path.charCodeAt(index) === 46) {
    index++;
    while (isDigit(path.charCodeAt(index))) (index++, digits++);
  }
  if (!digits) return -1;
  if ((path.charCodeAt(index) | 32) === 101) {
    let exponent = index + 1;
    if (path.charCodeAt(exponent) === 43 || path.charCodeAt(exponent) === 45) exponent++;
    if (isDigit(path.charCodeAt(exponent))) {
      index = exponent;
      while (isDigit(path.charCodeAt(index))) index++;
    }
  }
  return index;
}

/**
 * What an SVG path string costs to draw, or null when it can't be read
 * exactly as Vega's path parser and the browser read it. Each command
 * counts once per full set of parameters (an `L` with six numbers draws
 * three lines), times its PATH_COMMAND_COST. Parameters are read by
 * position, as Vega reads them: an arc's large-arc and sweep flags are one
 * character each, `0` or `1`, so `a1 1 0 011 1` is one arc. Separators are
 * whitespace with at most one comma. A parameter count that isn't a
 * positive multiple of the command's, a letter that isn't a command,
 * anything before the first command, or anything after a `z`, is
 * unreadable. One pass over characters the path budget has already charged.
 */
export function pathCost(path) {
  let cost = 0;
  let index = skipSpace(path, 0);
  while (index < path.length) {
    const type = commandAt(path, index);
    if (type === undefined) return null;
    const arity = PATH_ARITY[type];
    index = skipSpace(path, index + 1);
    let count = 0;
    while (index < path.length && commandAt(path, index) === undefined) {
      if (!arity) return null;
      const position = count % arity;
      const flag = type === "a" && (position === 3 || position === 4);
      const end = flag
        ? path.charCodeAt(index) === 48 || path.charCodeAt(index) === 49
          ? index + 1
          : -1
        : numberEnd(path, index);
      if (end < 0) return null;
      count++;
      index = skipSpace(path, end);
      if (path.charCodeAt(index) === 44) index = skipSpace(path, index + 1);
    }
    if (arity && (count === 0 || count % arity)) return null;
    cost += (arity ? count / arity : 1) * PATH_COMMAND_COST[type];
  }
  return cost;
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
  // A path, read as the browser will draw it.
  const path = own(from, "path") ? shortString(from.path, MAX_PATH) : undefined;
  if (path !== undefined) {
    spend(budget, "path", path.length);
    const commands = pathCost(path);
    if (commands === null) throw new SceneRefusal(SCENE_MALFORMED);
    if (commands > SCENE_PATH_COMMANDS) throw new SceneRefusal(SCENE_TOO_LARGE);
    spend(budget, "pathCommands", commands);
    into.path = path;
  }
  // A symbol draws one of Vega's own shapes. Vega keeps every custom shape
  // it parses in a module-wide cache that nothing clears, so any other
  // string is left out and the symbol draws as Vega's default circle.
  if (own(from, "shape") && CHART_SYMBOL_SHAPES.has(from.shape)) into.shape = from.shape;
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
  // formatter (vega-chart.mjs formatTooltip), as text. The page keeps a copy
  // built as its size is spent, never the received value.
  if (own(from, "tooltip") && from.tooltip !== undefined && typeof from.tooltip !== "function")
    into.tooltip = copyTooltip(budget, from.tooltip);
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
