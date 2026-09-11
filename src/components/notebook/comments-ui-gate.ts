import type { ReactNode } from "react";

export interface CommentsUiSurfaceOptions<SourceHandler, OutputHandler, ActivateHandler> {
  canCreateComments: boolean;
  commentsPanel: ReactNode;
  onCreateSourceComment: SourceHandler;
  onCreateOutputComment: OutputHandler;
  onActivateCommentThread: ActivateHandler;
}

export interface CommentsUiSurface<SourceHandler, OutputHandler, ActivateHandler> {
  commentsPanel: ReactNode | undefined;
  onCreateSourceComment: SourceHandler | undefined;
  onCreateOutputComment: OutputHandler | undefined;
  onActivateCommentThread: ActivateHandler | undefined;
}

export function resolveCommentsUiSurface<SourceHandler, OutputHandler, ActivateHandler>({
  canCreateComments,
  commentsPanel,
  onCreateSourceComment,
  onCreateOutputComment,
  onActivateCommentThread,
}: CommentsUiSurfaceOptions<SourceHandler, OutputHandler, ActivateHandler>): CommentsUiSurface<
  SourceHandler,
  OutputHandler,
  ActivateHandler
> {
  return {
    commentsPanel,
    onCreateSourceComment: canCreateComments ? onCreateSourceComment : undefined,
    onCreateOutputComment: canCreateComments ? onCreateOutputComment : undefined,
    onActivateCommentThread: onActivateCommentThread,
  };
}
