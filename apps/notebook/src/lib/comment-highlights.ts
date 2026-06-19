import {
  type CommentHighlight,
  type CommentHighlightPreview,
  setCommentHighlightsEffect,
} from "./comment-highlight-extension";
import { resolveSourceRangeAnchor, type SourceRangeCommentAnchor } from "./comment-source-anchor";
import { getCellEditor } from "./editor-registry";

export interface SourceCommentThread {
  threadId: string;
  anchor: SourceRangeCommentAnchor;
  resolved: boolean;
  color?: string;
  preview?: CommentHighlightPreview;
}

let threadsByCell = new Map<string, SourceCommentThread[]>();
let dispatchedCells = new Set<string>();

/** Replace the full set of source-comment threads and refresh affected cells. */
export function setSourceCommentThreads(next: Map<string, SourceCommentThread[]>): void {
  threadsByCell = next;
  const affected = new Set<string>([...dispatchedCells, ...next.keys()]);
  for (const cellId of affected) {
    dispatchCell(cellId);
  }
  dispatchedCells = new Set(next.keys());
}

/** Re-resolve and push highlights for one cell after its editor mounts. */
export function refreshCellCommentHighlights(cellId: string): void {
  dispatchCell(cellId);
}

function dispatchCell(cellId: string): void {
  const view = getCellEditor(cellId);
  if (!view) return;

  const threads = threadsByCell.get(cellId) ?? [];
  const source = view.state.doc.toString();
  const highlights: CommentHighlight[] = [];
  for (const thread of threads) {
    const range = resolveSourceRangeAnchor(source, thread.anchor);
    if (!range) continue;
    highlights.push({
      from: range.from,
      to: range.to,
      threadId: thread.threadId,
      resolved: thread.resolved,
      color: thread.color,
      preview: thread.preview,
    });
  }
  view.dispatch({ effects: setCommentHighlightsEffect.of(highlights) });
}
