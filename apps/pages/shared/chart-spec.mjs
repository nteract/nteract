// The checks a Vega-Lite chart spec passes before Pages draws it. No DOM, no
// Node built-ins and no Vega runtime, so the viewer and a Cloudflare Worker
// run the same function: the viewer before every draw (viewer/vega-chart.mjs),
// the Page host on write. Both the spec and the data it reads are untrusted.
//
// The first version of a chart is static: marks, axes, legends and Vega's
// hover tooltip, and nothing else interactive. Selections, bindings, hover
// encodings and raw signals are refused here, because each review of the
// interactive surface found another way through it. What a spec may use is listed, not excluded:
// data is `{ "name": ... }` only, transforms and their parameters come from
// TRANSFORMS with ranged numbers, expressions call only
// CHART_EXPRESSION_FUNCTIONS (every ExprRef and SignalRef, wherever it is), a
// cursor is a keyword, no string may hold a CSS url(), and every number is in
// CHART_NUMBER_RANGE. `checkChartSpec` never throws; anything it can't check
// is a refusal.
//
// Cost: spec bytes, views, nesting, rows and cells per dataset, folds, bins,
// steps, windows, ticks, sizes and scale, axis and legend counts are
// bounded, and every number is in CHART_NUMBER_RANGE. A spec that passes
// every check can still fail to terminate: the guards here and in
// viewer/chart-dataflow.mjs cover the cases reviews have found, and Vega's and
// d3's numeric loops aren't proven to end, so viewer/vega-chart.mjs runs the
// dataflow in a Worker and terminates a draw that outlasts its timer.
import { parseExpression } from "vega-expression";

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

/** Rows a chart reads from one dataset. viewer/vega-chart.mjs refuses more.
 * Transforms can still emit more rows than this, within their own bounds. */
export const CHART_MAX_ROWS = 100_000;

/** Cells (rows × columns) a chart copies from one dataset before Vega runs.
 * The viewer copies every column of every row, so a wide table costs memory
 * even when the spec reads two fields: 2,000,000 cells took 0.1 to 0.25 s and
 * about 100 MiB to copy on an M-series Mac; 5,000,000 took 0.3 to 0.6 s and
 * 300 MiB. viewer/vega-chart.mjs refuses more. */
export const CHART_MAX_CELLS = 2_000_000;

/**
 * Sizes a chart number may have besides 0, in a spec and in the data. Vega's
 * numeric loops assume normal doubles: its bin loop multiplies a step that
 * underflows to 0 forever, and wider spans overflow the same arithmetic.
 *
 * - The smallest gap between two numbers at least 1e-150 in size is about
 *   1.5e-166, and Vega's bin step is at least its span over 1e6 (`base` to
 *   the power of its level is at most maxbins × base, 1e5, and rounding adds
 *   at most √100), so a step stays far above the smallest normal double,
 *   2.2e-308.
 * - At most 1e150, a square stays finite, so variance, regression and
 *   distances never reach Infinity.
 *
 * viewer/chart-data.mjs applies `chartNumber` to every number in the data.
 */
export const CHART_NUMBER_RANGE = Object.freeze({ min: 1e-150, max: 1e150 });

/** A number as a chart reads it: 0 below the range, null above it or when
 * it isn't finite, the number itself otherwise. */
export function chartNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const size = Math.abs(value);
  if (size > CHART_NUMBER_RANGE.max) return null;
  return size < CHART_NUMBER_RANGE.min ? 0 : value;
}

/**
 * Vega expression functions a spec may call, in `calculate`, `filter`, `test`,
 * `labelExpr` and `expr`. Each group is what static charts use. Left out:
 * anything that writes (`modify`), reads by a path or another dataset's name
 * (`pluck`, `data`, `indata`, `merge`), looks up a scale by name
 * (`scale`, `invert`, `bandwidth`), builds an array or string whose length
 * the data or an argument sets (`sequence`, `timeSequence`, `utcSequence`,
 * `pad`, `join`, `split`), regular expressions, randomness, event and window
 * geometry, and logging.
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
    "ceil",
    "clamp",
    "exp",
    "floor",
    "log",
    "max",
    "min",
    "pow",
    "round",
    "sqrt",
    // Dates and times
    "now",
    "datetime",
    "date",
    "day",
    "year",
    "quarter",
    "month",
    "hours",
    "minutes",
    "seconds",
    "milliseconds",
    "time",
    "utc",
    "utcdate",
    "utcday",
    "utcyear",
    "utcquarter",
    "utcmonth",
    "utchours",
    "utcminutes",
    "utcseconds",
    "utcmilliseconds",
    "timeOffset",
    "utcOffset",
    // Strings, each no longer than its input
    "length",
    "lower",
    "upper",
    "trim",
    "slice",
    "substring",
    "indexof",
    "lastindexof",
    "replace",
    "truncate",
    "parseFloat",
    "parseInt",
    // Two-number arrays
    "extent",
    "span",
    "inrange",
    "clampRange",
    "peek",
    // Formatting and parsing, each with a literal specifier (checkFormatCall)
    "format",
    "timeFormat",
    "utcFormat",
    "timeParse",
    "utcParse",
    "dayFormat",
    "dayAbbrevFormat",
    "monthFormat",
    "monthAbbrevFormat",
    // Color, for label contrast
    "rgb",
    "hsl",
    "lab",
    "hcl",
    "luminance",
    "contrast",
  ]),
);

// Names an expression may not use as an identifier, a property or an object
// key, written plainly or as a string.
const FORBIDDEN_NAMES = new Set(["constructor", "__proto__", "prototype"]);
// Names every plain object answers to. Vega and Vega-Lite key their own
// plain objects by dataset, field and style names, so a chart named
// "toString" or a field named "constructor" fails inside them. A spec may not
// use one as a key or as a whole string; viewer/chart-data.mjs copies rows
// into null-prototype objects, so a column with such a name that no spec
// reads is harmless.
const RESERVED_NAMES = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  ...FORBIDDEN_NAMES,
]);
const MAX_FORMAT_WIDTH = 64;
// d3-format's specifier grammar; group 6 is the padded width.
const NUMBER_FORMAT = /^(?:(.)?([<>=^]))?([+\-( ])?([$#])?(0)?(\d+)?(,)?(\.\d+)?(~)?([a-z%])?$/i;

/** Why a d3 number format would build a long string, or null. */
export function formatProblem(specifier) {
  const width = NUMBER_FORMAT.exec(specifier)?.[6];
  return width && Number(width) > MAX_FORMAT_WIDTH
    ? `pads a number to ${width} characters, more than ${MAX_FORMAT_WIDTH}`
    : null;
}

/** Calls whose second argument is a format or parse specifier. A literal
 * specifier keeps the output's shape in the spec, not the data. */
const SPECIFIED_CALLS = new Set(["format", "timeFormat", "utcFormat", "timeParse", "utcParse"]);

/** `format(value, specifier)` needs a literal specifier that pads at most
 * MAX_FORMAT_WIDTH characters. Other calls pass. */
export function checkFormatCall(call) {
  if (!SPECIFIED_CALLS.has(call.callee.name)) return null;
  const specifier = call.arguments[1];
  if (specifier === undefined) return null;
  if (specifier.type !== "Literal" || typeof specifier.value !== "string")
    return "formats with a specifier that isn't a literal string";
  return call.callee.name === "format" ? formatProblem(specifier.value) : null;
}

/**
 * Why a parsed Vega expression can't run, or null. `functions` is the set a
 * call may name, and `checkCall(node)` may refuse an allowed call by its
 * arguments. The viewer runs the same policy over Vega's own parsed dataflow
 * with a wider set for the code Vega-Lite generates.
 *
 * - A call's callee is a plain identifier in `functions`.
 * - No forbidden name as an identifier, a property or an object key.
 * - A computed member's property is a literal (`datum["a b"]`, `row[0]`).
 *   vega-expression parses `datum[x]` and `datum["constructor"]` alike, as
 *   an identifier, so this also refuses prototype names written as strings.
 * - No regular expression literal.
 *
 * Iterative, so a deep expression can't overflow the stack.
 */
export function expressionProblem(
  ast,
  functions = CHART_EXPRESSION_FUNCTIONS,
  checkCall = checkFormatCall,
) {
  const stack = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    switch (node.type) {
      case "CallExpression": {
        if (node.callee?.type !== "Identifier") return "calls something that isn't a function name";
        if (!functions.has(node.callee.name)) return `calls ${node.callee.name}()`;
        const problem = checkCall?.(node);
        if (problem) return problem;
        stack.push(...node.arguments);
        continue;
      }
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
 * Where Vega-Lite 6.5.0 turns a spec string into a Vega expression, a call or
 * an event listener, and what this module does with each:
 *
 * | Position                                        | Check                  |
 * | ----------------------------------------------- | ---------------------- |
 * | `{ "expr": ... }` anywhere (ExprRef), a value   | parsed, policy         |
 * |   parameter's `expr`                            |                        |
 * | transform `calculate`; `filter` and `test`,     | parsed, policy         |
 * |   with strings inside `and`/`or`/`not`          |                        |
 * | axis, legend and header `labelExpr`             | parsed, policy         |
 * | `signal` in `encode` passthrough                | parsed, policy         |
 * | number `format` (d3-format width pads a string) | width at most 64       |
 * | `formatType` other than number, time, utc;      | refused: each names a  |
 * |   `customFormatTypes`, `numberFormatType`,      |   function Vega-Lite   |
 * |   `normalizedNumberFormatType`, `timeFormatType`|   calls                |
 * | a parameter's `select` and everything in it     | refused: charts are    |
 * |   (`on`, `clear`, `translate`, `zoom`,          |   static               |
 * |   `toggle`, `resolve`), legacy `selection`,     |                        |
 * |   `config.selection`, every `bind`, a `param`   |                        |
 * |   predicate or condition, `empty`               |                        |
 * | `config.signals` (raw Vega signals)             | refused                |
 * | `width` or `height` "container" (a resize       | refused                |
 * |   listener)                                     |                        |
 *
 * The viewer checks the compiled dataflow as well: no event stream, signal
 * handler or binding, operator types from a static list, and every expression
 * against the same policy.
 */
const EXPRESSION_KEYS = new Set(["expr", "calculate", "labelExpr", "signal"]);
const STATIC_ONLY_KEYS = new Set(["selection", "bind", "empty", "signals"]);
const FORMAT_TYPES = new Set(["number", "time", "utc"]);
const CUSTOM_FORMAT_KEYS = new Set([
  "customFormatTypes",
  "numberFormatType",
  "normalizedNumberFormatType",
  "timeFormatType",
]);
const SIZE_KEYS = new Set([
  "width",
  "height",
  "continuousWidth",
  "continuousHeight",
  "discreteWidth",
  "discreteHeight",
]);
const MAX_SIZE = 10_000;
const MAX_STEP = 1_000;
const MAX_TICKS = 1_000;

/*
 * Scale, axis and legend numbers that set a count, a step or a base, by key,
 * wherever the key sits (a scale, an axis, a legend or the same key under
 * `config`). Each must be a literal: an `{expr}` there is refused, since its
 * value is known only when the chart runs. d3 and Vega loop on these.
 *
 * | Key           | Allowed                                     | Why                                     |
 * | ------------- | ------------------------------------------- | --------------------------------------- |
 * | base          | 2 to 100                                    | log ticks count down from base - 1,     |
 * |               |                                             | which 1e20 - 1 never leaves; bin, too   |
 * | exponent      | -10 to 10                                   | pow scale                               |
 * | constant      | 1e-6 to 1e6                                 | symlog scale; 0 divides by zero         |
 * | nice          | true, false, 0 to 1,000, a time unit, or    | a nice count or step                    |
 * |               | {interval, step 1 to 1,000}                 |                                         |
 * | bins          | up to 1,000 numbers, or literal {start,     | a step alone bins the data's domain,    |
 * |               | stop, step} giving at most 1,000 bins       | whose size the data sets                |
 * | domain, range | a list of at most 1,000, never an {expr}    | each entry is a tick or a color         |
 * | values        | a list of at most 1,000, never an {expr}    | axis and legend ticks                   |
 * | unionWith     | a list of at most 1,000, never an {expr}    | added to a domain                       |
 * | tickCount     | 0 to 1,000                                  | ticks; never a time interval            |
 * | symbolLimit   | 0 to 1,000                                  | legend symbols                          |
 * | columns       | 0 to 1,000                                  | legend and facet columns                |
 * | count         | 1 to 256                                    | colors sampled from a scheme            |
 *
 * `tickMinStep` is a number in CHART_NUMBER_RANGE: Vega takes the smaller of
 * the tick count and the domain over the step, so tickCount bounds it. A
 * `binned` field with a `step` is refused in checkBin for the same reason as
 * `bins`.
 *
 * Every other number is a data value or a layout value. Data values (any
 * number under a key in DATA_NUMBER_KEYS, however deep: a param's value, a
 * sort list, a datum, a domain, a predicate bound) may be anything in
 * CHART_NUMBER_RANGE, so a timestamp fits. Layout values (sizes, offsets, angles, opacities, font sizes) must be
 * at most 1e6 in size; an `{expr}` there can compute more, which reaches a
 * drawn attribute and no loop.
 */
const TIME_UNITS = new Set([
  "millisecond",
  "second",
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "year",
]);
/** A list of at most 1,000, or a non-list form (a scheme name, `{unionWith}`),
 * but never an ExprRef or SignalRef, whose list is known only when the chart
 * runs. */
const isRef = (value) => isObject(value) && ("expr" in value || "signal" in value);
const shortList = (value) => (Array.isArray(value) ? value.length <= 1000 : !isRef(value));
const KEY_RULES = Object.assign(Object.create(null), {
  base: (v) => within(v, 2, 100),
  exponent: (v) => within(v, -10, 10),
  constant: (v) => within(v, 1e-6, 1e6),
  nice: (v) =>
    isBoolean(v) ||
    integerWithin(v, 0, 1000) ||
    TIME_UNITS.has(v) ||
    (isObject(v) &&
      Object.keys(v).every((key) => key === "interval" || key === "step") &&
      TIME_UNITS.has(v.interval) &&
      (v.step === undefined || integerWithin(v.step, 1, 1000))),
  bins: (v) =>
    (Array.isArray(v) && v.length <= 1000 && v.every(inRange)) ||
    (isObject(v) &&
      Object.keys(v).every((key) => ["start", "stop", "step"].includes(key)) &&
      [v.start, v.stop].every(inRange) &&
      positiveInRange(v.step) &&
      (v.stop - v.start) / v.step <= 1000),
  domain: shortList,
  range: shortList,
  values: shortList,
  unionWith: shortList,
  tickCount: (v) => within(v, 0, MAX_TICKS),
  symbolLimit: (v) => within(v, 0, 1000),
  columns: (v) => within(v, 0, 1000),
  count: (v) => integerWithin(v, 1, 256),
});
const KEY_SENTENCES = Object.assign(Object.create(null), {
  base: "a base must be a number from 2 to 100",
  exponent: "an exponent must be a number from -10 to 10",
  constant: "a symlog constant must be a number from 1e-6 to 1e6",
  nice: "nice must be true, false, a count up to 1,000 or a time unit",
  bins: "bins must be at most 1,000 numbers, or a literal start, stop and step giving at most 1,000",
  domain: "a domain can list at most 1,000 values, written out",
  range: "a range can list at most 1,000 values, written out",
  values: "values can list at most 1,000 entries, written out",
  unionWith: "unionWith can list at most 1,000 values, written out",
  tickCount: `a tick count must be a number up to ${MAX_TICKS}`,
  symbolLimit: "a symbol limit must be a number up to 1,000",
  columns: "columns must be a number up to 1,000",
  count: "a scheme count must be a whole number from 1 to 256",
});
const DATA_NUMBER_KEYS = new Set([
  "datum",
  "sort",
  "value",
  "domain",
  "domainMin",
  "domainMax",
  "domainMid",
  "domainRaw",
  "unionWith",
  "values",
  "range",
  "equal",
  "lt",
  "lte",
  "gt",
  "gte",
  "oneOf",
  "extent",
  "anchor",
  "start",
  "stop",
  "step",
  "steps",
  "minstep",
  "tickMinStep",
]);
const MAX_LAYOUT_NUMBER = 1e6;

/** Vega's own symbol shapes. A chart's symbols draw only these: Vega parses
 * a custom SVG path shape into a module-wide cache that nothing clears. */
export const CHART_SYMBOL_SHAPES = Object.freeze(
  new Set([
    "circle",
    "square",
    "cross",
    "diamond",
    "triangle-up",
    "triangle-down",
    "triangle-right",
    "triangle-left",
    "triangle",
    "arrow",
    "wedge",
    "stroke",
  ]),
);

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

const VIEW_ARRAYS = ["layer", "concat", "hconcat", "vconcat"];
const isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const at = (path) => (path.length ? ` (at ${path.join(".")})` : "");

class Refusal extends Error {}
const refuse = (sentence) => {
  throw new Refusal(sentence);
};

const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
/** A finite number in [min, max]. Vega coerces strings, so a bound compares
 * numbers only and refuses anything else. */
const within = (value, min, max) => number(value) !== null && value >= min && value <= max;
const integerWithin = (value, min, max) => within(value, min, max) && Number.isInteger(value);
/** 0, or a finite number whose size is in CHART_NUMBER_RANGE. */
const inRange = (value) => number(value) !== null && chartNumber(value) === value;
const isString = (value) => typeof value === "string";
const isBoolean = (value) => typeof value === "boolean";
const isStringList = (value, max = 64) =>
  Array.isArray(value) && value.length <= max && value.every(isString);
const isPair = (value) =>
  Array.isArray(value) && value.length === 2 && value.every((v) => number(v) !== null);
const isNamePair = (value) => isStringList(value, 2);
const any = () => true;

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

/** A filter or test: an expression string, or `and`/`or`/`not` over
 * predicates. Field predicates are plain data; a `param` predicate names a
 * selection and is refused with the rest of the interactive surface. Depth is
 * bounded by the depth pass that runs first. */
function checkPredicate(predicate, path) {
  if (isString(predicate)) return checkExpression(predicate, path);
  if (!isObject(predicate)) return;
  if ("param" in predicate) refuse(`A chart can't test a selection; charts are static${at(path)}.`);
  if ("timeUnit" in predicate) checkTimeUnit(predicate.timeUnit, [...path, "timeUnit"]);
  for (const key of ["and", "or"])
    if (Array.isArray(predicate[key]))
      predicate[key].forEach((item, index) => checkPredicate(item, [...path, key, index]));
  if (predicate.not !== undefined) checkPredicate(predicate.not, [...path, "not"]);
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
    if (keys.length === 1 && keys[0] === "name" && isString(data.name) && data.name) {
      if (RESERVED_NAMES.has(data.name)) refuse(reservedName(data.name, [...path, "name"]));
      if (!names.includes(data.name)) names.push(data.name);
      return;
    }
  }
  refuse(`Chart data must be {"name": "<dataset>"}${at(path)}.`);
}

/** A parameter: a name with a plain value or an expression, never a
 * selection or a binding. */
function checkParam(param, path) {
  if (!isObject(param)) refuse(`A chart parameter must be an object${at(path)}.`);
  if ("select" in param) refuse(`A chart can't have selections; charts are static${at(path)}.`);
  if ("bind" in param)
    refuse(`A chart can't bind a parameter to an input; charts are static${at(path)}.`);
  for (const key of Object.keys(param))
    if (!["name", "value", "expr", "description"].includes(key))
      refuse(`A chart parameter can't use "${key}"${at(path)}.`);
  if (!isString(param.name)) refuse(`A chart parameter needs a name${at(path)}.`);
}

// Bin parameters, transform or encoding. Vega's bin multiplies or divides its
// step in loops driven by `base` and `divide`, so each is ranged: a base below
// 2 never leaves the loop, and a step that underflows to 0 never grows. Every
// number feeding the step is 0 or in CHART_NUMBER_RANGE, and so is an
// extent's span unless it is 0.
const positiveInRange = (v) => inRange(v) && v > 0;
const BIN_PARAMS = {
  maxbins: (v) => integerWithin(v, 1, 1000),
  extent: (v) =>
    isPair(v) &&
    v.every(inRange) &&
    (v[0] === v[1] || Math.abs(v[1] - v[0]) >= CHART_NUMBER_RANGE.min),
  step: positiveInRange,
  steps: (v) => Array.isArray(v) && v.length <= 32 && v.every(positiveInRange),
  minstep: (v) => inRange(v) && v >= 0,
  base: (v) => within(v, 2, 100),
  divide: (v) => Array.isArray(v) && v.length <= 8 && v.every((d) => within(d, 1.001, 100)),
  nice: isBoolean,
  anchor: inRange,
  binned: isBoolean,
};
const MAX_BINS = 1000;

function checkBin(bin, path) {
  if (bin === true || bin === false || bin === null || bin === "binned") return;
  if (!isObject(bin)) refuse(`A chart bin must be true, "binned" or an object${at(path)}.`);
  for (const [key, value] of Object.entries(bin)) {
    const valid = Object.hasOwn(BIN_PARAMS, key) && BIN_PARAMS[key];
    if (!valid) refuse(`A chart bin can't use "${key}"${at(path)}.`);
    if (!valid(value)) refuse(`A chart bin's ${key} is out of range${at([...path, key])}.`);
  }
  const steps = [bin.step, ...(bin.steps ?? [])].filter((step) => step !== undefined);
  if (!steps.length) return;
  // Vega-Lite bins a binned field's scale by its step over the data's domain.
  if (bin.binned === true)
    refuse(`A binned chart field can't set a step; its bins would come from the data${at(path)}.`);
  const span = bin.extent ? Math.abs(bin.extent[1] - bin.extent[0]) : null;
  for (const step of steps)
    if (span === null || span / step > MAX_BINS)
      refuse(
        `A chart bin step needs a literal extent that gives at most ${MAX_BINS} bins${at(path)}.`,
      );
}

// A time unit's parameters. A step below 1 has no interval in d3-time.
const TIME_UNIT_PARAMS = {
  unit: isString,
  utc: isBoolean,
  binned: isBoolean,
  step: (v) => integerWithin(v, 1, MAX_BINS),
  maxbins: (v) => integerWithin(v, 1, MAX_BINS),
};

function checkTimeUnit(timeUnit, path) {
  if (timeUnit === undefined || isString(timeUnit)) return;
  if (!isObject(timeUnit)) refuse(`A chart time unit must be a name or an object${at(path)}.`);
  for (const [key, value] of Object.entries(timeUnit)) {
    const valid = Object.hasOwn(TIME_UNIT_PARAMS, key) && TIME_UNIT_PARAMS[key];
    if (!valid) refuse(`A chart time unit can't use "${key}"${at(path)}.`);
    if (!valid(value)) refuse(`A chart time unit's ${key} is out of range${at([...path, key])}.`);
  }
}

// Aggregate ops for `aggregate`, `joinaggregate` and `pivot`, which compute
// once per group.
const AGGREGATE_OPS = new Set([
  "count",
  "valid",
  "missing",
  "distinct",
  "sum",
  "product",
  "mean",
  "average",
  "variance",
  "variancep",
  "stdev",
  "stdevp",
  "stderr",
  "median",
  "q1",
  "q3",
  "ci0",
  "ci1",
  "min",
  "max",
  "argmin",
  "argmax",
]);
// Window ops Vega updates as rows enter and leave the frame. Left out: ci0,
// ci1, median, q1, q3 and values, which Vega recomputes from every value in
// the frame, for every row.
const WINDOW_OPS = new Set([
  "row_number",
  "rank",
  "dense_rank",
  "percent_rank",
  "cume_dist",
  "ntile",
  "lag",
  "lead",
  "first_value",
  "last_value",
  "nth_value",
  "count",
  "valid",
  "missing",
  "sum",
  "product",
  "mean",
  "average",
  "variance",
  "variancep",
  "stdev",
  "stdevp",
  "stderr",
  "min",
  "max",
  "argmin",
  "argmax",
]);
const MAX_WINDOW_SPAN = 200;
const MAX_FOLD_FIELDS = 32;
const MAX_STEPS = 500;

const opList = (ops) => (value) =>
  Array.isArray(value) &&
  value.length <= 32 &&
  value.every(
    (op) =>
      isObject(op) &&
      ops.has(op.op) &&
      (op.param === undefined || integerWithin(op.param, -CHART_MAX_ROWS, CHART_MAX_ROWS)) &&
      Object.keys(op).every((key) => ["op", "field", "as", "param"].includes(key)),
  );
const sortList = (value) =>
  Array.isArray(value) &&
  value.length <= 16 &&
  value.every(
    (sort) =>
      isObject(sort) && Object.keys(sort).every((key) => key === "field" || key === "order"),
  );
const frame = (value) =>
  Array.isArray(value) &&
  value.length === 2 &&
  value.every((v) => v === null || integerWithin(v, -CHART_MAX_ROWS, CHART_MAX_ROWS));
const lookupFrom = (value) =>
  isObject(value) &&
  Object.keys(value).every((key) => ["data", "key", "fields"].includes(key)) &&
  isString(value.key) &&
  (value.fields === undefined || isStringList(value.fields));

/*
 * Transforms a chart may use, each with the parameters it may set and the
 * range of each number. Anything else is refused.
 *
 * | Transform     | Bound                                                    |
 * | ------------- | -------------------------------------------------------- |
 * | aggregate     | ops from AGGREGATE_OPS; once per group                   |
 * | joinaggregate | ops from AGGREGATE_OPS; once per group                   |
 * | bin           | BIN_PARAMS: base 2 to 100, at most 1,000 bins            |
 * | calculate     | parsed expression                                        |
 * | density       | steps, minsteps, maxsteps 1 to 500                       |
 * | extent        | a field and a parameter name                             |
 * | filter        | parsed predicate                                         |
 * | fold          | at most 32 fields across all folds on a view's path      |
 * | lookup        | a named dataset, a key and fields; one match per key     |
 * | pivot         | limit 1 to 100 columns, required                         |
 * | quantile      | step 0.001 to 1, at most 1,000 probs                     |
 * | regression    | order 0 to 10                                            |
 * | sample        | 1 to CHART_MAX_ROWS                                      |
 * | stack         | fields, an offset and a sort                             |
 * | timeUnit      | a unit; step and maxbins 1 to 1,000                      |
 * | window        | WINDOW_OPS; a sliding frame spans at most 200 rows and   |
 * |               | sets ignorePeers; a frame starting at null only adds     |
 *
 * Refused: flatten (rows × array length, which the data sets), impute
 * (groups × keys, up to rows²), loess (work grows with rows² × bandwidth).
 */
const TRANSFORMS = {
  aggregate: { aggregate: opList(AGGREGATE_OPS), groupby: isStringList },
  joinaggregate: { joinaggregate: opList(AGGREGATE_OPS), groupby: isStringList },
  bin: { bin: any, field: isString, as: (v) => isString(v) || isNamePair(v) },
  calculate: { calculate: isString, as: isString },
  density: {
    density: isString,
    groupby: isStringList,
    cumulative: isBoolean,
    counts: isBoolean,
    bandwidth: (v) => within(v, 0, Number.MAX_VALUE),
    extent: isPair,
    minsteps: (v) => integerWithin(v, 1, MAX_STEPS),
    maxsteps: (v) => integerWithin(v, 1, MAX_STEPS),
    steps: (v) => integerWithin(v, 1, MAX_STEPS),
    as: isNamePair,
  },
  extent: { extent: isString, param: isString },
  filter: { filter: any },
  fold: { fold: (v) => isStringList(v, MAX_FOLD_FIELDS), as: isNamePair },
  lookup: {
    lookup: isString,
    from: lookupFrom,
    as: (v) => isString(v) || isStringList(v),
    default: (v) => v === null || ["string", "number", "boolean"].includes(typeof v),
  },
  pivot: {
    pivot: isString,
    value: isString,
    groupby: isStringList,
    limit: (v) => integerWithin(v, 1, 100),
    op: (v) => AGGREGATE_OPS.has(v),
  },
  quantile: {
    quantile: isString,
    groupby: isStringList,
    probs: (v) => Array.isArray(v) && v.length <= 1000 && v.every((p) => within(p, 0, 1)),
    step: (v) => within(v, 0.001, 1),
    as: isNamePair,
  },
  regression: {
    regression: isString,
    on: isString,
    groupby: isStringList,
    method: (v) => ["linear", "log", "exp", "pow", "quad", "poly"].includes(v),
    order: (v) => integerWithin(v, 0, 10),
    extent: isPair,
    params: isBoolean,
    as: isNamePair,
  },
  sample: { sample: (v) => integerWithin(v, 1, CHART_MAX_ROWS) },
  stack: {
    stack: isString,
    groupby: isStringList,
    offset: (v) => ["zero", "center", "normalize"].includes(v),
    sort: sortList,
    as: isNamePair,
  },
  timeUnit: { timeUnit: any, field: isString, as: isString },
  window: {
    window: opList(WINDOW_OPS),
    frame,
    ignorePeers: isBoolean,
    groupby: isStringList,
    sort: sortList,
  },
};
const REQUIRED = { pivot: ["limit"] };

function checkTransform(transform, path) {
  if (!isObject(transform)) refuse(`A chart transform must be an object${at(path)}.`);
  const type = Object.keys(TRANSFORMS).find((name) => name in transform);
  if (!type) {
    const name = Object.keys(transform)[0] ?? "empty";
    refuse(`A chart can't use the ${name} transform${at(path)}.`);
  }
  const params = TRANSFORMS[type];
  if (type === "window")
    for (const op of Array.isArray(transform.window) ? transform.window : [])
      if (isObject(op) && !WINDOW_OPS.has(op.op))
        refuse(
          `A chart window can't compute ${op.op}; it would rescan the frame for every row${at(path)}.`,
        );
  if (type === "fold" && Array.isArray(transform.fold) && transform.fold.length > MAX_FOLD_FIELDS)
    refuse(`A chart can fold at most ${MAX_FOLD_FIELDS} fields${at(path)}.`);
  for (const [key, value] of Object.entries(transform)) {
    if (!Object.hasOwn(params, key))
      refuse(`A chart's ${type} transform can't use "${key}"${at(path)}.`);
    if (!params[key](value))
      refuse(`A chart's ${type} transform has an out-of-range ${key}${at([...path, key])}.`);
  }
  for (const key of REQUIRED[type] ?? [])
    if (!(key in transform)) refuse(`A chart's ${type} transform needs a ${key}${at(path)}.`);
  if (type === "bin") checkBin(transform.bin, [...path, "bin"]);
  if (type === "timeUnit") checkTimeUnit(transform.timeUnit, [...path, "timeUnit"]);
  if (type === "filter") checkPredicate(transform.filter, [...path, "filter"]);
  if (type === "calculate") checkExpression(transform.calculate, [...path, "calculate"]);
  if (type === "lookup") checkData(transform.from.data, [...path, "from", "data"], []);
  if (type === "window" && Array.isArray(transform.frame)) {
    const [start, end] = transform.frame;
    if (start !== null) {
      if (end === null || end - start > MAX_WINDOW_SPAN)
        refuse(
          `A chart window frame must start at null or span at most ${MAX_WINDOW_SPAN} rows${at(path)}.`,
        );
      if (transform.ignorePeers !== true)
        refuse(
          `A chart's sliding window must set ignorePeers, or ties widen it to the whole partition${at(path)}.`,
        );
    }
  }
}

/** How many copies of its inner spec a repeat draws. A facet's cells come
 * from the data, so it counts once. */
function repeatFactor(repeat) {
  if (Array.isArray(repeat)) return repeat.length;
  if (!isObject(repeat)) return 1;
  let factor = 1;
  for (const key of ["row", "column", "layer"])
    if (Array.isArray(repeat[key])) factor *= Math.max(1, repeat[key].length);
  return factor;
}

/** The views a spec expands to, and the largest product of fold field counts
 * on any view's path (a view's transforms apply to its layers and inner
 * specs). Depth is bounded by the depth pass. */
function viewShape(spec, folds = 1) {
  if (!isObject(spec)) return { views: 1, folds };
  let product = folds;
  for (const transform of Array.isArray(spec.transform) ? spec.transform : [])
    if (Array.isArray(transform?.fold)) product *= Math.max(1, transform.fold.length);
  let views = 1;
  let largest = product;
  for (const key of VIEW_ARRAYS)
    if (Array.isArray(spec[key]))
      for (const child of spec[key]) {
        const shape = viewShape(child, product);
        views += shape.views;
        largest = Math.max(largest, shape.folds);
      }
  if (isObject(spec.spec)) {
    const shape = viewShape(spec.spec, product);
    views += repeatFactor(spec.repeat) * shape.views;
    largest = Math.max(largest, shape.folds);
  }
  return { views, folds: largest };
}

/** Refuse a string that holds a CSS url() or is a reserved name. */
function checkString(value, path) {
  if (loadsResource(value)) refuse(`A chart can't load anything from a URL${at(path)}.`);
  if (RESERVED_NAMES.has(value)) refuse(reservedName(value, path));
}

const reservedName = (name, path) =>
  `A chart can't use "${name}" as a name; every object already has it${at(path)}.`;

/** Refuse a number outside CHART_NUMBER_RANGE. */
function checkNumber(value, path) {
  if (!inRange(value))
    refuse(
      `A chart number must be 0 or between ${CHART_NUMBER_RANGE.min} and ${CHART_NUMBER_RANGE.max} in size${at(path)}.`,
    );
}

/** Refuse any string, number or key under `value` that checkString or
 * checkNumber refuses. */
function checkStrings(value, path) {
  if (isString(value)) checkString(value, path);
  else if (typeof value === "number") checkNumber(value, path);
  else if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value)) {
      if (RESERVED_NAMES.has(key)) refuse(reservedName(key, path));
      checkStrings(child, [...path, key]);
    }
}

/** A width, height or default view size: a number, `{step}` for a discrete
 * axis, or `{band}` for a bar's share of its band. */
function sizeAllowed(value) {
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (keys.length !== 1) return false;
    if (keys[0] === "step") return within(value.step, 0, MAX_STEP);
    if (keys[0] === "band") return within(value.band, 0, 1);
    return false;
  }
  return within(value, 0, MAX_SIZE);
}

/** Whether the string at `path` names a symbol shape: a mark's or config's
 * `shape`, a legend's `symbolType`, a `shape` channel's value (directly or
 * in a condition), a `shape` channel scale's range, or `config.range.symbol`. */
function isShapeValue(path) {
  const keys = path.filter((part) => typeof part === "string");
  const [last, second, third] = [keys.at(-1), keys.at(-2), keys.at(-3)];
  if (last === "shape" || last === "symbolType") return true;
  if (last === "value") return second === "shape" || (second === "condition" && third === "shape");
  if (last === "range" && second === "scale" && third === "shape") return true;
  return last === "symbol" && second === "range" && third === "config";
}

const SHAPE_SENTENCE = `A chart's symbols are Vega's own shapes: ${[...CHART_SYMBOL_SHAPES].slice(0, -1).join(", ")} or ${[...CHART_SYMBOL_SHAPES].at(-1)}; it can't draw a custom SVG path`;

function walk(value, path, names) {
  if (isString(value)) {
    checkString(value, path);
    // A scale's range may name Vega's own range of shapes.
    const namedRange = path.at(-1) === "range" && value === "symbol";
    if (isShapeValue(path) && !namedRange && !CHART_SYMBOL_SHAPES.has(value))
      refuse(`${SHAPE_SENTENCE}${at(path)}.`);
    return;
  }
  if (typeof value === "number") {
    checkNumber(value, path);
    const key = path.findLast((part) => typeof part === "string");
    const data = path.some((part) => typeof part === "string" && DATA_NUMBER_KEYS.has(part));
    if (!data && Math.abs(value) > MAX_LAYOUT_NUMBER)
      refuse(`A chart's ${key ?? "number"} must be at most 1e6 in size${at(path)}.`);
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
    if (RESERVED_NAMES.has(key)) refuse(reservedName(key, path));
    if (key === "usermeta") continue;
    // A hover encoding runs on pointer events, and `interactive` asks for them.
    if ((key === "hover" || key === "interactive") && path.includes("encode"))
      refuse(`A chart can't change on hover; charts are static, with hover tooltips${at(here)}.`);
    if (key === "url") refuse(`A chart can't load anything from a URL${at(here)}.`);
    if (key === "href") refuse(`A chart can't link anywhere${at(here)}.`);
    if (key === "datasets") refuse(`A chart reads named data, not inline datasets${at(here)}.`);
    if (STATIC_ONLY_KEYS.has(key) || (key === "param" && isString(child)))
      refuse(`A chart can't use "${key}"; charts are static, with hover tooltips${at(here)}.`);
    if (key === "impute") refuse(`A chart can't impute missing rows${at(here)}.`);
    if (CUSTOM_FORMAT_KEYS.has(key))
      refuse(`A chart can't use custom format functions${at(here)}.`);
    if (key === "formatType" && !FORMAT_TYPES.has(child))
      refuse(`A chart format type must be number, time or utc${at(here)}.`);
    if (key === "format" && isString(child)) {
      const problem = formatProblem(child);
      if (problem) refuse(`A chart format ${problem}${at(here)}.`);
    }
    if (key === "cursor" && !CHART_CURSORS.has(child))
      refuse(`A chart cursor must be a CSS cursor keyword${at(here)}.`);
    if (key in KEY_RULES && !KEY_RULES[key](child))
      refuse(`A chart's ${KEY_SENTENCES[key]}${at(here)}.`);
    if (SIZE_KEYS.has(key) && child === "container")
      refuse(
        `A chart can't size to its container; charts are static, with hover tooltips${at(here)}.`,
      );
    if (SIZE_KEYS.has(key) && !sizeAllowed(child))
      refuse(`A chart ${key} must be a number up to ${MAX_SIZE}, or a step${at(here)}.`);
    if (key === "data") {
      checkData(child, here, names);
      continue;
    }
    if (key === "transform") {
      if (!Array.isArray(child)) refuse(`A chart transform must be a list${at(here)}.`);
      child.forEach((transform, index) => {
        checkTransform(transform, [...here, index]);
        if (isObject(transform.from?.data)) checkData(transform.from.data, [...here, index], names);
      });
      // Transform parameters are checked by TRANSFORMS; only their strings
      // remain to check for url().
      checkStrings(child, here);
      continue;
    }
    if (key === "params") {
      if (!Array.isArray(child)) refuse(`Chart params must be a list${at(here)}.`);
      child.forEach((param, index) => checkParam(param, [...here, index]));
    }
    if (key === "mark" && (child === "image" || (isObject(child) && child.type === "image")))
      refuse(`A chart can't draw image marks${at(here)}.`);
    if (key === "bin") checkBin(child, here);
    if (key === "timeUnit") checkTimeUnit(child, here);
    if (key === "test") checkPredicate(child, here);
    else if (EXPRESSION_KEYS.has(key) && isString(child)) checkExpression(child, here);
    walk(child, here, names);
  }
}

/** Whether `value` nests at most `max` levels, checked without recursion so a
 * spec can't overflow the stack of any later pass. Cycles count as too deep. */
function nestsWithin(value, max) {
  const stack = [[value, 0]];
  let visited = 0;
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (depth > max || ++visited > CHART_SPEC_LIMITS.maxBytes) return false;
    for (const child of Array.isArray(node) ? node : Object.values(node))
      if (child && typeof child === "object") stack.push([child, depth + 1]);
  }
  return true;
}

/**
 * Check a parsed Vega-Lite spec. `datasets`, when given, lists the data names
 * the caller can supply; a spec that reads any other name is refused.
 *
 * Returns `{ ok: true, names }`, the data names the spec reads in first-use
 * order, or `{ ok: false, error }`, one sentence saying what is wrong. Never
 * throws. Whether the fields a spec encodes exist in the data is Vega-Lite's
 * to report.
 */
/**
 * Check every expression in the spec, wherever it is: any `expr`, `signal`,
 * `calculate` or `labelExpr` string, and any `filter` or `test` string. The
 * walk above checks the positions it knows; this pass has no early return, so
 * an ExprRef or SignalRef in a field predicate, a mark property, a scale or a
 * param's value is checked too. Iterative; depth is already bounded.
 */
function checkEveryExpression(spec) {
  const stack = [[spec, []]];
  while (stack.length) {
    const [value, path] = stack.pop();
    if (!value || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value)) {
      const here = [...path, key];
      if (isString(child) && !Array.isArray(value)) {
        if (EXPRESSION_KEYS.has(key) || key === "filter" || key === "test")
          checkExpression(child, here);
      } else if (child && typeof child === "object") stack.push([child, here]);
    }
  }
}

export function checkChartSpec(spec, { datasets } = {}) {
  try {
    if (!isObject(spec)) return { ok: false, error: "A chart spec must be a JSON object." };
    if (!nestsWithin(spec, CHART_SPEC_LIMITS.maxDepth))
      return {
        ok: false,
        error: `A chart spec can nest at most ${CHART_SPEC_LIMITS.maxDepth} levels deep.`,
      };
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
    if (isString(spec.$schema) && !spec.$schema.includes("/vega-lite/"))
      return { ok: false, error: "A chart spec must be Vega-Lite, not another schema." };
    const plain = JSON.parse(json);
    const { $schema: _schema, ...rest } = plain;
    const names = [];
    walk(rest, [], names);
    checkEveryExpression(rest);
    const shape = viewShape(plain);
    if (shape.views > CHART_SPEC_LIMITS.maxViews)
      return { ok: false, error: `A chart can have at most ${CHART_SPEC_LIMITS.maxViews} views.` };
    if (shape.folds > MAX_FOLD_FIELDS)
      return {
        ok: false,
        error: `A chart's folds can multiply its rows at most ${MAX_FOLD_FIELDS} times.`,
      };
    if (!names.length) return { ok: false, error: 'A chart needs data: {"name": "<dataset>"}.' };
    if (datasets) {
      const missing = names.find((name) => !datasets.includes(name));
      if (missing !== undefined)
        return {
          ok: false,
          error: `This chart reads "${missing}", but no dataset has that name.`,
        };
    }
    return { ok: true, names };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, error: error.message };
    return { ok: false, error: "This chart spec couldn't be checked." };
  }
}
