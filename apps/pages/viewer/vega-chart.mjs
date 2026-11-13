// Draws a Vega-Lite chart over datasets the caller has already loaded. Its own
// chunk: load it with `import("./vega-chart.mjs")` where a chart is shown, the
// way wordgard-dataframes.mjs loads sift-table.jsx for tables.
//
// A chart is static: marks, axes, legends and Vega's hover tooltip. Nothing
// else listens to the reader; selections, bindings, hover encodings and every
// other event stream are refused, and the View is made without `hover`,
// because each review of the interactive surface found another way through
// it. The tooltip handler formats every value without calling its own
// toString, and a tooltip that fails moves the chart to its error state.
//
// The spec and the rows are both untrusted. Four layers keep a chart from
// running code, fetching or navigating:
// - shared/chart-spec.mjs refuses a spec before anything compiles, with one
//   sentence: allowlists for data, transforms, parameters and expression
//   functions, no URL anywhere, keyword cursors, numbers in
//   CHART_NUMBER_RANGE. `datasetRows` puts the data's numbers in that range.
// - `runtimeProblem` is the boundary on what runs. It refuses a compiled Vega
//   dataflow, root or any subflow, that has any event stream, signal handler
//   or binding, any operator type outside STATIC_OPERATORS, a hover
//   encoding, or any expression outside the policy with VEGA_LITE_FUNCTIONS,
//   before the dataflow runs.
// - The viewer CSP has no 'unsafe-eval', so Vega runs with its expression
//   interpreter, and `deniedLoader` refuses every load and link.
// - The "pages-svg" renderer cleans each item's fill, stroke, font, blend and
//   cursor before Vega writes them, and the container's cursor setter takes
//   keywords only, so a data value can't put `url(...)` into a style.
//
// A chart still runs on the reader's main thread. `datasetRows` copies at
// most CHART_MAX_CELLS cells per dataset, nested values included, and
// `guardTransforms` checks the values bin, kde and regression read at run
// time. A spec that passes every check can still fail to terminate in a
// reader's tab: the guards cover the cases reviews have found, and Vega's and
// d3's numeric loops aren't proven to end. Compiling and running the dataflow
// in a Worker with a kill timer, and rendering its scenegraph here, is the
// next change. An error after the first draw moves the chart to its error
// state.
//
// The look is bare: the caller's title above, one thin rounded border around
// the drawing, and Vega-Lite's own axes, legend and hover tooltip inside it.
// The one control is the Maximize button a Mermaid diagram has, which opens
// the same expanded viewer.
import * as vega from "vega";
import * as vl from "vega-lite";
import { expressionInterpreter } from "vega-interpreter";
import { Handler as TooltipHandler } from "vega-tooltip";
import { BehaviorSubject, Observable, Subscription, combineLatest, concat } from "rxjs";
import { debounceTime, distinctUntilChanged, skip, switchMap, take } from "rxjs/operators";
import {
  CHART_CURSORS,
  CHART_EXPRESSION_FUNCTIONS,
  CHART_MAX_CELLS,
  CHART_MAX_ROWS,
  chartNumber,
  checkChartSpec,
  checkFormatCall,
  expressionProblem,
  loadsResource,
} from "../shared/chart-spec.mjs";
import { maximizeButton } from "./diagram-icons.mjs";
import { openDiagramViewer } from "./diagram-viewer.mjs";

export const CHART_RENDERER = `vega-lite@${vl.version} vega@${vega.version}`;
const DEFAULT_HEIGHT = 260;
const MIN_WIDTH = 120;
/** Wait after the last width change before redrawing, so a drag-resize draws
 * once at its end. */
export const RESIZE_SETTLE_MS = 120;

/**
 * Guards on the values Vega's looping transforms read at run time. The spec
 * check bounds literals and `datasetRows` bounds the data, but a `calculate`,
 * an aggregate or a window can derive a number outside CHART_NUMBER_RANGE
 * (`datum.x / 1e150 / 1e150 / 1e23` is about 1e-323), and these transforms
 * loop on what they read:
 *
 * | Transform  | Reads                                  | Loop                                 |
 * | ---------- | -------------------------------------- | ------------------------------------ |
 * | bin        | extent (from data), span, step, steps, | vega-statistics bin multiplies a step |
 * |            | minstep, anchor                        | that underflows to 0 forever         |
 * | kde        | extent and the field's values          | sampleCurve subdivides to span/steps |
 * | regression | extent and the x field's values        | sampleCurve, as kde                  |
 *
 * Each throws before the stock code runs when a value it reads isn't 0 or in
 * CHART_NUMBER_RANGE, so the chart moves to its error state. With every input
 * in range, a bin step is at least its span over 1e6 and a curve's stop is at
 * least its span over 500, both far above 0. Checked and left alone:
 * timeunit picks a unit from a fixed table, quantile's probabilities come
 * from the spec, and d3's linear ticks return none for a span they can't
 * step. Vega is bundled into this chunk alone, so the registry patch reaches
 * charts and nothing else.
 */
const GUARDED = Symbol.for("pages.chart.guarded");

const readable = (value) => {
  if (value == null) return true;
  let number;
  try {
    number = +value;
  } catch {
    return true;
  }
  return Number.isNaN(number) || chartNumber(number) === number;
};

function guardValues(values, transform) {
  for (const value of values)
    if (!readable(value))
      throw new Error(
        `A ${transform} read a computed value outside what a chart can draw: 0, or 1e-150 to 1e150 in size.`,
      );
}

function guardTransforms(registry) {
  if (registry[GUARDED]) return;
  registry[GUARDED] = true;
  const bin = registry.bin.prototype;
  const stockBins = bin._bins;
  bin._bins = function (_) {
    if (!this.value || _.modified()) {
      guardValues(_.extent ?? [], "bin");
      guardValues([_.span, _.step, _.minstep, _.anchor, ...(_.steps ?? [])], "bin");
    }
    return stockBins.call(this, _);
  };
  for (const [name, field] of [
    ["kde", "field"],
    ["regression", "x"],
  ]) {
    const proto = registry[name].prototype;
    const stock = proto.transform;
    proto.transform = function (_, pulse) {
      guardValues(_.extent ?? [], name);
      const read = _[field];
      if (typeof read === "function")
        for (const tuple of pulse.materialize(pulse.SOURCE).source ?? [])
          guardValues([read(tuple)], name);
      return stock.call(this, _, pulse);
    };
  }
}
guardTransforms(vega.transforms);

/** A loader that refuses every load and every link, so no spec can reach the
 * network or navigate. */
export const deniedLoader = Object.freeze({
  load: () => Promise.reject(Error("A chart reads only the datasets it is given.")),
  sanitize: () => Promise.reject(Error("A chart can't load or link to a URL.")),
  http: () => Promise.reject(Error("A chart can't load a URL.")),
  file: () => Promise.reject(Error("A chart can't load a file.")),
});

/**
 * One data value as a chart reads it. Numbers go through `chartNumber`
 * (bigints become numbers first). Vega coerces strings in arithmetic, so a
 * string that reads as a number outside CHART_NUMBER_RANGE, or as Infinity,
 * becomes that number's chart value.
 */
function plainScalar(value) {
  if (typeof value === "bigint") return chartNumber(Number(value));
  if (typeof value === "number") return chartNumber(value);
  if (typeof value === "string" && value.trim() !== "") {
    const read = Number(value);
    if (!Number.isNaN(read) && chartNumber(read) !== read) return chartNumber(read);
  }
  return value;
}

/** Nesting a copied value keeps; anything deeper becomes null. */
const MAX_NESTING = 32;

/** A dataset that needs more than CHART_MAX_CELLS cells to copy. */
class CellBudgetSpent extends Error {}

/** The cells left for one dataset's copy, top-level and nested together. */
function cellBudget(limit) {
  let left = limit;
  return (cells) => {
    left -= cells;
    if (left < 0) throw new CellBudgetSpent();
  };
}

/**
 * A copy of one data value, spending a cell for every array element and
 * object key it copies, nested ones included, so a payload shared by every row
 * counts once per row. A field path reaches nested values, so they get
 * `plainScalar` too. Objects copy as plain objects, since Vega coerces some
 * (a gradient paint) to strings; `toJSON` is honored,
 * as Arrow's nested values need; a cycle, a value deeper than MAX_NESTING or
 * a property that throws becomes null.
 */
function plainValue(value, spend, depth = 0, ancestors = []) {
  if (value instanceof Date || value === null || typeof value !== "object")
    return plainScalar(value);
  if (typeof value.toJSON === "function" && !(value instanceof Date)) {
    try {
      value = value.toJSON();
    } catch {
      return null;
    }
    if (value === null || typeof value !== "object") return plainScalar(value);
  }
  if (depth >= MAX_NESTING || ancestors.includes(value)) return null;
  ancestors.push(value);
  try {
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
      spend(value.length);
      const copy = new Array(value.length);
      for (let i = 0; i < value.length; i++)
        copy[i] = plainValue(value[i], spend, depth + 1, ancestors);
      return copy;
    }
    const copy = {};
    for (const key of Object.keys(value)) {
      spend(1);
      let item;
      try {
        item = value[key];
      } catch {
        item = null;
      }
      // Defined, not assigned, so "__proto__" stays a key, as JSON.parse
      // makes it.
      Object.defineProperty(copy, key, {
        value: plainValue(item, spend, depth + 1, ancestors),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return copy;
  } finally {
    ancestors.pop();
  }
}

const tooManyCells = (name) =>
  `The dataset "${name}" has more than ${CHART_MAX_CELLS.toLocaleString("en-US")} cells (rows × columns, nested values included); a chart reads at most that many.`;

/** Rows in a dataset, before any are copied. */
const rowCount = (dataset) =>
  Array.isArray(dataset) ? dataset.length : isArrowTable(dataset) ? dataset.numRows : 0;

/** Cells a copy of the dataset would hold, counted without copying: an Arrow
 * table's rows × columns, or each row's own keys, stopping once past `limit`. */
function cellCount(dataset, limit) {
  if (isArrowTable(dataset)) return dataset.numRows * dataset.schema.fields.length;
  if (!Array.isArray(dataset)) return 0;
  let cells = 0;
  for (const row of dataset) {
    if (row && typeof row === "object") cells += Object.keys(row).length;
    if (cells > limit) break;
  }
  return cells;
}

const isArrowTable = (value) =>
  !!value &&
  typeof value === "object" &&
  Array.isArray(value.schema?.fields) &&
  typeof value.getChildAt === "function" &&
  Number.isInteger(value.numRows);

/**
 * Plain rows for Vega from a dataset: an array of row objects, or an Arrow
 * table, or null for anything else. Rows are copied, since Vega tags each row
 * it ingests, and each value goes through `plainValue`: 64-bit integers
 * become numbers, since Vega's scales take only numbers, and every number
 * lands in CHART_NUMBER_RANGE or becomes 0 or null. Each copy has a null
 * prototype, so a column named `__proto__` stays a column and a missing
 * `constructor` or `toString` column reads as undefined.
 *
 * The copy spends at most `limit` cells, top-level and nested together, and
 * throws CellBudgetSpent past it.
 */
export function datasetRows(dataset, limit = CHART_MAX_CELLS) {
  const spend = cellBudget(limit);
  if (Array.isArray(dataset))
    return dataset.map((row) => {
      const copy = Object.create(null);
      if (!row || typeof row !== "object") return copy;
      for (const key of Object.keys(row)) {
        spend(1);
        copy[key] = plainValue(row[key], spend);
      }
      return copy;
    });
  if (isArrowTable(dataset)) {
    const columns = dataset.schema.fields.map((field, index) => ({
      name: field.name,
      vector: dataset.getChildAt(index),
    }));
    spend(dataset.numRows * columns.length);
    const rows = new Array(dataset.numRows);
    for (let r = 0; r < rows.length; r++) {
      const row = Object.create(null);
      for (const { name, vector } of columns) row[name] = plainValue(vector?.get(r) ?? null, spend);
      rows[r] = row;
    }
    return rows;
  }
  return null;
}

/** True when `error` is datasetRows running out of cells. */
export const spentCellBudget = (error) => error instanceof CellBudgetSpent;

/** The categorical palette, light and dark steps of the same eight hues
 * (validated for adjacent-pair color-vision separation). */
const CATEGORY = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};

/** The theme a chart draws with, read from the Page's own tokens. */
export function pageTheme(element) {
  const doc = element.ownerDocument;
  const style = doc.defaultView?.getComputedStyle?.(element);
  const token = (name, fallback) => style?.getPropertyValue(name).trim() || fallback;
  const dark = doc.documentElement.classList.contains("dark");
  return {
    dark,
    text: token("--foreground", dark ? "#f0efec" : "#0b0b0b"),
    muted: token("--muted-foreground", dark ? "#c3c2b7" : "#52514e"),
    line: token("--border", dark ? "#3a3a38" : "#e2e1dc"),
    font: style?.fontFamily || "system-ui, sans-serif",
  };
}

/** Vega-Lite config from a theme. A spec's own config wins over it. */
export function themeConfig(theme) {
  const category = theme.dark ? CATEGORY.dark : CATEGORY.light;
  return {
    background: null,
    font: theme.font,
    view: { stroke: null },
    axis: {
      labelColor: theme.muted,
      titleColor: theme.text,
      gridColor: theme.line,
      domainColor: theme.line,
      tickColor: theme.line,
      labelFontSize: 11,
      titleFontWeight: 500,
    },
    legend: { labelColor: theme.muted, titleColor: theme.text },
    title: { color: theme.text, anchor: "start", fontSize: 14, fontWeight: 600 },
    header: { labelColor: theme.muted, titleColor: theme.text },
    range: { category },
    // Every mark answers hover with its encoded fields; a spec's own
    // `tooltip: null` turns it off.
    mark: { color: category[0], tooltip: { content: "encoding" } },
    bar: { cornerRadiusEnd: 4 },
    line: { strokeWidth: 2 },
    point: { size: 64 },
  };
}

const isComposite = (spec) =>
  ["concat", "hconcat", "vconcat", "facet", "repeat"].some((key) => key in spec) ||
  ["row", "column", "facet"].some((key) => key in (spec.encoding ?? {}));
const DISCRETE = new Set(["nominal", "ordinal"]);

/** A spec sized for `width`, when it doesn't size itself. A discrete y axis
 * keeps Vega-Lite's own step height. */
export function sizedSpec(spec, width) {
  if (isComposite(spec)) return spec;
  return {
    ...spec,
    ...(spec.width === undefined && width > 0 && { width: Math.max(MIN_WIDTH, width) }),
    ...(spec.height === undefined &&
      !DISCRETE.has(spec.encoding?.y?.type) && { height: DEFAULT_HEIGHT }),
    autosize: spec.autosize ?? { type: "fit-x", contains: "padding" },
  };
}

/** One sentence from an error Vega or Vega-Lite threw. */
function errorSentence(error) {
  if (error instanceof ChartRefusal) return error.message;
  const message = String(error?.message ?? error ?? "").trim();
  const first = message
    .split(/(?<=[.!?])\s/)[0]
    .slice(0, 200)
    .replace(/[.!?]?$/, ".");
  return message ? `This chart couldn't be drawn: ${first}` : "This chart couldn't be drawn.";
}

const TOOLTIP_TEXT_MAX = 400;
const TOOLTIP_ROWS_MAX = 40;

/** Read `object[key]`, or `fallback` if a getter throws. */
function readKey(object, key, fallback = "[Value]") {
  try {
    return object[key];
  } catch {
    return fallback;
  }
}

/**
 * JSON-like text for a tooltip value that stops once it holds `max`
 * characters: arrays are read only as far as the text reaches, object keys
 * are enumerated only as far, nested objects past `maxDepth` become
 * "[Object]" and cycles "[Circular]". Never calls a value's own `toString` or
 * `valueOf`, and a getter that throws reads as "[Value]".
 */
function boundedText(root, maxDepth, max) {
  let out = "";
  const ancestors = [];
  const full = () => out.length >= max;
  const literal = (text) => JSON.stringify(text.length > max ? text.slice(0, max) : text);
  const visit = (value, depth) => {
    if (full()) return;
    if (typeof value === "string") out += literal(value);
    else if (typeof value === "number") out += Number.isFinite(value) ? String(value) : "null";
    else if (typeof value === "boolean" || typeof value === "bigint") out += String(value);
    else if (value === null || typeof value !== "object") out += "null";
    else if (value instanceof Date)
      out += literal(Number.isNaN(value.getTime()) ? "Invalid date" : value.toISOString());
    else if (ancestors.includes(value)) out += '"[Circular]"';
    else if (depth > maxDepth) out += '"[Object]"';
    else {
      ancestors.push(value);
      if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        out += "[";
        const length = readKey(value, "length", 0);
        for (let i = 0; i < length && !full(); i++) {
          if (i) out += ",";
          visit(readKey(value, i), depth + 1);
        }
        out += "]";
      } else {
        out += "{";
        let first = true;
        for (const key in value) {
          if (full()) break;
          if (!Object.hasOwn(value, key)) continue;
          const item = readKey(value, key);
          if (item === undefined || typeof item === "function") continue;
          out += `${first ? "" : ","}${literal(key)}:`;
          first = false;
          visit(item, depth + 1);
        }
        out += "}";
      }
      ancestors.pop();
    }
  };
  visit(root, 0);
  return out;
}

/** Text for one tooltip value, whatever it holds, at most TOOLTIP_TEXT_MAX
 * characters. Strings show as they are; anything else as bounded JSON. */
export function tooltipText(value, maxDepth = 2) {
  let text;
  try {
    if (typeof value === "string") text = value.slice(0, TOOLTIP_TEXT_MAX + 1);
    else if (value === null || typeof value !== "object") text = String(value);
    else if (value instanceof Date)
      text = Number.isNaN(value.getTime()) ? "Invalid date" : value.toISOString();
    else text = boundedText(value, maxDepth, TOOLTIP_TEXT_MAX + 1);
  } catch {
    text = "[Value]";
  }
  return text.length > TOOLTIP_TEXT_MAX ? `${text.slice(0, TOOLTIP_TEXT_MAX - 1)}…` : text;
}

/**
 * The tooltip's HTML: a title, then a table of the other fields, at most
 * TOOLTIP_ROWS_MAX of them, enumerated no further than that. `valueToHtml`
 * escapes each text. An `image` key is dropped, since vega-tooltip would load
 * its URL into an <img>; a chart's tooltip shows its fields and nothing else.
 */
export function formatTooltip(value, valueToHtml, maxDepth = 2) {
  const html = (item) => valueToHtml(tooltipText(item, maxDepth));
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Date)
    return html(value);
  let content = "";
  let rows = "";
  let shown = 0;
  let more = false;
  try {
    for (const key in value) {
      if (!Object.hasOwn(value, key) || key === "image") continue;
      const item = readKey(value, key);
      if (item === undefined) continue;
      if (key === "title") {
        if (item) content += `<h2>${html(item)}</h2>`;
        continue;
      }
      if (shown === TOOLTIP_ROWS_MAX) {
        more = true;
        break;
      }
      rows += `<tr><td class="key">${html(key)}</td><td class="value">${html(item)}</td></tr>`;
      shown++;
    }
  } catch {
    return html("[Value]");
  }
  if (more) rows += `<tr><td class="key">…</td><td class="value">more fields</td></tr>`;
  if (rows) content += `<table>${rows}</table>`;
  return content || "{}";
}

let tooltipCount = 0;

/**
 * Functions a static chart's compiled dataflow may call: the ones a spec may
 * call itself, plus what Vega-Lite 6.5.0 generates for static charts. The
 * corpus test in viewer/vega-chart.test.mjs compiles static specs across
 * marks, transforms and composition and fails if Vega-Lite emits a call
 * outside this set.
 */
export const VEGA_LITE_FUNCTIONS = Object.freeze(
  new Set([
    ...CHART_EXPRESSION_FUNCTIONS,
    // A scale by its name in the chart's own scope, for band offsets and
    // label positions.
    "bandwidth",
    "scale",
    // Scale lookups by Vega's internal scale reference, for encodings.
    "_bandwidth",
    "_range",
    "_scale",
    // Band and point scale layout: padding as a fraction of the step.
    "bandspace",
    // A facet's cell count and a layout's extent read the chart's own data.
    "data",
    // A scale's domain and range, for axis and legend layout.
    "domain",
    "range",
    // Legend symbol layout by column.
    "flush",
    // A continuous color legend's gradient.
    "gradient",
    // Multi-line titles and labels, joined from the spec's own strings.
    "join",
    // Linear interpolation for legend gradients and offsets.
    "lerp",
    // Time-unit labels for temporal axes.
    "timeUnitSpecifier",
  ]),
);

/**
 * Operator types a static chart's compiled dataflow uses, from the corpus
 * test. Interaction adds others (selection tuples, Voronoi for nearest
 * points), and those never run.
 */
export const STATIC_OPERATORS = Object.freeze(
  new Set([
    "aggregate",
    "axisticks",
    "bin",
    "bound",
    "collect",
    "datajoin",
    "encode",
    "extent",
    "facet",
    "filter",
    "fold",
    "formula",
    "geoshape",
    "impute",
    "joinaggregate",
    "kde",
    "legendentries",
    "lookup",
    "mark",
    "multiextent",
    "operator",
    "overlap",
    "pivot",
    "prefacet",
    "projection",
    "proxy",
    "quantile",
    "regression",
    "relay",
    "render",
    "sample",
    "scale",
    "sequence",
    "sieve",
    "sortitems",
    "stack",
    "timeunit",
    "tupleindex",
    "values",
    "viewlayout",
    "window",
  ]),
);

/** A refusal whose message is the sentence a reader sees. */
class ChartRefusal extends Error {}

const STATIC = "charts are static, with hover tooltips";

/** True for `timeUnitSpecifier(...)` over literals, which Vega-Lite passes
 * as a temporal axis's label specifier. */
const literalTimeUnitSpecifier = (node) =>
  node?.type === "CallExpression" &&
  node.callee?.type === "Identifier" &&
  node.callee.name === "timeUnitSpecifier" &&
  node.arguments.every(function literal(arg) {
    if (arg.type === "Literal") return true;
    if (arg.type === "ArrayExpression") return arg.elements.every(literal);
    if (arg.type === "ObjectExpression")
      return arg.properties.every((property) => literal(property.value));
    return false;
  });

/** The spec's call check, except that a format specifier may also be a
 * literal `timeUnitSpecifier(...)`. */
const checkCompiledCall = (call) =>
  literalTimeUnitSpecifier(call.arguments[1]) ? null : checkFormatCall(call);

/**
 * Why a parsed Vega dataflow can't run, or null. In the root and in every
 * `$subflow`: no event stream, signal handler or binding, and only
 * STATIC_OPERATORS. Anywhere: no hover encoding, no image mark, and every
 * expression within the policy with VEGA_LITE_FUNCTIONS.
 */
export function runtimeProblem(runtime) {
  if (!runtime || typeof runtime !== "object") return "This chart didn't compile.";
  const seen = new Set();
  const stack = [runtime];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    // The root and every `$subflow` (a facet's or a repeat's cells) is a
    // dataflow of its own, with its own operators and streams.
    if (node === runtime) {
      const problem = flowProblem(node);
      if (problem) return problem;
    }
    if (node.$subflow && typeof node.$subflow === "object") {
      const problem = flowProblem(node.$subflow);
      if (problem) return problem;
    }
    if (node.marktype === "image") return "This chart can't draw image marks.";
    // A hover encoding would run on pointer events.
    if (node.$encode && typeof node.$encode === "object" && "hover" in node.$encode)
      return `This chart changes on hover; ${STATIC}.`;
    if (node.ast) {
      const problem = expressionProblem(node.ast, VEGA_LITE_FUNCTIONS, checkCompiledCall);
      if (problem) return `This chart's compiled code ${problem}.`;
    }
    for (const child of Object.values(node))
      if (child && typeof child === "object") stack.push(child);
  }
  return null;
}

/** Why one dataflow, the root or a subflow, isn't static, or null. */
function flowProblem(flow) {
  for (const key of ["streams", "updates", "bindings"])
    if (flow[key] !== undefined && (!Array.isArray(flow[key]) || flow[key].length))
      return `This chart listens for events; ${STATIC}.`;
  if (flow.operators !== undefined && !Array.isArray(flow.operators))
    return "This chart didn't compile.";
  for (const operator of flow.operators ?? [])
    if (!STATIC_OPERATORS.has(operator?.type))
      return `This chart uses a ${operator?.type} operator; ${STATIC}.`;
  return null;
}

// A paint is a color, never a reference: hex, a color keyword, or one color
// function with no nested parentheses, quotes or escapes.
const PAINT =
  /^(?:#[0-9a-f]{3,8}|[a-z]+|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()\\;:"']*\))$/i;
const BLENDS = new Set([
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
]);
const safeColor = (value) => (typeof value === "string" && PAINT.test(value.trim()) ? value : null);

/** A fill or stroke the SVG renderer may write: a color, or a gradient whose
 * stops are colors. Vega writes its own `url(#id)` for a gradient. */
export function safePaint(value) {
  if (value && typeof value === "object" && value.gradient) {
    for (const stop of Array.isArray(value.stops) ? value.stops : [])
      if (stop && typeof stop === "object") stop.color = safeColor(stop.color) ?? "transparent";
    return Array.isArray(value.stops) ? value : null;
  }
  return safeColor(value);
}

/** Clean the scene item properties that reach a style or a cursor. */
export function cleanItem(item) {
  for (const key of ["fill", "stroke"])
    if (item[key] != null) {
      const safe = safePaint(item[key]);
      if (safe !== item[key]) item[key] = safe;
    }
  if (
    item.font != null &&
    (typeof item.font !== "string" || loadsResource(item.font) || /[\\();{}]/.test(item.font))
  )
    item.font = null;
  if (item.blend != null && !BLENDS.has(item.blend)) item.blend = null;
  if (item.cursor != null && !CHART_CURSORS.has(item.cursor)) item.cursor = null;
}

/** Vega's SVG renderer, cleaning each item before it writes it. `_update`
 * writes a mark's attributes (a text's font among them) and then calls
 * `style`; a group's background calls `style` directly. */
class PagesSVGRenderer extends vega.SVGRenderer {
  _update(mdef, el, item) {
    if (item) cleanItem(item);
    return super._update(mdef, el, item);
  }
  style(el, item) {
    if (item) cleanItem(item);
    return super.style(el, item);
  }
  background(color) {
    if (!arguments.length) return super.background();
    return super.background(safeColor(color));
  }
}
vega.renderModule("pages-svg", {
  renderer: PagesSVGRenderer,
  headless: PagesSVGRenderer,
  handler: vega.SVGHandler,
});

/** Vega sets the view's cursor with `container.style.cursor = value`. Let it
 * set keywords only. */
function guardCursor(element) {
  const style = element.style;
  let proto = Object.getPrototypeOf(style);
  while (proto && !Object.hasOwn(proto, "cursor")) proto = Object.getPrototypeOf(proto);
  const accessor = proto && Object.getOwnPropertyDescriptor(proto, "cursor");
  if (!accessor?.set) return;
  Object.defineProperty(style, "cursor", {
    configurable: true,
    get: () => accessor.get.call(style),
    set: (value) => accessor.set.call(style, CHART_CURSORS.has(value) ? value : ""),
  });
}

/** Vega's logger, handing each error to `onError`. An operator that throws
 * during a run logs and lets the run finish, so the logger is how a chart
 * learns it failed, on the first draw or any later run. */
function reportingLogger(onError) {
  const logger = vega.logger(vega.Warn);
  const error = logger.error;
  logger.error = (...args) => {
    onError(new Error(args.map((arg) => arg?.message ?? String(arg)).join(" ")));
    return error.apply(logger, args);
  };
  return logger;
}

/**
 * Draw `spec` over `data` (name → plain rows) into `target`. Resolves with the
 * Vega view; rejects with Vega's error after finalizing a half-built view.
 * `onError(error)` hears an error from any run after the first.
 */
export async function drawChart(target, { spec, data, theme, width, tooltip, onError }) {
  const compiled = vl.compile(sizedSpec(spec, width), { config: themeConfig(theme) }).spec;
  const runtime = vega.parse(compiled, null, { ast: true });
  const problem = runtimeProblem(runtime);
  if (problem) throw new ChartRefusal(problem);
  guardCursor(target);
  let firstError = null;
  let drawn = false;
  const view = new vega.View(runtime, {
    expr: expressionInterpreter,
    loader: deniedLoader,
    renderer: "pages-svg",
    container: target,
    ...(tooltip && { tooltip }),
    logger: reportingLogger((error) => {
      if (!drawn) firstError ??= error;
      else onError?.(error);
    }),
  });
  try {
    for (const [name, rows] of Object.entries(data)) view.data(name, rows);
    await view.runAsync();
    if (firstError) throw firstError;
    drawn = true;
    return view;
  } catch (error) {
    view.finalize();
    throw error;
  }
}

/** The width a chart may fill: the element's content box. */
function contentWidth(element) {
  const style = element.ownerDocument.defaultView?.getComputedStyle?.(element);
  const padding =
    (Number.parseFloat(style?.paddingLeft) || 0) + (Number.parseFloat(style?.paddingRight) || 0);
  return Math.max(0, Math.round(element.clientWidth - padding));
}

/**
 * Mount a chart in `container`. `spec` is a parsed Vega-Lite spec. `datasets`
 * maps each data name the spec reads to rows or an Arrow table; the chart
 * never fetches. `title` is shown above the chart. Returns `{ destroy }`.
 *
 * A Page theme change or a new container width redraws the chart, so text
 * keeps its size at any width; a draw still in flight is abandoned, so a slow
 * earlier draw never replaces a newer one. A spec the checks refuse, or one
 * Vega can't draw, shows one sentence inside the border instead.
 */
export function mount(container, { spec, datasets = {}, title = "" }) {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  const figure = container.appendChild(doc.createElement("figure"));
  figure.className = "pages-chart";
  figure.setAttribute("aria-label", title || "Chart");
  figure.dataset.chartStatus = "drawing";
  const header = figure.appendChild(doc.createElement("figcaption"));
  header.className = "pages-chart-header";
  if (title) {
    const caption = header.appendChild(doc.createElement("span"));
    caption.className = "pages-chart-title";
    caption.textContent = title;
  }
  const actions = header.appendChild(doc.createElement("div"));
  actions.className = "wordgard-diagram-actions";
  actions.setAttribute("role", "group");
  actions.setAttribute("aria-label", "Chart actions");
  const maximize = actions.appendChild(maximizeButton("Maximize chart", doc));
  const frame = figure.appendChild(doc.createElement("div"));
  frame.className = "pages-chart-frame";
  const canvas = frame.appendChild(doc.createElement("div"));
  canvas.className = "pages-chart-canvas";
  const message = frame.appendChild(doc.createElement("p"));
  message.className = "pages-chart-message";
  message.hidden = true;
  const showHeader = () => (header.hidden = !title && maximize.hidden);
  showHeader();

  let view = null;
  let viewer = null;
  const show = (status, sentence = "") => {
    figure.dataset.chartStatus = status;
    message.hidden = status !== "error";
    message.textContent = sentence;
    maximize.hidden = status !== "rendered";
    showHeader();
  };
  maximize.onclick = () => {
    const svg = canvas.querySelector("svg");
    if (svg) viewer = openDiagramViewer({ svg, label: title || "Chart", opener: maximize });
  };

  // Each step runs whether or not an earlier one throws, so the figure and
  // the tooltip always leave the document; the first failure is reported, not
  // thrown at the caller. `removeTooltip` is set once the tooltip exists.
  let removeTooltip = null;
  const teardown = () => {
    const closing = viewer;
    const finalizing = view;
    viewer = null;
    view = null;
    let failure = null;
    for (const step of [
      () => closing?.close(),
      () => finalizing?.finalize(),
      () => figure.remove(),
      () => removeTooltip?.(),
    ])
      try {
        step();
      } catch (error) {
        failure ??= error;
      }
    if (failure) (win?.reportError ?? console.error)(failure);
  };

  // Plain JSON: functions, cycles and prototypes never reach Vega-Lite.
  let plain;
  try {
    plain = JSON.parse(JSON.stringify(spec));
  } catch {
    plain = undefined;
  }
  const checked = checkChartSpec(plain, { datasets: Object.keys(datasets) });
  // Keyed by dataset name, so neither map answers to a name it wasn't given.
  const given = (name) => (Object.hasOwn(datasets, name) ? datasets[name] : undefined);
  const data = Object.create(null);
  let refusal = checked.ok ? null : checked.error;
  if (!refusal)
    for (const name of checked.names) {
      const rows = rowCount(given(name));
      if (rows > CHART_MAX_ROWS) {
        refusal = `The dataset "${name}" has ${rows.toLocaleString("en-US")} rows; a chart reads at most ${CHART_MAX_ROWS.toLocaleString("en-US")}.`;
        break;
      }
      if (cellCount(given(name), CHART_MAX_CELLS) > CHART_MAX_CELLS) {
        refusal = tooManyCells(name);
        break;
      }
      try {
        data[name] = datasetRows(given(name));
      } catch (error) {
        if (!spentCellBudget(error)) throw error;
        refusal = tooManyCells(name);
        break;
      }
      if (!data[name]) {
        refusal = `The dataset "${name}" must be rows or an Arrow table.`;
        break;
      }
    }
  if (refusal) {
    show("error", refusal);
    return { destroy: teardown };
  }

  const tooltipId = `pages-chart-tooltip-${++tooltipCount}`;
  removeTooltip = () => doc.getElementById(tooltipId)?.remove();
  const tooltip = new TooltipHandler({
    id: tooltipId,
    theme: "pages",
    disableDefaultStyle: true,
    formatTooltip,
  });
  // Finalizing a view hides its tooltip, and vega-tooltip creates the element
  // to hide it. After destroy, a late draw's finalize must not.
  let mounted = true;
  // A failure after the chart drew (a later run, a tooltip that can't show)
  // leaves it in its error state. Deferred, so a view isn't finalized inside
  // its own run or event. `target` is the drawing that failed; a newer one
  // stays.
  const fail = (error, target = canvas.firstChild) =>
    queueMicrotask(() => {
      if (!mounted || !target || canvas.firstChild !== target) return;
      view?.finalize();
      view = null;
      canvas.replaceChildren();
      show("error", errorSentence(error));
    });
  const showTooltip = (...args) => {
    if (!mounted) return;
    try {
      tooltip.call(...args);
    } catch (error) {
      fail(error);
    }
  };
  const themes = new BehaviorSubject(pageTheme(container));
  const watchTheme = win?.MutationObserver
    ? new win.MutationObserver(() => themes.next(pageTheme(container)))
    : null;
  watchTheme?.observe(doc.documentElement, { attributes: true, attributeFilter: ["class"] });
  const widths = new BehaviorSubject(contentWidth(frame));
  const watchSize = win?.ResizeObserver
    ? new win.ResizeObserver(() => widths.next(contentWidth(frame)))
    : null;
  watchSize?.observe(frame);
  // The first width draws at once; later ones wait for the resize to settle.
  const settledWidths = concat(
    widths.pipe(take(1)),
    widths.pipe(skip(1), debounceTime(RESIZE_SETTLE_MS)),
  ).pipe(distinctUntilChanged());

  const draw = ([theme, width]) =>
    new Observable((subscriber) => {
      let cancelled = false;
      const target = doc.createElement("div");
      const onError = (error) => fail(error, target);
      drawChart(target, { spec: plain, data, theme, width, tooltip: showTooltip, onError }).then(
        (drawn) => {
          if (cancelled) drawn.finalize();
          else subscriber.next({ view: drawn, target });
          subscriber.complete();
        },
        (error) => {
          if (!cancelled) subscriber.next({ error });
          subscriber.complete();
        },
      );
      return () => {
        cancelled = true;
      };
    });

  const subscription = new Subscription();
  subscription.add(
    combineLatest([themes.pipe(distinctUntilChanged((a, b) => a.dark === b.dark)), settledWidths])
      .pipe(switchMap(draw))
      .subscribe((result) => {
        view?.finalize();
        view = result.view ?? null;
        canvas.replaceChildren(...(result.target ? [result.target] : []));
        if (result.error) show("error", errorSentence(result.error));
        else show("rendered");
      }),
  );

  return {
    destroy() {
      mounted = false;
      subscription.unsubscribe();
      watchTheme?.disconnect();
      watchSize?.disconnect();
      teardown();
    },
  };
}
