import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { CommentAnchor } from "runtimed";

export type SourceRangeCommentAnchor = Extract<CommentAnchor, { kind: "source_range" }>;

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

  const doc = view.state.doc;
  const exactQuote = doc.sliceString(from, to);
  if (
    exactQuote.trim().length === 0 ||
    utf8Encoder.encode(exactQuote).length > maxExactQuoteBytes
  ) {
    return null;
  }

  const start = sourcePointFromOffset(doc, from);
  const end = sourcePointFromOffset(doc, to);

  return {
    kind: "source_range",
    cell_id: cellId,
    start_line: start.line,
    start_column: start.column,
    end_line: end.line,
    end_column: end.column,
    prefix_quote: doc.sliceString(Math.max(0, from - contextChars), from),
    exact_quote: exactQuote,
    suffix_quote: doc.sliceString(to, Math.min(doc.length, to + contextChars)),
  };
}
