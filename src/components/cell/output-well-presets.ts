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
      // Sift expects a fixed-height container with internal virtual scroll.
      // Focused mode caps the iframe at ~80% viewport with a 360px floor.
      return "focused";
    case "single-rich-text":
      // Markdown / HTML / SVG already pass scroll through to the page;
      // capping them with a wrapper scrollbar is hostile. Let them grow.
      return "expanded";
    case "streams-then-result":
      // The rich tail dominates — `print(...); df.head()` should treat
      // the dataframe as the headline output.
      return inferDefaultOutputMode(shape.result);
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
