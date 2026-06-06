import { project_markdown_json } from "../../apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm.js";

export const MARKDOWN_PROJECTION_MIME_TYPE =
  "application/vnd.nteract.markdown+json";

type MarkdownProjectionProjector = (source: string) => string;

const MARKDOWN_PROJECTION_CACHE_LIMIT = 128;

let markdownProjectionProjector: MarkdownProjectionProjector = project_markdown_json;
const markdownProjectionCache = new Map<string, MarkdownProjectionPlan>();

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

export interface MarkdownProjectionAnchor {
  anchorId: string;
  blockId: string;
  level: number;
  slug: string;
  sourceSpanByte: [number, number];
  sourceSpanUtf16: [number, number];
  title: string;
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
  anchors: MarkdownProjectionAnchor[];
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
  markdownProjectionCache.clear();
  return () => {
    markdownProjectionProjector = previousProjector;
    markdownProjectionCache.clear();
  };
}

export function projectMarkdownPlan(source: string): MarkdownProjectionPlan | null {
  if (!source.trim()) return null;
  const cached = markdownProjectionCache.get(source);
  if (cached) {
    markdownProjectionCache.delete(source);
    markdownProjectionCache.set(source, cached);
    return cached;
  }

  try {
    const json = markdownProjectionProjector(source);
    const plan = normalizeMarkdownProjectionPlan(JSON.parse(json) as MarkdownProjectionPlan);
    if (plan.error) {
      return null;
    }
    return cacheMarkdownProjectionPlan(source, plan);
  } catch {
    return null;
  }
}

function cacheMarkdownProjectionPlan(
  source: string,
  plan: MarkdownProjectionPlan,
): MarkdownProjectionPlan {
  const cachedPlan = freezeMarkdownProjectionPlan(plan);
  markdownProjectionCache.set(source, cachedPlan);
  if (markdownProjectionCache.size <= MARKDOWN_PROJECTION_CACHE_LIMIT) return cachedPlan;

  const oldestSource = markdownProjectionCache.keys().next().value;
  if (oldestSource !== undefined) {
    markdownProjectionCache.delete(oldestSource);
  }
  return cachedPlan;
}

function freezeMarkdownProjectionPlan(plan: MarkdownProjectionPlan): MarkdownProjectionPlan {
  Object.freeze(plan.anchors);
  Object.freeze(plan.blocks);
  Object.freeze(plan.runs);
  Object.freeze(plan);
  return plan;
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
  return plan != null;
}

export function markdownProjectionPlanFromMimeData(data: unknown): MarkdownProjectionPlan | null {
  if (data == null || typeof data !== "object") return null;

  const plan = data as MarkdownProjectionPlan;
  if (plan.version !== 1 || !Array.isArray(plan.blocks) || !Array.isArray(plan.runs)) {
    return null;
  }

  return normalizeMarkdownProjectionPlan(plan);
}

function normalizeMarkdownProjectionPlan(plan: MarkdownProjectionPlan): MarkdownProjectionPlan {
  if (Array.isArray(plan.anchors)) return plan;
  return { ...plan, anchors: [] };
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
