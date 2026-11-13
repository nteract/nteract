// The checks a Vega-Lite chart spec passes before Pages draws it. Plain data,
// no DOM and no Vega import, so the viewer and the host can run the same
// function: the viewer runs it before every draw (viewer/vega-chart.mjs), and
// a host write path can run it to refuse a spec with the same sentence.
//
// A chart reads only named data the caller supplies. Every `data` in a spec is
// `{ "name": ... }`: no URL, no inline values, no generator. Nothing in a spec
// may fetch or navigate (`url` and `href` anywhere, image marks), add input
// controls, or call an expression function outside CHART_EXPRESSION_FUNCTIONS.
// The viewer's Vega loader refuses every request as well; these checks give a
// clear refusal first.

export const CHART_SPEC_LIMITS = Object.freeze({
  /** UTF-8 bytes of the spec as JSON. */
  maxBytes: 64 * 1024,
  /** The spec itself plus each layer, concatenated view and facet or repeat
   * inner spec. */
  maxViews: 32,
  /** Nesting of objects and arrays. */
  maxDepth: 32,
});

/**
 * Vega expression functions a spec may call in `calculate`, `filter`, `test`,
 * `expr` and `signal` strings. Vega's own codegen already refuses anything
 * that isn't a Vega function; this list leaves out the ones a chart over a
 * Page's sources doesn't need: dataset writes (`modify`), lasso and tree
 * helpers, event and window geometry, logging, and regular expressions built
 * from strings.
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
    "timeSequence",
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
    "utcSequence",
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
    "sequence",
    "slice",
    "sort",
    "span",
    "lower",
    "pad",
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

// Keys whose string value is a Vega expression. `filter` is one only when it
// is a string; its predicate objects are plain data.
const EXPRESSION_KEYS = new Set(["expr", "calculate", "test", "signal", "filter"]);
// Names an expression may not mention at all, even as a property.
const FORBIDDEN_NAMES = new Set(["constructor", "__proto__", "prototype"]);
const VIEW_ARRAYS = ["layer", "concat", "hconcat", "vconcat"];
const STRING_LITERAL = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g;
const CALL = /([A-Za-z_$][\w$]*)\s*\(/g;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

const isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const at = (path) => (path.length ? ` (at ${path.join(".")})` : "");

class Refusal extends Error {}
const refuse = (sentence) => {
  throw new Refusal(sentence);
};

function checkExpression(text, path) {
  const code = text.replace(STRING_LITERAL, '""');
  for (const [name] of code.matchAll(IDENTIFIER))
    if (FORBIDDEN_NAMES.has(name)) refuse(`A chart expression can't use "${name}"${at(path)}.`);
  for (const [, name] of code.matchAll(CALL))
    if (!CHART_EXPRESSION_FUNCTIONS.has(name))
      refuse(`A chart expression can't call ${name}()${at(path)}.`);
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

function walk(value, path, state) {
  if (path.length > CHART_SPEC_LIMITS.maxDepth)
    refuse(`A chart spec can nest at most ${CHART_SPEC_LIMITS.maxDepth} levels deep.`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, [...path, index], state));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const here = [...path, key];
    if (key === "url") refuse(`A chart can't load anything from a URL${at(here)}.`);
    if (key === "href") refuse(`A chart can't link anywhere${at(here)}.`);
    if (key === "datasets") refuse(`A chart reads named data, not inline datasets${at(here)}.`);
    if (key === "data") checkData(child, here, state.names);
    if (key === "bind" && !isInteractionBinding(child))
      refuse(`A chart can't add input controls${at(here)}.`);
    if (key === "mark" && (child === "image" || (isObject(child) && child.type === "image")))
      refuse(`A chart can't draw image marks${at(here)}.`);
    if (key === "usermeta") continue;
    if (EXPRESSION_KEYS.has(key) && typeof child === "string") checkExpression(child, here);
    if (VIEW_ARRAYS.includes(key) && Array.isArray(child)) state.views += child.length;
    if (key === "spec" && isObject(child)) state.views += 1;
    if (state.views > CHART_SPEC_LIMITS.maxViews)
      refuse(`A chart can have at most ${CHART_SPEC_LIMITS.maxViews} views.`);
    if (key !== "data") walk(child, here, state);
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
  const state = { names: [], views: 1 };
  try {
    walk(JSON.parse(json), [], state);
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, error: error.message };
    throw error;
  }
  if (!state.names.length)
    return { ok: false, error: 'A chart needs data: {"name": "<dataset>"}.' };
  if (datasets) {
    const missing = state.names.find((name) => !datasets.includes(name));
    if (missing !== undefined)
      return { ok: false, error: `This chart reads "${missing}", but no dataset has that name.` };
  }
  return { ok: true, names: state.names };
}
