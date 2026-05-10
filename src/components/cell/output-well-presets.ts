/**
 * Map an {@link OutputShape} to a default output-well sizing mode.
 *
 * OutputArea supports compact / expanded / focused sizing. Code cells
 * infer one of those modes from the current output shape so common
 * compositions feel right without exposing per-cell layout controls.
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
    case "mixed":
      // Mixed output stacks are usually the notebook-native case:
      // display(HTML), display(plotly), display(altair), streams followed
      // by diagnostics, etc. A compact wrapper hides later siblings behind
      // an output-well scrollbar, which makes the cell feel broken even
      // though each renderer is working. Let the stack participate in the
      // page's natural scroll.
      return "expanded";
    case "empty":
    case "single-image":
    case "single-widget":
    case "single-error":
    case "streams-only":
      return "compact";
  }
}
