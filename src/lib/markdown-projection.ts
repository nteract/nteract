import { project_markdown_json } from "../../apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm.js";

export const MARKDOWN_PROJECTION_MIME_TYPE =
  "application/vnd.nteract.markdown+json";

type MarkdownProjectionProjector = (source: string) => string;

let markdownProjectionProjector: MarkdownProjectionProjector = project_markdown_json;

export interface MarkdownProjectionMeasurement {
  estimatedHeight: number;
  confidence: "low" | "medium" | "high" | string;
  width: number;
}

export interface MarkdownProjectionBlock {
  anchorSlug?: string;
  blockId: string;
  blockIndex: number;
  element: string;
  kind: string;
  measurement: MarkdownProjectionMeasurement & { basis?: string };
  ordered?: boolean;
  sourceSpanByte: [number, number];
  sourceSpanUtf16: [number, number];
  syntaxSpans: unknown[];
  text: string;
}

export interface MarkdownProjectionRun {
  blockId: string;
  inlineId: string;
  listItemIndex: number | null;
  listItemChecked?: boolean;
  href?: string;
  title?: string;
  renderedHtml?: string;
  renderedText: string;
  renderedTextUtf16: [number, number];
  semantic: string;
  sourceSpanByte: [number, number];
  sourceSpanUtf16: [number, number];
  tableCellAlign?: "none" | "left" | "right" | "center" | string;
  tableCellHeader?: boolean;
  tableCellIndex?: number;
  tableRowIndex?: number;
}

export interface MarkdownProjectionPlan {
  version: 1;
  engine: string;
  byteLength: number;
  utf16Length: number;
  error?: string;
  measurement: MarkdownProjectionMeasurement;
  blocks: MarkdownProjectionBlock[];
  runs: MarkdownProjectionRun[];
}

export function setMarkdownProjectionProjector(
  projector: MarkdownProjectionProjector,
): () => void {
  const previousProjector = markdownProjectionProjector;
  markdownProjectionProjector = projector;
  return () => {
    markdownProjectionProjector = previousProjector;
  };
}

export function projectMarkdownPlan(source: string): MarkdownProjectionPlan | null {
  if (!source.trim()) return null;

  try {
    const json = markdownProjectionProjector(source);
    const plan = JSON.parse(json) as MarkdownProjectionPlan;
    if (plan.error) {
      return null;
    }
    return plan;
  } catch {
    return null;
  }
}

export function canRenderMarkdownProjectionInHost(plan: MarkdownProjectionPlan | null): boolean {
  if (!plan) return false;

  return (
    plan.blocks.every((block) => block.kind !== "isolated") &&
    plan.runs.every((run) => !run.renderedHtml)
  );
}

export function markdownProjectionPlanFromMimeData(data: unknown): MarkdownProjectionPlan | null {
  if (data == null || typeof data !== "object") return null;

  const plan = data as MarkdownProjectionPlan;
  if (plan.version !== 1 || !Array.isArray(plan.blocks) || !Array.isArray(plan.runs)) {
    return null;
  }

  return plan;
}

export function projectedMarkdownPreviewHeight(
  plan: MarkdownProjectionPlan | null,
  fallbackHeight: number,
  options: { minHeight: number; maxHeight: number },
): number {
  const projectedHeight = plan?.measurement.estimatedHeight;
  if (!Number.isFinite(projectedHeight) || projectedHeight == null || projectedHeight <= 0) {
    return fallbackHeight;
  }

  return Math.min(options.maxHeight, Math.max(options.minHeight, projectedHeight));
}
