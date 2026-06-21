import type { ReactNode } from "react";

export interface CommentsUiSurfaceOptions<SourceHandler, OutputHandler, ActivateHandler> {
  commentsUiEnabled: boolean;
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
  commentsUiEnabled,
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
  const canShowCreateAffordances = commentsUiEnabled && canCreateComments;
  return {
    commentsPanel: commentsUiEnabled ? commentsPanel : undefined,
    onCreateSourceComment: canShowCreateAffordances ? onCreateSourceComment : undefined,
    onCreateOutputComment: canShowCreateAffordances ? onCreateOutputComment : undefined,
    onActivateCommentThread: commentsUiEnabled ? onActivateCommentThread : undefined,
  };
}
