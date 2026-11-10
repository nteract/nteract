// The expanded diagram viewer's state (diagram-viewer.mjs).
//
// State: `{ name, ... }`. `name` is one of NAMES:
//   closed    no viewer
//   idle      open, no pointer down
//   panning   open, one pointer dragging the diagram
//   pinching  open, two pointers zooming around their midpoint
// An open state also holds:
//   content   the SVG's natural size, `{ width, height }`
//   viewport  the stage's size, `{ width, height }`
//   padding   the space kept around a fitted diagram, in px
//   fit       the scale that fits the diagram in the viewport
//   view      `{ scale, x, y }`: the diagram's scale and its top-left corner
//             in stage coordinates
//   fitted    true until the reader zooms or pans; a resize refits
//   pointers  the pointers down, `[{ id, x, y }]`, at most two
//
// Events (coordinates are stage-relative px):
//   { type: "open", content, viewport, padding }
//   { type: "close" }
//   { type: "resize", viewport }
//   { type: "pointerDown", id, x, y }
//   { type: "pointerMove", id, x, y }
//   { type: "pointerUp", id }              also pointercancel
//   { type: "wheel", deltaY, deltaMode, ctrlKey, x, y }
//   { type: "zoom", factor, x?, y? }        buttons, keys and double-click;
//                                           without x/y it zooms at the center
//   { type: "pan", dx, dy }                 arrow keys
//   { type: "fit" }
//
// The transition is pure and returns `state` itself when nothing changes.
// viewerEffects says what the DOM interpreter does after a transition.

export const NAMES = Object.freeze(["closed", "idle", "panning", "pinching"]);

/** The largest scale a fitted diagram gets; small diagrams don't balloon. */
export const MAX_FIT = 2;
/** The largest scale the reader can zoom to, relative to the natural size. */
export const MAX_SCALE = 4;
/** One zoom button press or key press. */
export const ZOOM_STEP = 1.5;

export const initialViewer = Object.freeze({ name: "closed" });

const positive = (value) => (Number.isFinite(value) && value > 0 ? value : 0);

/**
 * The scale that fits `content` inside `viewport` less `padding` on each side,
 * capped at MAX_FIT. A diagram or viewport without a size fits at 1.
 */
export function fitScale(content, viewport, padding = 0) {
  const width = positive(content?.width);
  const height = positive(content?.height);
  const room = {
    width: positive(viewport?.width) - 2 * padding,
    height: positive(viewport?.height) - 2 * padding,
  };
  if (!width || !height || room.width <= 0 || room.height <= 0) return 1;
  return Math.min(room.width / width, room.height / height, MAX_FIT);
}

/** The zoom range for a diagram that fits at `fit`. */
export function scaleLimits(fit) {
  return { min: Math.min(fit, 1), max: Math.max(MAX_SCALE, fit) };
}

// One axis: a diagram smaller than the room is centered; a larger one may move
// until its edge reaches the padding, never further.
function clampAxis(offset, length, room, padding) {
  if (length <= room - 2 * padding) return (room - length) / 2;
  return Math.min(padding, Math.max(room - length - padding, offset));
}

/** `view` with its scale in range and the diagram kept on screen. */
export function clampView(view, { content, viewport, padding, fit }) {
  const { min, max } = scaleLimits(fit);
  const scale = Math.min(max, Math.max(min, view.scale));
  return {
    scale,
    x: clampAxis(view.x, content.width * scale, viewport.width, padding),
    y: clampAxis(view.y, content.height * scale, viewport.height, padding),
  };
}

/** The view that shows the whole diagram, centered. */
export function fittedView(frame) {
  return clampView({ scale: frame.fit, x: 0, y: 0 }, frame);
}

/**
 * Zoom by `factor` keeping the diagram point under (`x`, `y`) in place, then
 * move that point to (`toX`, `toY`) (a pinch's midpoint moves as it zooms).
 */
export function zoomView(view, factor, x, y, frame, toX = x, toY = y) {
  const { min, max } = scaleLimits(frame.fit);
  const scale = Math.min(max, Math.max(min, view.scale * factor));
  const ratio = scale / view.scale;
  return clampView({ scale, x: toX - (x - view.x) * ratio, y: toY - (y - view.y) * ratio }, frame);
}

/**
 * The zoom factor for one wheel event. A trackpad pinch arrives as a wheel
 * with ctrlKey and small deltas, so it zooms faster per pixel than a mouse
 * wheel. Line and page deltas are converted to pixels; one event is capped so
 * a fast flick can't jump the whole range.
 */
export function wheelFactor(deltaY, deltaMode = 0, ctrlKey = false) {
  const pixels = (Number(deltaY) || 0) * (deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1);
  const capped = Math.max(-120, Math.min(120, pixels));
  return Math.exp(-capped * (ctrlKey ? 0.01 : 0.002));
}

const sameView = (a, b) => a.scale === b.scale && a.x === b.x && a.y === b.y;
const isOpen = (state) => state.name !== "closed";

// A zoom or pan that moves nothing (at a limit, or on a centered axis) keeps
// the state, including whether it is still fitted.
function withView(state, view, fitted = false) {
  if (sameView(state.view, view) && (state.fitted || !fitted)) return state;
  return { ...state, view, fitted };
}

function center(pointers) {
  const [a, b] = pointers;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y) };
}

function pointerDown(state, { id, x, y }) {
  const known = state.pointers.findIndex((pointer) => pointer.id === id);
  if (known >= 0) {
    const pointers = state.pointers.map((pointer, index) =>
      index === known ? { id, x, y } : pointer,
    );
    return { ...state, pointers };
  }
  if (state.name === "idle") return { ...state, name: "panning", pointers: [{ id, x, y }] };
  if (state.name === "panning")
    return { ...state, name: "pinching", pointers: [...state.pointers, { id, x, y }] };
  return state; // A third finger joins nothing.
}

function pointerMove(state, { id, x, y }) {
  const index = state.pointers.findIndex((pointer) => pointer.id === id);
  if (index < 0) return state;
  const previous = state.pointers[index];
  if (previous.x === x && previous.y === y) return state;
  const pointers = state.pointers.map((pointer, at) => (at === index ? { id, x, y } : pointer));
  if (state.name === "panning") {
    const view = clampView(
      { ...state.view, x: state.view.x + x - previous.x, y: state.view.y + y - previous.y },
      state,
    );
    return { ...state, pointers, view, fitted: false };
  }
  const before = center(state.pointers);
  const after = center(pointers);
  const factor = before.distance > 0 && after.distance > 0 ? after.distance / before.distance : 1;
  const view = zoomView(state.view, factor, before.x, before.y, state, after.x, after.y);
  return { ...state, pointers, view, fitted: false };
}

function pointerUp(state, { id }) {
  const pointers = state.pointers.filter((pointer) => pointer.id !== id);
  if (pointers.length === state.pointers.length) return state;
  return { ...state, name: pointers.length ? "panning" : "idle", pointers };
}

/** The next state. Pure: returns `state` itself when the event changes nothing. */
export function transition(state, event) {
  if (event?.type === "open") {
    if (isOpen(state)) return state;
    const content = {
      width: positive(event.content?.width),
      height: positive(event.content?.height),
    };
    const viewport = {
      width: positive(event.viewport?.width),
      height: positive(event.viewport?.height),
    };
    const padding = positive(event.padding);
    const fit = fitScale(content, viewport, padding);
    const frame = { content, viewport, padding, fit };
    return { name: "idle", ...frame, view: fittedView(frame), fitted: true, pointers: [] };
  }
  if (!isOpen(state)) return state;
  switch (event?.type) {
    case "close":
      return initialViewer;
    case "resize": {
      const viewport = {
        width: positive(event.viewport?.width),
        height: positive(event.viewport?.height),
      };
      if (viewport.width === state.viewport.width && viewport.height === state.viewport.height)
        return state;
      const fit = fitScale(state.content, viewport, state.padding);
      const next = { ...state, viewport, fit };
      return { ...next, view: state.fitted ? fittedView(next) : clampView(state.view, next) };
    }
    case "pointerDown":
      return pointerDown(state, event);
    case "pointerMove":
      return pointerMove(state, event);
    case "pointerUp":
      return pointerUp(state, event);
    case "wheel": {
      const factor = wheelFactor(event.deltaY, event.deltaMode, event.ctrlKey);
      return withView(state, zoomView(state.view, factor, event.x, event.y, state));
    }
    case "zoom": {
      const x = Number.isFinite(event.x) ? event.x : state.viewport.width / 2;
      const y = Number.isFinite(event.y) ? event.y : state.viewport.height / 2;
      return withView(state, zoomView(state.view, event.factor, x, y, state));
    }
    case "pan": {
      const view = { ...state.view, x: state.view.x + event.dx, y: state.view.y + event.dy };
      return withView(state, clampView(view, state));
    }
    case "fit":
      return withView(state, fittedView(state), true);
    default:
      return state;
  }
}

/** Whether the zoom-in and zoom-out controls can act on `state`. */
export function zoomAvailability(state) {
  if (!isOpen(state)) return { zoomIn: false, zoomOut: false };
  const { min, max } = scaleLimits(state.fit);
  return { zoomIn: state.view.scale < max * 0.999, zoomOut: state.view.scale > min * 1.001 };
}

/**
 * What runs after a transition, in order:
 *   show         the dialog opens as a modal
 *   focusStage   focus moves to the diagram stage, where keys zoom and pan
 *   render       the diagram's size, position and the controls update
 *   hide         the dialog closes and leaves the document
 *   returnFocus  focus goes back to the control that opened the viewer
 */
export function viewerEffects(previous, next) {
  if (previous === next) return [];
  if (!isOpen(previous)) return isOpen(next) ? ["show", "focusStage", "render"] : [];
  if (!isOpen(next)) return ["hide", "returnFocus"];
  return previous.view !== next.view || previous.name !== next.name ? ["render"] : [];
}
