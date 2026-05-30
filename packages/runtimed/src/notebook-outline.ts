/**
 * Host-neutral notebook outline projection.
 *
 * This lives in `runtimed` rather than the rail UI so desktop, cloud, and
 * future document surfaces share one deterministic heading/cell outline shape.
 */
export type NotebookOutlineItemKind = "heading" | "cell";

export interface NotebookOutlineSourceCell {
  id: string;
  source?: string | null;
  cell_type?: string | null;
  cellType?: string | null;
  execution_count?: number | null;
}

export interface NotebookOutlineItem {
  id: string;
  cellId: string;
  title: string;
  level: number;
  kind: NotebookOutlineItemKind;
  anchor?: string | null;
  detail?: string | null;
  statusLabel?: string | null;
}

export interface NotebookOutlineProjection {
  items: NotebookOutlineItem[];
  source: "headings" | "cells" | "empty";
}

export interface ProjectNotebookOutlineOptions<TCell extends NotebookOutlineSourceCell> {
  getStatusLabel?: (cell: TCell) => string | null | undefined;
  fallbackToCells?: boolean;
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
  const headings: NotebookOutlineItem[] = [];
  const anchorCounts = new Map<string, number>();

  for (const cell of cells) {
    if (cellKind(cell) !== "markdown") continue;
    const parsed = parseMarkdownHeadings(cell.source ?? "");
    parsed.forEach((heading, index) => {
      headings.push({
        id: `${cell.id}:heading:${index}`,
        cellId: cell.id,
        title: heading.title,
        level: heading.level,
        kind: "heading",
        anchor: nextHeadingAnchor(heading.title, anchorCounts),
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
      return {
        id: `${cell.id}:cell`,
        cellId: cell.id,
        title: summarizeCell(cell, index),
        level: 1,
        kind: "cell",
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

export function slugifyNotebookHeading(title: string): string {
  const slug = cleanOutlineTitle(title)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "heading";
}

function nextHeadingAnchor(title: string, anchorCounts: Map<string, number>): string {
  const base = slugifyNotebookHeading(title);
  const count = anchorCounts.get(base) ?? 0;
  anchorCounts.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function summarizeCell(cell: NotebookOutlineSourceCell, index: number): string {
  const source = cell.source ?? "";
  const kind = cellKind(cell);
  const firstLine = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return `${detailLabel(kind)} ${index + 1}`;
  }

  if (kind !== "markdown") {
    return truncateOutlineTitle(firstLine.replace(/\s+/g, " ").trim());
  }

  return cleanOutlineTitle(firstLine.replace(/^#{1,6}\s+/, ""));
}

function cleanOutlineTitle(title: string): string {
  const text = title
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
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
