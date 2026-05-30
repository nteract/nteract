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
  detail?: string | null;
  statusLabel?: string | null;
}

export interface DeriveNotebookOutlineOptions<TCell extends NotebookOutlineSourceCell> {
  getStatusLabel?: (cell: TCell) => string | null | undefined;
  fallbackToCells?: boolean;
}

interface ParsedHeading {
  title: string;
  level: number;
}

const MAX_OUTLINE_TITLE_LENGTH = 96;

export function deriveNotebookOutlineItems<TCell extends NotebookOutlineSourceCell>(
  cells: readonly TCell[],
  options: DeriveNotebookOutlineOptions<TCell> = {},
): NotebookOutlineItem[] {
  const fallbackToCells = options.fallbackToCells ?? true;
  const headings: NotebookOutlineItem[] = [];

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
        statusLabel: options.getStatusLabel?.(cell) ?? null,
      });
    });
  }

  if (headings.length > 0 || !fallbackToCells) {
    return headings;
  }

  return cells.map((cell, index) => {
    const kind = cellKind(cell);
    return {
      id: `${cell.id}:cell`,
      cellId: cell.id,
      title: summarizeCell(cell, index),
      level: 1,
      kind: "cell",
      detail: detailLabel(kind),
      statusLabel: options.getStatusLabel?.(cell) ?? null,
    };
  });
}

export function parseMarkdownHeadings(source: string): ParsedHeading[] {
  const headings: ParsedHeading[] = [];
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
