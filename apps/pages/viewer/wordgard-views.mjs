// Draws each view node (`figure[data-pages-view]`, one `view_id`) as its
// chart. The node is an atomic leaf that stores only the view's id; the view
// itself is a host-written document (view-replicas.mjs) whose spec reads the
// Page's sources (page-source-store.mjs). Selecting the node and pressing
// Backspace removes the embed; the view document stays.
//
// The embed is bare: the view's title, the chart in one thin border, and the
// Maximize control Mermaid diagrams have. The chart code is its own chunk
// (view-chart.mjs). A Page whose editor holds a view embed loads it as the
// embed connects and starts the chart Worker (`chartWarmup`), so both are
// ready by the time the first chart's view and data are; each embed still
// reads its view and sources only near the viewport.
//
// Until its chart draws, an embed reserves the height the chart last drew at
// in this browser (view-heights.mjs), or wordgard.css's default, so the Page
// below it holds still while the chunk, the view and the data load. The
// reserve is one inline custom property, `--pages-view-reserve`; the CSS
// applies it and releases it once the embed shows a chart or a sentence that
// stays.
import { Decoration, Widget } from "wordgard/editor";
import { PagesView } from "../model/wordgard-doc.mjs";
import { readViewNode } from "../shared/views.mjs";
import { viewHeight } from "./view-heights.mjs";
import { dataframeLifecycle } from "./wordgard-dataframes.mjs";
import { reportRendererUnavailable } from "./wordgard-widgets.mjs";

/** The chart chunk, with `mount(container, { view$, sources })` returning
 * `{ destroy }`. */
export const VIEW_RENDERER = () => import("./view-chart.mjs");

/** What an embed says before its chart chunk is drawing, and if the chunk
 * can't load. */
export const VIEW_EMBED_STATUS = Object.freeze({
  waiting: "This chart loads when you scroll to it.",
  loading: "Loading chart…",
});
export const VIEW_EMBED_UNAVAILABLE = "Chart unavailable.";
/** What an embed says on a Page that can't hold views. */
export const VIEW_NOT_HERE = "This chart isn't on this Page.";
/** The custom property that holds an embed's remembered height. */
export const VIEW_RESERVE_PROPERTY = "--pages-view-reserve";

/** Events on the chart's own controls (Maximize) are the chart's; everything
 * else on the embed reaches Wordgard, which selects the node. */
export const viewEventReachesEditor = (event) =>
  !event.target?.closest?.(".wordgard-diagram-actions");

/** The embed's frame: the canvas the chart chunk draws into, and a status
 * line for the time before it draws. `heights` (view-heights.mjs) supplies
 * the height to reserve when this browser has drawn the chart before. */
export function viewFrame({ viewId, heights = null }) {
  const dom = document.createElement("section");
  dom.className = "wordgard-widget wordgard-view-embed";
  dom.dataset.viewId = viewId;
  const reserve = heights?.read(viewId) ?? null;
  if (reserve !== null) dom.style.setProperty(VIEW_RESERVE_PROPERTY, `${reserve}px`);
  dom.setAttribute("aria-roledescription", "chart");
  const canvas = dom.appendChild(document.createElement("div"));
  canvas.className = "wordgard-view-canvas";
  const status = dom.appendChild(document.createElement("p"));
  status.className = "wordgard-view-status";
  status.textContent = VIEW_EMBED_STATUS.waiting;
  const announce = dom.appendChild(document.createElement("p"));
  announce.className = "sr-only";
  announce.setAttribute("role", "status");
  return { dom, canvas, status, announce };
}

/**
 * One embed's lifecycle, under dataframeLifecycle's rules: nothing happens
 * until the embed nears the viewport (or at once, `eager`). Then the chart
 * chunk loads and the embed holds its view for as long as the chart is
 * mounted, so an embed that never came near the viewport costs no lookup
 * and no timer. The chart stays mounted until the embed is disconnected past
 * its park, offscreen included; view-replicas.mjs takes the slot of a held
 * view whose document is missing when another view needs it.
 *
 * The section carries `data-embed-state="failed"` while the lifecycle is in
 * its failed state (the chunk didn't load), so wordgard.css releases the
 * reserve around "Chart unavailable."
 */
export function viewLifecycle({
  viewId,
  views,
  sources,
  frame,
  load = VIEW_RENDERER,
  onUnavailable = reportRendererUnavailable,
  ...options
}) {
  const mirror = () => {
    if (!frame.dom?.dataset) return;
    if (lifecycle.state === "failed") frame.dom.dataset.embedState = "failed";
    else delete frame.dom.dataset.embedState;
  };
  const lifecycle = dataframeLifecycle({
    ...frame,
    load: () =>
      load().then((chunk) => ({
        mount: (canvas) => {
          // A Page without views reads every view as not on this Page: a
          // sentence that stays, like a blocked view (view-draw.mjs).
          if (!views || !sources) {
            canvas.textContent = VIEW_NOT_HERE;
            if (canvas.dataset) canvas.dataset.viewState = "blocked";
            return {
              destroy() {
                canvas.textContent = "";
                if (canvas.dataset) delete canvas.dataset.viewState;
              },
            };
          }
          // A held view asks for its document for as long as the chart is
          // mounted (view-replicas.mjs).
          const held = views.hold(viewId);
          let chart;
          try {
            chart = chunk.mount(canvas, { view$: held.view$, sources });
          } catch (error) {
            held.release();
            throw error;
          }
          return {
            destroy() {
              // A chart that throws while tearing down still lets go of
              // its view, so its slot frees.
              try {
                chart.destroy();
              } catch {
              } finally {
                held.release();
              }
            },
          };
        },
      })),
    attrs: {},
    texts: VIEW_EMBED_STATUS,
    unavailable: VIEW_EMBED_UNAVAILABLE,
    onUnavailable: () => {
      mirror();
      onUnavailable?.();
    },
    ...options,
  });
  return {
    connect() {
      lifecycle.connect();
      mirror();
    },
    disconnect() {
      lifecycle.disconnect();
      mirror();
    },
    get state() {
      return lifecycle.state;
    },
  };
}

/**
 * Warms the chart path for one editor's embeds: while at least one embed is
 * connected, the chart chunk is loaded (`load`, the same import an embed's
 * lifecycle makes) and the document's chart Worker is kept started
 * (view-chart.mjs `warm`). It looks up no view or source, holds no view slot
 * and arms no timer of its own. A chunk that fails to load is ignored here;
 * the embed's own load reports it. The last embed's release lets the Worker
 * go a microtask later, so an embed Wordgard disconnects and connects again
 * in one turn keeps it.
 */
export function chartWarmup({ load = VIEW_RENDERER } = {}) {
  let holds = 0;
  let release = null;
  let loading = false;
  const start = (doc) => {
    if (release || loading) return;
    loading = true;
    Promise.resolve()
      .then(load)
      .then((chunk) => {
        loading = false;
        if (holds > 0 && !release) release = chunk.warm?.(doc) ?? null;
      })
      .catch(() => {
        loading = false;
      });
  };
  const settle = () => {
    if (holds > 0 || !release) return;
    const stop = release;
    release = null;
    try {
      stop();
    } catch {}
  };
  return {
    /** Hold the warm path for an embed in `doc`; returns its release. */
    hold(doc) {
      let held = true;
      holds++;
      start(doc);
      return () => {
        if (!held) return;
        held = false;
        holds--;
        queueMicrotask(settle);
      };
    },
  };
}

/** The warm-up an editor's embeds share: none without the Page's views and
 * sources, where every embed says its chart isn't on this Page. */
export const warmupFor = ({ views, sources, load }) =>
  views && sources ? chartWarmup({ load }) : null;

/** Whether the embed shows its view drawn (view-draw.mjs "drawn") as a chart
 * Vega has finished (vega-chart.mjs "rendered"). */
const chartDrawn = (dom) =>
  !!dom.querySelector?.(
    '.pages-view[data-view-state="drawn"] .pages-view-chart:not([hidden]) .pages-chart[data-chart-status="rendered"]',
  );

/** Whether a chart or diagram is open in the expanded viewer
 * (diagram-viewer.mjs): a modal over the Page that hides the root's
 * overflow, so the Page behind it isn't laid out as a reader sees it. */
const maximized = (dom) => !!dom.ownerDocument?.querySelector?.(".diagram-viewer[open]");

/**
 * Remembers the height an embed's chart draws at in `heights`
 * (view-heights.mjs), so the next render reserves it. It writes only while
 * the chart is drawn and nothing is maximized, in whole CSS px, and only a
 * height that changed. `connect` starts watching the section's size and
 * `disconnect` stops; without `heights` or a ResizeObserver it does nothing.
 */
export function heightRecorder({ dom, viewId, heights, Observer = globalThis.ResizeObserver }) {
  let observer = null;
  let recorded = heights?.read(viewId) ?? null;
  const record = (entries) => {
    if (!chartDrawn(dom) || maximized(dom)) return;
    const box = entries.at(-1)?.borderBoxSize?.[0];
    const px = viewHeight(box ? box.blockSize : dom.getBoundingClientRect().height);
    if (px === null || px === recorded) return;
    recorded = heights.write(viewId, px) ?? recorded;
  };
  return {
    connect() {
      if (!heights || !Observer || observer) return;
      observer = new Observer(record);
      observer.observe(dom);
    },
    disconnect() {
      observer?.disconnect();
      observer = null;
    },
  };
}

const mounted = new WeakMap();

/** A watcher that reports every embed near the viewport at once. */
const alwaysNear = (_element, onChange) => {
  onChange(true);
  return () => {};
};

const viewEmbed = Widget.define({
  eq: (a, b) =>
    a.viewId === b.viewId &&
    a.views === b.views &&
    a.sources === b.sources &&
    a.eager === b.eager &&
    a.heights === b.heights &&
    a.warmup === b.warmup,
  render(attrs) {
    const frame = viewFrame(attrs);
    mounted.set(frame.dom, {
      warmup: attrs.warmup,
      release: null,
      lifecycle: viewLifecycle({
        viewId: attrs.viewId,
        views: attrs.views,
        sources: attrs.sources,
        frame,
        ...(attrs.eager && { observe: alwaysNear }),
      }),
      recorder: heightRecorder({ dom: frame.dom, viewId: attrs.viewId, heights: attrs.heights }),
    });
    return frame.dom;
  },
  connect(_value, dom) {
    const embed = mounted.get(dom);
    if (embed && !embed.release) embed.release = embed.warmup?.hold(dom.ownerDocument) ?? null;
    embed?.lifecycle.connect();
    embed?.recorder.connect();
  },
  disconnect(_value, dom) {
    const embed = mounted.get(dom);
    embed?.recorder.disconnect();
    embed?.lifecycle.disconnect();
    embed?.release?.();
    if (embed) embed.release = null;
  },
  propagateEvent: viewEventReachesEditor,
});

/**
 * Editor config that draws every view node (the Page model's PagesView) as
 * its chart. `views` is the Page's view replicas (view-replicas.mjs) and
 * `sources` its source store; without them every embed says its chart isn't
 * on this Page. `eager` draws each chart at once rather than near the
 * viewport. `heights` (view-heights.mjs) remembers each chart's drawn height
 * for the next render's reserve; without it every embed reserves the
 * default. With views and sources, a connected embed warms the chart path
 * (`chartWarmup`). An editor without this config draws
 * the node's own inert figure, as a card does.
 */
export function wordgardViews({
  views = null,
  sources = null,
  eager = false,
  heights = null,
} = {}) {
  const warmup = warmupFor({ views, sources });
  return [
    Decoration.Tag.shape(
      PagesView,
      (tag) =>
        viewEmbed.of({
          viewId: readViewNode(tag.param)?.view_id ?? "",
          views,
          sources,
          eager,
          heights,
          warmup,
        }),
      { atom: true },
    ),
  ];
}
