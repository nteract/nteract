// Wordgard owns the diagram DOM. Use the same small stroke icons as the React
// toolbar (Lucide paths) without mounting a second React root inside an editor
// decoration, a chart (vega-chart.mjs) or the expanded viewer.
const PATHS = {
  code: ["m16 18 6-6-6-6", "m8 6-6 6 6 6"],
  preview: [
    "M2.1 12a1 1 0 0 1 0-.7 10.8 10.8 0 0 1 19.8 0 1 1 0 0 1 0 .7 10.8 10.8 0 0 1-19.8 0",
    "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  ],
  copy: ["M9 9h11v11H9z", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"],
  check: ["m20 6-11 11-5-5"],
  maximize: ["M15 3h6v6", "m21 3-7 7", "m3 21 7-7", "M9 21H3v-6"],
  zoomIn: ["M5 12h14", "M12 5v14"],
  zoomOut: ["M5 12h14"],
  close: ["M18 6 6 18", "m6 6 12 12"],
};

/** A decorative 24×24 stroke icon; `kind` is a key of PATHS. */
export function diagramIcon(kind, doc = document) {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  }))
    svg.setAttribute(name, value);
  for (const d of PATHS[kind]) {
    const path = doc.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** An icon button in a diagram's or chart's action group. */
export function diagramButton(label, icon, className = "", doc = document) {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = `icon-button wordgard-diagram-action ${className}`;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.append(diagramIcon(icon, doc));
  return button;
}

/**
 * Maximize opens a rendered diagram or chart in the expanded viewer
 * (diagram-viewer.mjs). It stays hidden until there is a rendered SVG to show.
 */
export function maximizeButton(label = "Maximize diagram", doc = document) {
  const button = diagramButton(label, "maximize", "wordgard-diagram-maximize", doc);
  button.setAttribute("aria-haspopup", "dialog");
  button.hidden = true;
  return button;
}
