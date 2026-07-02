import { Fragment, type ReactNode } from "react";
import { Code } from "lucide-react";
import { ExecutionCount } from "@/components/cell/ExecutionCount";

export type NotebookCellStripPreviewEntry =
  | {
      kind: "markdown";
      text: string;
    }
  | {
      kind: "code";
      text: string;
      execution_count?: number;
    };

export interface NotebookCellStripProps {
  preview: NotebookCellStripPreviewEntry[];
  thumbnail?: { src: string; alt?: string } | null;
  className?: string;
}

/**
 * Renders a notebook's content preview as a mini cell strip: a prose line from
 * the first markdown cell, the closing line of the last code cell (with its
 * execution count), and the notebook's rendered output thumbnail. Preview text
 * is untrusted cell source - it renders exclusively as React text nodes (the
 * mini markdown parser emits elements, never HTML), so markup in a cell's
 * source stays inert.
 */
export function NotebookCellStrip({ preview, thumbnail, className }: NotebookCellStripProps) {
  if (preview.length === 0 && !thumbnail) {
    return null;
  }

  return (
    <div className={["nb-cellstrip", className].filter(Boolean).join(" ")}>
      {preview.map((entry, index) =>
        entry.kind === "markdown" ? (
          <div key={`markdown-${index}`} className="nb-cellrow nb-cellrow-md">
            <span className="nb-cellribbon" data-ct="markdown" />
            <div className="nb-md-preview">{renderMiniMarkdown(entry.text)}</div>
          </div>
        ) : (
          <div key={`code-${index}`} className="nb-cellrow" data-ct="code">
            <span className="nb-cellribbon" data-ct="code" />
            <span className="nb-cellgutter">
              {entry.execution_count ? (
                <ExecutionCount count={entry.execution_count} className="nb-cell-exec" />
              ) : (
                <Code aria-hidden="true" size={13} strokeWidth={1.8} />
              )}
            </span>
            <code className="nb-cellcode">{entry.text}</code>
          </div>
        ),
      )}
      {thumbnail ? (
        <div className="nb-cellout">
          <span className="nb-output-img">
            <img src={thumbnail.src} alt={thumbnail.alt ?? ""} loading="lazy" />
          </span>
        </div>
      ) : null}
    </div>
  );
}

function renderMiniMarkdown(text: string): ReactNode {
  const heading = text.match(/^(#{1,6})\s+(.*)$/u);
  if (heading) {
    return (
      <span className="nb-md-h" data-lvl={heading[1]?.length}>
        {heading[2]}
      </span>
    );
  }

  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/gu).filter(Boolean);
  return (
    <span className="nb-md-p">
      {parts.map((part, index) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={index}>{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code key={index} className="nb-md-code">
              {part.slice(1, -1)}
            </code>
          );
        }
        return <Fragment key={index}>{part}</Fragment>;
      })}
    </span>
  );
}
