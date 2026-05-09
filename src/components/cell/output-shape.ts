/**
 * Cell-level output shape classification.
 *
 * Looks at the full set of outputs on a code cell and produces a single
 * discriminated value describing what's there. Other modules use the shape
 * to pick sensible defaults — currently the output-well sizing mode (see
 * {@link ./output-well-presets}), potentially other UI affordances later.
 *
 * Pure: no React, no DOM, no metadata. Only the outputs and the MIME
 * priority drive the result.
 */

import { DEFAULT_PRIORITY, getSelectedMimeType } from "@/components/outputs/media-router";
import { isVegaMimeType } from "@/components/outputs/vega-mime";
import type { JupyterOutput } from "./jupyter-output";

export type OutputShape =
  | { kind: "empty" }
  | {
      kind: "single-iframe-chart";
      mime: "plotly" | "vega" | "leaflet";
      explicitHeight?: number;
    }
  | { kind: "single-table"; mime: "parquet" | "arrow" }
  | { kind: "single-image"; mime: string }
  | { kind: "single-rich-text"; mime: "markdown" | "html" | "svg" }
  | { kind: "single-widget" }
  | { kind: "single-error" }
  | { kind: "streams-only" }
  | { kind: "streams-then-result"; result: OutputShape }
  | { kind: "mixed" };

const PLOTLY_MIME = "application/vnd.plotly.v1+json";
const GEOJSON_MIME = "application/geo+json";
const ARROW_MIME = "application/vnd.apache.arrow.stream";
const PARQUET_MIME = "application/vnd.apache.parquet";
const WIDGET_MIME = "application/vnd.jupyter.widget-view+json";
const MD_MIME = "text/markdown";
const HTML_MIME = "text/html";
const SVG_MIME = "image/svg+xml";

function classifyRichOutput(
  output: Extract<JupyterOutput, { output_type: "execute_result" | "display_data" }>,
  priority: readonly string[],
): OutputShape {
  const mime = getSelectedMimeType(output.data, priority);
  if (!mime) return { kind: "mixed" };

  if (mime === PLOTLY_MIME) {
    const layout = (output.data[mime] as { layout?: { height?: unknown } } | undefined)?.layout;
    const layoutHeight = layout?.height;
    return {
      kind: "single-iframe-chart",
      mime: "plotly",
      ...(typeof layoutHeight === "number" ? { explicitHeight: layoutHeight } : {}),
    };
  }
  if (isVegaMimeType(mime)) return { kind: "single-iframe-chart", mime: "vega" };
  if (mime === GEOJSON_MIME) return { kind: "single-iframe-chart", mime: "leaflet" };
  if (mime === PARQUET_MIME) return { kind: "single-table", mime: "parquet" };
  if (mime === ARROW_MIME) return { kind: "single-table", mime: "arrow" };
  if (mime === WIDGET_MIME) return { kind: "single-widget" };
  if (mime === MD_MIME) return { kind: "single-rich-text", mime: "markdown" };
  if (mime === HTML_MIME) return { kind: "single-rich-text", mime: "html" };
  if (mime === SVG_MIME) return { kind: "single-rich-text", mime: "svg" };
  if (mime.startsWith("image/")) return { kind: "single-image", mime };
  return { kind: "mixed" };
}

/**
 * Classify the cell's output composition into a single shape.
 *
 * Recognised shapes (first match wins):
 *  - `empty` — no outputs.
 *  - `streams-only` — every output is a stream.
 *  - `streams-then-result` — N streams followed by exactly one
 *    non-stream output. The dominant tail is recursively classified
 *    so callers can apply per-result rules.
 *  - `single-iframe-chart` / `single-table` / `single-image` /
 *    `single-rich-text` / `single-widget` / `single-error` — one output,
 *    classified by its selected MIME.
 *  - `mixed` — anything else.
 */
export function classifyOutputShape(
  outputs: readonly JupyterOutput[],
  priority: readonly string[] = DEFAULT_PRIORITY,
): OutputShape {
  if (outputs.length === 0) return { kind: "empty" };

  const allStreams = outputs.every((o) => o.output_type === "stream");
  if (allStreams) return { kind: "streams-only" };

  if (outputs.length === 1) {
    const only = outputs[0];
    if (only.output_type === "error") return { kind: "single-error" };
    if (only.output_type === "stream") return { kind: "streams-only" };
    return classifyRichOutput(only, priority);
  }

  // streams* + single non-stream tail
  const streamPrefix = outputs.slice(0, -1).every((o) => o.output_type === "stream");
  const tail = outputs[outputs.length - 1];
  if (streamPrefix && tail.output_type !== "stream") {
    if (tail.output_type === "error")
      return { kind: "streams-then-result", result: { kind: "single-error" } };
    return { kind: "streams-then-result", result: classifyRichOutput(tail, priority) };
  }

  return { kind: "mixed" };
}
