// Draws each dataframe node (wordgard-model.mjs PagesDataframe) by its media
// type. The node is an atomic leaf with no text, so the table is its whole
// shape; selecting the node and pressing Backspace removes it.
//
// Sorting, filtering and column changes stay in each reader's view. A shared
// view belongs beside the node, not in its attrs; see the README's Dataframes
// section.
import { Decoration, Widget } from "wordgard/editor";
import { PagesDataframe } from "./wordgard-model.mjs";
import { reportRendererUnavailable } from "./wordgard-widgets.mjs";
import { PARQUET_MEDIA_TYPE, readDataframe } from "../shared/dataset-assets.mjs";

/** Media type -> lazily loaded renderer module with
 * `mount(container, { src, pageId })` returning `{ destroy }`. Each is its own
 * chunk, loaded only when a Page shows that kind of dataframe. */
export const DATAFRAME_RENDERERS = Object.freeze({
  [PARQUET_MEDIA_TYPE]: () => import("./sift-table.jsx"),
});

/** The table's frame: a caption (the title, when set) above the canvas. */
export function dataframeFrame({ title, media_type }) {
  const dom = document.createElement("section");
  dom.className = "wordgard-widget wordgard-dataframe-table";
  dom.tabIndex = -1;
  dom.dataset.mediaType = media_type;
  dom.setAttribute("aria-label", title ?? "Table");
  if (title) {
    const caption = dom.appendChild(document.createElement("div"));
    caption.className = "wordgard-dataframe-title";
    caption.textContent = title;
  }
  const status = dom.appendChild(document.createElement("p"));
  status.setAttribute("role", "status");
  const canvas = dom.appendChild(document.createElement("div"));
  canvas.className = "wordgard-dataframe-canvas";
  const load = DATAFRAME_RENDERERS[media_type];
  status.textContent = load ? "Loading table…" : `This build can't show ${media_type}.`;
  canvas.hidden = !load;
  return { dom, status, canvas, load };
}

/**
 * The renderer lifecycle of one table, as a state machine:
 *
 *   idle --connect--> scheduled --timer--> loading --loaded--> mounted
 *   any  --disconnect--> idle (cancels the timer, destroys a mounted table)
 *   loading --failed--> failed
 *
 * Wordgard can connect and disconnect a widget more than once. Each connect
 * starts a new generation; a load that resolves for an older generation is
 * dropped, so a widget never holds two mounted tables.
 */
export function dataframeLifecycle({ load, canvas, status, attrs, delay = 50, onUnavailable }) {
  let state = "idle",
    generation = 0,
    timer = null,
    instance = null;
  const transition = (event, value) => {
    switch (event) {
      case "connect":
        if (state !== "idle" || !load) return;
        state = "scheduled";
        generation++;
        timer = setTimeout(() => transition("timer", generation), delay);
        return;
      case "timer": {
        if (state !== "scheduled" || value !== generation) return;
        state = "loading";
        const current = generation;
        load().then(
          (module) => transition("loaded", { current, module }),
          () => transition("failed", current),
        );
        return;
      }
      case "loaded":
        if (state !== "loading" || value.current !== generation) return;
        state = "mounted";
        // The renderer draws its own loading and error states, including
        // fetchDataset's access and missing-asset messages.
        status.hidden = true;
        instance = value.module.mount(canvas, attrs);
        return;
      case "failed":
        if (state !== "loading" || value !== generation) return;
        state = "failed";
        onUnavailable?.();
        status.hidden = false;
        status.textContent = "Table unavailable.";
        return;
      case "disconnect":
        clearTimeout(timer);
        timer = null;
        instance?.destroy();
        instance = null;
        generation++;
        state = "idle";
        return;
    }
  };
  return {
    connect: () => transition("connect"),
    disconnect: () => transition("disconnect"),
    get state() {
      return state;
    },
  };
}

const mounted = new WeakMap();

const dataframeTable = Widget.define({
  eq: (a, b) =>
    a.src === b.src &&
    a.media_type === b.media_type &&
    a.title === b.title &&
    a.pageId === b.pageId,
  render(attrs) {
    const frame = dataframeFrame(attrs);
    mounted.set(
      frame.dom,
      dataframeLifecycle({
        ...frame,
        attrs: { src: attrs.src, pageId: attrs.pageId },
        onUnavailable: reportRendererUnavailable,
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
  propagateEvent: false,
});

/**
 * Editor config that draws every dataframe node as its table, reading only
 * datasets of `pageId`. This is a tag shape, the node type's own drawing, not
 * a point decoration. Wordgard 0.6.2 throws "Moving past end of document"
 * when a shaped point decoration first appears at an insertion boundary at
 * the end of a document, which is where a dropped dataset usually lands.
 */
export function wordgardDataframes({ pageId } = {}) {
  return Decoration.Tag.shape(
    PagesDataframe,
    (tag) => {
      const { src, media_type, title } = readDataframe(tag.param);
      return dataframeTable.of({ src, media_type, title, pageId });
    },
    { atom: true },
  );
}
