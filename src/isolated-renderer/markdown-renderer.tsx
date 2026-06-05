/**
 * Markdown Renderer Plugin
 *
 * On-demand renderer plugin for text/markdown outputs. Loaded into the
 * isolated iframe via the renderer plugin API (CJS module with install()).
 *
 * This is NOT part of the core isolated renderer bundle — it's built
 * separately and injected on-demand when markdown outputs are needed.
 */

import { MarkdownOutput } from "@/components/outputs/markdown-output";
import { MathOutput } from "@/components/outputs/math-output";
import { markdownHeadingAnchorsFromMetadata } from "@/components/outputs/markdown-heading-anchors";

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

export function install(ctx: {
  register: (mimeTypes: string[], component: React.ComponentType<RendererProps>) => void;
}) {
  ctx.register(["text/markdown"], MarkdownRenderer);
  ctx.register(["text/latex"], LatexRenderer);
}
