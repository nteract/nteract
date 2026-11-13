// Draws a Vega-Lite chart over datasets the caller has already loaded. Its own
// chunk: load it with `import("./vega-chart.mjs")` where a chart is shown, the
// way wordgard-dataframes.mjs loads sift-table.jsx for tables.
//
// A chart is static: marks, axes, legends and Vega's hover tooltip. Nothing
// else listens to the reader; selections, bindings, hover encodings and every
// other event stream are refused, because each review of the interactive
// surface found another way through it.
//
// Vega runs in a Worker (viewer/chart-worker.mjs, viewer/chart-dataflow.mjs):
// it compiles the spec, checks the compiled dataflow, runs it and posts the
// finished scenegraph back. The charts on a Page share at most CHART_WORKERS
// Workers (viewer/chart-pool.mjs). This page draws the scenegraph with Vega's
// SVG renderer and keeps the tooltip; it never holds a Vega View and never
// runs the dataflow itself. A draw that outlasts CHART_TIMEOUT_MS from its
// start shows the chart's error state and its Worker is replaced, so a spec
// that never terminates costs the reader a sentence, not the tab.
//
// The spec and the rows are both untrusted:
// - shared/chart-spec.mjs refuses a spec here before any Worker starts, with
//   one sentence: allowlists for data, transforms, parameters and expression
//   functions, no URL anywhere, keyword cursors, numbers in
//   CHART_NUMBER_RANGE, and the row and cell budgets.
// - The Worker checks the spec again, normalizes the data, checks the
//   compiled dataflow (`runtimeProblem`), guards the transforms that loop on
//   derived values, runs expressions through Vega's interpreter and denies
//   every load.
// - The page rebuilds the returned scene from known marks and keys within
//   bounds (viewer/chart-scene.mjs), and the "pages-svg" renderer cleans each
//   item's fill, stroke, font, blend and cursor before it writes them, so
//   neither a data value nor a Worker's answer can put `url(...)` into a
//   style.
//
// The look is bare: the caller's title above, one thin rounded border around
// the drawing, and Vega-Lite's own axes, legend and hover tooltip inside it.
// The one control is the Maximize button a Mermaid diagram has, which opens
// the same expanded viewer.
import { SVGHandler, SVGRenderer, sceneFromJSON } from "vega-scenegraph";
import { Handler as TooltipHandler } from "vega-tooltip";
import { BehaviorSubject, Subscription, combineLatest, concat, from } from "rxjs";
import { debounceTime, distinctUntilChanged, filter, skip, switchMap, take } from "rxjs/operators";
import {
  CHART_CURSORS,
  CHART_MAX_CELLS,
  CHART_MAX_ROWS,
  checkChartSpec,
  loadsResource,
} from "../shared/chart-spec.mjs";
import {
  UnreadableDataset,
  cellCount,
  isArrowTable,
  rowCount,
  tooManyCells,
  unreadableDataset,
} from "./chart-data.mjs";
import { CHART_READY_MS, CHART_WORKERS, TIMED_OUT, createChartPool } from "./chart-pool.mjs";
import { pageScene } from "./chart-scene.mjs";
import { maximizeButton } from "./diagram-icons.mjs";
import { openDiagramViewer } from "./diagram-viewer.mjs";

/** Wait after the last width change before redrawing, so a drag-resize draws
 * once at its end. */
export const RESIZE_SETTLE_MS = 120;
/** How long one draw may take in its Worker, from its start to its scene. */
export const CHART_TIMEOUT_MS = 8_000;
export { TIMED_OUT };

// The Worker script, a content-hashed chunk the build names (scripts/build.mjs).
const WORKER_URL =
  typeof __PAGES_CHART_WORKER_URL__ === "string" ? __PAGES_CHART_WORKER_URL__ : null;
const defaultWorkers = Object.freeze({
  create: () => {
    if (!WORKER_URL) throw new Error("This build has no chart Worker.");
    return new Worker(WORKER_URL, { name: "chart" });
  },
  timeoutMs: CHART_TIMEOUT_MS,
  readyMs: CHART_READY_MS,
  size: CHART_WORKERS,
  checkSpec: true,
});
const SVG_NS = "http://www.w3.org/2000/svg";
let workers = defaultWorkers;
// One pool per document, made when its first chart mounts.
let pools = new WeakMap();
/**
 * The widths `doc` draws probe `items` at: SVG text with the attributes Vega's
 * SVG renderer writes, so a probe compares what the Worker measures with what
 * the page draws, not with a second canvas. In WebKit on macOS a canvas
 * measures `system-ui` digits 2 to 5 percent narrower than SVG draws them.
 * Null when the document lays out no text.
 */
export function drawnWidths(doc, items) {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute(
    "style",
    "position:absolute;left:0;top:0;width:0;height:0;overflow:hidden;visibility:hidden",
  );
  for (const { item, text } of items) {
    const node = svg.appendChild(doc.createElementNS(SVG_NS, "text"));
    node.setAttribute("font-family", item.font);
    node.setAttribute("font-size", `${item.fontSize}px`);
    if (item.fontWeight !== undefined) node.setAttribute("font-weight", item.fontWeight);
    node.textContent = text;
  }
  (doc.body ?? doc.documentElement).append(svg);
  try {
    const widths = [...svg.children].map((node) => node.getComputedTextLength?.());
    return widths.every(Number.isFinite) ? widths : null;
  } finally {
    svg.remove();
  }
}

const poolFor = (doc) => {
  let pool = pools.get(doc);
  if (!pool) {
    // Each new Worker is probed with the Page's own font stack.
    const font = () =>
      doc.defaultView?.getComputedStyle?.(doc.body ?? doc.documentElement)?.fontFamily;
    pool = createChartPool({ font, measure: (items) => drawnWidths(doc, items), ...workers, doc });
    pools.set(doc, pool);
  }
  return pool;
};

/** Start `doc`'s chart Worker before its first chart draws (chart-pool.mjs
 * `warm`). Returns the function that lets it go. */
export const warmCharts = (doc) => poolFor(doc).warm();

/** Replace how charts start their Workers, how long a draw may take and how
 * many Workers a document shares: for tests in a DOM without Workers, and
 * for the smoke's fixture Worker. `checkSpec: false` skips the page's spec
 * check, so the smoke can prove the timer cuts off a spec the checks would
 * refuse. Charts mounted after the call use a new pool. Returns a function
 * that restores the previous setting. */
export function setChartWorker(create, options = {}) {
  const previous = workers;
  workers = { ...defaultWorkers, ...options, create };
  pools = new WeakMap();
  return () => {
    workers = previous;
    pools = new WeakMap();
  };
}

/** Links and loads go nowhere: the scenegraph carries no hrefs or images, and
 * the handler's loader refuses anyway. */
const deniedLoader = Object.freeze({
  sanitize: () => Promise.reject(Error("A chart can't link anywhere.")),
});

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
  };
}

/** One sentence from a draw's failure: a refusal as it is, anything Vega or
 * Vega-Lite threw as its first sentence. */
function errorSentence(error) {
  if (error?.refusal) return error.message;
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
class PagesSVGRenderer extends SVGRenderer {
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
/** The width a chart may fill: the element's content box. */
function contentWidth(element) {
  const style = element.ownerDocument.defaultView?.getComputedStyle?.(element);
  const padding =
    (Number.parseFloat(style?.paddingLeft) || 0) + (Number.parseFloat(style?.paddingRight) || 0);
  return Math.max(0, Math.round(element.clientWidth - padding));
}

/**
 * Draw a Worker's scenegraph into `target` with the cleaning SVG renderer, and
 * show each item's tooltip on hover through `tooltip`. Returns `{ finalize }`,
 * which stops listening and hides the tooltip.
 */
export function drawScene(target, { scene, width, height, origin, background }, tooltip) {
  const size = (value) => (Number.isFinite(value) ? Math.min(Math.max(value, 0), 100_000) : 0);
  width = size(width);
  height = size(height);
  origin = Array.isArray(origin) ? [size(origin[0]), size(origin[1])] : [0, 0];
  background = typeof background === "string" && background.length <= 256 ? background : null;
  const root = sceneFromJSON(pageScene(scene));
  const renderer = new PagesSVGRenderer(deniedLoader)
    .initialize(target, width, height, origin)
    .background(background ?? null);
  renderer.render(root);
  const handler = new SVGHandler(deniedLoader, tooltip).initialize(target, origin, null);
  return {
    finalize() {
      handler.initialize(null, origin, null);
      tooltip?.(handler, null, null, null);
    },
  };
}

/** A real apache-arrow Table: Arrow's shape with record batches behind it.
 * A wrapper that only looks like one can't be serialized for a Worker. */
const isArrowBacked = (dataset) => isArrowTable(dataset) && Array.isArray(dataset.batches);

/** What crosses to a Worker for one dataset, built for each Worker that
 * needs it: rows by structured clone; Arrow IPC bytes as this chart's own
 * copy, transferred, since the caller's bytes may back other views and
 * tables; an Arrow table serialized to fresh IPC bytes, transferred.
 * `transfer` collects the buffers; `arrow` is the apache-arrow module,
 * loaded only when a table needs it. */
function crossing(dataset, transfer, arrow) {
  if (dataset instanceof Uint8Array) {
    const ipc = dataset.slice();
    transfer.push(ipc.buffer);
    return { ipc };
  }
  if (isArrowBacked(dataset)) {
    const ipc = arrow.tableToIPC(dataset);
    transfer.push(ipc.buffer);
    return { ipc };
  }
  return { rows: dataset };
}

/**
 * Mount a chart in `container`. `spec` is a parsed Vega-Lite spec. `datasets`
 * maps each data name the spec reads to rows, Arrow IPC bytes (a Uint8Array
 * the chart copies, never transfers) or an apache-arrow Table; the chart
 * never fetches. `title` is shown above the chart. Returns `{ destroy }`.
 *
 * A Page theme change or a new container width redraws the chart, so text
 * keeps its size at any width; a draw still in flight is abandoned, so a slow
 * earlier draw never replaces a newer one. A spec the checks refuse, one Vega
 * can't draw, one that outlasts CHART_TIMEOUT_MS, or a Worker that can't
 * start shows one sentence inside the border instead. A chart that timed
 * out doesn't redraw; the caller mounts it again for a new spec or data.
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

  let drawing = null;
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
    const finalizing = drawing;
    viewer = null;
    drawing = null;
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
  const checked = workers.checkSpec
    ? checkChartSpec(plain, { datasets: Object.keys(datasets) })
    : { ok: true, names: Object.keys(datasets) };
  // Keyed by dataset name, so neither map answers to a name it wasn't given.
  const given = (name) => (Object.hasOwn(datasets, name) ? datasets[name] : undefined);
  let refusal = checked.ok ? null : checked.error;
  if (!refusal)
    for (const name of checked.names) {
      const dataset = given(name);
      // IPC bytes are counted in the Worker, as they decode.
      if (dataset instanceof Uint8Array) continue;
      if (!Array.isArray(dataset) && !isArrowBacked(dataset)) {
        refusal = `The dataset "${name}" must be rows, Arrow IPC bytes or an Arrow table.`;
        break;
      }
      const rows = rowCount(dataset);
      if (rows > CHART_MAX_ROWS) {
        refusal = `The dataset "${name}" has ${rows.toLocaleString("en-US")} rows; a chart reads at most ${CHART_MAX_ROWS.toLocaleString("en-US")}.`;
        break;
      }
      let cells;
      try {
        cells = cellCount(dataset, CHART_MAX_CELLS);
      } catch (error) {
        if (!(error instanceof UnreadableDataset)) throw error;
        refusal = unreadableDataset(name);
        break;
      }
      if (cells > CHART_MAX_CELLS) {
        refusal = tooManyCells(name);
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
  let mounted = true;
  // A tooltip that can't show leaves the chart in its error state. Deferred,
  // so the drawing isn't torn down inside its own event.
  const fail = (error) =>
    queueMicrotask(() => {
      if (!mounted || !drawing) return;
      drawing.finalize();
      drawing = null;
      canvas.replaceChildren();
      show("error", errorSentence(error));
    });
  // After destroy, a late finalize must not recreate the tooltip element.
  const showTooltip = (...args) => {
    if (!mounted) return;
    try {
      tooltip.call(...args);
    } catch (error) {
      fail(error);
    }
  };

  // The chart's place in its document's Worker pool, once Arrow (needed only
  // to serialize a table) has loaded.
  let client = null;
  const attached = (
    checked.names.some((name) => isArrowBacked(given(name)))
      ? import("apache-arrow")
      : Promise.resolve(null)
  ).then((arrow) => {
    if (!mounted) return null;
    client = poolFor(doc).attach(() => {
      const transfer = [];
      const datasets = Object.create(null);
      for (const name of checked.names) datasets[name] = crossing(given(name), transfer, arrow);
      return { datasets, transfer };
    });
    return client;
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
  // Only a measured width draws: a frame with no width yet (not laid out, or
  // in a hidden tab) posts nothing until its first observed width, so no
  // chart draws at Vega-Lite's default size first. The first width draws at
  // once; later ones wait for the resize to settle. Without a ResizeObserver
  // the width read at mount is the only one there will be.
  const measured = watchSize ? widths.pipe(filter((width) => width > 0)) : widths;
  const settledWidths = concat(
    measured.pipe(take(1)),
    measured.pipe(skip(1), debounceTime(RESIZE_SETTLE_MS)),
  ).pipe(distinctUntilChanged());

  // One draw: the Worker's answer drawn into a fresh target, or the error.
  const draw = ([theme, width]) =>
    from(attached).pipe(
      switchMap((pooled) => {
        if (!pooled) return [];
        // A chart already on screen redraws behind charts not yet drawn.
        return pooled.draw({ spec: plain, theme, width }, { redraw: drawing !== null });
      }),
      switchMap((answer) => {
        if (answer.error) return [{ error: answer.error, timedOut: answer.timedOut === true }];
        const target = doc.createElement("div");
        try {
          return [{ target, drawing: drawScene(target, answer, showTooltip) }];
        } catch (error) {
          return [{ error }];
        }
      }),
    );

  const subscription = new Subscription();
  subscription.add(
    combineLatest([themes.pipe(distinctUntilChanged((a, b) => a.dark === b.dark)), settledWidths])
      .pipe(switchMap(draw))
      .subscribe((result) => {
        drawing?.finalize();
        drawing = result.drawing ?? null;
        canvas.replaceChildren(...(result.target ? [result.target] : []));
        if (result.error) show("error", errorSentence(result.error));
        else show("rendered");
        // A chart that timed out stays in its error state: a resize or theme
        // change doesn't run it again, and its data leaves the Worker. A new
        // spec or data revision mounts it anew. Ten hung charts on one Page
        // then cost the Worker at most ten timers, once.
        if (result.timedOut) {
          subscription.unsubscribe();
          watchTheme?.disconnect();
          watchSize?.disconnect();
          client?.detach();
        }
      }),
  );

  return {
    destroy() {
      mounted = false;
      subscription.unsubscribe();
      watchTheme?.disconnect();
      watchSize?.disconnect();
      client?.detach();
      teardown();
    },
  };
}
