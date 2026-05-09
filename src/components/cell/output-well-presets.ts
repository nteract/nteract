/**
 * Map an {@link OutputShape} to a default output-well sizing mode.
 *
 * The mode strip in the cell chrome offers compact / expanded / focused.
 * Until the user clicks the strip, the cell falls back to whatever this
 * function returns — picked so the most common composition for each
 * shape feels right out of the box. User toggles persist in cell
 * metadata (`metadata.nteract.outputMode`) and override this default
 * until the cell's outputs are cleared.
 */

import type { OutputShape } from "./output-shape";

export type OutputMode = "compact" | "expanded" | "focused";

export function inferDefaultOutputMode(shape: OutputShape): OutputMode {
  switch (shape.kind) {
    case "single-iframe-chart":
      // Plotly / vega / leaflet at the user's requested height should flow
      // inline like any other tall block. Compact's 75% vh wrapper cap
      // would clip a `height=900` chart inside a 722px scrollable
      // wrapper — producing a "double scrollbar" (page + wrapper). Expanded
      // drops the wrapper cap; the chart takes its requested height in
      // document order, the page scrolls naturally past it.
      return "expanded";
    case "single-table":
      // Sift owns its own size (200–600px) and is scroll-passthrough — the
      // page wheels past, click engages the table. Expanded keeps the
      // wrapper out of the way so the cell behaves like any other inline
      // block in the document.
      return "expanded";
    case "single-rich-text":
      // Markdown / HTML / SVG already pass scroll through to the page;
      // capping them with a wrapper scrollbar is hostile. Let them grow.
      return "expanded";
    case "streams-then-result":
      // A long stdout block plus a final result (dataframe, plot, etc.)
      // looks wrong inside a wrapper scrollbar — the streams want to flow
      // inline like document content, and the page is already scrollable.
      return "expanded";
    case "empty":
    case "single-image":
    case "single-widget":
    case "single-error":
    case "streams-only":
    case "mixed":
      return "compact";
  }
}
