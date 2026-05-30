/**
 * Host-neutral notebook outline projection.
 *
 * This lives in `runtimed` rather than the rail UI so desktop, cloud, and
 * future document surfaces share one deterministic heading/cell outline shape.
 */
export type NotebookOutlineItemKind = "heading" | "cell";
export type NotebookOutlineHrefTarget = "cell" | "heading";

export interface NotebookOutlineSourceCell {
  id: string;
  source?: string | null;
  cell_type?: string | null;
  cellType?: string | null;
  execution_count?: number | null;
  metadata?: NotebookOutlineSourceMetadata | null;
}

export type NotebookOutlineSourceMetadata = Record<string, unknown> & {
  title?: unknown;
  heading?: unknown;
  name?: unknown;
};

export interface NotebookOutlineItem {
  id: string;
  cellId: string;
  title: string;
  level: number;
  kind: NotebookOutlineItemKind;
  cellAnchorId: string;
  headingAnchorId: string | null;
  href: string;
  anchor?: string | null;
  detail?: string | null;
  statusLabel?: string | null;
}

export interface NotebookOutlineProjection {
  items: NotebookOutlineItem[];
  source: "headings" | "cells" | "empty";
}

export interface NotebookOutlineTreeNode {
  item: NotebookOutlineItem;
  children: NotebookOutlineTreeNode[];
}

export interface ProjectNotebookOutlineOptions<TCell extends NotebookOutlineSourceCell> {
  getStatusLabel?: (cell: TCell) => string | null | undefined;
  fallbackToCells?: boolean;
  hrefTarget?: NotebookOutlineHrefTarget;
}

export interface NotebookOutlineSelectionInput {
  selectedItemId?: string | null;
  selectedCellId?: string | null;
  cellIds?: readonly string[];
}

export interface ParsedNotebookHeading {
  title: string;
  level: number;
}

const MAX_OUTLINE_TITLE_LENGTH = 96;

export function projectNotebookOutline<TCell extends NotebookOutlineSourceCell>(
  cells: readonly TCell[],
  options: ProjectNotebookOutlineOptions<TCell> = {},
): NotebookOutlineProjection {
  const fallbackToCells = options.fallbackToCells ?? true;
  const hrefTarget = options.hrefTarget ?? "cell";
  const headings: NotebookOutlineItem[] = [];
  const anchorCounts = new Map<string, number>();

  for (const cell of cells) {
    if (cellKind(cell) !== "markdown") continue;
    const parsed = parseMarkdownHeadings(cell.source ?? "");
    parsed.forEach((heading, index) => {
      const anchor = nextHeadingAnchor(heading.title, anchorCounts);
      const cellAnchorId = notebookCellAnchorId(cell.id);
      const headingAnchorId = notebookHeadingAnchorId(cell.id, anchor);
      headings.push({
        id: `${cell.id}:heading:${index}`,
        cellId: cell.id,
        title: heading.title,
        level: heading.level,
        kind: "heading",
        cellAnchorId,
        headingAnchorId,
        href: notebookOutlineHref(cellAnchorId, headingAnchorId, hrefTarget),
        anchor,
        statusLabel: options.getStatusLabel?.(cell) ?? null,
      });
    });
  }

  if (headings.length > 0) {
    return { items: headings, source: "headings" };
  }

  if (!fallbackToCells) {
    return { items: [], source: "empty" };
  }

  return {
    source: cells.length > 0 ? "cells" : "empty",
    items: cells.map((cell, index) => {
      const kind = cellKind(cell);
      const cellAnchorId = notebookCellAnchorId(cell.id);
      return {
        id: `${cell.id}:cell`,
        cellId: cell.id,
        title: summarizeCell(cell, index),
        level: 1,
        kind: "cell",
        cellAnchorId,
        headingAnchorId: null,
        href: notebookCellAnchorHref(cell.id),
        anchor: null,
        detail: detailLabel(kind),
        statusLabel: options.getStatusLabel?.(cell) ?? null,
      };
    }),
  };
}

export function parseMarkdownHeadings(source: string): ParsedNotebookHeading[] {
  const headings: ParsedNotebookHeading[] = [];
  let fencedBy: string | null = null;

  for (const rawLine of source.split(/\r?\n/)) {
    const fence = rawLine.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1][0];
      if (fencedBy === marker) {
        fencedBy = null;
      } else if (fencedBy === null) {
        fencedBy = marker;
      }
      continue;
    }

    if (fencedBy !== null) continue;

    const match = rawLine.match(/^ {0,3}(#{1,6})(?:\s+|$)(.*?)\s*$/);
    if (!match) continue;

    const title = cleanOutlineTitle(match[2].replace(/\s+#+\s*$/, ""));
    if (!title) continue;

    headings.push({
      title,
      level: match[1].length,
    });
  }

  return headings;
}

export function deriveNotebookOutlineItems<TCell extends NotebookOutlineSourceCell>(
  cells: readonly TCell[],
  options: ProjectNotebookOutlineOptions<TCell> = {},
): NotebookOutlineItem[] {
  return projectNotebookOutline(cells, options).items;
}

export function buildNotebookOutlineTree(
  items: readonly NotebookOutlineItem[],
): NotebookOutlineTreeNode[] {
  const roots: NotebookOutlineTreeNode[] = [];
  const stack: NotebookOutlineTreeNode[] = [];

  for (const item of items) {
    const node: NotebookOutlineTreeNode = { item, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].item.level >= item.level) {
      stack.pop();
    }

    const parent = stack.at(-1);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
    stack.push(node);
  }

  return roots;
}

export function slugifyNotebookHeading(title: string): string {
  const slug = cleanOutlineTitle(title)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "heading";
}

export function notebookCellAnchorId(cellId: string): string {
  return `notebook-cell-${encodeNotebookAnchorComponent(cellId)}`;
}

export function notebookCellAnchorHref(cellId: string): string {
  return `#${notebookCellAnchorId(cellId)}`;
}

export function notebookHeadingAnchorId(cellId: string, headingAnchor: string): string {
  return `${notebookCellAnchorId(cellId)}-heading-${encodeNotebookAnchorComponent(headingAnchor)}`;
}

export function notebookHeadingAnchorHref(cellId: string, headingAnchor: string): string {
  return `#${notebookHeadingAnchorId(cellId, headingAnchor)}`;
}

export function notebookOutlineItemHref(
  item: Pick<NotebookOutlineItem, "cellAnchorId" | "headingAnchorId">,
  hrefTarget: NotebookOutlineHrefTarget = "cell",
): string {
  return notebookOutlineHref(item.cellAnchorId, item.headingAnchorId, hrefTarget);
}

export function resolveNotebookOutlineSelection(
  items: readonly NotebookOutlineItem[],
  selection: NotebookOutlineSelectionInput,
): string | null {
  if (selection.selectedItemId && items.some((item) => item.id === selection.selectedItemId)) {
    return selection.selectedItemId;
  }

  if (selection.selectedCellId) {
    const exactItem = items.find((item) => item.cellId === selection.selectedCellId);
    if (exactItem) return exactItem.id;

    if (selection.cellIds) {
      return resolveNotebookOutlineContextItemId(
        items,
        selection.cellIds,
        selection.selectedCellId,
      );
    }
  }

  return null;
}

export function resolveNotebookOutlineContextItemId(
  items: readonly NotebookOutlineItem[],
  cellIds: readonly string[],
  cellId: string,
): string | null {
  const cellIndexById = new Map(cellIds.map((id, index) => [id, index]));
  const selectedCellIndex = cellIndexById.get(cellId);
  if (selectedCellIndex == null) return null;

  let contextItem: NotebookOutlineItem | null = null;
  let contextCellIndex = -1;

  for (const item of items) {
    const itemCellIndex = cellIndexById.get(item.cellId);
    if (itemCellIndex == null || itemCellIndex > selectedCellIndex) continue;
    if (itemCellIndex >= contextCellIndex) {
      contextItem = item;
      contextCellIndex = itemCellIndex;
    }
  }

  return contextItem?.id ?? null;
}

function nextHeadingAnchor(title: string, anchorCounts: Map<string, number>): string {
  const base = slugifyNotebookHeading(title);
  const count = anchorCounts.get(base) ?? 0;
  anchorCounts.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function notebookOutlineHref(
  cellAnchorId: string,
  headingAnchorId: string | null,
  hrefTarget: NotebookOutlineHrefTarget,
): string {
  return `#${hrefTarget === "heading" && headingAnchorId !== null ? headingAnchorId : cellAnchorId}`;
}

function encodeNotebookAnchorComponent(value: string): string {
  if (!value) return "empty";

  let encoded = "";
  for (const character of value) {
    if (/^[A-Za-z0-9-]$/.test(character)) {
      encoded += character;
    } else if (character === "_") {
      encoded += "__";
    } else {
      encoded += `_${character.codePointAt(0)?.toString(16) ?? "0"}_`;
    }
  }
  return encoded;
}

function summarizeCell(cell: NotebookOutlineSourceCell, index: number): string {
  const explicitTitle = metadataOutlineTitle(cell.metadata);
  if (explicitTitle) return explicitTitle;

  const source = cell.source ?? "";
  const kind = cellKind(cell);

  if (kind === "code") {
    const sectionTitle = codeSectionCommentTitle(source);
    if (sectionTitle) return sectionTitle;
  }

  const firstLine = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return `${detailLabel(kind)} ${index + 1}`;
  }

  if (kind !== "markdown") {
    return summarizeCodeLikeLine(firstLine);
  }

  return summarizeMarkdownProseLine(firstLine);
}

function metadataOutlineTitle(
  metadata: NotebookOutlineSourceMetadata | null | undefined,
): string | null {
  if (!metadata) return null;

  for (const key of ["title", "heading", "name"] as const) {
    const value = metadata[key];
    if (typeof value !== "string") continue;
    const title = cleanOutlineTitle(value);
    if (title) return title;
  }

  return null;
}

function codeSectionCommentTitle(source: string): string | null {
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(/^(?:#|\/\/|--)\s*(?:%%\s*)?(?:[-=]{2,}\s*)?(.*?)(?:\s*[-=]{2,})?$/);
    if (!match) return null;

    const title = cleanOutlineTitle(match[1]);
    if (!title || isIgnoredCodeCommentTitle(title)) return null;
    return title;
  }

  return null;
}

function isIgnoredCodeCommentTitle(title: string): boolean {
  return /^(?:noqa|type:\s*ignore|pylint|ruff|flake8|fmt:|pragma:)/i.test(title);
}

function summarizeMarkdownProseLine(line: string): string {
  return cleanOutlineTitle(
    line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^>\s*/, "")
      .replace(/^(?:[-*+]|\d+[.)])\s+/, ""),
  );
}

function summarizeCodeLikeLine(line: string): string {
  return truncateOutlineTitle(line.replace(/\s+/g, " ").trim());
}

function cleanOutlineTitle(title: string): string {
  const text = title
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length <= MAX_OUTLINE_TITLE_LENGTH) return text;
  return truncateOutlineTitle(text);
}

function truncateOutlineTitle(text: string): string {
  if (text.length <= MAX_OUTLINE_TITLE_LENGTH) return text;
  return `${text.slice(0, MAX_OUTLINE_TITLE_LENGTH - 1).trimEnd()}...`;
}

function cellKind(cell: NotebookOutlineSourceCell): string {
  return cell.cell_type ?? cell.cellType ?? "cell";
}

function detailLabel(kind: string): string {
  if (kind === "code") return "Code";
  if (kind === "markdown") return "Markdown";
  if (kind === "raw") return "Raw";
  return "Cell";
}
