/**
 * Bridges the comments projection to the editor highlight extension.
 *
 * Source-range threads are grouped by cell and resolved to live offsets against
 * each editor's current document, then pushed in as decorations. This keeps the
 * derivation in one place (driven by the projection) rather than threading
 * anchor data through every cell component.
 *
 * Two entry points keep editors in sync regardless of mount order:
 *   - `setSourceCommentThreads` — push, called when the projection changes.
 *   - `refreshCellCommentHighlights` — pull, called when a cell's editor mounts
 *     so a late editor picks up highlights that already exist.
 */

import { colorForActorLabel } from "./actor-colors";
import {
  type CommentHighlight,
  setCommentHighlightsEffect,
} from "./comment-highlight-extension";
import { resolveSourceRangeAnchor, type SourceRangeCommentAnchor } from "./comment-source-anchor";
import { getCellEditor } from "./editor-registry";

export interface SourceCommentThread {
  threadId: string;
  anchor: SourceRangeCommentAnchor;
  resolved: boolean;
  /** Actor label of the thread author, used to color the highlight. */
  authorActorLabel: string | null;
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

/** Re-resolve and push highlights for one cell (e.g. when its editor mounts). */
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
      color: thread.authorActorLabel ? colorForActorLabel(thread.authorActorLabel) : undefined,
    });
  }
  view.dispatch({ effects: setCommentHighlightsEffect.of(highlights) });
}
