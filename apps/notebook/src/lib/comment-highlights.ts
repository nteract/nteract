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
let dispatchScheduled = false;
const pendingDispatchCells = new Set<string>();

/** Replace the full set of source-comment threads and refresh affected cells. */
export function setSourceCommentThreads(next: Map<string, SourceCommentThread[]>): void {
  threadsByCell = next;
  const affected = new Set<string>([...dispatchedCells, ...next.keys()]);
  for (const cellId of affected) {
    scheduleCellDispatch(cellId);
  }
  dispatchedCells = new Set(next.keys());
}

/** Re-resolve and push highlights for one cell after its editor mounts. */
export function refreshCellCommentHighlights(cellId: string): void {
  scheduleCellDispatch(cellId);
}

function scheduleCellDispatch(cellId: string): void {
  pendingDispatchCells.add(cellId);
  if (dispatchScheduled) return;
  dispatchScheduled = true;
  queueMicrotask(flushPendingDispatches);
}

function flushPendingDispatches(): void {
  dispatchScheduled = false;
  const cellIds = [...pendingDispatchCells];
  pendingDispatchCells.clear();
  for (const cellId of cellIds) {
    dispatchCell(cellId);
  }
}

function dispatchCell(cellId: string): void {
  const view = getCellEditor(cellId);
  if (!view) return;

  const threads = threadsByCell.get(cellId) ?? [];
  const source = view.state.doc.toString();
  const highlights: CommentHighlight[] = [];
  for (const thread of threads) {
    // Resolved threads leave no highlight in the document. They stay reachable
    // under "Show resolved" in the rail, but the inline mark goes away.
    if (thread.resolved) continue;
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
