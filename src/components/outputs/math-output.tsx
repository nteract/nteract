import katex from "katex";
import { useEffect, useRef } from "react";
import { katexStrict } from "@/lib/katex-options";
import { cn } from "@/lib/utils";

import "katex/dist/katex.min.css";

interface MathOutputProps {
  /** Raw LaTeX string, possibly wrapped in $...$ or $$...$$ delimiters */
  content: string;
  className?: string;
  /**
   * KaTeX trust enables commands such as \href and \html*. Keep it disabled
   * in the host DOM; isolated renderers may opt in inside their sandbox.
   */
  trust?: boolean;
}

/**
 * Strip $/$$ delimiters and detect display mode.
 * Sympy wraps in `$\displaystyle ...$`, other CAS may use `$$...$$`.
 * Raw LaTeX without delimiters defaults to display mode.
 */
function parseLatex(raw: string): { latex: string; displayMode: boolean } {
  const trimmed = raw.trim();
  if (trimmed.startsWith("$$") && trimmed.endsWith("$$")) {
    return { latex: trimmed.slice(2, -2).trim(), displayMode: true };
  }
  if (trimmed.startsWith("$") && trimmed.endsWith("$")) {
    return { latex: trimmed.slice(1, -1).trim(), displayMode: true };
  }
  return { latex: trimmed, displayMode: true };
}

/**
 * Renders a `text/latex` MIME output using KaTeX.
 *
 * Used for display_data / execute_result from CAS kernels (sympy, Sage, etc.).
 * Host renderers keep KaTeX trust disabled; iframe renderers can opt into
 * trusted commands inside the sandbox.
 */
export function MathOutput({ content, className, trust = false }: MathOutputProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current || !content.trim()) return;
    const { latex, displayMode } = parseLatex(content);
    katex.render(latex, ref.current, {
      displayMode,
      strict: katexStrict,
      throwOnError: false,
      trust,
    });
  }, [content, trust]);

  return <div data-slot="math-output" className={cn("py-1", className)} ref={ref} />;
}
