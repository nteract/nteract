// Draws a Vega-Lite chart over a Page's named sources. Its own chunk, loaded
// only when a Page shows a chart, like sift-table.jsx for tables.
//
// The viewer CSP has no 'unsafe-eval', so Vega runs with its expression
// interpreter, and its loader refuses every request: a chart's only data is
// the rows `resolveSource` supplies, and it can't fetch an image or follow a
// link. The spec checks in shared/chart-spec.mjs refuse the same things first,
// with a message.
import * as vega from "vega";
import * as vl from "vega-lite";
import { expressionInterpreter } from "vega-interpreter";
import { BehaviorSubject, combineLatest, concat, Observable, Subscription } from "rxjs";
import { debounceTime, distinctUntilChanged, skip, switchMap, take } from "rxjs/operators";
import { checkChartSpec, checkFields } from "../shared/chart-spec.mjs";

export const CHART_RENDERER = `vega-lite@${vl.version} vega@${vega.version}`;
const DEFAULT_HEIGHT = 260;
const ROW_BATCH = 4096;

/** A loader that refuses every load and every link, so no spec can reach the
 * network or navigate. */
export const deniedLoader = Object.freeze({
  load: () => Promise.reject(Error("Charts read only the Page's sources")),
  sanitize: () => Promise.reject(Error("Charts can't load or link to URLs")),
  http: () => Promise.reject(Error("Charts can't load URLs")),
  file: () => Promise.reject(Error("Charts can't load files")),
});

/**
 * Rows and column names from a source. Takes a Sift TableData (what
 * loadTableFile returns) or plain `{ columns: string[], rows: object[] }`.
 */
export function sourceRows(table) {
  if (Array.isArray(table?.rows) && Array.isArray(table.columns))
    return { columns: table.columns.map(String), rows: table.rows };
  const columns = table.columns.map((column) => column.key);
  const rows = new Array(table.rowCount);
  for (let start = 0; start < table.rowCount; start += ROW_BATCH) {
    const end = Math.min(start + ROW_BATCH, table.rowCount);
    table.prefetchViewport?.(Array.from({ length: end - start }, (_, i) => start + i));
    for (let r = start; r < end; r++) {
      const row = {};
      for (let c = 0; c < columns.length; c++) row[columns[c]] = table.getCellRaw(r, c);
      rows[r] = row;
    }
  }
  return { columns, rows };
}

/** The categorical palette, light and dark steps of the same eight hues
 * (validated for adjacent-pair color-vision separation). */
const CATEGORY = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};

/** The theme a chart draws with, read from the Page's own tokens. */
export function pageTheme(element) {
  const root = element.ownerDocument.documentElement;
  const style = element.ownerDocument.defaultView?.getComputedStyle?.(element);
  const token = (name, fallback) => style?.getPropertyValue(name).trim() || fallback;
  const dark = root.classList.contains("dark");
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

/**
 * One tooltip element for a chart, drawn with the Page's tokens rather than
 * the browser's title popup. Returns `{ handler, destroy }`; `handler` is a
 * Vega tooltip handler. Values are set as text, never as markup.
 */
export function chartTooltip(doc) {
  let tip = null;
  const hide = () => {
    if (tip) tip.hidden = true;
  };
  const show = (event, value) => {
    tip ??= Object.assign(doc.body.appendChild(doc.createElement("div")), {
      className: "pages-chart-tooltip",
    });
    tip.setAttribute("role", "tooltip");
    const rows =
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.entries(value)
        : [[null, value]];
    tip.replaceChildren(
      ...rows.map(([key, item]) => {
        const row = doc.createElement("div");
        row.className = "pages-chart-tooltip-row";
        if (key !== null) {
          const name = row.appendChild(doc.createElement("span"));
          name.className = "pages-chart-tooltip-key";
          name.textContent = key;
        }
        const text = row.appendChild(doc.createElement("span"));
        text.className = "pages-chart-tooltip-value";
        text.textContent = typeof item === "object" ? JSON.stringify(item) : String(item);
        return row;
      }),
    );
    tip.hidden = false;
    const view = doc.defaultView;
    const { width, height } = tip.getBoundingClientRect();
    const x =
      event.clientX + 14 + width > (view?.innerWidth ?? Infinity)
        ? event.clientX - 14 - width
        : event.clientX + 14;
    const y =
      event.clientY + 14 + height > (view?.innerHeight ?? Infinity)
        ? event.clientY - 14 - height
        : event.clientY + 14;
    tip.style.left = `${Math.max(4, x)}px`;
    tip.style.top = `${Math.max(4, y)}px`;
  };
  return {
    handler(_handler, event, _item, value) {
      if (value == null || value === "" || !event) hide();
      else show(event, value);
    },
    destroy() {
      tip?.remove();
      tip = null;
    },
  };
}

const isComposite = (spec) =>
  ["concat", "hconcat", "vconcat", "facet", "repeat"].some((key) => key in spec) ||
  "row" in (spec.encoding ?? {}) ||
  "column" in (spec.encoding ?? {}) ||
  "facet" in (spec.encoding ?? {});

/** A spec sized for `width`, when it doesn't size itself. */
export function sizedSpec(spec, width) {
  if (isComposite(spec)) return spec;
  return {
    ...spec,
    ...(spec.width === undefined && width > 0 && { width: Math.max(120, width) }),
    ...(spec.height === undefined && { height: DEFAULT_HEIGHT }),
    autosize: spec.autosize ?? { type: "fit-x", contains: "padding" },
  };
}

/**
 * Draw one spec into `element`. Resolves with the render report:
 * `{ status: "rendered", renderer, sources, warnings }`, or
 * `{ status: "error", renderer, error, problems?, warnings }`. Never rejects;
 * an abort resolves with `status: "aborted"`.
 */
export async function drawChart(element, { spec, resolveSource, theme, signal, width, tooltip }) {
  const report = { renderer: CHART_RENDERER, warnings: [] };
  const { sources: names, problems } = checkChartSpec(spec);
  if (problems.length)
    return { ...report, status: "error", error: "This chart can't be drawn.", problems };
  const sources = {};
  const data = {};
  try {
    for (const name of names) {
      const resolved = await resolveSource(name, { signal });
      if (signal?.aborted) return { ...report, status: "aborted" };
      // A resolver may return the table alone, or `{ table, release?,
      // ...version }` with the source_id, asset_id and source_revision it
      // resolved to. The resolver owns the table and may share it, so a
      // chart never frees it: it copies the rows out, then calls `release`
      // to say it's done.
      const { table, release, ...version } = resolved?.table ? resolved : { table: resolved };
      let columns, rows;
      try {
        ({ columns, rows } = sourceRows(table));
      } finally {
        release?.();
      }
      sources[name] = { ...version, rows: rows.length, columns };
      data[name] = rows;
    }
  } catch (error) {
    if (signal?.aborted) return { ...report, status: "aborted" };
    return { ...report, status: "error", error: error?.message ?? String(error) };
  }
  const fields = checkFields(
    spec,
    Object.fromEntries(Object.entries(sources).map(([name, s]) => [name, s.columns])),
  );
  for (const { channel, field } of fields.unknown)
    report.warnings.push(`${channel}: no source column or transform supplies "${field}".`);
  if (fields.unchecked)
    report.warnings.push("Some fields come from transforms this check can't follow.");
  let view;
  try {
    const compiled = vl.compile(sizedSpec(spec, width), { config: themeConfig(theme) }).spec;
    view = new vega.View(vega.parse(compiled, null, { ast: true }), {
      expr: expressionInterpreter,
      loader: deniedLoader,
      renderer: "svg",
      container: element,
      hover: true,
      ...(tooltip && { tooltip }),
      logLevel: vega.Warn,
      logger: collectingLogger(report.warnings),
    });
    for (const [name, rows] of Object.entries(data)) view.data(name, rows);
    await view.runAsync();
  } catch (error) {
    view?.finalize();
    if (signal?.aborted) return { ...report, status: "aborted" };
    return { ...report, status: "error", error: error?.message ?? String(error), sources };
  }
  if (signal?.aborted) {
    view.finalize();
    return { ...report, status: "aborted" };
  }
  return { ...report, status: "rendered", sources, view };
}

function collectingLogger(warnings) {
  let level = vega.Warn;
  const logger = {
    level(value) {
      if (value === undefined) return level;
      level = value;
      return logger;
    },
    error: (...args) => warnings.push(args.map(String).join(" ")),
    warn: (...args) => level >= vega.Warn && warnings.push(args.map(String).join(" ")),
    info: () => logger,
    debug: () => logger,
  };
  return logger;
}

/** Wait after the last width change before redrawing, so a drag-resize
 * draws once at its end. */
export const RESIZE_SETTLE_MS = 120;

/** The width a chart may fill: the container's content box. */
function contentWidth(element) {
  const style = element.ownerDocument.defaultView?.getComputedStyle?.(element);
  const padding =
    (Number.parseFloat(style?.paddingLeft) || 0) + (Number.parseFloat(style?.paddingRight) || 0);
  return Math.max(0, Math.round(element.clientWidth - padding));
}

/**
 * Mount a chart in `container`. `resolveSource(name, { signal })` returns a
 * source's table, which the resolver owns; `onReport(report)` hears each
 * render's outcome without the view. Returns `{ update(spec), destroy() }`.
 * A new spec, a Page theme change or a new container width replaces the
 * drawing, so text keeps its size at any width; a render still in flight is
 * abandoned, so a slow earlier render never replaces a newer one.
 */
export function mount(container, { spec, resolveSource, onReport }) {
  const doc = container.ownerDocument;
  const frame = container.appendChild(doc.createElement("div"));
  frame.className = "pages-chart";
  const message = container.appendChild(doc.createElement("p"));
  message.className = "pages-chart-message";
  message.hidden = true;
  const tooltip = chartTooltip(doc);
  const specs = new BehaviorSubject(spec);
  const themes = new BehaviorSubject(pageTheme(container));
  const watchTheme = new (
    doc.defaultView?.MutationObserver ??
    class {
      observe() {}
      disconnect() {}
    }
  )(() => themes.next(pageTheme(container)));
  watchTheme.observe(doc.documentElement, { attributes: true, attributeFilter: ["class"] });
  const widths = new BehaviorSubject(contentWidth(container));
  const Resize = doc.defaultView?.ResizeObserver;
  const watchSize = Resize ? new Resize(() => widths.next(contentWidth(container))) : null;
  watchSize?.observe(container);
  // The first width draws at once; later ones wait for the resize to settle.
  const settledWidths = concat(
    widths.pipe(take(1)),
    widths.pipe(skip(1), debounceTime(RESIZE_SETTLE_MS)),
  ).pipe(distinctUntilChanged());
  const draw = ([current, theme, width]) =>
    new Observable((subscriber) => {
      const controller = new AbortController();
      const target = doc.createElement("div");
      drawChart(target, {
        spec: current,
        resolveSource,
        theme,
        signal: controller.signal,
        width,
        tooltip: tooltip.handler,
      }).then((result) => {
        if (result.status !== "aborted") subscriber.next({ result, target });
        subscriber.complete();
      });
      return () => controller.abort();
    });
  let view = null;
  const subscription = new Subscription();
  subscription.add(
    combineLatest([
      specs,
      themes.pipe(distinctUntilChanged((a, b) => a.dark === b.dark)),
      settledWidths,
    ])
      .pipe(switchMap(draw))
      .subscribe(({ result, target }) => {
        view?.finalize();
        view = result.view ?? null;
        frame.replaceChildren(...(result.status === "rendered" ? [target] : []));
        message.hidden = result.status === "rendered";
        message.textContent =
          result.status === "rendered"
            ? ""
            : [result.error, ...(result.problems ?? [])].filter(Boolean).join(" ");
        container.dataset.chartStatus = result.status;
        const { view: _view, ...report } = result;
        onReport?.(report);
      }),
  );
  return {
    update(next) {
      specs.next(next);
    },
    destroy() {
      subscription.unsubscribe();
      watchTheme.disconnect();
      watchSize?.disconnect();
      tooltip.destroy();
      view?.finalize();
      view = null;
      frame.remove();
      message.remove();
    },
  };
}
