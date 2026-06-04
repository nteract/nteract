import type { JupyterOutput } from "@/components/cell/jupyter-output";
import { DEFAULT_PRIORITY, selectMimeType } from "@/components/outputs/mime-priority";
import { isSafeForMainDom } from "@/components/outputs/safe-mime-types";
import { isVegaMimeType } from "@/components/outputs/vega-mime";
import {
  canRenderMarkdownProjectionInHost,
  MARKDOWN_PROJECTION_MIME_TYPE,
  markdownProjectionPlanFromMimeData,
  projectMarkdownPlan,
} from "../../lib/markdown-projection";

export type OutputLane = "dom" | "static-frame" | "interactive-frame" | "sift-frame" | "vega-frame";

export interface OutputSegment {
  lane: OutputLane;
  outputs: JupyterOutput[];
}

export interface OutputSegmentationOptions {
  isolated?: boolean | "auto";
  hasCollapseControl?: boolean;
  priority?: readonly string[];
}

const SCROLL_PASSTHROUGH_MIME_TYPES = new Set([
  // Static document-like outputs (markdown / HTML / SVG) all behave better as
  // click-to-engage: the page wheels through them by default, while
  // pointer-down hands events back to the iframe.
  "text/markdown",
  "text/html",
  "image/svg+xml",
  // Sift's interactive tables are also click-to-engage (see SIFT_MIME_TYPES).
  "application/vnd.apache.parquet",
  "application/vnd.apache.arrow.stream",
  "application/vnd.nteract.arrow-stream-manifest+json",
]);

const SIFT_MIME_TYPES = new Set([
  "application/vnd.apache.parquet",
  "application/vnd.apache.arrow.stream",
  "application/vnd.nteract.arrow-stream-manifest+json",
]);

export function selectedOutputMimeType(
  output: JupyterOutput,
  priority: readonly string[] = DEFAULT_PRIORITY,
): string | null {
  if (output.output_type === "execute_result" || output.output_type === "display_data") {
    return selectMimeType(output.data, priority);
  }

  return null;
}

export function isScrollPassthroughMimeType(mimeType: string): boolean {
  return SCROLL_PASSTHROUGH_MIME_TYPES.has(mimeType) || isVegaMimeType(mimeType);
}

export function isSiftMimeType(mimeType: string): boolean {
  return SIFT_MIME_TYPES.has(mimeType);
}

export function outputAllowsScrollPassthrough(
  output: JupyterOutput,
  priority: readonly string[] = DEFAULT_PRIORITY,
): boolean {
  if (output.output_type !== "execute_result" && output.output_type !== "display_data") {
    return true;
  }

  const mimeType = selectedOutputMimeType(output, priority);
  return mimeType !== null && isScrollPassthroughMimeType(mimeType);
}

export function outputUsesSift(
  output: JupyterOutput,
  priority: readonly string[] = DEFAULT_PRIORITY,
): boolean {
  const mimeType = selectedOutputMimeType(output, priority);
  return mimeType !== null && isSiftMimeType(mimeType);
}

export function outputUsesVega(
  output: JupyterOutput,
  priority: readonly string[] = DEFAULT_PRIORITY,
): boolean {
  const mimeType = selectedOutputMimeType(output, priority);
  return mimeType !== null && isVegaMimeType(mimeType);
}

/**
 * Outputs whose iframe must own the wheel once the user engages it: Sift's
 * crossfilter tables scroll internally, Vega/Altair charts pan and zoom. While
 * engaged the wheel-boundary forwarding is locked so the page does not steal
 * the gesture (the source of unintended Altair zoom-while-scrolling).
 */
export function outputUsesWheelOwningFrame(
  output: JupyterOutput,
  priority: readonly string[] = DEFAULT_PRIORITY,
): boolean {
  return outputUsesSift(output, priority) || outputUsesVega(output, priority);
}

export function outputUsesWidget(
  output: JupyterOutput,
  priority: readonly string[] = DEFAULT_PRIORITY,
): boolean {
  const mimeType = selectedOutputMimeType(output, priority);
  return mimeType === "application/vnd.jupyter.widget-view+json";
}

function outputMarkdownCanRenderInHost(
  output: JupyterOutput,
  priority: readonly string[] = DEFAULT_PRIORITY,
): boolean {
  const mimeType = selectedOutputMimeType(output, priority);
  if (output.output_type !== "execute_result" && output.output_type !== "display_data") {
    return false;
  }

  if (mimeType === MARKDOWN_PROJECTION_MIME_TYPE) {
    return canRenderMarkdownProjectionInHost(
      markdownProjectionPlanFromMimeData(output.data[MARKDOWN_PROJECTION_MIME_TYPE]),
    );
  }

  if (mimeType !== "text/markdown") return false;
  const content = output.data["text/markdown"];
  return canRenderMarkdownProjectionInHost(projectMarkdownPlan(String(content ?? "")));
}

export function outputNeedsIsolation(
  output: JupyterOutput,
  priority: readonly string[] = DEFAULT_PRIORITY,
): boolean {
  const mimeType = selectedOutputMimeType(output, priority);
  if (mimeType === "text/markdown" || mimeType === MARKDOWN_PROJECTION_MIME_TYPE) {
    return !outputMarkdownCanRenderInHost(output, priority);
  }
  return mimeType !== null && !isSafeForMainDom(mimeType);
}

export function anyOutputNeedsIsolation(
  outputs: readonly JupyterOutput[],
  priority: readonly string[] = DEFAULT_PRIORITY,
): boolean {
  return outputs.some((output) => outputNeedsIsolation(output, priority));
}

export function hasWidgetOutputs(
  outputs: readonly JupyterOutput[],
  priority: readonly string[] = DEFAULT_PRIORITY,
): boolean {
  return outputs.some((output) => outputUsesWidget(output, priority));
}

export function outputSegmentLane(
  output: JupyterOutput,
  priority: readonly string[] = DEFAULT_PRIORITY,
): OutputLane {
  if (!outputNeedsIsolation(output, priority)) return "dom";
  if (outputUsesSift(output, priority)) return "sift-frame";
  if (outputUsesVega(output, priority)) return "vega-frame";
  if (outputAllowsScrollPassthrough(output, priority)) return "static-frame";
  return "interactive-frame";
}

function laneStandsAlone(lane: OutputLane): boolean {
  // Sift tables and Vega/Altair charts each own their wheel once engaged, so
  // they must never coalesce with neighbors: a shared iframe would lock the
  // wheel boundary over sibling document outputs too.
  return lane === "sift-frame" || lane === "vega-frame";
}

export function splitOutputSegments(
  outputs: readonly JupyterOutput[],
  priority: readonly string[] = DEFAULT_PRIORITY,
): OutputSegment[] {
  const segments: OutputSegment[] = [];

  for (const output of outputs) {
    const lane = outputSegmentLane(output, priority);
    const previous = segments.at(-1);

    if (!laneStandsAlone(lane) && previous && previous.lane === lane) {
      previous.outputs.push(output);
    } else {
      segments.push({ lane, outputs: [output] });
    }
  }

  return segments;
}

export function segmentedOutputLanes(
  outputs: readonly JupyterOutput[],
  {
    isolated = "auto",
    hasCollapseControl = false,
    priority = DEFAULT_PRIORITY,
  }: OutputSegmentationOptions = {},
): OutputSegment[] {
  if (outputs.length <= 1) return [];

  const segments = splitOutputSegments(outputs, priority);
  const hasStandaloneBoundary = segments.some((segment) => laneStandsAlone(segment.lane));
  if (isolated !== "auto" || hasCollapseControl) {
    return hasStandaloneBoundary && segments.length > 1 ? segments : [];
  }

  return segments.length > 1 ? segments : [];
}
