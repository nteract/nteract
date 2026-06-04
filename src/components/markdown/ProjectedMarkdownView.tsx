import { Check, Copy } from "lucide-react";
import { Fragment, useState, type CSSProperties } from "react";
import katex from "katex";
import { StaticCodeBlock } from "@/components/editor/static-highlight";
import type {
  MarkdownProjectionBlock,
  MarkdownProjectionPlan,
  MarkdownProjectionRun,
} from "@/lib/markdown-projection";
import { useColorTheme, useDarkMode } from "@/lib/dark-mode";
import { katexStrict } from "@/lib/katex-options";
import { cn } from "@/lib/utils";
import type { MarkdownHeadingAnchor } from "@/components/outputs/markdown-heading-anchors";

import "katex/dist/katex.min.css";

interface ProjectedMarkdownViewProps {
  plan: MarkdownProjectionPlan;
  className?: string;
  headingAnchors?: readonly MarkdownHeadingAnchor[];
  onLinkClick?: (url: string) => void;
}

export function ProjectedMarkdownView({
  plan,
  className,
  headingAnchors = [],
  onLinkClick,
}: ProjectedMarkdownViewProps) {
  const isDark = useDarkMode();
  const rawTheme = useColorTheme();
  const colorTheme = (rawTheme === "cream" ? "cream" : "classic") as "classic" | "cream";
  const runsByBlock = new Map<string, MarkdownProjectionRun[]>();
  for (const run of plan.runs) {
    const runs = runsByBlock.get(run.blockId);
    if (runs) {
      runs.push(run);
    } else {
      runsByBlock.set(run.blockId, [run]);
    }
  }

  return (
    <div
      data-slot="projected-markdown-output"
      className={cn(
        "select-text py-2 text-base leading-[1.65] text-foreground font-[var(--output-document-font)] [text-rendering:optimizeLegibility]",
        className,
      )}
    >
      {plan.blocks.map((block) => (
        <ProjectedMarkdownBlock
          key={block.blockId}
          block={block}
          headingAnchor={headingAnchorForBlock(block, headingAnchors)}
          colorTheme={colorTheme}
          isDark={isDark}
          runs={runsByBlock.get(block.blockId) ?? []}
          onLinkClick={onLinkClick}
        />
      ))}
    </div>
  );
}

interface ProjectedMarkdownBlockProps {
  block: MarkdownProjectionBlock;
  headingAnchor?: MarkdownHeadingAnchor;
  colorTheme: "classic" | "cream";
  isDark: boolean;
  runs: MarkdownProjectionRun[];
  onLinkClick?: (url: string) => void;
}

function ProjectedMarkdownBlock({
  block,
  headingAnchor,
  colorTheme,
  isDark,
  runs,
  onLinkClick,
}: ProjectedMarkdownBlockProps) {
  if (block.kind === "heading") {
    const Heading = headingTag(block.element);
    return (
      <Heading
        id={headingAnchor?.headingAnchorId}
        data-nteract-heading-anchor={headingAnchor?.headingAnchorId}
        data-nteract-outline-item-id={headingAnchor?.itemId}
        className={headingClass(block.element)}
      >
        {renderRuns(runs, onLinkClick)}
      </Heading>
    );
  }

  if (block.kind === "list") {
    const items = groupListRuns(runs);
    const List = block.ordered || block.element === "ol" ? "ol" : "ul";
    return (
      <List
        className={cn(
          "my-2 pl-6",
          List === "ol" ? "list-decimal" : "list-disc",
          items.some(({ checked }) => checked !== undefined) && "list-none pl-0",
        )}
      >
        {items.map(({ checked, key, runs }) => (
          <li
            key={key}
            className={cn("my-1", checked !== undefined && "flex min-w-0 items-baseline gap-2")}
          >
            {checked !== undefined ? (
              <input
                type="checkbox"
                checked={checked}
                readOnly
                tabIndex={-1}
                className="translate-y-0.5 accent-primary"
                aria-label={checked ? "Completed task" : "Incomplete task"}
              />
            ) : null}
            <span className="min-w-0">{renderRuns(runs, onLinkClick)}</span>
          </li>
        ))}
      </List>
    );
  }

  if (block.kind === "code") {
    return <ProjectedCodeBlock code={block.text} colorTheme={colorTheme} isDark={isDark} />;
  }

  if (block.kind === "math") {
    return <ProjectedMath latex={block.text} displayMode />;
  }

  if (block.kind === "blockquote") {
    return (
      <blockquote className="my-4 border-l-4 border-border pl-4 text-muted-foreground italic">
        {renderRuns(runs, onLinkClick)}
      </blockquote>
    );
  }

  if (block.kind === "thematic-break") {
    return <hr className="my-6 border-border" />;
  }

  if (block.kind === "table") {
    return <ProjectedTable runs={runs} fallbackText={block.text} onLinkClick={onLinkClick} />;
  }

  if (block.kind === "paragraph") {
    return <p className="my-2 leading-relaxed">{renderRuns(runs, onLinkClick)}</p>;
  }

  return block.text ? <div className="my-3">{renderRuns(runs, onLinkClick)}</div> : null;
}

function headingAnchorForBlock(
  block: MarkdownProjectionBlock,
  headingAnchors: readonly MarkdownHeadingAnchor[],
): MarkdownHeadingAnchor | undefined {
  if (block.kind !== "heading") return undefined;

  return headingAnchors.find((anchor) => {
    if (block.anchorSlug && anchor.anchor === block.anchorSlug) return true;
    return anchor.title === block.text && `h${anchor.level}` === block.element;
  });
}

function headingTag(element: string): "h1" | "h2" | "h3" | "h4" | "h5" | "h6" {
  if (element === "h1") return "h1";
  if (element === "h2") return "h2";
  if (element === "h3") return "h3";
  if (element === "h4") return "h4";
  if (element === "h5") return "h5";
  return "h6";
}

function headingClass(element: string) {
  if (element === "h1") return "mt-6 mb-4 text-2xl leading-tight font-bold";
  if (element === "h2") return "mt-5 mb-3 text-xl leading-tight font-bold";
  if (element === "h3") return "mt-4 mb-2 text-lg leading-tight font-semibold";
  if (element === "h4") return "mt-3 mb-2 text-base leading-tight font-semibold";
  if (element === "h5") return "mt-2 mb-1 text-sm leading-tight font-semibold";
  return "mt-2 mb-1 text-sm leading-tight font-medium text-muted-foreground";
}

function groupListRuns(runs: MarkdownProjectionRun[]) {
  const groups = new Map<number, MarkdownProjectionRun[]>();
  for (const run of runs) {
    const itemIndex = run.listItemIndex ?? 0;
    const group = groups.get(itemIndex);
    if (group) {
      group.push(run);
    } else {
      groups.set(itemIndex, [run]);
    }
  }

  return Array.from(groups, ([key, runs]) => ({
    checked: runs.find((run) => run.listItemChecked !== undefined)?.listItemChecked,
    key,
    runs,
  }));
}

function ProjectedTable({
  fallbackText,
  onLinkClick,
  runs,
}: {
  fallbackText: string;
  onLinkClick?: (url: string) => void;
  runs: MarkdownProjectionRun[];
}) {
  const rows = groupTableRuns(runs);
  if (rows.length === 0) {
    return (
      <pre className="my-2 overflow-x-auto rounded bg-muted px-3 py-2 font-mono text-sm leading-relaxed whitespace-pre-wrap">
        {fallbackText}
      </pre>
    );
  }

  const [headerRow, ...bodyRows] = rows;
  const hasHeader = headerRow?.cells.some((cell) => cell.header);

  return (
    <div className="my-4 overflow-x-auto">
      <table className="min-w-full border-collapse border border-border text-sm">
        {hasHeader ? (
          <thead>
            <tr>
              {headerRow.cells.map((cell) => (
                <th
                  key={cell.key}
                  className="border border-border bg-muted px-3 py-2 font-semibold"
                  style={tableCellStyle(cell.align)}
                >
                  {renderRuns(cell.runs, onLinkClick)}
                </th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {(hasHeader ? bodyRows : rows).map((row) => (
            <tr key={row.key}>
              {row.cells.map((cell) => (
                <td
                  key={cell.key}
                  className="border border-border px-3 py-2 align-top"
                  style={tableCellStyle(cell.align)}
                >
                  {renderRuns(cell.runs, onLinkClick)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function groupTableRuns(runs: MarkdownProjectionRun[]) {
  const rows = new Map<number, Map<number, MarkdownProjectionRun[]>>();
  for (const run of runs) {
    const rowIndex = run.tableRowIndex ?? 0;
    const cellIndex = run.tableCellIndex ?? 0;
    let row = rows.get(rowIndex);
    if (!row) {
      row = new Map<number, MarkdownProjectionRun[]>();
      rows.set(rowIndex, row);
    }
    const cell = row.get(cellIndex);
    if (cell) {
      cell.push(run);
    } else {
      row.set(cellIndex, [run]);
    }
  }

  return Array.from(rows, ([rowIndex, cells]) => ({
    key: rowIndex,
    cells: Array.from(cells, ([cellIndex, runs]) => ({
      align: runs.find((run) => run.tableCellAlign)?.tableCellAlign,
      header: runs.some((run) => run.tableCellHeader),
      key: `${rowIndex}:${cellIndex}`,
      runs,
    })),
  }));
}

function tableCellStyle(align: MarkdownProjectionRun["tableCellAlign"]): CSSProperties | undefined {
  if (align === "right" || align === "center" || align === "left") {
    return { textAlign: align };
  }

  return undefined;
}

function renderRuns(runs: MarkdownProjectionRun[], onLinkClick?: (url: string) => void) {
  if (runs.length === 0) return null;

  return runs.map((run) => <Fragment key={run.inlineId}>{renderRun(run, onLinkClick)}</Fragment>);
}

function renderRun(run: MarkdownProjectionRun, onLinkClick?: (url: string) => void) {
  const text = run.renderedText;
  if (!text) return null;

  if (run.href) {
    return (
      <a
        href={run.href}
        title={run.title}
        className="text-primary underline-offset-2 hover:underline"
        onClick={(event) => {
          event.preventDefault();
          onLinkClick?.(run.href ?? "");
        }}
      >
        {text}
      </a>
    );
  }

  if (run.semantic === "strong") return <strong>{text}</strong>;
  if (run.semantic === "emphasis") return <em>{text}</em>;
  if (run.semantic === "delete") return <del>{text}</del>;
  if (run.semantic === "inline-code") {
    return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.92em]">{text}</code>;
  }
  if (run.semantic === "math-source") return <ProjectedMath latex={text} />;
  if (run.semantic === "code-block") return text;
  if (run.semantic === "link-label") return text;

  return text;
}

function ProjectedCodeBlock({
  code,
  colorTheme,
  isDark,
}: {
  code: string;
  colorTheme: "classic" | "cream";
  isDark: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (error) {
      console.error("Failed to copy projected markdown code block:", error);
    }
  };

  return (
    <div className="group/codeblock relative my-3">
      <StaticCodeBlock code={code} colorTheme={colorTheme} isDark={isDark} className="max-w-full" />
      <button
        type="button"
        className="absolute top-2 right-2 z-10 rounded border border-border bg-background p-1.5 text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover/codeblock:opacity-100 hover:bg-muted hover:text-foreground"
        title={copied ? "Copied" : "Copy code"}
        onClick={copyCode}
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </button>
    </div>
  );
}

function ProjectedMath({ displayMode = false, latex }: { displayMode?: boolean; latex: string }) {
  const html = renderLatex(latex, displayMode);
  if (!html) {
    return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.92em]">{latex}</code>;
  }

  return (
    <span
      className={cn(displayMode ? "my-4 block overflow-x-auto" : "inline-block align-baseline")}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function renderLatex(latex: string, displayMode: boolean): string | null {
  try {
    return katex.renderToString(latex.trim(), {
      displayMode,
      strict: katexStrict,
      throwOnError: false,
      trust: true,
    });
  } catch {
    return null;
  }
}
