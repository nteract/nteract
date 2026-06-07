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
import {
  markdownBlockquoteClassName,
  markdownCodeBlockCopyButtonClassName,
  markdownCodeBlockLabelClassName,
  markdownCodeBlockShellClassName,
  markdownCodeBlockToolbarClassName,
  markdownDeleteClassName,
  markdownDisplayMathClassName,
  markdownDocumentClassName,
  markdownEmphasisClassName,
  markdownFigureCaptionClassName,
  markdownFigureClassName,
  markdownHeadingAnchorClassName,
  markdownHeadingClassName,
  markdownImageClassName,
  markdownInlineCodeClassName,
  markdownInlineMathClassName,
  markdownLinkClassName,
  markdownListMarkerClassName,
  markdownParagraphClassName,
  markdownStrongClassName,
  markdownTaskCheckboxClassName,
  markdownTaskCheckboxGlyphClassName,
  markdownTaskContentClassName,
  markdownTaskListClassName,
  markdownTaskListItemClassName,
  markdownTableCellClassName,
  markdownTableClassName,
  markdownTableHeadClassName,
  markdownTableHeaderCellClassName,
  markdownTableRowClassName,
  markdownTableWrapperClassName,
  markdownThematicBreakClassName,
} from "./markdown-typography";

import "katex/dist/katex.min.css";

interface ProjectedMarkdownViewProps {
  plan: MarkdownProjectionPlan;
  className?: string;
  activeSourcePosition?: number;
  colorTheme?: "classic" | "cream";
  headingAnchors?: readonly MarkdownHeadingAnchor[];
  onLinkClick?: (url: string) => void;
  onTaskCheckedChange?: (run: MarkdownProjectionRun, checked: boolean) => void;
}

export function ProjectedMarkdownView({
  plan,
  className,
  activeSourcePosition,
  colorTheme: colorThemeOverride,
  headingAnchors = [],
  onLinkClick,
  onTaskCheckedChange,
}: ProjectedMarkdownViewProps) {
  const isDark = useDarkMode();
  const rawTheme = useColorTheme();
  const colorTheme = colorThemeOverride ?? (rawTheme === "cream" ? "cream" : "classic");
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
    <div data-slot="projected-markdown-output" className={cn(markdownDocumentClassName, className)}>
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
          markdownHeadingClassName(block.element),
          activeBlockId === block.blockId && sourceActiveBlockClass,
        )}
      >
        {renderRuns(runs, onLinkClick, activeInlineId)}
        {headingAnchor?.headingAnchorId ? (
          <a
            aria-label={`Link to ${block.text}`}
            className={markdownHeadingAnchorClassName}
            href={`#${headingAnchor.headingAnchorId}`}
          >
            #
          </a>
        ) : null}
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
          markdownBlockquoteClassName,
          activeBlockId === block.blockId && sourceActiveBlockClass,
        )}
      >
        {renderRuns(runs, onLinkClick, activeInlineId)}
      </blockquote>
    );
  }

  if (block.kind === "thematic-break") {
    return <hr className={markdownThematicBreakClassName} />;
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
    const figureRun = imageOnlyRun(runs);
    if (figureRun) {
      return (
        <ProjectedFigure
          active={activeBlockId === block.blockId}
          activeInlineId={activeInlineId}
          run={figureRun}
        />
      );
    }

    return (
      <p
        data-source-active={activeBlockId === block.blockId ? "true" : undefined}
        className={cn(
          markdownParagraphClassName,
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
const sourceActiveRunClass = "";

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
        allItemsAreTasks
          ? markdownTaskListClassName
          : cn(
              "my-3 ml-6 leading-relaxed",
              ordered ? "list-decimal" : "list-disc",
              markdownListMarkerClassName,
            ),
        activeBlock && sourceActiveBlockClass,
      )}
    >
      {items.map((item) => (
        <ProjectedListItem
          key={item.key}
          item={item}
          activeInlineId={activeInlineId}
          taskProtocol={allItemsAreTasks}
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
  taskProtocol,
  onLinkClick,
  onTaskCheckedChange,
}: {
  item: ProjectedListItem;
  activeInlineId?: string;
  taskProtocol: boolean;
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
          ? taskProtocol
            ? markdownTaskListItemClassName
            : "flex min-w-0 items-start gap-2"
          : null,
      )}
    >
      {item.checked !== undefined && item.children.length > 0 ? (
        <div
          className={cn(
            taskProtocol ? markdownTaskListItemClassName : "flex min-w-0 items-start gap-2",
          )}
        >
          {content}
        </div>
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
      className={cn(markdownTaskCheckboxClassName, interactive && "cursor-pointer")}
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
          markdownTaskCheckboxGlyphClassName,
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
    <span className={cn(markdownTaskContentClassName, checked === true && "text-muted-foreground")}>
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
      className={cn(markdownTableWrapperClassName, activeBlock && sourceActiveBlockClass)}
    >
      <table className={markdownTableClassName}>
        {hasHeader ? (
          <thead className={markdownTableHeadClassName}>
            <tr>
              {headerRow.cells.map((cell) => (
                <th
                  key={cell.key}
                  className={markdownTableHeaderCellClassName}
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
            <tr key={row.key} className={markdownTableRowClassName}>
              {row.cells.map((cell) => (
                <td
                  key={cell.key}
                  className={markdownTableCellClassName}
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
        className={markdownLinkClassName}
        onClick={(event) => {
          event.preventDefault();
          onLinkClick?.(run.href ?? "");
        }}
      >
        {text}
      </a>
    );
  }

  if (run.semantic === "strong") return <strong className={markdownStrongClassName}>{text}</strong>;
  if (run.semantic === "emphasis") return <em className={markdownEmphasisClassName}>{text}</em>;
  if (run.semantic === "delete") return <del className={markdownDeleteClassName}>{text}</del>;
  if (run.semantic === "inline-code") return <InlineCode>{text}</InlineCode>;
  if (run.semantic === "math-source") return <ProjectedMath latex={text} />;
  if (run.semantic === "code-block") return text;
  if (run.semantic === "link-label") return text;

  return text;
}

function imageOnlyRun(runs: MarkdownProjectionRun[]): MarkdownProjectionRun | null {
  const visibleRuns = runs.filter((run) => run.semantic !== "isolated-placeholder");
  if (visibleRuns.length !== 1) return null;
  const [run] = visibleRuns;
  return run.semantic === "image" && run.imageSrc ? run : null;
}

function ProjectedFigure({
  active,
  activeInlineId,
  run,
}: {
  active: boolean;
  activeInlineId?: string;
  run: MarkdownProjectionRun;
}) {
  const image = <ProjectedImage run={run} />;
  const title = run.imageTitle?.trim();
  return (
    <figure
      data-source-active={active ? "true" : undefined}
      className={cn(markdownFigureClassName, active && sourceActiveBlockClass)}
    >
      {activeInlineId === run.inlineId ? (
        <span data-source-active-run="true" className={sourceActiveRunClass}>
          {image}
        </span>
      ) : (
        image
      )}
      {title ? <figcaption className={markdownFigureCaptionClassName}>{title}</figcaption> : null}
    </figure>
  );
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
      className={markdownImageClassName}
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

  const languageLabel = codeBlockLanguageLabel(language);

  return (
    <div
      className={markdownCodeBlockShellClassName}
      data-code-language={languageLabel === "code" ? undefined : languageLabel}
    >
      <div className={markdownCodeBlockToolbarClassName}>
        <span
          className={markdownCodeBlockLabelClassName}
          title={languageLabel === "code" ? "Code block" : `${languageLabel} code block`}
        >
          code
        </span>
        <button
          type="button"
          aria-label={copied ? "Copied code" : "Copy code"}
          className={markdownCodeBlockCopyButtonClassName}
          title={copied ? "Copied" : "Copy code"}
          onClick={copyCode}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </button>
      </div>
      <StaticCodeBlock
        code={code}
        colorTheme={colorTheme}
        isDark={isDark}
        language={language}
        className="max-w-full"
      />
    </div>
  );
}

function codeBlockLanguageLabel(language: string | undefined): string {
  const trimmed = language?.trim();
  if (!trimmed) return "code";
  return trimmed;
}

function ProjectedMath({ displayMode = false, latex }: { displayMode?: boolean; latex: string }) {
  const html = renderLatex(latex, displayMode);
  if (!html) {
    if (displayMode) {
      return (
        <div className={markdownDisplayMathClassName}>
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
        className={markdownDisplayMathClassName}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <span
      data-slot="projected-markdown-math"
      data-display-mode="false"
      className={markdownInlineMathClassName}
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
  return <code className={cn(markdownInlineCodeClassName, className)}>{children}</code>;
}
