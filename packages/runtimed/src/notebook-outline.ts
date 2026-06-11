/**
 * Host-neutral notebook outline projection.
 *
 * This lives in `runtimed` rather than the rail UI so desktop, cloud, and
 * future document surfaces share one deterministic heading/cell outline shape.
 */
export type NotebookOutlineItemKind = "heading" | "cell" | "output";
export type NotebookOutlineHrefTarget = "cell" | "heading";

export interface NotebookOutlineSourceCell {
  id: string;
  source?: string | null;
  cell_type?: string | null;
  cellType?: string | null;
  execution_count?: number | null;
  metadata?: NotebookOutlineSourceMetadata | null;
  markdownProjection?: NotebookOutlineMarkdownProjection | null;
  outputs?: readonly NotebookOutlineSourceOutput[] | null;
}

export type NotebookOutlineSourceMetadata = Record<string, unknown> & {
  title?: unknown;
  heading?: unknown;
  name?: unknown;
};

export interface NotebookOutlineMarkdownProjection {
  anchors?: readonly NotebookOutlineMarkdownAnchor[] | null;
  runs?: readonly NotebookOutlineMarkdownRun[] | null;
}

export interface NotebookOutlineMarkdownAnchor {
  blockId?: string | null;
  slug: string;
  title: string;
  level: number;
}

export interface NotebookOutlineMarkdownRun {
  blockId?: string | null;
  renderedText?: string | null;
  semantic?: string | null;
  href?: string | null;
  title?: string | null;
}

export interface NotebookOutlineSourceOutput {
  output_id?: string | null;
  output_type?: string | null;
  data?: Record<string, unknown> | null;
}

export interface NotebookOutlineTitleSegment {
  text: string;
  semantic?: string | null;
  href?: string | null;
  title?: string | null;
}

export interface NotebookOutlineImagePreview {
  mimeType: string;
  src: string;
  alt: string;
}

export interface NotebookOutlineItem {
  id: string;
  cellId: string;
  cellType?: string | null;
  outputId?: string | null;
  title: string;
  titleSegments?: readonly NotebookOutlineTitleSegment[];
  level: number;
  kind: NotebookOutlineItemKind;
  cellAnchorId: string;
  outputAnchorId?: string | null;
  headingAnchorId: string | null;
  href: string;
  anchor?: string | null;
  detail?: string | null;
  statusLabel?: string | null;
  imagePreview?: NotebookOutlineImagePreview | null;
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
  getMarkdownAnchors?: (cell: TCell) => readonly NotebookOutlineMarkdownAnchor[] | null | undefined;
  fallbackToCells?: boolean;
  hrefTarget?: NotebookOutlineHrefTarget;
}

export interface NotebookOutlineSelectionInput {
  selectedItemId?: string | null;
  selectedCellId?: string | null;
  cellIds?: readonly string[];
}

const MAX_OUTLINE_TITLE_LENGTH = 96;

export function projectNotebookOutline<TCell extends NotebookOutlineSourceCell>(
  cells: readonly TCell[],
  options: ProjectNotebookOutlineOptions<TCell> = {},
): NotebookOutlineProjection {
  const fallbackToCells = options.fallbackToCells ?? true;
  const hrefTarget = options.hrefTarget ?? "cell";
  const documentItems: NotebookOutlineItem[] = [];
  let headingCount = 0;
  let currentHeadingLevel = 0;

  for (const cell of cells) {
    const kind = cellKind(cell);
    if (!isSourceHiddenForOutline(cell) && kind === "markdown") {
      const parsed = markdownHeadingAnchorsForOutline(cell, options);
      parsed.forEach((heading, index) => {
        const anchor =
          cleanHeadingAnchorSlug(heading.slug) || slugifyNotebookHeading(heading.title);
        const cellAnchorId = notebookCellAnchorId(cell.id);
        const headingAnchorId = notebookHeadingAnchorId(cell.id, anchor);
        const titleSegments = markdownHeadingTitleSegmentsForOutline(cell, heading);
        documentItems.push({
          id: `${cell.id}:heading:${index}`,
          cellId: cell.id,
          title: heading.title,
          ...(titleSegments ? { titleSegments } : {}),
          level: heading.level,
          kind: "heading",
          cellAnchorId,
          headingAnchorId,
          href: notebookOutlineHref(cellAnchorId, headingAnchorId, hrefTarget),
          anchor,
          statusLabel: options.getStatusLabel?.(cell) ?? null,
        });
        headingCount += 1;
        currentHeadingLevel = heading.level;
      });
    }

    if (isOutputsHiddenForOutline(cell)) continue;
    for (const image of rasterImageOutputsForOutline(cell)) {
      const cellAnchorId = notebookCellAnchorId(cell.id);
      const outputAnchorId = notebookOutputAnchorId(cell.id, image.outputAnchor);
      documentItems.push({
        id: `${cell.id}:output:${image.outputAnchor}`,
        cellId: cell.id,
        cellType: kind,
        outputId: image.outputId,
        title: image.title,
        level: currentHeadingLevel === 0 ? 1 : Math.min(6, currentHeadingLevel + 1),
        kind: "output",
        cellAnchorId,
        outputAnchorId,
        headingAnchorId: null,
        href: `#${outputAnchorId}`,
        anchor: null,
        detail: image.detail,
        statusLabel: options.getStatusLabel?.(cell) ?? null,
        imagePreview: image.preview,
      });
    }
  }

  if (documentItems.length > 0) {
    return { items: documentItems, source: headingCount > 0 ? "headings" : "cells" };
  }

  if (!fallbackToCells) {
    return { items: [], source: "empty" };
  }

  const fallbackItems = cells.flatMap((cell, index) => {
    const kind = cellKind(cell);
    if (!shouldIncludeFallbackCell(cell, kind)) return [];

    const cellAnchorId = notebookCellAnchorId(cell.id);
    const detail = fallbackDetailLabel(kind);
    return [
      {
        id: `${cell.id}:cell`,
        cellId: cell.id,
        cellType: kind,
        title: summarizeCell(cell, index),
        level: 1,
        kind: "cell" as const,
        cellAnchorId,
        headingAnchorId: null,
        href: notebookCellAnchorHref(cell.id),
        anchor: null,
        ...(detail ? { detail } : {}),
        statusLabel: options.getStatusLabel?.(cell) ?? null,
      },
    ];
  });

  return {
    source: fallbackItems.length > 0 ? "cells" : "empty",
    items: fallbackItems,
  };
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

export function notebookOutputAnchorId(cellId: string, outputId: string): string {
  return `${notebookCellAnchorId(cellId)}-output-${encodeNotebookAnchorComponent(outputId)}`;
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

function markdownHeadingAnchorsForOutline<TCell extends NotebookOutlineSourceCell>(
  cell: TCell,
  options: ProjectNotebookOutlineOptions<TCell>,
): Array<NotebookOutlineMarkdownAnchor & { title: string; level: number; slug: string }> {
  const anchors = options.getMarkdownAnchors?.(cell) ?? cell.markdownProjection?.anchors ?? [];
  return anchors.flatMap((anchor) => {
    if (!anchor || typeof anchor !== "object") return [];
    const title = typeof anchor.title === "string" ? cleanOutlineTitle(anchor.title) : "";
    const level = normalizeMarkdownHeadingLevel(anchor.level);
    if (!title || level === null) return [];
    return [
      {
        ...anchor,
        title,
        level,
        slug: cleanHeadingAnchorSlug(anchor.slug),
      },
    ];
  });
}

function markdownHeadingTitleSegmentsForOutline(
  cell: NotebookOutlineSourceCell,
  heading: NotebookOutlineMarkdownAnchor,
): NotebookOutlineTitleSegment[] | null {
  if (!heading.blockId) return null;
  const runs = cell.markdownProjection?.runs ?? [];
  const titleSegments = runs.flatMap((run) => {
    if (run.blockId !== heading.blockId) return [];
    const text = typeof run.renderedText === "string" ? run.renderedText : "";
    if (!text) return [];
    const semantic = typeof run.semantic === "string" ? run.semantic : null;
    if (
      semantic === "image" ||
      semantic === "html-fragment" ||
      semantic === "isolated-placeholder"
    ) {
      return [];
    }
    return [
      {
        text,
        ...(semantic ? { semantic } : {}),
        ...(typeof run.href === "string" && run.href ? { href: run.href } : {}),
        ...(typeof run.title === "string" && run.title ? { title: run.title } : {}),
      },
    ];
  });

  if (titleSegments.length === 0) return null;
  const renderedTitle = cleanOutlineTitle(titleSegments.map((segment) => segment.text).join(""));
  return renderedTitle === heading.title ? titleSegments : null;
}

function normalizeMarkdownHeadingLevel(level: unknown): number | null {
  if (typeof level !== "number") return null;
  if (!Number.isInteger(level)) return null;
  return Math.min(6, Math.max(1, level));
}

function cleanHeadingAnchorSlug(slug: unknown): string {
  return typeof slug === "string" ? slug.trim() : "";
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

function shouldIncludeFallbackCell(cell: NotebookOutlineSourceCell, kind: string): boolean {
  if (isSourceHiddenForOutline(cell)) return false;
  if (kind !== "code") return true;
  if (metadataOutlineTitle(cell.metadata)) return true;
  return (cell.source ?? "").trim().length > 0;
}

function isSourceHiddenForOutline(cell: NotebookOutlineSourceCell): boolean {
  const jupyter = cell.metadata?.jupyter;
  if (!isRecord(jupyter)) return false;
  return jupyter.source_hidden === true;
}

function isOutputsHiddenForOutline(cell: NotebookOutlineSourceCell): boolean {
  const jupyter = cell.metadata?.jupyter;
  if (!isRecord(jupyter)) return false;
  return jupyter.outputs_hidden === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const RASTER_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

function rasterImageOutputsForOutline(cell: NotebookOutlineSourceCell): Array<{
  outputAnchor: string;
  outputId: string | null;
  title: string;
  detail: string;
  preview: NotebookOutlineImagePreview;
}> {
  return (cell.outputs ?? []).flatMap((output, index) => {
    if (!output || typeof output !== "object") return [];
    if (output.output_type !== "display_data" && output.output_type !== "execute_result") return [];
    const data = output.data;
    if (!data || typeof data !== "object") return [];
    for (const mimeType of RASTER_IMAGE_MIME_TYPES) {
      const src = imageDataToSrc(data[mimeType], mimeType);
      if (!src) continue;
      const outputId =
        typeof output.output_id === "string" && output.output_id.trim()
          ? output.output_id.trim()
          : null;
      return [
        {
          outputAnchor: outputId ?? String(index),
          outputId,
          title: "Image output",
          detail: mimeLabel(mimeType),
          preview: {
            mimeType,
            src,
            alt: "Image output",
          },
        },
      ];
    }
    return [];
  });
}

function imageDataToSrc(value: unknown, mimeType: string): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^(?:data:|https?:|blob:)/.test(trimmed)) return trimmed;
    return `data:${mimeType};base64,${trimmed.replace(/\s+/g, "")}`;
  }

  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    const joined = value.join("").trim();
    return joined ? `data:${mimeType};base64,${joined.replace(/\s+/g, "")}` : null;
  }

  if (isRecord(value) && typeof value.url === "string" && value.url.trim()) {
    return value.url.trim();
  }

  return null;
}

function mimeLabel(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return "PNG";
    case "image/jpeg":
      return "JPEG";
    case "image/gif":
      return "GIF";
    case "image/webp":
      return "WebP";
    default:
      return "Image";
  }
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

function fallbackDetailLabel(kind: string): string | null {
  if (kind === "code") return null;
  return detailLabel(kind);
}
