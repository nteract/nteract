import { useEffect, useRef } from "react";
import type { CommentAnchor, CommentsProjection } from "./comment-types";
import { getCellById } from "./state/cell-store";
import {
  getCellExecutionId,
  getExecutionById,
  useExecutionStructureVersion,
} from "./state/execution-store";
import { useOutputStructureVersion } from "./state/output-store";

export type OutputCommentAnchor = Extract<CommentAnchor, { kind: "output" }>;

export interface OutputCommentAnchorRuntimeState {
  cellExists: boolean;
  currentExecutionId: string | null;
  currentOutputIds: readonly string[];
}

export function shouldDemoteOutputCommentAnchor(
  anchor: OutputCommentAnchor,
  state: OutputCommentAnchorRuntimeState,
): boolean {
  if (!state.cellExists) return true;
  if (anchor.execution_id && anchor.execution_id !== state.currentExecutionId) return true;
  if (anchor.output_id && !state.currentOutputIds.includes(anchor.output_id)) return true;
  return false;
}

export function outputCommentAnchorMatchesRuntimeState(
  anchor: OutputCommentAnchor,
  state: OutputCommentAnchorRuntimeState,
): boolean {
  return !shouldDemoteOutputCommentAnchor(anchor, state);
}

export function outputCommentAnchorRuntimeState(
  anchor: OutputCommentAnchor,
): OutputCommentAnchorRuntimeState {
  const cell = getCellById(anchor.cell_id);
  const currentExecutionId = getCellExecutionId(anchor.cell_id);
  const currentExecution = currentExecutionId ? getExecutionById(currentExecutionId) : undefined;
  return {
    cellExists: Boolean(cell),
    currentExecutionId,
    currentOutputIds: currentExecution?.output_ids ?? [],
  };
}

export function outputCommentAnchorMatchesLiveState(anchor: OutputCommentAnchor): boolean {
  return outputCommentAnchorMatchesRuntimeState(anchor, outputCommentAnchorRuntimeState(anchor));
}

interface UseDemoteDetachedOutputCommentThreadsOptions {
  commentsProjection: CommentsProjection | null;
  enabled: boolean;
  demoteThreadToNotebook: (threadId: string) => void;
}

export function useDemoteDetachedOutputCommentThreads({
  commentsProjection,
  enabled,
  demoteThreadToNotebook,
}: UseDemoteDetachedOutputCommentThreadsOptions): void {
  const attemptedThreadIds = useRef(new Set<string>());
  const executionStructureVersion = useExecutionStructureVersion();
  const outputStructureVersion = useOutputStructureVersion();

  useEffect(() => {
    if (!enabled || !commentsProjection) return;
    for (const thread of commentsProjection.threads) {
      if (thread.anchor.kind !== "output") continue;
      if (attemptedThreadIds.current.has(thread.id)) continue;
      if (
        !shouldDemoteOutputCommentAnchor(
          thread.anchor,
          outputCommentAnchorRuntimeState(thread.anchor),
        )
      ) {
        continue;
      }
      attemptedThreadIds.current.add(thread.id);
      demoteThreadToNotebook(thread.id);
    }
  }, [
    commentsProjection,
    demoteThreadToNotebook,
    enabled,
    executionStructureVersion,
    outputStructureVersion,
  ]);
}
