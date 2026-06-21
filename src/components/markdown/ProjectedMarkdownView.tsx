import { type CSSProperties, type ReactNode } from "react";
import katex from "katex";
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
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { MarkdownFigure, MarkdownFigureCaption, MarkdownImage } from "./MarkdownFigure";
import { MarkdownHeading, markdownHeadingElement } from "./MarkdownHeading";
import {
  MarkdownTableBody,
  MarkdownTableCell,
  MarkdownTableElement,
  MarkdownTableFrame,
  MarkdownTableHead,
  MarkdownTableHeaderCell,
  MarkdownTableHeaderRow,
  MarkdownTableRow,
} from "./MarkdownTable";
import { MarkdownTaskCheckbox, MarkdownTaskContent } from "./MarkdownTask";
import {
  MarkdownBlockquote,
  MarkdownDelete,
  MarkdownEmphasis,
  MarkdownInlineCode,
  MarkdownStrong,
} from "./MarkdownText";
import {
  markdownDisplayMathClassName,
  markdownDocumentClassName,
  markdownInlineMathClassName,
  markdownLinkClassName,
  markdownListMarkerClassName,
  markdownParagraphClassName,
  markdownTaskListClassName,
  markdownTaskListItemClassName,
  markdownThematicBreakClassName,
} from "./markdown-typography";

import "katex/dist/katex.min.css";

export interface MarkdownCommentHighlight {
  from: number;
  to: number;
  color?: string;
  resolved: boolean;
}

interface ProjectedMarkdownViewProps {
  plan: MarkdownProjectionPlan;
  className?: string;
  activeSourcePosition?: number;
  commentHighlights?: ReadonlyArray<MarkdownCommentHighlight>;
  colorTheme?: "classic" | "cream";
  headingAnchors?: readonly MarkdownHeadingAnchor[];
  onLinkClick?: (url: string) => void;
  onTaskCheckedChange?: (run: MarkdownProjectionRun, checked: boolean) => void;
}

export function ProjectedMarkdownView({
  plan,
  className,
  activeSourcePosition,
  commentHighlights,
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
          commentHighlights={commentHighlights}
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
  commentHighlights?: ReadonlyArray<MarkdownCommentHighlight>;
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
  commentHighlights,
  isDark,
  runs,
  onLinkClick,
  onTaskCheckedChange,
}: ProjectedMarkdownBlockProps) {
  if (block.kind === "heading") {
    return (
      <MarkdownHeading
        element={markdownHeadingElement(block.element)}
        id={headingAnchor?.headingAnchorId}
        anchorHref={
          headingAnchor?.headingAnchorId ? `#${headingAnchor.headingAnchorId}` : undefined
        }
        anchorLabel={headingAnchor?.headingAnchorId ? `Link to ${block.text}` : undefined}
        data-nteract-heading-anchor={headingAnchor?.headingAnchorId}
        data-nteract-outline-item-id={headingAnchor?.itemId}
        data-source-active={activeBlockId === block.blockId ? "true" : undefined}
        className={cn(activeBlockId === block.blockId && sourceActiveBlockClass)}
      >
        {renderRuns(runs, { activeInlineId, commentHighlights, onLinkClick })}
      </MarkdownHeading>
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
        commentHighlights={commentHighlights}
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
        <MarkdownCodeBlock
          code={block.text}
          colorTheme={colorTheme}
          isDark={isDark}
          language={block.codeLanguage}
          preClassName="max-w-full"
          copyResetMs={1800}
          copyErrorMessage="Failed to copy projected markdown code block:"
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
      <MarkdownBlockquote
        data-source-active={activeBlockId === block.blockId ? "true" : undefined}
        className={cn(activeBlockId === block.blockId && sourceActiveBlockClass)}
      >
        {renderRuns(runs, { activeInlineId, commentHighlights, onLinkClick })}
      </MarkdownBlockquote>
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
        commentHighlights={commentHighlights}
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
          commentHighlights={commentHighlights}
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
        {renderRuns(runs, { activeInlineId, commentHighlights, onLinkClick })}
      </p>
    );
  }

  return block.text ? (
    <div
      data-source-active={activeBlockId === block.blockId ? "true" : undefined}
      className={cn("my-2", activeBlockId === block.blockId && sourceActiveBlockClass)}
    >
      {renderRuns(runs, { activeInlineId, commentHighlights, onLinkClick })}
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
  commentHighlights,
  ordered,
  onLinkClick,
  onTaskCheckedChange,
}: {
  items: ProjectedListItem[];
  activeBlock: boolean;
  activeInlineId?: string;
  commentHighlights?: ReadonlyArray<MarkdownCommentHighlight>;
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
          commentHighlights={commentHighlights}
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
  commentHighlights,
  taskProtocol,
  onLinkClick,
  onTaskCheckedChange,
}: {
  item: ProjectedListItem;
  activeInlineId?: string;
  commentHighlights?: ReadonlyArray<MarkdownCommentHighlight>;
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
        {renderRuns(item.runs, { activeInlineId, commentHighlights, onLinkClick })}
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
          commentHighlights={commentHighlights}
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
  return (
    <MarkdownTaskCheckbox
      checked={checked}
      label={label}
      onToggle={onToggle}
      slot="projected-markdown-task-checkbox"
    />
  );
}

function ProjectedTaskContent({
  checked,
  children,
}: {
  checked: boolean | undefined;
  children: ReactNode;
}) {
  return <MarkdownTaskContent checked={checked}>{children}</MarkdownTaskContent>;
}

function ProjectedTable({
  activeBlock,
  activeInlineId,
  commentHighlights,
  fallbackText,
  onLinkClick,
  runs,
}: {
  activeBlock: boolean;
  activeInlineId?: string;
  commentHighlights?: ReadonlyArray<MarkdownCommentHighlight>;
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
  const columnAlign = tableColumnAlignments(rows);

  return (
    <MarkdownTableFrame
      data-slot="projected-markdown-table"
      data-source-active={activeBlock ? "true" : undefined}
      className={cn(activeBlock && sourceActiveBlockClass)}
    >
      <MarkdownTableElement>
        {hasHeader ? (
          <MarkdownTableHead>
            <MarkdownTableHeaderRow>
              {headerRow.cells.map((cell) => (
                <MarkdownTableHeaderCell
                  key={cell.key}
                  style={tableCellStyle(columnAlign.get(cell.cellIndex))}
                >
                  {renderRuns(cell.runs, {
                    activeInlineId,
                    commentHighlights,
                    onLinkClick,
                  })}
                </MarkdownTableHeaderCell>
              ))}
            </MarkdownTableHeaderRow>
          </MarkdownTableHead>
        ) : null}
        <MarkdownTableBody>
          {(hasHeader ? bodyRows : rows).map((row) => (
            <MarkdownTableRow key={row.key}>
              {row.cells.map((cell) => (
                <MarkdownTableCell
                  key={cell.key}
                  style={tableCellStyle(columnAlign.get(cell.cellIndex))}
                >
                  {renderRuns(cell.runs, {
                    activeInlineId,
                    commentHighlights,
                    onLinkClick,
                  })}
                </MarkdownTableCell>
              ))}
            </MarkdownTableRow>
          ))}
        </MarkdownTableBody>
      </MarkdownTableElement>
    </MarkdownTableFrame>
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
      cellIndex,
      header: runs.some((run) => run.tableCellHeader),
      key: `${rowIndex}:${cellIndex}`,
      runs,
    })),
  }));
}

function tableColumnAlignments(rows: ReturnType<typeof groupTableRuns>) {
  const alignments = new Map<number, MarkdownProjectionRun["tableCellAlign"]>();

  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell.align) {
        alignments.set(cell.cellIndex, cell.align);
      }
    }
  }

  for (const row of rows.slice(1)) {
    for (const cell of row.cells) {
      if (alignments.has(cell.cellIndex)) continue;
      const columnCells = rows
        .slice(1)
        .flatMap((bodyRow) =>
          bodyRow.cells.filter((bodyCell) => bodyCell.cellIndex === cell.cellIndex),
        );
      if (
        columnCells.length > 0 &&
        columnCells.every((bodyCell) => isNumericTableCell(bodyCell.runs))
      ) {
        alignments.set(cell.cellIndex, "right");
      }
    }
  }

  return alignments;
}

function isNumericTableCell(runs: MarkdownProjectionRun[]) {
  const text = runs
    .map((run) => run.renderedText)
    .join("")
    .trim();
  return /^[-+]?(?:[$]\s*)?\d[\d,]*(?:\.\d+)?(?:\s?(?:%|[a-zA-Z]+))?$/.test(text);
}

function tableCellStyle(align: MarkdownProjectionRun["tableCellAlign"]): CSSProperties | undefined {
  if (align === "right" || align === "center" || align === "left") {
    return { textAlign: align };
  }

  return undefined;
}

interface RenderRunsOptions {
  activeInlineId?: string;
  commentHighlights?: ReadonlyArray<MarkdownCommentHighlight>;
  onLinkClick?: (url: string) => void;
}

function renderRuns(runs: MarkdownProjectionRun[], options: RenderRunsOptions = {}) {
  if (runs.length === 0) return null;

  const { activeInlineId, commentHighlights, onLinkClick } = options;
  return runs.map((run) => {
    // Keep choosing one best highlight per run for now; multiple disjoint
    // highlight fragments in the same run are intentionally deferred.
    const highlight = commentHighlightForRun(run, commentHighlights);
    return (
      <span
        key={run.inlineId}
        data-markdown-source-run="true"
        data-rendered-start={run.renderedTextUtf16[0]}
        data-rendered-end={run.renderedTextUtf16[1]}
        data-source-start={run.sourceSpanUtf16[0]}
        data-source-end={run.sourceSpanUtf16[1]}
        data-source-active-run={activeInlineId === run.inlineId ? "true" : undefined}
        className={cn(activeInlineId === run.inlineId && sourceActiveRunClass)}
      >
        {renderRunWithHighlight(run, highlight, onLinkClick)}
      </span>
    );
  });
}

function commentHighlightForRun(
  run: MarkdownProjectionRun,
  commentHighlights: ReadonlyArray<MarkdownCommentHighlight> | undefined,
): MarkdownCommentHighlight | null {
  if (!commentHighlights?.length) return null;
  const [runStart, runEnd] = run.sourceSpanUtf16;
  let best: MarkdownCommentHighlight | null = null;
  let bestLength = Number.POSITIVE_INFINITY;
  let bestStart = Number.POSITIVE_INFINITY;

  for (const highlight of commentHighlights) {
    const start = Math.min(highlight.from, highlight.to);
    const end = Math.max(highlight.from, highlight.to);
    if (start === end) continue;
    if (runStart >= end || runEnd <= start) continue;
    const length = end - start;
    if (length < bestLength || (length === bestLength && start < bestStart)) {
      best = highlight;
      bestLength = length;
      bestStart = start;
    }
  }

  return best;
}

function commentHighlightStyle(
  highlight: MarkdownCommentHighlight | null,
): CSSProperties | undefined {
  if (!highlight?.color) return undefined;
  return { "--cm-comment-color": highlight.color } as CSSProperties;
}

const splittableRunSemantics = new Set([
  "text",
  "heading-text",
  "list-item",
  "table-cell",
  "strong",
  "emphasis",
  "delete",
  "inline-code",
  "link-label",
]);

function renderRunWithHighlight(
  run: MarkdownProjectionRun,
  highlight: MarkdownCommentHighlight | null,
  onLinkClick?: (url: string) => void,
) {
  if (!highlight) return renderRun(run, onLinkClick);

  if (!canSplitRunForHighlight(run)) {
    return (
      <span
        className={cn("comment-highlight", highlight.resolved && "comment-highlight-resolved")}
        style={commentHighlightStyle(highlight)}
      >
        {renderRun(run, onLinkClick)}
      </span>
    );
  }

  const [runStart, runEnd] = run.sourceSpanUtf16;
  const highlightStart = Math.min(highlight.from, highlight.to);
  const highlightEnd = Math.max(highlight.from, highlight.to);
  const overlapStart = Math.max(highlightStart, runStart);
  const overlapEnd = Math.min(highlightEnd, runEnd);
  const length = run.renderedText.length;
  const start = clamp(overlapStart - runStart, 0, length);
  const end = clamp(overlapEnd - runStart, 0, length);

  if (end <= start) return renderRun(run, onLinkClick);

  const before = run.renderedText.slice(0, start);
  const highlighted = run.renderedText.slice(start, end);
  const after = run.renderedText.slice(end);

  return (
    <>
      {before ? renderRunText(run, before, onLinkClick) : null}
      <span
        className={cn("comment-highlight", highlight.resolved && "comment-highlight-resolved")}
        style={commentHighlightStyle(highlight)}
      >
        {renderRunText(run, highlighted, onLinkClick)}
      </span>
      {after ? renderRunText(run, after, onLinkClick) : null}
    </>
  );
}

function canSplitRunForHighlight(run: MarkdownProjectionRun) {
  const sourceLength = run.sourceSpanUtf16[1] - run.sourceSpanUtf16[0];
  return (
    run.renderedText.length > 0 &&
    run.renderedText.length === sourceLength &&
    splittableRunSemantics.has(run.semantic)
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
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

  return renderRunText(run, text, onLinkClick);
}

function renderRunText(
  run: MarkdownProjectionRun,
  text: string,
  onLinkClick?: (url: string) => void,
) {
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

  if (run.semantic === "strong") return <MarkdownStrong>{text}</MarkdownStrong>;
  if (run.semantic === "emphasis") return <MarkdownEmphasis>{text}</MarkdownEmphasis>;
  if (run.semantic === "delete") return <MarkdownDelete>{text}</MarkdownDelete>;
  if (run.semantic === "inline-code") return <MarkdownInlineCode>{text}</MarkdownInlineCode>;
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
  commentHighlights,
  run,
}: {
  active: boolean;
  activeInlineId?: string;
  commentHighlights?: ReadonlyArray<MarkdownCommentHighlight>;
  run: MarkdownProjectionRun;
}) {
  const image = <ProjectedImage run={run} />;
  const highlight = commentHighlightForRun(run, commentHighlights);
  const title = run.imageTitle?.trim();
  return (
    <MarkdownFigure
      data-source-active={active ? "true" : undefined}
      className={cn(active && sourceActiveBlockClass)}
    >
      {activeInlineId === run.inlineId || highlight ? (
        <span
          data-source-active-run={activeInlineId === run.inlineId ? "true" : undefined}
          className={cn(
            activeInlineId === run.inlineId && sourceActiveRunClass,
            highlight && "comment-highlight",
            highlight?.resolved && "comment-highlight-resolved",
          )}
          style={commentHighlightStyle(highlight)}
        >
          {image}
        </span>
      ) : (
        image
      )}
      {title ? <MarkdownFigureCaption>{title}</MarkdownFigureCaption> : null}
    </MarkdownFigure>
  );
}

function ProjectedImage({ run }: { run: MarkdownProjectionRun }) {
  const src = safeImageSrc(run.imageSrc);
  const alt = run.imageAlt ?? run.renderedText;
  if (!src) {
    return alt ? <span>{alt}</span> : null;
  }

  return <MarkdownImage src={src} alt={alt} title={run.imageTitle} loading="lazy" />;
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

function ProjectedMath({ displayMode = false, latex }: { displayMode?: boolean; latex: string }) {
  const html = renderLatex(latex, displayMode);
  if (!html) {
    if (displayMode) {
      return (
        <div className={markdownDisplayMathClassName}>
          <MarkdownInlineCode className="block px-3 py-2">{latex}</MarkdownInlineCode>
        </div>
      );
    }

    return <MarkdownInlineCode>{latex}</MarkdownInlineCode>;
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
