/**
 * HTMLMath widget - renders HTML content with LaTeX math support.
 *
 * Maps to ipywidgets HTMLMathModel.
 * Uses KaTeX to render math expressions in $...$ and $$...$$ delimiters.
 */

import "katex/dist/katex.min.css";

import katex from "katex";
import { Label } from "@/components/ui/label";
import { katexStrict } from "@/lib/katex-options";
import { cn } from "@/lib/utils";
import type { WidgetComponentProps } from "../widget-registry";
import { useWidgetModelValue } from "../widget-store-context";

// Process math in content using KaTeX
function processMath(content: string): string {
  // Process display math ($$...$$)
  let processed = content.replace(/\$\$([\s\S]*?)\$\$/g, (_, math) => {
    try {
      return katex.renderToString(math.trim(), {
        displayMode: true,
        strict: katexStrict,
        throwOnError: false,
      });
    } catch {
      return `$$${math}$$`;
    }
  });

  // Process inline math ($...$)
  processed = processed.replace(/\$([^$\n]+?)\$/g, (_, math) => {
    try {
      return katex.renderToString(math.trim(), {
        displayMode: false,
        strict: katexStrict,
        throwOnError: false,
      });
    } catch {
      return `$${math}$`;
    }
  });

  return processed;
}

export function HTMLMathWidget({ modelId, className }: WidgetComponentProps) {
  const value = useWidgetModelValue<string>(modelId, "value") ?? "";
  const description = useWidgetModelValue<string>(modelId, "description");
  const placeholder = useWidgetModelValue<string>(modelId, "placeholder");

  // Show placeholder if value is empty
  const displayValue = value || placeholder || "";

  // Process content for math rendering
  const processedContent = displayValue ? processMath(displayValue) : "";

  return (
    <div
      className={cn("inline-flex shrink-0 items-baseline gap-1", className)}
      data-widget-id={modelId}
      data-widget-type="HTMLMath"
    >
      {description && <Label className="shrink-0 text-sm">{description}</Label>}
      <div
        className="widget-html-math-content"
        dangerouslySetInnerHTML={{ __html: processedContent }}
      />
    </div>
  );
}

export default HTMLMathWidget;
