import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { CommentAnchor } from "runtimed";

export type SourceRangeCommentAnchor = Extract<CommentAnchor, { kind: "source_range" }>;

/**
 * Viewport-space rectangle bounding a comment-worthy selection. Used to anchor
 * the inline comment composer next to the text the comment is about, the same
 * way Google Docs floats its composer beside the selection.
 */
export interface SourceCommentSelectionRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const DEFAULT_CONTEXT_CHARS = 40;
export const MAX_SOURCE_COMMENT_EXACT_QUOTE_BYTES = 4096;
const utf8Encoder = new TextEncoder();

export interface SourcePoint {
  line: number;
  column: number;
}

export function sourcePointFromOffset(doc: Text, offset: number): SourcePoint {
  const line = doc.lineAt(offset);
  return {
    line: line.number - 1,
    column: offset - line.from,
  };
}

export function sourceRangeAnchorFromSelection(
  cellId: string,
  view: EditorView,
  contextChars = DEFAULT_CONTEXT_CHARS,
  maxExactQuoteBytes = MAX_SOURCE_COMMENT_EXACT_QUOTE_BYTES,
): SourceRangeCommentAnchor | null {
  const selection = view.state.selection.main;
  const from = Math.min(selection.anchor, selection.head);
  const to = Math.max(selection.anchor, selection.head);
  if (from === to) return null;

  return sourceRangeAnchorFromOffsets(
    cellId,
    view.state.doc.toString(),
    from,
    to,
    contextChars,
    maxExactQuoteBytes,
  );
}

/**
 * Bounding rectangle of the current selection in viewport coordinates, or null
 * when the selection is empty or off-screen. Spans the full selection so the
 * composer can anchor to the whole highlighted run, not just the caret.
 */
export function selectionRectFromView(view: EditorView): SourceCommentSelectionRect | null {
  const selection = view.state.selection.main;
  const from = Math.min(selection.anchor, selection.head);
  const to = Math.max(selection.anchor, selection.head);
  if (from === to) return null;

  const startCoords = view.coordsAtPos(from);
  const endCoords = view.coordsAtPos(to);
  if (!startCoords || !endCoords) return null;

  return {
    left: Math.min(startCoords.left, endCoords.left),
    top: Math.min(startCoords.top, endCoords.top),
    right: Math.max(startCoords.right, endCoords.right),
    bottom: Math.max(startCoords.bottom, endCoords.bottom),
  };
}

/**
 * Bounding rectangle of a DOM selection in viewport coordinates, or null when
 * the selection is empty or has no geometry. Used by the rendered-markdown
 * comment path, which selects in HTML rather than a CodeMirror editor.
 */
export function selectionRectFromDomSelection(
  selection: Selection | null,
): SourceCommentSelectionRect | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

/** Convert a DOM rect (e.g. from an element) to a selection rect. */
export function selectionRectFromDomRect(rect: DOMRect): SourceCommentSelectionRect {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

export function sourcePointFromStringOffset(source: string, offset: number): SourcePoint {
  const normalizedOffset = Math.min(source.length, Math.max(0, offset));
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < normalizedOffset; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return {
    line,
    column: normalizedOffset - lineStart,
  };
}

export function sourceRangeAnchorFromOffsets(
  cellId: string,
  source: string,
  fromOffset: number,
  toOffset: number,
  contextChars = DEFAULT_CONTEXT_CHARS,
  maxExactQuoteBytes = MAX_SOURCE_COMMENT_EXACT_QUOTE_BYTES,
): SourceRangeCommentAnchor | null {
  const from = Math.min(fromOffset, toOffset);
  const to = Math.max(fromOffset, toOffset);
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to > source.length ||
    from === to
  ) {
    return null;
  }

  const exactQuote = source.slice(from, to);
  if (
    exactQuote.trim().length === 0 ||
    utf8Encoder.encode(exactQuote).length > maxExactQuoteBytes
  ) {
    return null;
  }

  const start = sourcePointFromStringOffset(source, from);
  const end = sourcePointFromStringOffset(source, to);

  return {
    kind: "source_range",
    cell_id: cellId,
    start_line: start.line,
    start_column: start.column,
    end_line: end.line,
    end_column: end.column,
    prefix_quote: source.slice(Math.max(0, from - contextChars), from),
    exact_quote: exactQuote,
    suffix_quote: source.slice(to, Math.min(source.length, to + contextChars)),
  };
}

/** Character offset for a zero-based (line, column) point in `source`. */
export function offsetFromSourcePoint(source: string, line: number, column: number): number {
  let offset = 0;
  let currentLine = 0;
  while (currentLine < line && offset < source.length) {
    const newline = source.indexOf("\n", offset);
    if (newline === -1) {
      offset = source.length;
      break;
    }
    offset = newline + 1;
    currentLine += 1;
  }
  return Math.min(source.length, offset + Math.max(0, column));
}

export interface ResolvedSourceRange {
  from: number;
  to: number;
}

/**
 * Resolve a stored source-range anchor to live character offsets in the current
 * source, repairing the position when the document has shifted since the
 * comment was created.
 *
 * Strategy: trust the stored line/column when the text there still equals the
 * exact quote. Otherwise search for the quote and pick the occurrence whose
 * neighbouring text best matches the stored prefix/suffix, breaking ties by
 * proximity to the original offset. Returns null when the quoted text is gone,
 * which the caller treats as "the anchored text no longer exists."
 */
export function resolveSourceRangeAnchor(
  source: string,
  anchor: SourceRangeCommentAnchor,
): ResolvedSourceRange | null {
  const quote = anchor.exact_quote ?? "";
  if (quote.length === 0) return null;

  const expectedFrom = offsetFromSourcePoint(source, anchor.start_line, anchor.start_column);
  if (source.slice(expectedFrom, expectedFrom + quote.length) === quote) {
    return { from: expectedFrom, to: expectedFrom + quote.length };
  }

  const occurrences: number[] = [];
  for (let index = source.indexOf(quote); index !== -1; index = source.indexOf(quote, index + 1)) {
    occurrences.push(index);
  }
  if (occurrences.length === 0) return null;
  if (occurrences.length === 1) {
    return { from: occurrences[0], to: occurrences[0] + quote.length };
  }

  const prefix = anchor.prefix_quote ?? "";
  const suffix = anchor.suffix_quote ?? "";
  let best = occurrences[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const index of occurrences) {
    const before = source.slice(Math.max(0, index - prefix.length), index);
    const after = source.slice(index + quote.length, index + quote.length + suffix.length);
    let score = 0;
    if (prefix.length > 0 && before.endsWith(prefix)) score += 2;
    if (suffix.length > 0 && after.startsWith(suffix)) score += 2;
    // Proximity to the original offset breaks ties (closer is better).
    score -= Math.abs(index - expectedFrom) / Math.max(1, source.length);
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  }
  return { from: best, to: best + quote.length };
}
