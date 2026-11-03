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
  const status = dom.appendChild(document.createElement("p"));
  status.setAttribute("role", "status");
  const canvas = dom.appendChild(document.createElement("div"));
  canvas.className = "wordgard-dataframe-canvas";
  const load = DATAFRAME_RENDERERS[media_type];
  status.textContent = load ? "Loading table…" : `This build can't show ${media_type}.`;
  canvas.hidden = !load;
  return { dom, header, status, canvas, load };
}

/** Events inside Sift's canvas are the grid's; Wordgard never sees them.
 * Everything on the frame reaches Wordgard, which selects the node. */
export const dataframeEventReachesEditor = (event) =>
  !event.target?.closest?.(".wordgard-dataframe-canvas");

/** States of one table's renderer lifecycle (dataframeStep). */
export const DATAFRAME_STATES = Object.freeze([
  "idle",
  "waiting",
  "scheduled",
  "loading",
  "mounted",
  "parked",
  "failed",
]);

/**
 * The renderer lifecycle of one table, as a pure transition:
 *
 *   idle --connect--> waiting --visible--> scheduled --timer--> loading
 *   scheduled --hidden--> waiting (cancels the timer)
 *   loading --loaded--> mounted   loading --failed--> failed
 *   mounted --disconnect--> parked --connect--> mounted
 *   parked --parkExpired--> idle (destroys the table)
 *   any other state --disconnect--> idle (cancels what's pending)
 *
 * `waiting` holds a connected table until it nears the viewport, so a Page
 * with many tables loads Sift and fetches a dataset only for the ones a
 * reader scrolls to. Once loading starts, visibility no longer matters: a
 * mounted table stays mounted offscreen, keeping the reader's sort and
 * filters.
 *
 * Selecting the node makes Wordgard move the same DOM into a selection
 * wrapper, which disconnects and reconnects the widget. `parked` keeps the
 * mounted table across that move instead of reloading the dataset.
 *
 * Wordgard can connect and disconnect a widget more than once. Each connect
 * starts a new generation; a timer or load that settles for an older
 * generation is dropped, so a widget never holds two mounted tables.
 *
 * Returns the next model and the effects to run, in order. Every effect
 * names the generation it belongs to where it can settle later.
 */
export function dataframeStep(model, event, { canLoad = true } = {}) {
  const { state, generation } = model;
  const stay = { model, effects: [] };
  const current = event.generation === generation;
  switch (event.type) {
    case "connect":
      if (state === "parked")
        return { model: { state: "mounted", generation }, effects: ["clearTimer", "markMoved"] };
      if (state !== "idle" || !canLoad) return stay;
      return { model: { state: "waiting", generation: generation + 1 }, effects: ["observe"] };
    case "visible":
      if (state !== "waiting") return stay;
      return {
        model: { state: "scheduled", generation },
        effects: [{ type: "startTimer", event: "timer", generation }],
      };
    case "hidden":
      if (state !== "scheduled") return stay;
      return { model: { state: "waiting", generation }, effects: ["clearTimer"] };
    case "timer":
      if (state !== "scheduled" || !current) return stay;
      return {
        model: { state: "loading", generation },
        effects: ["unobserve", { type: "load", generation }],
      };
    case "loaded":
      if (state !== "loading" || !current) return stay;
      return {
        model: { state: "mounted", generation },
        effects: [{ type: "mount", module: event.module }],
      };
    case "failed":
      if (state !== "loading" || !current) return stay;
      return { model: { state: "failed", generation }, effects: ["fail"] };
    case "parkExpired":
      if (state !== "parked" || !current) return stay;
      return { model: { state: "idle", generation: generation + 1 }, effects: ["destroy"] };
    case "disconnect":
      if (state === "mounted")
        return {
          model: { state: "parked", generation },
          effects: [{ type: "startTimer", event: "parkExpired", generation }],
        };
      if (state === "idle") return stay;
      return {
        model: { state: "idle", generation: generation + 1 },
        effects: ["clearTimer", "unobserve", "destroy"],
      };
  }
  return stay;
}

/** How far outside the viewport a table starts loading, so it's usually
 * drawn by the time a reader scrolls to it. */
const PRELOAD_MARGIN = "600px 0px";
let sharedObserver = null;
const observed = new Map();
/** Calls `onChange(near)` when `element` comes within PRELOAD_MARGIN of the
 * viewport or leaves it; returns the function that stops watching. Without
 * IntersectionObserver every table counts as near. */
export function observeNearViewport(element, onChange) {
  if (typeof IntersectionObserver !== "function") {
    onChange(true);
    return () => {};
  }
  sharedObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) observed.get(entry.target)?.(entry.isIntersecting);
    },
    { rootMargin: PRELOAD_MARGIN },
  );
  observed.set(element, onChange);
  sharedObserver.observe(element);
  return () => {
    observed.delete(element);
    sharedObserver.unobserve(element);
  };
}

/** Runs dataframeStep for one table, with its effects at the edge. */
export function dataframeLifecycle({
  load,
  dom,
  canvas,
  status,
  attrs,
  delay = 50,
  park = 1000,
  observe = observeNearViewport,
  onUnavailable,
}) {
  let model = { state: "idle", generation: 0 },
    timer = null,
    instance = null,
    stopObserving = null;
  const dispatch = (event) => {
    const result = dataframeStep(model, event, { canLoad: Boolean(load) });
    model = result.model;
    for (const effect of result.effects)
      run(typeof effect === "string" ? { type: effect } : effect);
  };
  const run = (effect) => {
    switch (effect.type) {
      case "observe":
        stopObserving?.();
        // The observer can report at once; dispatch reads the updated model.
        stopObserving = observe(dom ?? canvas, (near) =>
          dispatch({ type: near ? "visible" : "hidden" }),
        );
        return;
      case "unobserve":
        stopObserving?.();
        stopObserving = null;
        return;
      case "startTimer":
        clearTimeout(timer);
        timer = setTimeout(
          () => dispatch({ type: effect.event, generation: effect.generation }),
          effect.event === "parkExpired" ? park : delay,
        );
        return;
      case "clearTimer":
        clearTimeout(timer);
        timer = null;
        return;
      case "load":
        load().then(
          (module) => dispatch({ type: "loaded", generation: effect.generation, module }),
          () => dispatch({ type: "failed", generation: effect.generation }),
        );
        return;
      case "mount":
        // The renderer draws its own loading and error states, including
        // fetchDataset's access and missing-asset messages.
        status.hidden = true;
        instance = effect.module.mount(canvas, attrs);
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
        timer = null;
        return;
    }
  };
  return {
    connect: () => dispatch({ type: "connect" }),
    disconnect: () => dispatch({ type: "disconnect" }),
    get state() {
      return model.state;
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
 * Page Up/Down and Home/End scroll rows. Returns false (Enter does its usual
 * work) when no table is selected or its grid hasn't loaded.
 */
export function enterDataframeGrid(editor) {
  const selection = selectedDataframe(editor.state);
  if (!selection) return false;
  const dom = editor.nodeDOM(selection.from);
  const frame = dom?.matches?.(".wordgard-dataframe-table")
    ? dom
    : dom?.querySelector?.(".wordgard-dataframe-table");
  const target = gridTarget(frame);
  if (!target) return false;
  target.focus({ preventScroll: true });
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
