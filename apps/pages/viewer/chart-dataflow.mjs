// The chart's Vega side: compile a checked Vega-Lite spec, check the compiled
// dataflow, run it over the datasets, and return the finished scenegraph as
// plain objects. viewer/chart-worker.mjs runs it in a Worker, so a chart that
// never terminates is cut off by the page's timer instead of freezing the tab;
// viewer/vega-chart.mjs draws the scenegraph. No DOM.
import * as vega from "vega";
import * as vl from "vega-lite";
import { expressionInterpreter } from "vega-interpreter";
import {
  CHART_EXPRESSION_FUNCTIONS,
  CHART_MAX_CELLS,
  CHART_MAX_ROWS,
  chartNumber,
  checkChartSpec,
  checkFormatCall,
  expressionProblem,
} from "../shared/chart-spec.mjs";
import { tableFromIPC } from "apache-arrow";
import { chartTable } from "./chart-arrow.mjs";
import { datasetRows, ownRows, spentCellBudget, tooManyCells } from "./chart-data.mjs";
import { SCENE_KEYS } from "./chart-scene.mjs";
import { CHART_FALLBACK_FONT, probeItems, usableFont } from "./chart-font.mjs";

export const CHART_RENDERER = `vega-lite@${vl.version} vega@${vega.version}`;
const DEFAULT_HEIGHT = 260;
const MIN_WIDTH = 120;

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

/** A loader that refuses every load and every link, so no spec can reach the
 * network or navigate. */
export const deniedLoader = Object.freeze({
  load: () => Promise.reject(Error("A chart reads only the datasets it is given.")),
  sanitize: () => Promise.reject(Error("A chart can't load or link to a URL.")),
  http: () => Promise.reject(Error("A chart can't load a URL.")),
  file: () => Promise.reject(Error("A chart can't load a file.")),
});

/** The categorical palette, light and dark steps of the same eight hues
 * (validated for adjacent-pair color-vision separation). */
const CATEGORY = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};

/** Vega-Lite config from a theme. A spec's own config wins over it. The font
 * is the stack the page chose for this Worker (chart-font.mjs). */
export function themeConfig(theme) {
  const category = theme.dark ? CATEGORY.dark : CATEGORY.light;
  return {
    background: null,
    font: usableFont(theme.font) ? theme.font : CHART_FALLBACK_FONT,
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

/** Measure text with an OffscreenCanvas where the Worker has one, as Vega
 * measures with a canvas in a page; without one, Vega estimates. The Worker
 * sees only installed fonts, so the page probes it before choosing the stack
 * charts draw in (chart-font.mjs). */
export function installTextMetrics(scope = globalThis) {
  if (typeof scope.OffscreenCanvas !== "function") return false;
  const context = new scope.OffscreenCanvas(1, 1).getContext("2d");
  if (!context) return false;
  vega.textMetrics.width = (item, text) => {
    const line = text == null ? "" : String(text).trim();
    if (!line || !(vega.textMetrics.height(item) > 0)) return 0;
    context.font = vega.font(item);
    return context.measureText(line).width;
  };
  return true;
}

/** A tooltip value as plain JSON, or null if it isn't JSON. */
function plainTooltip(value) {
  if (value === null || typeof value !== "object") return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

const GRADIENT_KEYS = ["gradient", "id", "x1", "y1", "x2", "y2", "r1", "r2"];

/** A gradient without its `stop` method: the keys and stops the SVG
 * renderer reads. */
function plainGradient(value) {
  const out = {};
  for (const key of GRADIENT_KEYS) if (value[key] !== undefined) out[key] = value[key];
  out.stops = Array.isArray(value.stops)
    ? value.stops.map(({ offset, color }) => ({ offset, color }))
    : [];
  return out;
}

/** One scene value as structured clone and the page's renderer take it:
 * primitives as they are, arrays as JSON, gradients without their methods.
 * Anything else (a function, a class instance) is left out. */
function plainSceneValue(key, value) {
  if (key === "tooltip") return plainTooltip(value);
  if (value === null || typeof value !== "object")
    return typeof value === "function" ? undefined : value;
  if ((key === "fill" || key === "stroke") && value.gradient) return plainGradient(value);
  return Array.isArray(value) ? (plainTooltip(value) ?? undefined) : undefined;
}

/** A shape mark's items draw from a function on the mark (geoshape's
 * projected path), which can't cross to the page. The Worker runs it and
 * sends a path mark with each item's SVG path string. */
function shapeItem(mark, item) {
  const generator = mark.shape || item.shape;
  const out = plainItem(item);
  out.path = typeof generator?.context === "function" ? (generator.context(null)(item) ?? "") : "";
  return out;
}

function plainItem(node) {
  const out = {};
  for (const key of SCENE_KEYS) {
    const value = node[key];
    if (value === undefined || key === "items" || key === "shape") continue;
    const plain = plainSceneValue(key, value);
    if (plain !== undefined) out[key] = plain;
  }
  // A symbol's shape is a name or an SVG path string.
  if (typeof node.shape === "string") out.shape = node.shape;
  return out;
}

/** The scenegraph as plain objects, for postMessage and sceneFromJSON. */
export function plainScene(node) {
  if (Array.isArray(node)) return node.map(plainScene);
  if (node.marktype === "shape") {
    const out = plainItem(node);
    out.marktype = "path";
    out.items = (node.items ?? []).map((item) => shapeItem(node, item));
    return out;
  }
  const out = plainItem(node);
  if (Array.isArray(node.items)) out.items = node.items.map(plainScene);
  return out;
}

/** The sentence for a dataset over the row budget. */
export const tooManyRows = (name, rows) =>
  `The dataset "${name}" has ${rows.toLocaleString("en-US")} rows; a chart reads at most ${CHART_MAX_ROWS.toLocaleString("en-US")}.`;

/** A dataset as it crosses to the Worker: `{ rows }` from structured clone,
 * or `{ ipc }`, Arrow IPC bytes the page copied for this Worker, read through
 * chart-arrow.mjs `chartTable` so decimals, 64-bit integers, times and nested
 * values read as a chart reads them. Normalized under the row and cell
 * budgets. */
function readDataset(name, dataset) {
  try {
    if (Array.isArray(dataset?.rows)) {
      if (dataset.rows.length > CHART_MAX_ROWS)
        throw new ChartRefusal(tooManyRows(name, dataset.rows.length));
      return ownRows(dataset.rows);
    }
    if (dataset?.ipc instanceof Uint8Array) {
      const table = tableFromIPC(dataset.ipc);
      if (table.numRows > CHART_MAX_ROWS) throw new ChartRefusal(tooManyRows(name, table.numRows));
      return datasetRows(chartTable(table));
    }
  } catch (error) {
    if (spentCellBudget(error)) throw new ChartRefusal(tooManyCells(name));
    if (error instanceof ChartRefusal) throw error;
    throw new ChartRefusal(`The dataset "${name}" couldn't be read.`);
  }
  throw new ChartRefusal(`The dataset "${name}" must be rows, Arrow IPC bytes or an Arrow table.`);
}

/** Every dataset the page sent, normalized: name → rows. */
export function readDatasets(datasets) {
  const data = Object.create(null);
  for (const [name, dataset] of Object.entries(datasets)) data[name] = readDataset(name, dataset);
  return data;
}

/**
 * Compile and run a chart over `data` (name → rows from readDatasets), and
 * return what the page draws: the scenegraph as
 * plain objects, the background, and the drawing's size and origin. `spec`
 * is checked again here (`checkSpec`), the compiled dataflow is checked before
 * it runs (`checkDataflow`), and the looping transforms are guarded (`guard`).
 * Turning those off is for tests and for the smoke's fixture Worker, which
 * proves the page's timer cuts off a chart the checks would have refused.
 */
export async function runChart(
  { spec, data, theme, width },
  { checkSpec = true, checkDataflow = true, guard = true } = {},
) {
  if (guard) guardTransforms(vega.transforms);
  if (checkSpec) {
    const checked = checkChartSpec(spec, { datasets: Object.keys(data) });
    if (!checked.ok) throw new ChartRefusal(checked.error);
  }
  const compiled = vl.compile(sizedSpec(spec, width), { config: themeConfig(theme) }).spec;
  const runtime = vega.parse(compiled, null, { ast: true });
  if (checkDataflow) {
    const problem = runtimeProblem(runtime);
    if (problem) throw new ChartRefusal(problem);
  }
  let firstError = null;
  const view = new vega.View(runtime, {
    expr: expressionInterpreter,
    loader: deniedLoader,
    renderer: "none",
    logger: reportingLogger((error) => {
      firstError ??= error;
    }),
  });
  try {
    for (const [name, rows] of Object.entries(data)) view.data(name, rows);
    await view.runAsync();
    if (firstError) throw firstError;
    // The size and offset Vega's own renderer takes (vega-view
    // render-size.js): the layout origin, which moves for axis labels and
    // titles, plus the padding.
    const padding = view.padding();
    const [x, y] = view.origin();
    return {
      scene: plainScene(view.scenegraph().root),
      background: view.background() ?? null,
      width: Math.max(0, view._viewWidth + padding.left + padding.right),
      height: Math.max(0, view._viewHeight + padding.top + padding.bottom),
      origin: [padding.left + x, padding.top + y],
    };
  } finally {
    view.finalize();
  }
}

/** True when `error`'s message is the sentence a reader sees as it is. */
export const isRefusal = (error) => error instanceof ChartRefusal;

/** What a failed draw tells the page: the message, and whether it is already
 * the one sentence a reader sees. */
const failure = (error) => ({
  message: String(error?.message ?? error ?? ""),
  refusal: error instanceof ChartRefusal,
});

/** Widths for the page's font probe, measured as the Worker's layout measures
 * text (Vega's text metrics). A stack the page may not name is measured as
 * the fallback. */
export function probe(fonts) {
  const stacks = (Array.isArray(fonts) ? fonts : []).slice(0, 2);
  while (stacks.length < 2) stacks.push(CHART_FALLBACK_FONT);
  return probeItems(stacks.map((font) => (usableFont(font) ? font : CHART_FALLBACK_FONT))).map(
    ({ item, text }) => vega.textMetrics.width(item, text),
  );
}

/**
 * Answer the page's messages in `scope` (the Worker's global). The page
 * (chart-pool.mjs) hands this Worker one job at a time:
 *
 * - `{ type: "draw", id, key, spec, theme, width, datasets? }` draws chart
 *   `key`. `datasets` comes with the first job for a chart and is decoded
 *   and kept for its later jobs; a dataset that can't be read fails that
 *   chart's jobs with its sentence. `failed` in place of `datasets` says the
 *   page couldn't send them. Each job is answered with `{ type: "answer",
 *   id, scene, width, height, origin, background }` or `{ type: "answer",
 *   id, error }`.
 * - `{ type: "drop", key }` forgets a chart's data.
 * - `{ type: "probe", fonts }` measures the font probe (chart-font.mjs) in
 *   each stack, answered with `{ type: "probed", widths }`.
 *
 * `{ type: "ready" }` is posted once, when the script has loaded. Jobs that
 * arrive while one runs wait their turn, in order.
 */
export function serveCharts(scope, options = {}) {
  const charts = new Map();
  const queue = [];
  let running = false;
  const take = (message) => {
    if (typeof message.failed === "string")
      charts.set(message.key, { data: null, error: new Error(message.failed) });
    else if (message.datasets !== undefined)
      try {
        charts.set(message.key, { data: readDatasets(message.datasets), error: null });
      } catch (error) {
        charts.set(message.key, { data: null, error });
      }
  };
  const pump = async () => {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const message = queue.shift();
        const { id, key, spec, theme, width } = message;
        try {
          take(message);
          const chart = charts.get(key);
          if (!chart) throw new ChartRefusal("This chart has no data yet.");
          if (chart.error) throw chart.error;
          const result = await runChart({ spec, data: chart.data, theme, width }, options);
          scope.postMessage({ type: "answer", id, ...result });
        } catch (error) {
          scope.postMessage({ type: "answer", id, error: failure(error) });
        }
      }
    } finally {
      running = false;
    }
  };
  scope.addEventListener("message", ({ data: message }) => {
    if (message?.type === "probe")
      scope.postMessage({ type: "probed", widths: probe(message.fonts) });
    else if (message?.type === "drop") charts.delete(message.key);
    else if (message?.type === "draw") {
      queue.push(message);
      pump();
    }
  });
  scope.postMessage({ type: "ready" });
}
