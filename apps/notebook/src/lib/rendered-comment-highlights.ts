import type { MarkdownCommentHighlight } from "@/components/markdown/ProjectedMarkdownView";
import type { SourceCommentThread } from "./comment-highlights";
import { resolveSourceRangeAnchor, type SourceRangeCommentAnchor } from "./comment-source-anchor";

export const PENDING_RENDERED_COMMENT_HIGHLIGHT_COLOR =
  "var(--comment-author-color, var(--primary, #2563eb))";

interface RenderedCommentHighlightOptions {
  cellId: string;
  source: string;
  editing: boolean;
  projectionMatchesPreview: boolean;
  commentThreads?: readonly SourceCommentThread[];
  pendingCommentAnchor?: SourceRangeCommentAnchor | null;
}

export function buildRenderedCommentHighlights({
  cellId,
  source,
  editing,
  projectionMatchesPreview,
  commentThreads,
  pendingCommentAnchor,
}: RenderedCommentHighlightOptions): MarkdownCommentHighlight[] | undefined {
  if (editing || !projectionMatchesPreview) return undefined;

  const highlights: MarkdownCommentHighlight[] = [];
  for (const thread of commentThreads ?? []) {
    // Resolved threads leave no rendered highlight; they stay in the rail
    // under "Show resolved".
    if (thread.resolved) continue;
    const range = resolveSourceRangeAnchor(source, thread.anchor);
    if (!range) continue;
    highlights.push({
      from: range.from,
      to: range.to,
      threadId: thread.threadId,
      resolved: thread.resolved,
      ...(thread.color ? { color: thread.color } : {}),
    });
  }

  if (pendingCommentAnchor?.cell_id === cellId) {
    const range = resolveSourceRangeAnchor(source, pendingCommentAnchor);
    if (range) {
      highlights.push({
        from: range.from,
        to: range.to,
        resolved: false,
        pending: true,
        color: PENDING_RENDERED_COMMENT_HIGHLIGHT_COLOR,
      });
    }
  }

  return highlights.length > 0 ? highlights : undefined;
}
