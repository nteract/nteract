/**
 * Markdown Renderer Plugin
 *
 * On-demand renderer plugin for plain and projected Markdown outputs. Loaded into the
 * isolated iframe via the renderer plugin API (CJS module with install()).
 *
 * This is NOT part of the core isolated renderer bundle — it's built
 * separately and injected on-demand when markdown outputs are needed.
 */

import { MarkdownOutput } from "@/components/outputs/markdown-output";
import { MathOutput } from "@/components/outputs/math-output";
import { markdownHeadingAnchorsFromMetadata } from "@/components/outputs/markdown-heading-anchors";
import { ProjectedMarkdownView } from "@/components/markdown/ProjectedMarkdownView";
import {
  MARKDOWN_PROJECTION_MIME_TYPE,
  markdownProjectionPlanFromMimeData,
} from "@/lib/markdown-projection";

interface RendererProps {
  data: unknown;
  metadata?: Record<string, unknown>;
  mimeType: string;
}

function MarkdownRenderer({ data, metadata }: RendererProps) {
  return (
    <MarkdownOutput
      content={String(data)}
      headingAnchors={markdownHeadingAnchorsFromMetadata(metadata)}
    />
  );
}

function LatexRenderer({ data }: RendererProps) {
  return <MathOutput content={String(data)} trust />;
}

function ProjectedMarkdownRenderer({ data, metadata }: RendererProps) {
  const plan = markdownProjectionPlanFromMimeData(data);
  if (!plan) return <div role="alert">Unable to render invalid Markdown output.</div>;
  return (
    <ProjectedMarkdownView
      plan={plan}
      headingAnchors={markdownHeadingAnchorsFromMetadata(metadata)}
    />
  );
}

export function install(ctx: {
  register: (mimeTypes: string[], component: React.ComponentType<RendererProps>) => void;
}) {
  ctx.register(["text/markdown"], MarkdownRenderer);
  ctx.register([MARKDOWN_PROJECTION_MIME_TYPE], ProjectedMarkdownRenderer);
  ctx.register(["text/latex"], LatexRenderer);
}
