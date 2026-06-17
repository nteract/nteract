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

  return sourceRangeAnchorFromOffsets(
    cellId,
    view.state.doc.toString(),
    from,
    to,
    contextChars,
    maxExactQuoteBytes,
  );
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
