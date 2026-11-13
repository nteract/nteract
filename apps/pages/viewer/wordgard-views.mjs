// Draws each view node (`figure[data-pages-view]`, one `view_id`) as its
// chart. The node is an atomic leaf that stores only the view's id; the view
// itself is a host-written document (view-replicas.mjs) whose spec reads the
// Page's sources (page-source-store.mjs). Selecting the node and pressing
// Backspace removes the embed; the view document stays.
//
// The embed is bare: the view's title, the chart in one thin border, and the
// Maximize control Mermaid diagrams have. The chart code is its own chunk
// (view-chart.mjs), loaded only when a Page shows a view near the viewport.
import { Decoration, Widget } from "wordgard/editor";
import { PagesView } from "../model/wordgard-doc.mjs";
import { readViewNode } from "../shared/views.mjs";
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

/** Events on the chart's own controls (Maximize) are the chart's; everything
 * else on the embed reaches Wordgard, which selects the node. */
export const viewEventReachesEditor = (event) =>
  !event.target?.closest?.(".wordgard-diagram-actions");

/** The embed's frame: the canvas the chart chunk draws into, and a status
 * line for the time before it draws. */
export function viewFrame({ viewId }) {
  const dom = document.createElement("section");
  dom.className = "wordgard-widget wordgard-view-embed";
  dom.dataset.viewId = viewId;
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
 */
export function viewLifecycle({ viewId, views, sources, frame, load = VIEW_RENDERER, ...options }) {
  const lifecycle = dataframeLifecycle({
    ...frame,
    load: () =>
      load().then((chunk) => ({
        mount: (canvas) => {
          // A Page without views reads every view as not on this Page.
          if (!views || !sources) {
            canvas.textContent = VIEW_NOT_HERE;
            return { destroy: () => (canvas.textContent = "") };
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
    onUnavailable: reportRendererUnavailable,
    ...options,
  });
  return {
    connect: () => lifecycle.connect(),
    disconnect: () => lifecycle.disconnect(),
    get state() {
      return lifecycle.state;
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
    a.viewId === b.viewId && a.views === b.views && a.sources === b.sources && a.eager === b.eager,
  render(attrs) {
    const frame = viewFrame(attrs);
    mounted.set(
      frame.dom,
      viewLifecycle({
        viewId: attrs.viewId,
        views: attrs.views,
        sources: attrs.sources,
        frame,
        ...(attrs.eager && { observe: alwaysNear }),
      }),
    );
    return frame.dom;
  },
  connect(_value, dom) {
    mounted.get(dom)?.connect();
  },
  disconnect(_value, dom) {
    mounted.get(dom)?.disconnect();
  },
  propagateEvent: viewEventReachesEditor,
});

/**
 * Editor config that draws every view node (the Page model's PagesView) as
 * its chart. `views` is the Page's view replicas (view-replicas.mjs) and
 * `sources` its source store; without them every embed says its chart isn't
 * on this Page. `eager` draws each chart at once rather than near the
 * viewport. An editor without this config draws the node's own inert
 * figure, as a card does.
 */
export function wordgardViews({ views = null, sources = null, eager = false } = {}) {
  return [
    Decoration.Tag.shape(
      PagesView,
      (tag) =>
        viewEmbed.of({
          viewId: readViewNode(tag.param)?.view_id ?? "",
          views,
          sources,
          eager,
        }),
      { atom: true },
    ),
  ];
}
