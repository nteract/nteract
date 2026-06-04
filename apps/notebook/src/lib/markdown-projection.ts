import { project_markdown_json } from "../wasm/runtimed-wasm/runtimed_wasm.js";

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

export function projectMarkdownPlan(source: string): MarkdownProjectionPlan | null {
  if (!source.trim()) return null;

  try {
    const json = project_markdown_json(source);
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
