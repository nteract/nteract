// The expanded diagram viewer: a full-viewport modal dialog showing a copy of
// a rendered diagram's SVG, with pan and zoom. Read-only: the source stays in
// the Page and nothing here writes to it.
//
// diagram-viewer-machine.mjs holds the state. This module is its interpreter:
// it turns DOM input into events and runs the effects the machine returns.
import { diagramIcon } from "./diagram-icons.mjs";
import {
  ZOOM_STEP,
  initialViewer,
  transition,
  viewerEffects,
  zoomAvailability,
} from "./diagram-viewer-machine.mjs";

const PAN_STEP = 48;
const DOUBLE_CLICK_ZOOM = 2;
// Space kept around a fitted diagram. Phones have less of it to spare.
const padding = (stage) => (stage.clientWidth < 600 ? 12 : 32);
let viewerCount = 0;
let active = null;

const number = (value) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

/**
 * An SVG's natural size: its width and height attributes, else its viewBox,
 * else its laid-out box.
 */
export function svgSize(svg) {
  let width = number(svg.getAttribute("width"));
  let height = number(svg.getAttribute("height"));
  if (!width || !height) {
    const box = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/);
    width ||= number(box[2]);
    height ||= number(box[3]);
  }
  if (!width || !height) {
    const rect = svg.getBoundingClientRect?.();
    width ||= number(rect?.width);
    height ||= number(rect?.height);
  }
  return { width, height };
}

const URL_REFERENCE = /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g;
const ID_LISTS = new Set(["aria-labelledby", "aria-describedby"]);

/**
 * Give every id under `root` a `-suffix` and rewrite the references to them
 * (`url(#id)` in attributes and styles, and ARIA id lists). The inline diagram
 * keeps its ids, so a copy beside it never resolves markers or labels to the
 * original's elements.
 */
export function isolateIds(root, suffix) {
  const ids = new Map();
  for (const element of [root, ...root.querySelectorAll("[id]")]) {
    if (!element.id) continue;
    const id = `${element.id}-${suffix}`;
    ids.set(element.id, id);
    element.id = id;
  }
  if (!ids.size) return root;
  for (const element of [root, ...root.querySelectorAll("*")]) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name === "id") continue;
      let value = attribute.value;
      if (ID_LISTS.has(attribute.name))
        value = value
          .split(/\s+/)
          .map((token) => ids.get(token) ?? token)
          .join(" ");
      else if (value.includes("url("))
        value = value.replace(URL_REFERENCE, (match, quote, id) =>
          ids.has(id) ? `url(${quote}#${ids.get(id)}${quote})` : match,
        );
      if (value !== attribute.value) element.setAttribute(attribute.name, value);
    }
  }
  return root;
}

// Pele's inline zoom writes these on the SVG it manages. The copy starts from
// the diagram's natural frame instead of the inline view.
const INLINE_ZOOM_STYLES = [
  "width",
  "height",
  "max-width",
  "margin",
  "display",
  "cursor",
  "user-select",
  "touch-action",
  "outline",
];

/** A copy of a rendered diagram SVG, reset to its natural frame. */
export function cloneDiagram(svg, suffix) {
  const { width, height } = svgSize(svg);
  const clone = svg.cloneNode(true);
  for (const property of INLINE_ZOOM_STYLES) clone.style.removeProperty(property);
  clone.removeAttribute("tabindex");
  if (width && height) clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
  return { svg: isolateIds(clone, suffix), width, height };
}

function element(doc, tag, className, attributes = {}) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

function iconButton(doc, label, icon, className) {
  const button = element(doc, "button", `diagram-viewer-button ${className}`, {
    type: "button",
    "aria-label": label,
    title: label,
  });
  button.append(diagramIcon(icon, doc));
  return button;
}

const focusable = (dialog) =>
  Array.from(dialog.querySelectorAll("button, [tabindex='0']")).filter(
    (node) => !node.hidden && !node.closest("[hidden]"),
  );

/**
 * Open `svg` (a rendered diagram) in the expanded viewer. `label` titles the
 * dialog; focus returns to `opener` when the viewer closes. Opening a second
 * viewer closes the first. Returns `{ close, dialog, state }`.
 */
export function openDiagramViewer({ svg, label = "Diagram", opener = null }) {
  active?.close();
  const doc = svg.ownerDocument;
  const win = doc.defaultView;
  const id = `diagram-viewer-${++viewerCount}`;
  const copy = cloneDiagram(svg, id);

  const dialog = element(doc, "dialog", "diagram-viewer", {
    "aria-labelledby": `${id}-title`,
    "aria-describedby": `${id}-hint`,
  });
  const bar = dialog.appendChild(element(doc, "div", "diagram-viewer-bar"));
  const title = bar.appendChild(element(doc, "h2", "diagram-viewer-title", { id: `${id}-title` }));
  title.textContent = label;
  const zoom = bar.appendChild(
    element(doc, "div", "diagram-viewer-zoom", { role: "group", "aria-label": "Zoom" }),
  );
  const zoomOut = zoom.appendChild(iconButton(doc, "Zoom out", "zoomOut", "diagram-viewer-out"));
  const scale = zoom.appendChild(element(doc, "span", "diagram-viewer-scale"));
  const zoomIn = zoom.appendChild(iconButton(doc, "Zoom in", "zoomIn", "diagram-viewer-in"));
  const fit = zoom.appendChild(
    element(doc, "button", "diagram-viewer-button diagram-viewer-fit", {
      type: "button",
      "aria-label": "Fit diagram to screen",
      title: "Fit diagram to screen",
    }),
  );
  fit.textContent = "Fit";
  const close = bar.appendChild(iconButton(doc, "Close", "close", "diagram-viewer-close"));
  const stage = dialog.appendChild(
    element(doc, "div", "diagram-viewer-stage", {
      tabindex: "0",
      role: "group",
      "aria-label": "Diagram view",
    }),
  );
  const content = stage.appendChild(element(doc, "div", "diagram-viewer-content"));
  content.append(copy.svg);
  const hint = dialog.appendChild(element(doc, "p", "sr-only", { id: `${id}-hint` }));
  hint.textContent =
    "Drag to pan. Scroll, pinch, or press plus and minus to zoom. Press 0 to fit. Escape closes.";

  let state = initialViewer;
  let frame = 0;
  let observer;

  const render = () => {
    if (state.name === "closed") return;
    const { view } = state;
    copy.svg.style.width = `${copy.width * view.scale}px`;
    copy.svg.style.height = `${copy.height * view.scale}px`;
    content.style.transform = `translate(${view.x}px, ${view.y}px)`;
    scale.textContent = `${Math.round(view.scale * 100)}%`;
    const available = zoomAvailability(state);
    // aria-disabled keeps a focused button focused at the end of the range.
    zoomIn.setAttribute("aria-disabled", String(!available.zoomIn));
    zoomOut.setAttribute("aria-disabled", String(!available.zoomOut));
    stage.dataset.gesture = state.name;
  };
  const scheduleRender = () => {
    if (frame) return;
    if (!win.requestAnimationFrame) return render();
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  };

  const effects = {
    show() {
      if (!dialog.isConnected) doc.body.append(dialog);
      if (dialog.open) return;
      try {
        dialog.showModal();
      } catch {
        // No modal dialog support (jsdom, very old browsers): still show it.
        dialog.setAttribute("open", "");
      }
    },
    focusStage() {
      stage.focus({ preventScroll: true });
    },
    render() {
      // The first frame renders at once so the copy never flashes unscaled.
      if (!stage.dataset.gesture) render();
      else scheduleRender();
    },
    hide() {
      if (frame) win.cancelAnimationFrame?.(frame);
      frame = 0;
      observer?.disconnect();
      win.removeEventListener("resize", resized);
      if (dialog.open) {
        try {
          dialog.close();
        } catch {
          dialog.removeAttribute("open");
        }
      }
      dialog.remove();
      if (active === handle) active = null;
    },
    returnFocus() {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    },
  };

  const dispatch = (event) => {
    const previous = state;
    state = transition(state, event);
    for (const effect of viewerEffects(previous, state)) effects[effect]();
  };

  const local = (event) => {
    const rect = stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const resized = () =>
    dispatch({
      type: "resize",
      viewport: { width: stage.clientWidth, height: stage.clientHeight },
    });

  stage.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    stage.focus({ preventScroll: true });
    stage.setPointerCapture?.(event.pointerId);
    dispatch({ type: "pointerDown", id: event.pointerId, ...local(event) });
  });
  stage.addEventListener("pointermove", (event) =>
    dispatch({ type: "pointerMove", id: event.pointerId, ...local(event) }),
  );
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
    stage.addEventListener(type, (event) => dispatch({ type: "pointerUp", id: event.pointerId }));
  stage.addEventListener("dblclick", (event) =>
    dispatch({ type: "zoom", factor: DOUBLE_CLICK_ZOOM, ...local(event) }),
  );
  dialog.addEventListener(
    "wheel",
    (event) => {
      // Nothing in the dialog scrolls; the Page behind it must not either.
      event.preventDefault();
      if (!stage.contains(event.target)) return;
      dispatch({
        type: "wheel",
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey,
        ...local(event),
      });
    },
    { passive: false },
  );
  // Safari's own pinch gestures would zoom the Page; pointer events zoom the diagram.
  for (const type of ["gesturestart", "gesturechange"])
    dialog.addEventListener(type, (event) => event.preventDefault(), { passive: false });

  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      dispatch({ type: "close" });
      return;
    }
    if (event.key === "Tab") {
      // The modal makes the Page inert; this keeps Tab cycling inside the
      // dialog instead of leaving for the browser's own controls.
      const stops = focusable(dialog);
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (event.shiftKey ? doc.activeElement === first : doc.activeElement === last) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
      return;
    }
    if (event.target !== stage || event.ctrlKey || event.metaKey || event.altKey) return;
    const action = {
      "+": { type: "zoom", factor: ZOOM_STEP },
      "=": { type: "zoom", factor: ZOOM_STEP },
      "-": { type: "zoom", factor: 1 / ZOOM_STEP },
      _: { type: "zoom", factor: 1 / ZOOM_STEP },
      0: { type: "fit" },
      ArrowLeft: { type: "pan", dx: PAN_STEP, dy: 0 },
      ArrowRight: { type: "pan", dx: -PAN_STEP, dy: 0 },
      ArrowUp: { type: "pan", dx: 0, dy: PAN_STEP },
      ArrowDown: { type: "pan", dx: 0, dy: -PAN_STEP },
    }[event.key];
    if (!action) return;
    event.preventDefault();
    dispatch(action);
  });
  // The browser's own close requests (Android back, Escape where keydown
  // didn't reach us) go through the machine like the Close button.
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dispatch({ type: "close" });
  });
  dialog.addEventListener("close", () => dispatch({ type: "close" }));

  const unlessDisabled = (button, event) => () => {
    if (button.getAttribute("aria-disabled") !== "true") dispatch(event);
  };
  zoomIn.addEventListener("click", unlessDisabled(zoomIn, { type: "zoom", factor: ZOOM_STEP }));
  zoomOut.addEventListener(
    "click",
    unlessDisabled(zoomOut, { type: "zoom", factor: 1 / ZOOM_STEP }),
  );
  fit.addEventListener("click", () => dispatch({ type: "fit" }));
  close.addEventListener("click", () => dispatch({ type: "close" }));

  const handle = {
    dialog,
    get state() {
      return state;
    },
    close: () => dispatch({ type: "close" }),
  };
  active = handle;

  // Measure the stage after the dialog is laid out, then open the machine.
  effects.show();
  dispatch({
    type: "open",
    content: { width: copy.width, height: copy.height },
    viewport: { width: stage.clientWidth, height: stage.clientHeight },
    padding: padding(stage),
  });
  if (win.ResizeObserver) {
    observer = new win.ResizeObserver(resized);
    observer.observe(stage);
  } else win.addEventListener("resize", resized);
  return handle;
}
