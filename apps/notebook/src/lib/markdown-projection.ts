import { project_markdown_json } from "../wasm/runtimed-wasm/runtimed_wasm.js";

export interface MarkdownProjectionMeasurement {
  estimatedHeight: number;
  confidence: "low" | "medium" | "high" | string;
  width: number;
}

export interface MarkdownProjectionPlan {
  version: 1;
  engine: string;
  byteLength: number;
  utf16Length: number;
  error?: string;
  measurement: MarkdownProjectionMeasurement;
  blocks: unknown[];
  runs: unknown[];
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
