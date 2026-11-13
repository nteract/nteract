// The checks a Vega-Lite chart spec passes before Pages draws it. No DOM and
// no Vega runtime, so the viewer and the host can run the same function: the
// viewer runs it before every draw (viewer/vega-chart.mjs), and a host write
// path can run it to refuse a spec with the same sentence. Both the spec and
// the data it reads are untrusted.
//
// A chart reads only named data the caller supplies. Every `data` in a spec is
// `{ "name": ... }`: no URL, no inline values, no generator. Nothing in a spec
// may fetch or navigate: no `url` or `href` key, no image mark, no CSS
// `url(...)` in any string, and a cursor is a keyword. It may not add input
// controls or Vega signals, name a custom format function, or bind events to
// the Page. Every expression is parsed and checked against
// CHART_EXPRESSION_FUNCTIONS (see `expressionProblem`).
//
// Cost: views, nesting and spec bytes are bounded here, rows per dataset in
// CHART_MAX_ROWS, and the transforms that multiply rows or cost are bounded or
// refused in TRANSFORM_BOUNDS. What remains unbounded is still the reader's
// own tab: facets (one cell per distinct value), marks per row (up to
// CHART_MAX_ROWS SVG elements), and window, density and regression work
// within their bounds. Running Vega in a Worker with a kill timer is what
// would bound those; nothing here does.
import { parseExpression } from "vega-expression";
import { parseSelector } from "vega-event-selector";

export const CHART_SPEC_LIMITS = Object.freeze({
  /** UTF-8 bytes of the spec as JSON. */
  maxBytes: 64 * 1024,
  /** Views after expansion: each layer, concatenated view, and each repeated
   * copy of a repeat's inner spec. A facet counts once; its cells depend on
   * the data. */
  maxViews: 32,
  /** Nesting of objects and arrays. */
  maxDepth: 32,
});

/** Rows a chart reads from one dataset. viewer/vega-chart.mjs refuses more. */
export const CHART_MAX_ROWS = 100_000;

/**
 * Vega expression functions a spec may call. Vega's own codegen already
 * refuses anything that isn't a Vega function; this list leaves out the ones
 * a chart over a Page's sources doesn't need or that let a small spec do
 * unbounded work: dataset writes (`modify`), lasso and tree helpers, event and
 * window geometry, logging, regular expressions, and the generators
 * `sequence`, `timeSequence`, `utcSequence` and `pad`, which build arrays or
 * strings of any length.
 */
export const CHART_EXPRESSION_FUNCTIONS = Object.freeze(
  new Set([
    // Types and conversion
    "isArray",
    "isBoolean",
    "isDate",
    "isDefined",
    "isNumber",
    "isObject",
    "isString",
    "isValid",
    "toBoolean",
    "toDate",
    "toNumber",
    "toString",
    "if",
    // Math
    "isNaN",
    "isFinite",
    "abs",
    "acos",
    "asin",
    "atan",
    "atan2",
    "ceil",
    "clamp",
    "cos",
    "exp",
    "floor",
    "hypot",
    "log",
    "max",
    "min",
    "pow",
    "random",
    "round",
    "sin",
    "sqrt",
    "tan",
    // Statistics
    "sampleNormal",
    "cumulativeNormal",
    "densityNormal",
    "quantileNormal",
    "sampleLogNormal",
    "cumulativeLogNormal",
    "densityLogNormal",
    "quantileLogNormal",
    "sampleUniform",
    "cumulativeUniform",
    "densityUniform",
    "quantileUniform",
    // Dates and times
    "now",
    "datetime",
    "date",
    "day",
    "dayofyear",
    "year",
    "quarter",
    "month",
    "week",
    "hours",
    "minutes",
    "seconds",
    "milliseconds",
    "time",
    "timezoneoffset",
    "timeOffset",
    "utc",
    "utcdate",
    "utcday",
    "utcdayofyear",
    "utcyear",
    "utcquarter",
    "utcmonth",
    "utcweek",
    "utchours",
    "utcminutes",
    "utcseconds",
    "utcmilliseconds",
    "utcOffset",
    // Arrays and strings
    "extent",
    "clampRange",
    "indexof",
    "inrange",
    "join",
    "lastindexof",
    "length",
    "peek",
    "pluck",
    "reverse",
    "slice",
    "sort",
    "span",
    "lower",
    "parseFloat",
    "parseInt",
    "replace",
    "split",
    "substring",
    "trim",
    "truncate",
    "upper",
    "merge",
    // Formatting
    "dayFormat",
    "dayAbbrevFormat",
    "format",
    "monthFormat",
    "monthAbbrevFormat",
    "timeUnitSpecifier",
    "timeFormat",
    "timeParse",
    "utcFormat",
    "utcParse",
    // Color
    "rgb",
    "hsl",
    "lab",
    "hcl",
    "luminance",
    "contrast",
    // Scales and data in the chart itself
    "scale",
    "invert",
    "bandwidth",
    "domain",
    "range",
    "data",
    "indata",
  ]),
);

// Names an expression may not use as an identifier, a property or an object
// key, written plainly or as a string.
const FORBIDDEN_NAMES = new Set(["constructor", "__proto__", "prototype"]);

/**
 * Why a parsed Vega expression can't run, or null. `functions` is the set a
 * call may name. The viewer runs the same policy over Vega's own parsed
 * dataflow with a wider set for the code Vega-Lite generates.
 *
 * - A call's callee is a plain identifier in `functions`.
 * - No forbidden name as an identifier, a property or an object key.
 * - A computed member's property is a literal (`datum["a b"]`, `row[0]`).
 *   vega-expression parses `datum[x]` and `datum["constructor"]` alike, as
 *   an identifier, so this also refuses prototype names written as strings.
 * - No regular expression literal.
 */
export function expressionProblem(ast, functions = CHART_EXPRESSION_FUNCTIONS) {
  const stack = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    switch (node.type) {
      case "CallExpression":
        if (node.callee?.type !== "Identifier") return "calls something that isn't a function name";
        if (!functions.has(node.callee.name)) return `calls ${node.callee.name}()`;
        stack.push(...node.arguments);
        continue;
      case "Identifier":
        if (FORBIDDEN_NAMES.has(node.name)) return `uses "${node.name}"`;
        continue;
      case "MemberExpression":
        if (node.computed && node.property?.type !== "Literal")
          return node.property?.type === "Identifier" && FORBIDDEN_NAMES.has(node.property.name)
            ? `uses "${node.property.name}"`
            : "indexes with something other than a literal";
        if (node.property?.type === "Literal" && FORBIDDEN_NAMES.has(String(node.property.value)))
          return `uses "${node.property.value}"`;
        stack.push(node.object, node.property);
        continue;
      case "Property":
        if (FORBIDDEN_NAMES.has(node.key?.name ?? String(node.key?.value)))
          return `uses "${node.key?.name ?? node.key?.value}"`;
        stack.push(node.value);
        continue;
      case "Literal":
        if (node.regex) return "uses a regular expression";
        continue;
      default:
        for (const [key, child] of Object.entries(node))
          if (key !== "type" && child && typeof child === "object") stack.push(child);
    }
  }
  return null;
}

/*
 * Where Vega-Lite 6.5.0 turns a spec string into a Vega expression or a call,
 * and what this module does with each:
 *
 * | Position                                   | Check                    |
 * | ------------------------------------------ | ------------------------ |
 * | `{ "expr": ... }` anywhere (ExprRef), a     | parsed, policy           |
 * |   parameter's `expr`                        |                          |
 * | transform `calculate`, `filter` (string,    | parsed, policy           |
 * |   and strings inside `and`/`or`/`not`)      |                          |
 * | condition `test`                            | parsed, policy           |
 * | axis, legend and header `labelExpr`         | parsed, policy           |
 * | `signal` (Vega `encode` passthrough in      | parsed, policy           |
 * |   axis, legend, title and header `encode`)  |                          |
 * | signal `init` and `update` strings          | parsed, policy           |
 * | selection `on` and `clear` event streams    | parsed as event selectors|
 * |   (string filters `[...]` are expressions)  |   and each filter checked|
 * | event-stream objects' `filter`              | parsed, policy           |
 * | `signals` in `config` (raw Vega signals)    | refused                  |
 * | `formatType` other than number, time, utc;  | refused: each names a    |
 * |   `customFormatTypes`, `numberFormatType`,  |   function Vega-Lite     |
 * |   `normalizedNumberFormatType`,             |   calls                  |
 * |   `timeFormatType`                          |                          |
 * | `bind` with an input or element             | refused                  |
 *
 * The viewer checks every expression in the compiled dataflow as well, so a
 * position missing here is refused before it runs.
 */
const EXPRESSION_KEYS = new Set([
  "expr",
  "calculate",
  "filter",
  "test",
  "labelExpr",
  "signal",
  "init",
  "update",
]);
const EVENT_STREAM_KEYS = new Set(["on", "clear"]);
const FORMAT_TYPES = new Set(["number", "time", "utc"]);
const CUSTOM_FORMAT_KEYS = new Set([
  "customFormatTypes",
  "numberFormatType",
  "normalizedNumberFormatType",
  "timeFormatType",
]);

/** CSS cursor keywords. A cursor is never a URL or an expression. */
export const CHART_CURSORS = Object.freeze(
  new Set([
    "auto",
    "default",
    "none",
    "context-menu",
    "help",
    "pointer",
    "progress",
    "wait",
    "cell",
    "crosshair",
    "text",
    "vertical-text",
    "alias",
    "copy",
    "move",
    "no-drop",
    "not-allowed",
    "grab",
    "grabbing",
    "all-scroll",
    "col-resize",
    "row-resize",
    "n-resize",
    "e-resize",
    "s-resize",
    "w-resize",
    "ne-resize",
    "nw-resize",
    "se-resize",
    "sw-resize",
    "ew-resize",
    "ns-resize",
    "nesw-resize",
    "nwse-resize",
    "zoom-in",
    "zoom-out",
  ]),
);

const CSS_ESCAPE = /\\(?:([0-9a-fA-F]{1,6})\s?|(.))/gs;
/** A string with CSS escapes decoded, so `u\72l(` reads as `url(`. */
const cssText = (text) =>
  text.replace(CSS_ESCAPE, (_m, hex, char) =>
    hex ? String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff) || 0xfffd) : char,
  );
// CSS functions that load a resource. A function token has no space before
// its parenthesis, so prose such as "image (left)" isn't one.
const CSS_RESOURCE = /(?:^|[^\w-])(?:url|src|image-set|-webkit-image-set)\(/i;
/** Whether a string would make CSS or SVG load something if it reached a
 * style or presentation attribute. */
export const loadsResource = (text) => CSS_RESOURCE.test(cssText(text));

/*
 * Transforms that multiply rows or cost, and what this module does:
 *
 * | Transform          | Rule      | Why                                      |
 * | ------------------ | --------- | ---------------------------------------- |
 * | fold               | bounded   | at most 32 fields: rows × fields         |
 * | flatten            | refused   | rows × array length, which data controls |
 * | window             | bounded   | a sliding frame spans at most 200 rows;  |
 * |                    |           | cumulative frames add and never re-scan  |
 * | density            | bounded   | steps, minsteps, maxsteps at most 500:   |
 * |                    |           | rows × steps kernel evaluations          |
 * | regression         | bounded   | order at most 10                         |
 * | loess              | refused   | work grows with rows × bandwidth × rows  |
 * | impute (transform  | refused   | output is groups × keys, up to rows²     |
 * |   and encoding)    |           |                                          |
 * | bin                | bounded   | maxbins at most 1,000; `step` or `steps` |
 * |                    |           | only with a literal extent giving at     |
 * |                    |           | most 1,000 bins                          |
 * | quantile           | bounded   | step at least 0.001, at most 1,000 probs |
 * | pivot              | bounded   | needs a limit of at most 100 columns     |
 * | lookup             | accepted  | one match per key; never multiplies rows |
 * | aggregate, joinaggregate, stack, timeUnit, calculate, filter, sample,    |
 * |   extent           | accepted  | linear or n log n in rows                |
 */
const TRANSFORM_BOUNDS = {
  maxFoldFields: 32,
  maxWindowSpan: 200,
  maxDensitySteps: 500,
  maxRegressionOrder: 10,
  maxBins: 1000,
  minQuantileStep: 0.001,
  maxQuantileProbs: 1000,
  maxPivotLimit: 100,
};

const VIEW_ARRAYS = ["layer", "concat", "hconcat", "vconcat"];
const isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const at = (path) => (path.length ? ` (at ${path.join(".")})` : "");

class Refusal extends Error {}
const refuse = (sentence) => {
  throw new Refusal(sentence);
};

function checkExpression(text, path) {
  let ast;
  try {
    ast = parseExpression(text);
  } catch {
    refuse(`A chart expression doesn't parse${at(path)}.`);
  }
  const problem = expressionProblem(ast);
  if (problem) refuse(`A chart expression ${problem}${at(path)}.`);
}

/** A filter or test: an expression string, a list of them (an event
 * stream's filter), or `and`/`or`/`not` over predicates. Field predicates are
 * plain data. */
function checkPredicate(predicate, path) {
  if (typeof predicate === "string") return checkExpression(predicate, path);
  if (Array.isArray(predicate))
    return predicate.forEach((item, index) => checkPredicate(item, [...path, index]));
  if (!isObject(predicate)) return;
  for (const key of ["and", "or"])
    if (Array.isArray(predicate[key]))
      predicate[key].forEach((item, index) => checkPredicate(item, [...path, key, index]));
  if (predicate.not !== undefined) checkPredicate(predicate.not, [...path, "not"]);
}

function checkEventStream(text, path) {
  let streams;
  try {
    streams = parseSelector(text, "view");
  } catch {
    refuse(`A chart event stream doesn't parse${at(path)}.`);
  }
  const visit = (stream) => {
    if (!isObject(stream)) return;
    for (const filter of stream.filter ?? []) checkExpression(filter, path);
    for (const inner of [...(stream.between ?? []), ...(stream.merge ?? []), stream.stream])
      visit(inner);
  };
  streams.forEach(visit);
}

function checkData(data, path, names) {
  // `null` in a layer means "no data", which reads nothing.
  if (data === null) return;
  if (isObject(data)) {
    if ("url" in data) refuse(`A chart can't load data from a URL${at(path)}.`);
    if ("values" in data) refuse(`A chart reads named data, not inline values${at(path)}.`);
    for (const generator of ["sequence", "sphere", "graticule"])
      if (generator in data) refuse(`A chart reads named data, not generated data${at(path)}.`);
    const keys = Object.keys(data);
    if (keys.length === 1 && keys[0] === "name" && typeof data.name === "string" && data.name) {
      if (!names.includes(data.name)) names.push(data.name);
      return;
    }
  }
  refuse(`Chart data must be {"name": "<dataset>"}${at(path)}.`);
}

const isInteractionBinding = (bind) =>
  bind === "scales" ||
  bind === "legend" ||
  (isObject(bind) && Object.keys(bind).length === 1 && "legend" in bind);

const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

function checkBin(bin, path) {
  if (!isObject(bin)) return;
  if (bin.maxbins !== undefined && !(number(bin.maxbins) <= TRANSFORM_BOUNDS.maxBins))
    refuse(`A chart can use at most ${TRANSFORM_BOUNDS.maxBins} bins${at(path)}.`);
  const steps = [bin.step, ...(Array.isArray(bin.steps) ? bin.steps : [])].filter(
    (step) => step !== undefined,
  );
  if (bin.steps !== undefined && !Array.isArray(bin.steps))
    refuse(`Chart bin steps must be a list of numbers${at(path)}.`);
  if (!steps.length) return;
  const extent = Array.isArray(bin.extent) ? bin.extent.map(number) : [];
  const span =
    extent.length === 2 && extent.every((v) => v !== null) ? extent[1] - extent[0] : null;
  for (const step of steps)
    if (!(number(step) > 0) || span === null || Math.abs(span) / step > TRANSFORM_BOUNDS.maxBins)
      refuse(
        `A chart bin step needs a literal extent that gives at most ${TRANSFORM_BOUNDS.maxBins} bins${at(path)}.`,
      );
}

function checkTransform(transform, path) {
  if (!isObject(transform)) return;
  if ("flatten" in transform) refuse(`A chart can't flatten arrays into rows${at(path)}.`);
  if ("loess" in transform) refuse(`A chart can't use loess; use a regression${at(path)}.`);
  if ("impute" in transform) refuse(`A chart can't impute missing rows${at(path)}.`);
  if (Array.isArray(transform.fold) && transform.fold.length > TRANSFORM_BOUNDS.maxFoldFields)
    refuse(`A chart can fold at most ${TRANSFORM_BOUNDS.maxFoldFields} fields${at(path)}.`);
  if ("window" in transform && transform.frame !== undefined) {
    const [start, end] = Array.isArray(transform.frame) ? transform.frame : [];
    const sliding = start !== null;
    if (
      sliding &&
      !(
        number(start) !== null &&
        number(end) !== null &&
        end - start <= TRANSFORM_BOUNDS.maxWindowSpan
      )
    )
      refuse(
        `A chart window frame must start at null or span at most ${TRANSFORM_BOUNDS.maxWindowSpan} rows${at(path)}.`,
      );
  }
  if ("density" in transform)
    for (const key of ["steps", "minsteps", "maxsteps"])
      if (
        transform[key] !== undefined &&
        !(number(transform[key]) <= TRANSFORM_BOUNDS.maxDensitySteps)
      )
        refuse(
          `A chart density can use at most ${TRANSFORM_BOUNDS.maxDensitySteps} steps${at(path)}.`,
        );
  if (
    "regression" in transform &&
    transform.order !== undefined &&
    !(number(transform.order) <= TRANSFORM_BOUNDS.maxRegressionOrder)
  )
    refuse(
      `A chart regression can have order at most ${TRANSFORM_BOUNDS.maxRegressionOrder}${at(path)}.`,
    );
  if ("quantile" in transform) {
    if (
      transform.step !== undefined &&
      !(number(transform.step) >= TRANSFORM_BOUNDS.minQuantileStep)
    )
      refuse(
        `A chart quantile step must be at least ${TRANSFORM_BOUNDS.minQuantileStep}${at(path)}.`,
      );
    if (
      Array.isArray(transform.probs) &&
      transform.probs.length > TRANSFORM_BOUNDS.maxQuantileProbs
    )
      refuse(
        `A chart quantile can use at most ${TRANSFORM_BOUNDS.maxQuantileProbs} probabilities${at(path)}.`,
      );
  }
  if (
    "pivot" in transform &&
    !(number(transform.limit) > 0 && transform.limit <= TRANSFORM_BOUNDS.maxPivotLimit)
  )
    refuse(
      `A chart pivot needs a limit of at most ${TRANSFORM_BOUNDS.maxPivotLimit} columns${at(path)}.`,
    );
}

/** How many copies of its inner spec a facet or repeat draws, as far as the
 * spec says. A facet's cells come from the data, so it counts once. */
function repeatFactor(repeat) {
  if (Array.isArray(repeat)) return repeat.length;
  if (!isObject(repeat)) return 1;
  let factor = 1;
  for (const key of ["row", "column", "layer"])
    if (Array.isArray(repeat[key])) factor *= Math.max(1, repeat[key].length);
  return factor;
}

/** Views a spec expands to: itself, its layers and concatenations, and each
 * repeated copy of an inner spec. */
function viewCount(spec, depth = 0) {
  if (!isObject(spec) || depth > CHART_SPEC_LIMITS.maxDepth) return 1;
  let count = 1;
  for (const key of VIEW_ARRAYS)
    if (Array.isArray(spec[key]))
      for (const child of spec[key]) {
        count += viewCount(child, depth + 1);
        if (count > CHART_SPEC_LIMITS.maxViews) return count;
      }
  if (isObject(spec.spec)) count += repeatFactor(spec.repeat) * viewCount(spec.spec, depth + 1);
  return count;
}

function walk(value, path, names) {
  if (path.length > CHART_SPEC_LIMITS.maxDepth)
    refuse(`A chart spec can nest at most ${CHART_SPEC_LIMITS.maxDepth} levels deep.`);
  if (typeof value === "string") {
    if (loadsResource(value)) refuse(`A chart can't load anything from a URL${at(path)}.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, [...path, index], names));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const here = [...path, key];
    if (FORBIDDEN_NAMES.has(key)) refuse(`A chart spec can't use the key "${key}"${at(path)}.`);
    if (key === "usermeta") continue;
    if (key === "url") refuse(`A chart can't load anything from a URL${at(here)}.`);
    if (key === "href") refuse(`A chart can't link anywhere${at(here)}.`);
    if (key === "datasets") refuse(`A chart reads named data, not inline datasets${at(here)}.`);
    if (key === "signals") refuse(`A chart can't define Vega signals; use params${at(here)}.`);
    if (key === "impute") refuse(`A chart can't impute missing rows${at(here)}.`);
    if (CUSTOM_FORMAT_KEYS.has(key))
      refuse(`A chart can't use custom format functions${at(here)}.`);
    if (key === "formatType" && !FORMAT_TYPES.has(child))
      refuse(`A chart format type must be number, time or utc${at(here)}.`);
    if (key === "cursor" && !CHART_CURSORS.has(child))
      refuse(`A chart cursor must be a CSS cursor keyword${at(here)}.`);
    if (key === "data") {
      checkData(child, here, names);
      continue;
    }
    if (key === "bind" && !isInteractionBinding(child))
      refuse(`A chart can't add input controls${at(here)}.`);
    if (key === "mark" && (child === "image" || (isObject(child) && child.type === "image")))
      refuse(`A chart can't draw image marks${at(here)}.`);
    if (key === "transform" && Array.isArray(child))
      child.forEach((transform, index) => checkTransform(transform, [...here, index]));
    if (key === "bin") checkBin(child, here);
    if (key === "filter" || key === "test") checkPredicate(child, here);
    else if (EXPRESSION_KEYS.has(key) && typeof child === "string") checkExpression(child, here);
    if (EVENT_STREAM_KEYS.has(key) && typeof child === "string") checkEventStream(child, here);
    walk(child, here, names);
  }
}

/**
 * Check a parsed Vega-Lite spec. `datasets`, when given, lists the data names
 * the caller can supply; a spec that reads any other name is refused.
 *
 * Returns `{ ok: true, names }`, the data names the spec reads in first-use
 * order, or `{ ok: false, error }`, one sentence saying what is wrong. Whether
 * the fields a spec encodes exist in the data is Vega-Lite's to report.
 */
export function checkChartSpec(spec, { datasets } = {}) {
  if (!isObject(spec)) return { ok: false, error: "A chart spec must be a JSON object." };
  let json;
  try {
    json = JSON.stringify(spec);
  } catch {
    return { ok: false, error: "A chart spec must be plain JSON." };
  }
  if (new TextEncoder().encode(json).byteLength > CHART_SPEC_LIMITS.maxBytes)
    return {
      ok: false,
      error: `A chart spec must be ${CHART_SPEC_LIMITS.maxBytes / 1024} KiB or smaller.`,
    };
  if (typeof spec.$schema === "string" && !spec.$schema.includes("/vega-lite/"))
    return { ok: false, error: "A chart spec must be Vega-Lite, not another schema." };
  const plain = JSON.parse(json);
  const { $schema: _schema, ...rest } = plain;
  const names = [];
  try {
    walk(rest, [], names);
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, error: error.message };
    throw error;
  }
  if (viewCount(plain) > CHART_SPEC_LIMITS.maxViews)
    return { ok: false, error: `A chart can have at most ${CHART_SPEC_LIMITS.maxViews} views.` };
  if (!names.length) return { ok: false, error: 'A chart needs data: {"name": "<dataset>"}.' };
  if (datasets) {
    const missing = names.find((name) => !datasets.includes(name));
    if (missing !== undefined)
      return { ok: false, error: `This chart reads "${missing}", but no dataset has that name.` };
  }
  return { ok: true, names };
}
