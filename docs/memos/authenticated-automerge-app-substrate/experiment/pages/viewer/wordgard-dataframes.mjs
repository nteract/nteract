// Draws each dataframe node (wordgard-model.mjs PagesDataframe) by its media
// type. The node is an atomic leaf with no text, so the table is its whole
// shape; selecting the node and pressing Backspace removes it.
//
// Sorting, filtering and column changes stay in each reader's view. A shared
// view belongs beside the node, not in its attrs; see the README's Dataframes
// section.
import { Decoration, Widget } from "wordgard/editor";
import { GardSelection } from "wordgard/state";
import { PagesDataframe } from "./wordgard-model.mjs";
import { reportRendererUnavailable } from "./wordgard-widgets.mjs";
import { PARQUET_MEDIA_TYPE, readDataframe } from "../shared/dataset-assets.mjs";

/** Media type -> lazily loaded renderer module with
 * `mount(container, { src, pageId })` returning `{ destroy }`. Each is its own
 * chunk, loaded only when a Page shows that kind of dataframe. */
export const DATAFRAME_RENDERERS = Object.freeze({
  [PARQUET_MEDIA_TYPE]: () => import("./sift-table.jsx"),
});

/**
 * The table's frame: a header (the title, when set, and a select handle)
 * above the canvas. The header and the frame's edges belong to the node;
 * the canvas belongs to Sift, so text inside the grid stays selectable.
 */
export function dataframeFrame({ title, media_type }) {
  const dom = document.createElement("section");
  dom.className = "wordgard-widget wordgard-dataframe-table";
  dom.tabIndex = -1;
  dom.dataset.mediaType = media_type;
  dom.setAttribute("aria-label", title ?? "Table");
  const header = dom.appendChild(document.createElement("div"));
  header.className = "wordgard-dataframe-header";
  const caption = header.appendChild(document.createElement("div"));
  caption.className = "wordgard-dataframe-title";
  caption.textContent = title ?? "";
  const handle = header.appendChild(document.createElement("button"));
  handle.type = "button";
  handle.className = "wordgard-dataframe-select";
  handle.setAttribute("aria-label", "Select table");
  handle.title = "Select table";
  handle.textContent = "⋮⋮";
  const status = dom.appendChild(document.createElement("p"));
  status.setAttribute("role", "status");
  const canvas = dom.appendChild(document.createElement("div"));
  canvas.className = "wordgard-dataframe-canvas";
  const load = DATAFRAME_RENDERERS[media_type];
  status.textContent = load ? "Loading table…" : `This build can't show ${media_type}.`;
  canvas.hidden = !load;
  return { dom, header, handle, status, canvas, load };
}

/**
 * Select the dataframe drawn by `dom` as one node, so cut, copy, delete and
 * drag act on the whole table, the way a click selects an image. A press
 * inside Sift's canvas is left alone: that's for the grid.
 */
export function selectDataframeOnPress(editor, dom) {
  dom.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || event.target.closest?.(".wordgard-dataframe-canvas")) return;
    const block = editor.nodeFromDOM(dom);
    if (!block || block.node.type !== PagesDataframe) return;
    event.preventDefault();
    // Focus first: focusing reads the DOM selection, which would replace a
    // node selection made before it.
    editor.focus();
    editor.dispatch({ selection: GardSelection.node(block.pos, block.node) });
  });
}

/**
 * The renderer lifecycle of one table, as a state machine:
 *
 *   idle --connect--> scheduled --timer--> loading --loaded--> mounted
 *   mounted --disconnect--> parked --connect--> mounted
 *   parked --park timer--> idle (destroys the table)
 *   other --disconnect--> idle (cancels the timer)
 *   loading --failed--> failed
 *
 * Selecting the node makes Wordgard move the same DOM into a selection
 * wrapper, which disconnects and reconnects the widget. `parked` keeps the
 * mounted table across that move instead of reloading the dataset.
 *
 * Wordgard can connect and disconnect a widget more than once. Each connect
 * starts a new generation; a load that resolves for an older generation is
 * dropped, so a widget never holds two mounted tables.
 */
export function dataframeLifecycle({
  load,
  canvas,
  status,
  attrs,
  delay = 50,
  park = 1000,
  onUnavailable,
}) {
  let state = "idle",
    generation = 0,
    timer = null,
    instance = null;
  const transition = (event, value) => {
    switch (event) {
      case "connect":
        if (state === "parked") {
          clearTimeout(timer);
          timer = null;
          state = "mounted";
          return;
        }
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
      case "parkExpired":
        if (state !== "parked" || value !== generation) return;
        instance?.destroy();
        instance = null;
        timer = null;
        generation++;
        state = "idle";
        return;
      case "failed":
        if (state !== "loading" || value !== generation) return;
        state = "failed";
        onUnavailable?.();
        status.hidden = false;
        status.textContent = "Table unavailable.";
        return;
      case "disconnect":
        if (state === "mounted") {
          state = "parked";
          const current = generation;
          timer = setTimeout(() => transition("parkExpired", current), park);
          return;
        }
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
  render(attrs, editor) {
    const frame = dataframeFrame(attrs);
    selectDataframeOnPress(editor, frame.dom);
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
  // Events inside Sift's canvas are the grid's; the editor ignores them.
  // Events on the frame (keys and clipboard while the node is selected)
  // reach the editor, so cut, copy and delete act on the node.
  propagateEvent: (event) => !event.target?.closest?.(".wordgard-dataframe-canvas"),
});

/**
 * Editor config that draws every dataframe node as its table, reading only
 * datasets of `pageId`. This is a tag shape, the node type's own drawing, not
 * a point decoration. Wordgard 0.6.2 throws "Moving past end of document"
 * when a shaped point decoration first appears at an insertion boundary at
 * the end of a document, which is where a dropped dataset usually lands.
 */
export function wordgardDataframes({ pageId } = {}) {
  if (typeof pageId !== "string" || !pageId)
    throw Error("wordgardDataframes needs the Page id it shows");
  return Decoration.Tag.shape(
    PagesDataframe,
    (tag) => {
      const { src, media_type, title } = readDataframe(tag.param);
      return dataframeTable.of({ src, media_type, title, pageId });
    },
    { atom: true },
  );
}
