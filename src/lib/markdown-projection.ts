import { project_markdown_json } from "../../apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm.js";

export const MARKDOWN_PROJECTION_MIME_TYPE =
  "application/vnd.nteract.markdown+json";

type MarkdownProjectionProjector = (source: string) => string;

const MARKDOWN_PROJECTION_CACHE_LIMIT = 128;

let markdownProjectionProjector: MarkdownProjectionProjector = project_markdown_json;
const markdownProjectionCache = new Map<string, MarkdownProjectionPlan>();

export interface MarkdownProjectionMeasurement {
  readonly estimatedHeight: number;
  readonly confidence: "low" | "medium" | "high" | string;
  readonly width: number;
}

export interface MarkdownProjectionBlock {
  readonly anchorSlug?: string;
  readonly blockId: string;
  readonly blockIndex: number;
  readonly codeLanguage?: string;
  readonly codeMeta?: string;
  readonly element: string;
  readonly kind: string;
  readonly measurement: MarkdownProjectionMeasurement & { readonly basis?: string };
  readonly ordered?: boolean;
  readonly sourceSpanByte: readonly [number, number];
  readonly sourceSpanUtf16: readonly [number, number];
  readonly syntaxSpans: readonly unknown[];
  readonly text: string;
}

export interface MarkdownProjectionAnchor {
  readonly anchorId: string;
  readonly blockId: string;
  readonly level: number;
  readonly slug: string;
  readonly sourceSpanByte: readonly [number, number];
  readonly sourceSpanUtf16: readonly [number, number];
  readonly title: string;
}

export interface MarkdownProjectionRun {
  readonly blockId: string;
  readonly imageAlt?: string;
  readonly imageSrc?: string;
  readonly imageTitle?: string;
  readonly inlineId: string;
  readonly listItemIndex: number | null;
  readonly listItemChecked?: boolean;
  readonly listItemDepth?: number;
  readonly listItemOrdered?: boolean;
  readonly listItemPath?: string;
  readonly href?: string;
  readonly title?: string;
  readonly renderedHtml?: string;
  readonly renderedText: string;
  readonly renderedTextUtf16: readonly [number, number];
  readonly semantic: string;
  readonly sourceSpanByte: readonly [number, number];
  readonly sourceSpanUtf16: readonly [number, number];
  readonly tableCellAlign?: "none" | "left" | "right" | "center" | string;
  readonly tableCellHeader?: boolean;
  readonly tableCellIndex?: number;
  readonly tableRowIndex?: number;
}

export interface MarkdownProjectionPlan {
  readonly version: 1;
  readonly engine: string;
  readonly byteLength: number;
  readonly utf16Length: number;
  readonly error?: string;
  readonly measurement: MarkdownProjectionMeasurement;
  readonly anchors: readonly MarkdownProjectionAnchor[];
  readonly blocks: readonly MarkdownProjectionBlock[];
  readonly runs: readonly MarkdownProjectionRun[];
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
  Object.freeze(plan.measurement);
  for (const anchor of plan.anchors) {
    Object.freeze(anchor);
  }
  for (const block of plan.blocks) {
    Object.freeze(block.measurement);
    Object.freeze(block.syntaxSpans);
    Object.freeze(block);
  }
  for (const run of plan.runs) {
    Object.freeze(run);
  }
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
  span: readonly [number, number],
  position: number,
): boolean {
  const [start, end] = span;
  if (start === end) return position === start;
  return position >= start && position <= end;
}

function spanLength(span: readonly [number, number]): number {
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
