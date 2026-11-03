// Draws each dataframe node (wordgard-model.mjs PagesDataframe) by its media
// type. The node is an atomic leaf with no text, so the table is its whole
// shape; selecting the node and pressing Backspace removes it.
//
// Sorting, filtering and column changes stay in each reader's view. A shared
// view belongs beside the node, not in its attrs; see the README's Dataframes
// section.
import { Decoration, KeyBinding, Widget } from "wordgard/editor";
import { GardSelection } from "wordgard/state";
import { PagesDataframe } from "./wordgard-model.mjs";
import { reportRendererUnavailable } from "./wordgard-widgets.mjs";
import { PARQUET_MEDIA_TYPE, readDataframe } from "../shared/dataset-assets.mjs";
import { asyncScheduler, timer as rxTimer } from "rxjs";
import { dataframeTableMachine } from "./dataframe-table-machine.mjs";

/** Media type -> lazily loaded renderer module with
 * `mount(container, { src, pageId })` returning `{ destroy }`. Each is its own
 * chunk, loaded only when a Page shows that kind of dataframe. */
export const DATAFRAME_RENDERERS = Object.freeze({
  [PARQUET_MEDIA_TYPE]: () => import("./sift-table.jsx"),
});

/**
 * The table's frame: a title row above the canvas. The title row and the
 * frame's edges belong to the node: a click there selects the table the way
 * a click selects an image (Wordgard's native atom selection). The canvas
 * belongs to Sift.
 */
export function dataframeFrame({ title, media_type }) {
  const dom = document.createElement("section");
  dom.className = "wordgard-widget wordgard-dataframe-table";
  dom.dataset.mediaType = media_type;
  dom.setAttribute("aria-label", title ?? "Table");
  dom.setAttribute("aria-roledescription", "table");
  const header = dom.appendChild(document.createElement("div"));
  header.className = "wordgard-dataframe-header";
  const caption = header.appendChild(document.createElement("div"));
  caption.className = "wordgard-dataframe-title";
  caption.textContent = title ?? "Table";
  caption.classList.toggle("is-untitled", !title);
  // The status sits over the canvas, not above it, so hiding it when the
  // table draws doesn't move anything.
  const body = dom.appendChild(document.createElement("div"));
  body.className = "wordgard-dataframe-body";
  const canvas = body.appendChild(document.createElement("div"));
  canvas.className = "wordgard-dataframe-canvas";
  const status = body.appendChild(document.createElement("p"));
  status.setAttribute("role", "status");
  const load = DATAFRAME_RENDERERS[media_type];
  // A live region announces changes, not its first text. Starting with the
  // text the lifecycle shows first means connecting a table announces
  // nothing; only loading and failure do.
  status.textContent = load ? DATAFRAME_STATUS.waiting : `This build can't show ${media_type}.`;
  canvas.hidden = !load;
  return { dom, header, status, canvas, load };
}

/** Events inside Sift's canvas are the grid's; Wordgard never sees them.
 * Everything on the frame reaches Wordgard, which selects the node. */
export const dataframeEventReachesEditor = (event) =>
  !event.target?.closest?.(".wordgard-dataframe-canvas");

/** Status text while a table waits for the viewport, and while it loads. */
export const DATAFRAME_STATUS = Object.freeze({
  waiting: "This table loads when you scroll to it.",
  loading: "Loading table…",
});

/** How far outside the viewport a table starts loading, so it's usually
 * drawn by the time a reader scrolls to it. */
export const PRELOAD_MARGIN = "600px 0px";

/**
 * A viewport watcher over one shared observer: `observe(element, onChange)`
 * calls `onChange(near)` when the element comes within PRELOAD_MARGIN of the
 * viewport or leaves it, and returns the function that stops watching.
 * Printing counts every watched table as near, so a printed Page starts
 * loading its tables. Without an Observer every table counts as near.
 */
export function viewportWatcher({ Observer, target } = {}) {
  if (typeof Observer !== "function")
    return (_element, onChange) => {
      onChange(true);
      return () => {};
    };
  const watched = new Map();
  let observer = null;
  target?.addEventListener?.("beforeprint", () => {
    for (const onChange of watched.values()) onChange(true);
  });
  return (element, onChange) => {
    observer ??= new Observer(
      (entries) => {
        for (const entry of entries) watched.get(entry.target)?.(entry.isIntersecting);
      },
      { rootMargin: PRELOAD_MARGIN },
    );
    watched.set(element, onChange);
    observer.observe(element);
    return () => {
      // A later observe of the same element replaces its callback. A stop
      // from an older one leaves that registration watched.
      if (watched.get(element) !== onChange) return;
      watched.delete(element);
      observer.unobserve(element);
    };
  };
}

let defaultWatcher = null;
/** The page's shared viewport watcher. */
export const observeNearViewport = (element, onChange) =>
  (defaultWatcher ??= viewportWatcher({
    Observer: globalThis.IntersectionObserver,
    target: globalThis.window,
  }))(element, onChange);

/**
 * Runs dataframeTableMachine (dataframe-table-machine.mjs) for one table,
 * with its effects at the edge: the viewport watcher, the one armed timer,
 * the renderer chunk and the mounted instance. A media type with no renderer
 * (`load` undefined) never connects.
 */
export function dataframeLifecycle({
  load,
  dom,
  canvas,
  status,
  attrs,
  delay = 50,
  park = 1000,
  observe = observeNearViewport,
  scheduler = asyncScheduler,
  onUnavailable,
}) {
  let model = dataframeTableMachine.initial,
    timer = null,
    instance = null,
    stopWatching = null,
    module = null;
  const dispatch = (event) => {
    const result = dataframeTableMachine.step(model, event);
    model = result.state;
    for (const effect of result.effects) run(effect);
  };
  const run = (effect) => {
    switch (effect.type) {
      case "showStatus":
        status.hidden = false;
        status.textContent = DATAFRAME_STATUS[effect.status];
        return;
      case "observe":
        stopWatching?.();
        // The watcher can answer at once; dispatch reads the updated model.
        stopWatching = observe(dom ?? canvas, (near) =>
          dispatch({ type: near ? "visible" : "hidden" }),
        );
        return;
      case "unobserve":
        stopWatching?.();
        stopWatching = null;
        return;
      case "startTimer":
        timer?.unsubscribe();
        timer = rxTimer(effect.timer === "park" ? park : delay, scheduler).subscribe(() => {
          timer = null;
          dispatch({
            type: effect.timer === "park" ? "parkExpired" : "timer",
            generation: effect.generation,
          });
        });
        return;
      case "clearTimer":
        timer?.unsubscribe();
        timer = null;
        return;
      case "load":
        load().then(
          (loaded) => {
            module = { generation: effect.generation, loaded };
            dispatch({ type: "loaded", generation: effect.generation });
          },
          () => dispatch({ type: "failed", generation: effect.generation }),
        );
        return;
      case "mount":
        // The renderer draws its own loading and error states, including
        // fetchDataset's access and missing-asset messages.
        status.hidden = true;
        instance = module.loaded.mount(canvas, attrs);
        module = null;
        return;
      case "markMoved":
        // A move re-inserts the DOM, which restarts CSS animations. Sift's
        // load-in animations would replay on every select; turn them off.
        if (canvas.dataset) canvas.dataset.moved = "";
        return;
      case "fail":
        onUnavailable?.();
        status.hidden = false;
        status.textContent = "Table unavailable.";
        return;
      case "destroy":
        instance?.destroy();
        instance = null;
        return;
    }
  };
  return {
    connect: () => load && dispatch({ type: "connect" }),
    disconnect: () => load && dispatch({ type: "disconnect" }),
    get state() {
      return model.name;
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
    leaveGridOnEscape(editor, frame.dom);
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
  propagateEvent: dataframeEventReachesEditor,
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
  return [
    Decoration.Tag.shape(
      PagesDataframe,
      (tag) => {
        const { src, media_type, title } = readDataframe(tag.param);
        return dataframeTable.of({ src, media_type, title, pageId });
      },
      { atom: true },
    ),
    KeyBinding.of({ key: "Escape", run: deselectDataframe }),
    KeyBinding.of({ key: "Enter", run: enterDataframeGrid }),
  ];
}

const selectedDataframe = (state) =>
  state.selection instanceof GardSelection.Node && state.selection.node.type === PagesDataframe
    ? state.selection
    : null;

/** The focus target inside a rendered table: Sift's grid container. */
const gridTarget = (frame) =>
  frame?.querySelector(".wordgard-dataframe-canvas [tabindex='0']") ?? null;

/**
 * Enter on a selected dataframe moves focus into Sift's grid, where arrows,
 * Page Up/Down and Home/End scroll rows. Before the grid has loaded, Enter
 * on the selected table does nothing, rather than its usual work of
 * replacing the selected node. Returns false only when no table is
 * selected.
 */
export function enterDataframeGrid(editor) {
  const selection = selectedDataframe(editor.state);
  if (!selection) return false;
  const dom = editor.nodeDOM(selection.from);
  const frame = dom?.matches?.(".wordgard-dataframe-table")
    ? dom
    : dom?.querySelector?.(".wordgard-dataframe-table");
  gridTarget(frame)?.focus({ preventScroll: true });
  return true;
}

/**
 * Escape inside the grid returns to the table selected in the editor. Sift
 * uses its first Escape to clear active filters (and prevents the default);
 * only an Escape it didn't take leaves the grid.
 */
function leaveGridOnEscape(editor, frame) {
  frame.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (!event.target?.closest?.(".wordgard-dataframe-canvas")) return;
    const block = editor.nodeFromDOM(frame);
    if (!block || block.node.type !== PagesDataframe) return;
    event.preventDefault();
    editor.focus();
    editor.dispatch({ selection: GardSelection.node(block.pos, block.node) });
  });
}

/**
 * Escape on a selected dataframe puts the caret just after it, so the table
 * is no longer selected. Returns false (letting Escape through) otherwise.
 */
export function deselectDataframe(editor) {
  const selection = selectedDataframe(editor.state);
  if (!selection) return false;
  editor.dispatch({
    selection: (cx) =>
      selection.nextNormalCursor(cx, true) ?? GardSelection.near(cx, selection.from, -1),
  });
  return true;
}
