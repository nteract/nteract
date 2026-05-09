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
    case "single-table":
      // Sift renders at a fixed 600px and is now scroll-passthrough — the
      // page wheels past it, click engages the table. Compact's 75% vh cap
      // never engages at that height, so compact and expanded are visually
      // identical. We pick compact as the conservative default and hide
      // the mode strip on these cells (sift's own maximize button is the
      // entry to fullscreen).
      return "compact";
    case "single-rich-text":
      // Markdown / HTML / SVG already pass scroll through to the page;
      // capping them with a wrapper scrollbar is hostile. Let them grow.
      return "expanded";
    case "streams-then-result":
      // A long stdout block plus a final result (dataframe, plot, etc.)
      // looks wrong inside a wrapper scrollbar — the streams want to flow
      // inline like document content, and the page is already scrollable.
      // Expanded drops the wrapper cap so the whole cell grows naturally;
      // sift / plotly / md tail still gets its own click-to-engage behavior
      // when applicable.
      return "expanded";
    case "empty":
    case "single-iframe-chart":
    case "single-image":
    case "single-widget":
    case "single-error":
    case "streams-only":
    case "mixed":
      return "compact";
  }
}
