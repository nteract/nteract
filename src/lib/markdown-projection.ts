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
  codeLanguage?: string;
  codeMeta?: string;
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
  imageAlt?: string;
  imageSrc?: string;
  imageTitle?: string;
  inlineId: string;
  listItemIndex: number | null;
  listItemChecked?: boolean;
  listItemDepth?: number;
  listItemOrdered?: boolean;
  listItemPath?: string;
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

export interface MarkdownProjectionSourceMatch {
  block: MarkdownProjectionBlock | null;
  position: number;
  run: MarkdownProjectionRun | null;
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

function normalizeSourcePosition(plan: MarkdownProjectionPlan, position: number): number {
  if (!Number.isFinite(position)) return 0;
  return Math.min(plan.utf16Length, Math.max(0, position));
}

function spanContainsPosition(
  span: [number, number],
  position: number,
): boolean {
  const [start, end] = span;
  if (start === end) return position === start;
  return position >= start && position <= end;
}

function spanLength(span: [number, number]): number {
  return Math.max(0, span[1] - span[0]);
}

export function findMarkdownProjectionAtSourcePosition(
  plan: MarkdownProjectionPlan | null,
  position: number,
): MarkdownProjectionSourceMatch | null {
  if (!plan) return null;

  const normalizedPosition = normalizeSourcePosition(plan, position);
  const block =
    plan.blocks.find((candidate) =>
      spanContainsPosition(candidate.sourceSpanUtf16, normalizedPosition),
    ) ?? null;
  const runCandidates = plan.runs.filter((candidate) =>
    spanContainsPosition(candidate.sourceSpanUtf16, normalizedPosition),
  );
  const run =
    runCandidates.sort((left, right) => {
      const lengthDelta =
        spanLength(left.sourceSpanUtf16) - spanLength(right.sourceSpanUtf16);
      if (lengthDelta !== 0) return lengthDelta;
      return left.sourceSpanUtf16[0] - right.sourceSpanUtf16[0];
    })[0] ?? null;

  return { block, position: normalizedPosition, run };
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
