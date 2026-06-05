import { Check, Copy } from "lucide-react";
import { Fragment, useState, type CSSProperties, type ReactNode } from "react";
import katex from "katex";
import { StaticCodeBlock } from "@/components/editor/static-highlight";
import type {
  MarkdownProjectionBlock,
  MarkdownProjectionPlan,
  MarkdownProjectionRun,
} from "../../lib/markdown-projection";
import { findMarkdownProjectionAtSourcePosition } from "../../lib/markdown-projection";
import { useColorTheme, useDarkMode } from "@/lib/dark-mode";
import { katexStrict } from "@/lib/katex-options";
import { cn } from "@/lib/utils";
import type { MarkdownHeadingAnchor } from "@/components/outputs/markdown-heading-anchors";

import "katex/dist/katex.min.css";

interface ProjectedMarkdownViewProps {
  plan: MarkdownProjectionPlan;
  className?: string;
  activeSourcePosition?: number;
  headingAnchors?: readonly MarkdownHeadingAnchor[];
  onLinkClick?: (url: string) => void;
  onTaskCheckedChange?: (run: MarkdownProjectionRun, checked: boolean) => void;
}

export function ProjectedMarkdownView({
  plan,
  className,
  activeSourcePosition,
  headingAnchors = [],
  onLinkClick,
  onTaskCheckedChange,
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
  const sourceMatch =
    activeSourcePosition == null
      ? null
      : findMarkdownProjectionAtSourcePosition(plan, activeSourcePosition);
  const activeBlockId = sourceMatch?.block?.blockId;
  const activeInlineId = sourceMatch?.run?.inlineId;

  return (
    <div
      data-slot="projected-markdown-output"
      className={cn(
        "not-prose select-text py-2 text-base leading-[1.65] text-foreground font-[var(--output-document-font)] [font-kerning:normal] [text-rendering:optimizeLegibility] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_kbd]:rounded-sm [&_kbd]:border [&_kbd]:border-border [&_kbd]:bg-muted/60 [&_kbd]:px-1.5 [&_kbd]:py-0.5 [&_kbd]:font-[var(--output-ui-font)] [&_kbd]:text-[0.82em] [&_mark]:rounded-sm [&_mark]:bg-amber-200/70 [&_mark]:px-1 dark:[&_mark]:bg-amber-500/25 [&_sub]:text-[0.75em] [&_sup]:text-[0.75em]",
        className,
      )}
    >
      {plan.blocks.map((block) => (
        <ProjectedMarkdownBlock
          key={block.blockId}
          block={block}
          headingAnchor={headingAnchorForBlock(block, headingAnchors)}
          activeBlockId={activeBlockId}
          activeInlineId={activeInlineId}
          colorTheme={colorTheme}
          isDark={isDark}
          runs={runsByBlock.get(block.blockId) ?? []}
          onLinkClick={onLinkClick}
          onTaskCheckedChange={onTaskCheckedChange}
        />
      ))}
    </div>
  );
}

interface ProjectedMarkdownBlockProps {
  block: MarkdownProjectionBlock;
  headingAnchor?: MarkdownHeadingAnchor;
  activeBlockId?: string;
  activeInlineId?: string;
  colorTheme: "classic" | "cream";
  isDark: boolean;
  runs: MarkdownProjectionRun[];
  onLinkClick?: (url: string) => void;
  onTaskCheckedChange?: (run: MarkdownProjectionRun, checked: boolean) => void;
}

function ProjectedMarkdownBlock({
  block,
  headingAnchor,
  activeBlockId,
  activeInlineId,
  colorTheme,
  isDark,
  runs,
  onLinkClick,
  onTaskCheckedChange,
}: ProjectedMarkdownBlockProps) {
  if (block.kind === "heading") {
    const Heading = headingTag(block.element);
    return (
      <Heading
        id={headingAnchor?.headingAnchorId}
        data-nteract-heading-anchor={headingAnchor?.headingAnchorId}
        data-nteract-outline-item-id={headingAnchor?.itemId}
        data-source-active={activeBlockId === block.blockId ? "true" : undefined}
        className={cn(
          headingClass(block.element),
          activeBlockId === block.blockId && sourceActiveBlockClass,
        )}
      >
        {renderRuns(runs, onLinkClick, activeInlineId)}
      </Heading>
    );
  }

  if (block.kind === "list") {
    const items = groupListRuns(runs);
    const ordered = block.ordered || block.element === "ol";
    return (
      <ProjectedList
        items={items}
        activeBlock={activeBlockId === block.blockId}
        activeInlineId={activeInlineId}
        ordered={ordered}
        onLinkClick={onLinkClick}
        onTaskCheckedChange={onTaskCheckedChange}
      />
    );
  }

  if (block.kind === "code") {
    return (
      <div
        data-source-active={activeBlockId === block.blockId ? "true" : undefined}
        className={cn(activeBlockId === block.blockId && sourceActiveBlockClass)}
      >
        <ProjectedCodeBlock
          code={block.text}
          colorTheme={colorTheme}
          isDark={isDark}
          language={block.codeLanguage}
        />
      </div>
    );
  }

  if (block.kind === "math") {
    return (
      <div
        data-source-active={activeBlockId === block.blockId ? "true" : undefined}
        className={cn(activeBlockId === block.blockId && sourceActiveBlockClass)}
      >
        <ProjectedMath latex={block.text} displayMode />
      </div>
    );
  }

  if (block.kind === "blockquote") {
    return (
      <blockquote
        data-source-active={activeBlockId === block.blockId ? "true" : undefined}
        className={cn(
          "my-4 border-l-4 border-border pl-4 text-muted-foreground italic",
          activeBlockId === block.blockId && sourceActiveBlockClass,
        )}
      >
        {renderRuns(runs, onLinkClick, activeInlineId)}
      </blockquote>
    );
  }

  if (block.kind === "thematic-break") {
    return <hr className="my-6 border-border" />;
  }

  if (block.kind === "table") {
    return (
      <ProjectedTable
        activeBlock={activeBlockId === block.blockId}
        activeInlineId={activeInlineId}
        runs={runs}
        fallbackText={block.text}
        onLinkClick={onLinkClick}
      />
    );
  }

  if (block.kind === "isolated") {
    return null;
  }

  if (block.kind === "paragraph") {
    return (
      <p
        data-source-active={activeBlockId === block.blockId ? "true" : undefined}
        className={cn(
          "my-3 leading-relaxed",
          activeBlockId === block.blockId && sourceActiveBlockClass,
        )}
      >
        {renderRuns(runs, onLinkClick, activeInlineId)}
      </p>
    );
  }

  return block.text ? (
    <div
      data-source-active={activeBlockId === block.blockId ? "true" : undefined}
      className={cn("my-2", activeBlockId === block.blockId && sourceActiveBlockClass)}
    >
      {renderRuns(runs, onLinkClick, activeInlineId)}
    </div>
  ) : null;
}

const sourceActiveBlockClass = "";
const sourceActiveRunClass =
  "rounded-sm bg-primary/10 ring-1 ring-primary/20 ring-offset-1 ring-offset-background";

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
  if (element === "h1") return "mt-6 mb-4 text-[1.875rem] leading-tight font-bold";
  if (element === "h2") return "mt-[1.35rem] mb-3 text-2xl leading-tight font-bold";
  if (element === "h3") return "mt-[1.2rem] mb-2.5 text-xl leading-tight font-semibold";
  if (element === "h4") return "mt-4 mb-2 text-lg leading-tight font-semibold";
  if (element === "h5") return "mt-3.5 mb-1.5 text-base leading-tight font-semibold";
  return "mt-3 mb-1.5 text-sm leading-tight font-semibold text-muted-foreground";
}

interface ProjectedListItem {
  checked?: boolean;
  children: ProjectedListItem[];
  key: string;
  ordered?: boolean;
  runs: MarkdownProjectionRun[];
  taskRun?: MarkdownProjectionRun;
}

function ProjectedList({
  items,
  activeBlock,
  activeInlineId,
  ordered,
  onLinkClick,
  onTaskCheckedChange,
}: {
  items: ProjectedListItem[];
  activeBlock: boolean;
  activeInlineId?: string;
  ordered: boolean;
  onLinkClick?: (url: string) => void;
  onTaskCheckedChange?: (run: MarkdownProjectionRun, checked: boolean) => void;
}) {
  const List = ordered ? "ol" : "ul";
  const allItemsAreTasks = items.length > 0 && items.every(({ checked }) => checked !== undefined);

  return (
    <List
      data-source-active={activeBlock ? "true" : undefined}
      className={cn(
        "my-3 ml-6 leading-relaxed",
        ordered ? "list-decimal" : "list-disc",
        allItemsAreTasks && "ml-0 list-none",
        activeBlock && sourceActiveBlockClass,
      )}
    >
      {items.map((item) => (
        <ProjectedListItem
          key={item.key}
          item={item}
          activeInlineId={activeInlineId}
          onLinkClick={onLinkClick}
          onTaskCheckedChange={onTaskCheckedChange}
        />
      ))}
    </List>
  );
}

function ProjectedListItem({
  item,
  activeInlineId,
  onLinkClick,
  onTaskCheckedChange,
}: {
  item: ProjectedListItem;
  activeInlineId?: string;
  onLinkClick?: (url: string) => void;
  onTaskCheckedChange?: (run: MarkdownProjectionRun, checked: boolean) => void;
}) {
  const taskRun = item.taskRun;
  const checked = item.checked;
  const taskLabel = item.runs
    .map((run) => run.renderedText)
    .join("")
    .trim();
  const content = (
    <>
      {checked !== undefined ? (
        <TaskCheckbox
          checked={checked}
          label={taskLabel || "task"}
          onToggle={
            taskRun && onTaskCheckedChange
              ? () => onTaskCheckedChange(taskRun, !checked)
              : undefined
          }
        />
      ) : null}
      <ProjectedTaskContent checked={checked}>
        {renderRuns(item.runs, onLinkClick, activeInlineId)}
      </ProjectedTaskContent>
    </>
  );

  return (
    <li
      className={cn(
        "group/task my-1",
        item.checked !== undefined && "list-none",
        item.checked !== undefined && item.children.length === 0
          ? "flex min-w-0 items-start gap-2"
          : null,
      )}
    >
      {item.checked !== undefined && item.children.length > 0 ? (
        <div className="flex min-w-0 items-start gap-2">{content}</div>
      ) : (
        content
      )}
      {item.children.length > 0 ? (
        <ProjectedList
          items={item.children}
          activeBlock={false}
          activeInlineId={activeInlineId}
          ordered={item.children[0]?.ordered ?? false}
          onLinkClick={onLinkClick}
          onTaskCheckedChange={onTaskCheckedChange}
        />
      ) : null}
    </li>
  );
}

function groupListRuns(runs: MarkdownProjectionRun[]): ProjectedListItem[] {
  const groups = new Map<string, MarkdownProjectionRun[]>();
  const itemOrder: string[] = [];
  for (const run of runs) {
    const itemIndex = run.listItemIndex ?? 0;
    const itemPath = run.listItemPath ?? String(itemIndex);
    const group = groups.get(itemPath);
    if (group) {
      group.push(run);
    } else {
      groups.set(itemPath, [run]);
      itemOrder.push(itemPath);
    }
  }

  const items = new Map<string, ProjectedListItem>();
  const ensureItem = (key: string) => {
    const existing = items.get(key);
    if (existing) return existing;

    const runs = groups.get(key) ?? [];
    const taskRun = runs.find((run) => run.listItemChecked !== undefined);
    const item = {
      checked: taskRun?.listItemChecked,
      children: [],
      key,
      ordered: runs.find((run) => run.listItemOrdered !== undefined)?.listItemOrdered,
      runs,
      taskRun,
    } satisfies ProjectedListItem;
    items.set(key, item);
    return item;
  };

  for (const key of itemOrder) {
    ensureItem(key);
    let parentKey = parentListItemPath(key);
    while (parentKey) {
      ensureItem(parentKey);
      parentKey = parentListItemPath(parentKey);
    }
  }

  const roots: ProjectedListItem[] = [];
  for (const key of [...items.keys()].sort(compareListItemPaths)) {
    const item = items.get(key);
    if (!item) continue;

    const parentKey = parentListItemPath(key);
    const parent = parentKey ? items.get(parentKey) : undefined;
    if (parent) {
      parent.children.push(item);
    } else {
      roots.push(item);
    }
  }

  return roots;
}

function compareListItemPaths(left: string, right: string): number {
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  const length = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = Number(leftParts[index]);
    const rightPart = Number(rightParts[index]);
    const bothNumeric = Number.isFinite(leftPart) && Number.isFinite(rightPart);
    const difference = bothNumeric
      ? leftPart - rightPart
      : leftParts[index].localeCompare(rightParts[index]);
    if (difference !== 0) return difference;
  }
  return leftParts.length - rightParts.length;
}

function parentListItemPath(path: string): string | null {
  const index = path.lastIndexOf(".");
  if (index === -1) return null;
  return path.slice(0, index);
}

function TaskCheckbox({
  checked,
  label,
  onToggle,
}: {
  checked: boolean;
  label: string;
  onToggle?: () => void;
}) {
  const interactive = Boolean(onToggle);
  const actionLabel = interactive
    ? checked
      ? "Mark task incomplete"
      : "Mark task complete"
    : checked
      ? "Completed task"
      : "Incomplete task";

  return (
    <label
      className={cn(
        "relative mt-[0.34em] inline-grid size-4 shrink-0 place-items-center",
        interactive && "cursor-pointer",
      )}
      data-slot="projected-markdown-task-checkbox"
      data-state={checked ? "checked" : "unchecked"}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={!interactive}
        readOnly={!interactive}
        tabIndex={interactive ? 0 : -1}
        aria-label={`${actionLabel}: ${label}`}
        className="peer sr-only"
        onChange={interactive ? onToggle : undefined}
      />
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none grid size-3.5 place-items-center rounded-sm border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring/40 peer-focus-visible:ring-offset-1 peer-disabled:opacity-100",
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background",
          interactive && "group-hover/task:border-primary/70",
        )}
      >
        {checked ? <Check className="size-2.5 stroke-[3]" /> : null}
      </span>
    </label>
  );
}

function ProjectedTaskContent({
  checked,
  children,
}: {
  checked: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <span className={cn("min-w-0 leading-relaxed", checked === true && "text-muted-foreground")}>
      {children}
    </span>
  );
}

function ProjectedTable({
  activeBlock,
  activeInlineId,
  fallbackText,
  onLinkClick,
  runs,
}: {
  activeBlock: boolean;
  activeInlineId?: string;
  fallbackText: string;
  onLinkClick?: (url: string) => void;
  runs: MarkdownProjectionRun[];
}) {
  const rows = groupTableRuns(runs);
  if (rows.length === 0) {
    return (
      <pre
        data-source-active={activeBlock ? "true" : undefined}
        className={cn(
          "my-2 overflow-x-auto rounded bg-muted px-3 py-2 font-mono text-sm leading-relaxed whitespace-pre-wrap",
          activeBlock && sourceActiveBlockClass,
        )}
      >
        {fallbackText}
      </pre>
    );
  }

  const [headerRow, ...bodyRows] = rows;
  const hasHeader = headerRow?.cells.some((cell) => cell.header);

  return (
    <div
      data-slot="projected-markdown-table"
      data-source-active={activeBlock ? "true" : undefined}
      className={cn(
        "my-4 overflow-x-auto border-y border-border",
        activeBlock && sourceActiveBlockClass,
      )}
    >
      <table className="min-w-full border-collapse font-[var(--output-ui-font)] text-sm leading-normal">
        {hasHeader ? (
          <thead>
            <tr>
              {headerRow.cells.map((cell) => (
                <th
                  key={cell.key}
                  className="border-b border-r border-border bg-muted/55 px-3 py-2 text-left font-semibold text-foreground last:border-r-0"
                  style={tableCellStyle(cell.align)}
                >
                  {renderRuns(cell.runs, onLinkClick, activeInlineId)}
                </th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {(hasHeader ? bodyRows : rows).map((row) => (
            <tr key={row.key} className="odd:bg-muted/[0.04]">
              {row.cells.map((cell) => (
                <td
                  key={cell.key}
                  className="border-r border-t border-border px-3 py-2 align-top text-muted-foreground first:text-foreground last:border-r-0"
                  style={tableCellStyle(cell.align)}
                >
                  {renderRuns(cell.runs, onLinkClick, activeInlineId)}
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

function renderRuns(
  runs: MarkdownProjectionRun[],
  onLinkClick?: (url: string) => void,
  activeInlineId?: string,
) {
  if (runs.length === 0) return null;

  return runs.map((run) => (
    <Fragment key={run.inlineId}>
      {activeInlineId === run.inlineId ? (
        <span data-source-active-run="true" className={sourceActiveRunClass}>
          {renderRun(run, onLinkClick)}
        </span>
      ) : (
        renderRun(run, onLinkClick)
      )}
    </Fragment>
  ));
}

function renderRun(run: MarkdownProjectionRun, onLinkClick?: (url: string) => void) {
  const text = run.renderedText;
  if (run.semantic === "image" && run.imageSrc) {
    return <ProjectedImage run={run} />;
  }

  if (run.semantic === "html-fragment") {
    return text || null;
  }

  if (run.semantic === "isolated-placeholder") {
    return null;
  }

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
  if (run.semantic === "inline-code") return <InlineCode>{text}</InlineCode>;
  if (run.semantic === "math-source") return <ProjectedMath latex={text} />;
  if (run.semantic === "code-block") return text;
  if (run.semantic === "link-label") return text;

  return text;
}

function ProjectedImage({ run }: { run: MarkdownProjectionRun }) {
  const src = safeImageSrc(run.imageSrc);
  const alt = run.imageAlt ?? run.renderedText;
  if (!src) {
    return alt ? <span>{alt}</span> : null;
  }

  return (
    <img
      src={src}
      alt={alt}
      title={run.imageTitle}
      className="my-4 max-w-full h-auto rounded-sm"
      loading="lazy"
    />
  );
}

function safeImageSrc(src: string | undefined): string | null {
  if (!src) return null;

  if (
    src.startsWith("/") ||
    src.startsWith("./") ||
    src.startsWith("../") ||
    src.startsWith("#") ||
    src.startsWith("blob:") ||
    src.startsWith("attachment:")
  ) {
    return src;
  }

  if (src.startsWith("data:")) {
    return /^data:image\//i.test(src) ? src : null;
  }

  if (!/^[a-z][a-z0-9+.-]*:/i.test(src)) {
    return src;
  }

  try {
    const url = new URL(src);
    return url.protocol === "http:" || url.protocol === "https:" ? src : null;
  } catch {
    return null;
  }
}

function ProjectedCodeBlock({
  code,
  colorTheme,
  isDark,
  language,
}: {
  code: string;
  colorTheme: "classic" | "cream";
  isDark: boolean;
  language?: string;
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
      <StaticCodeBlock
        code={code}
        colorTheme={colorTheme}
        isDark={isDark}
        language={language}
        className="max-w-full"
      />
      <button
        type="button"
        aria-label={copied ? "Copied code" : "Copy code"}
        className="absolute top-2 right-2 z-10 rounded border border-border bg-background p-1.5 text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover/codeblock:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
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
    if (displayMode) {
      return (
        <div className="my-4 overflow-x-auto">
          <InlineCode className="block px-3 py-2">{latex}</InlineCode>
        </div>
      );
    }

    return <InlineCode>{latex}</InlineCode>;
  }

  if (displayMode) {
    return (
      <div
        data-slot="projected-markdown-math"
        data-display-mode="true"
        className="my-4 overflow-x-auto px-1 py-1 text-center [&_.katex-display]:my-0"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <span
      data-slot="projected-markdown-math"
      data-display-mode="false"
      className="inline align-baseline [&_.katex]:text-[1.03em]"
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
    });
  } catch {
    return null;
  }
}

function InlineCode({ children, className }: { children: string; className?: string }) {
  return (
    <code
      className={cn(
        "rounded-sm bg-muted/75 px-1.5 py-0.5 font-mono text-[0.9em] text-foreground",
        className,
      )}
    >
      {children}
    </code>
  );
}
