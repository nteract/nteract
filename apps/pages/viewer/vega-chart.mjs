// Draws a Vega-Lite chart over datasets the caller has already loaded. Its own
// chunk: load it with `import("./vega-chart.mjs")` where a chart is shown, the
// way wordgard-dataframes.mjs loads sift-table.jsx for tables.
//
// The viewer CSP has no 'unsafe-eval', so Vega runs with its expression
// interpreter, and its loader refuses every request: a chart's only data is
// the rows the caller passes, and it can't fetch an image or follow a link.
// shared/chart-spec.mjs refuses the same things first, with a sentence.
//
// The look is bare: the caller's title above, one thin rounded border around
// the drawing, and Vega-Lite's own axes, legend and hover tooltip inside it.
// The one control is the Maximize button a Mermaid diagram has, which opens
// the same expanded viewer.
import * as vega from "vega";
import * as vl from "vega-lite";
import { expressionInterpreter } from "vega-interpreter";
import { Handler as TooltipHandler, formatValue } from "vega-tooltip";
import { BehaviorSubject, Observable, Subscription, combineLatest, concat } from "rxjs";
import { debounceTime, distinctUntilChanged, skip, switchMap, take } from "rxjs/operators";
import { checkChartSpec } from "../shared/chart-spec.mjs";
import { maximizeButton } from "./diagram-icons.mjs";
import { openDiagramViewer } from "./diagram-viewer.mjs";

export const CHART_RENDERER = `vega-lite@${vl.version} vega@${vega.version}`;
const DEFAULT_HEIGHT = 260;
const MIN_WIDTH = 120;
/** Wait after the last width change before redrawing, so a drag-resize draws
 * once at its end. */
export const RESIZE_SETTLE_MS = 120;

/** A loader that refuses every load and every link, so no spec can reach the
 * network or navigate. */
export const deniedLoader = Object.freeze({
  load: () => Promise.reject(Error("A chart reads only the datasets it is given.")),
  sanitize: () => Promise.reject(Error("A chart can't load or link to a URL.")),
  http: () => Promise.reject(Error("A chart can't load a URL.")),
  file: () => Promise.reject(Error("A chart can't load a file.")),
});

const plainValue = (value) =>
  typeof value === "bigint"
    ? Number(value)
    : value instanceof Date || value === null || typeof value !== "object"
      ? value
      : JSON.parse(
          JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? Number(item) : item)),
        );

const isArrowTable = (value) =>
  !!value &&
  typeof value === "object" &&
  Array.isArray(value.schema?.fields) &&
  typeof value.getChildAt === "function" &&
  Number.isInteger(value.numRows);

/**
 * Plain rows for Vega from a dataset: an array of row objects, or an Arrow
 * table. Rows are copied, since Vega tags each row it ingests, and 64-bit
 * integers become numbers, since Vega's scales take only numbers.
 */
export function datasetRows(dataset) {
  if (Array.isArray(dataset))
    return dataset.map((row) => {
      const copy = {};
      for (const [key, value] of Object.entries(row ?? {})) copy[key] = plainValue(value);
      return copy;
    });
  if (isArrowTable(dataset)) {
    const columns = dataset.schema.fields.map((field, index) => ({
      name: field.name,
      vector: dataset.getChildAt(index),
    }));
    const rows = new Array(dataset.numRows);
    for (let r = 0; r < rows.length; r++) {
      const row = {};
      for (const { name, vector } of columns) row[name] = plainValue(vector?.get(r) ?? null);
      rows[r] = row;
    }
    return rows;
  }
  return null;
}

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
  const message = String(error?.message ?? error ?? "").trim();
  const first = message
    .split(/(?<=[.!?])\s/)[0]
    .slice(0, 200)
    .replace(/[.!?]?$/, ".");
  return message ? `This chart couldn't be drawn: ${first}` : "This chart couldn't be drawn.";
}

// A tooltip value's `image` key would load a URL into an <img>; a chart's
// tooltip shows its fields and nothing else.
export const formatTooltip = (value, valueToHtml, maxDepth, baseURL) => {
  if (value && typeof value === "object" && !Array.isArray(value) && "image" in value) {
    const { image: _image, ...rest } = value;
    value = rest;
  }
  return formatValue(value, valueToHtml, maxDepth, baseURL);
};

let tooltipCount = 0;

/**
 * Draw `spec` over `data` (name → plain rows) into `target`. Resolves with the
 * Vega view; rejects with Vega's error after finalizing a half-built view.
 */
export async function drawChart(target, { spec, data, theme, width, tooltip }) {
  const compiled = vl.compile(sizedSpec(spec, width), { config: themeConfig(theme) }).spec;
  const view = new vega.View(vega.parse(compiled, null, { ast: true }), {
    expr: expressionInterpreter,
    loader: deniedLoader,
    renderer: "svg",
    container: target,
    hover: true,
    ...(tooltip && { tooltip }),
    logLevel: vega.Warn,
  });
  try {
    for (const [name, rows] of Object.entries(data)) view.data(name, rows);
    await view.runAsync();
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

  const teardown = () => {
    viewer?.close();
    viewer = null;
    view?.finalize();
    view = null;
    figure.remove();
  };

  // Plain JSON: functions, cycles and prototypes never reach Vega-Lite.
  let plain;
  try {
    plain = JSON.parse(JSON.stringify(spec));
  } catch {
    plain = undefined;
  }
  const checked = checkChartSpec(plain, { datasets: Object.keys(datasets) });
  const data = {};
  let refusal = checked.ok ? null : checked.error;
  if (!refusal)
    for (const name of checked.names) {
      data[name] = datasetRows(datasets[name]);
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
  const tooltip = new TooltipHandler({
    id: tooltipId,
    theme: "pages",
    disableDefaultStyle: true,
    formatTooltip,
  });
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
      drawChart(target, { spec: plain, data, theme, width, tooltip: tooltip.call }).then(
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
      subscription.unsubscribe();
      watchTheme?.disconnect();
      watchSize?.disconnect();
      teardown();
      // After the view: finalizing it hides the tooltip, which recreates the
      // element.
      doc.getElementById(tooltipId)?.remove();
    },
  };
}
