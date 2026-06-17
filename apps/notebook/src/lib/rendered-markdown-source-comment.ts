import {
  sourceRangeAnchorFromOffsets,
  type SourceRangeCommentAnchor,
} from "./comment-source-anchor";

export const MARKDOWN_SOURCE_RUN_SELECTOR = "[data-markdown-source-run='true']";

interface SourceRunElement extends HTMLElement {
  dataset: DOMStringMap & {
    renderedEnd?: string;
    renderedStart?: string;
    sourceEnd?: string;
    sourceStart?: string;
  };
}

interface SelectionPoint {
  element: SourceRunElement;
  offset: number;
}

export function sourceRangeAnchorFromRenderedMarkdownSelection(
  cellId: string,
  source: string,
  root: HTMLElement,
  selection: Selection | null,
): SourceRangeCommentAnchor | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  if (selection.toString().trim().length === 0) return null;

  const start = selectionPointForRangeBoundary(root, range.startContainer, range.startOffset);
  const end = selectionPointForRangeBoundary(root, range.endContainer, range.endOffset);
  if (!start || !end) return null;

  const from = sourceOffsetForRenderedPoint(start, "start");
  const to = sourceOffsetForRenderedPoint(end, "end");
  if (from === null || to === null) return null;

  return sourceRangeAnchorFromOffsets(cellId, source, from, to);
}

function selectionPointForRangeBoundary(
  root: HTMLElement,
  node: Node,
  nodeOffset: number,
): SelectionPoint | null {
  const element =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : (node.parentElement as Element | null);
  const runElement = element?.closest(MARKDOWN_SOURCE_RUN_SELECTOR) as SourceRunElement | null;
  if (!runElement || !root.contains(runElement)) return null;

  const offset = textOffsetWithin(runElement, node, nodeOffset);
  if (offset === null) return null;
  return { element: runElement, offset };
}

function textOffsetWithin(root: HTMLElement, node: Node, nodeOffset: number): number | null {
  const ownerDocument = root.ownerDocument;
  try {
    const range = ownerDocument.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, nodeOffset);
    return range.toString().length;
  } catch {
    return null;
  }
}

function sourceOffsetForRenderedPoint(
  point: SelectionPoint,
  edge: "start" | "end",
): number | null {
  const sourceStart = numberDatasetValue(point.element.dataset.sourceStart);
  const sourceEnd = numberDatasetValue(point.element.dataset.sourceEnd);
  const renderedStart = numberDatasetValue(point.element.dataset.renderedStart);
  const renderedEnd = numberDatasetValue(point.element.dataset.renderedEnd);
  if (
    sourceStart === null ||
    sourceEnd === null ||
    renderedStart === null ||
    renderedEnd === null ||
    sourceEnd < sourceStart ||
    renderedEnd < renderedStart
  ) {
    return null;
  }

  const renderedLength = renderedEnd - renderedStart;
  const sourceLength = sourceEnd - sourceStart;
  const offset = Math.min(renderedLength, Math.max(0, point.offset));
  if (renderedLength === sourceLength) {
    return sourceStart + offset;
  }

  if (offset <= 0) return sourceStart;
  if (offset >= renderedLength) return sourceEnd;
  return edge === "start" ? sourceStart : sourceEnd;
}

function numberDatasetValue(value: string | undefined): number | null {
  if (value === undefined || value.trim().length === 0) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return null;
  return parsed;
}
