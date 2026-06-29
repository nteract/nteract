import {
  notebookCellAnchorHref,
  notebookCellAnchorId,
  notebookOutputAnchorId,
  projectNotebookOutline,
  type NotebookOutlineItem,
} from "runtimed";
import { resolveMarkdownProjection } from "@/lib/markdown-projection";
import type { NotebookViewCell } from "./view-model";

export type DocumentAnchorId = string;

export type DocumentAnchorKind = "cell" | "markdown_block" | "markdown_heading" | "output";

export interface DocumentAnchor {
  id: DocumentAnchorId;
  kind: DocumentAnchorKind;
  cellId: string;
  cellAnchorId: string;
  domId: string;
  href: string;
  cellType?: NotebookViewCell["cellType"];
  markdownBlockId?: string;
  markdownHeadingAnchorId?: string;
  markdownAnchorSlug?: string | null;
  outlineItemId?: string;
  outputId?: string;
  outputAnchorId?: string;
  sourceSpanUtf16?: readonly [number, number];
}

export interface CreateNotebookDocumentAnchorsOptions {
  outlineItems?: readonly NotebookOutlineItem[];
}

export function createNotebookDocumentAnchors(
  cells: readonly NotebookViewCell[],
  options: CreateNotebookDocumentAnchorsOptions = {},
): readonly DocumentAnchor[] {
  const anchors: DocumentAnchor[] = [];
  const outlineItems = options.outlineItems ?? outlineItemsForDocumentAnchors(cells);

  for (const cell of cells) {
    const cellAnchorId = notebookCellAnchorId(cell.id);
    anchors.push({
      id: cellAnchorId,
      kind: "cell",
      cellId: cell.id,
      cellType: cell.cellType,
      cellAnchorId,
      domId: cellAnchorId,
      href: notebookCellAnchorHref(cell.id),
    });

    const projection = resolveMarkdownProjection(cell.markdownProjection, cell.source);
    for (const block of projection?.blocks ?? []) {
      const blockAnchorId = documentMarkdownBlockAnchorId(cell.id, block.blockId);
      anchors.push({
        id: blockAnchorId,
        kind: "markdown_block",
        cellId: cell.id,
        cellType: cell.cellType,
        cellAnchorId,
        domId: cellAnchorId,
        href: notebookCellAnchorHref(cell.id),
        markdownBlockId: block.blockId,
        sourceSpanUtf16: block.sourceSpanUtf16,
      });
    }

    for (const output of cell.outputs) {
      if (!output.output_id) continue;
      const outputAnchorId = notebookOutputAnchorId(cell.id, output.output_id);
      anchors.push({
        id: outputAnchorId,
        kind: "output",
        cellId: cell.id,
        cellType: cell.cellType,
        cellAnchorId,
        domId: outputAnchorId,
        href: `#${outputAnchorId}`,
        outputAnchorId,
        outputId: output.output_id,
      });
    }
  }

  for (const item of outlineItems) {
    if (item.kind !== "heading" || item.headingAnchorId === null) continue;
    anchors.push({
      id: item.headingAnchorId,
      kind: "markdown_heading",
      cellId: item.cellId,
      cellAnchorId: item.cellAnchorId,
      domId: item.headingAnchorId,
      href: item.href,
      markdownHeadingAnchorId: item.headingAnchorId,
      markdownAnchorSlug: item.anchor ?? null,
      outlineItemId: item.id,
    });
  }

  return anchors;
}

export function createDocumentAnchorMap(
  anchors: readonly DocumentAnchor[],
): ReadonlyMap<DocumentAnchorId, DocumentAnchor> {
  return new Map(anchors.map((anchor) => [anchor.id, anchor]));
}

export function documentAnchorForOutlineItem(
  item: NotebookOutlineItem,
  anchors: readonly DocumentAnchor[],
): DocumentAnchor | null {
  const anchorId = documentAnchorIdForOutlineItem(item);
  return anchors.find((anchor) => anchor.id === anchorId) ?? null;
}

export function documentAnchorIdForOutlineItem(item: NotebookOutlineItem): DocumentAnchorId {
  if (item.kind === "heading" && item.headingAnchorId !== null) {
    return item.headingAnchorId;
  }
  if (item.kind === "output" && item.href.startsWith("#")) {
    return item.href.slice(1);
  }
  return item.cellAnchorId;
}

export function documentMarkdownBlockAnchorId(cellId: string, blockId: string): DocumentAnchorId {
  return `${notebookCellAnchorId(cellId)}-markdown-block-${encodeURIComponent(blockId)}`;
}

function outlineItemsForDocumentAnchors(cells: readonly NotebookViewCell[]): NotebookOutlineItem[] {
  return projectNotebookOutline(cells, {
    hrefTarget: "heading",
    getMarkdownAnchors: (cell) => {
      if (!cell.source.trim()) return [];
      return resolveMarkdownProjection(cell.markdownProjection, cell.source)?.anchors ?? null;
    },
  }).items;
}
