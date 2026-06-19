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
  // Only demote on positive evidence that the anchored execution is gone.
  // Absence of data is "not loaded yet", never "detached": during a reconnect or
  // notebook switch the comments projection is preserved while the cell and
  // execution stores momentarily reset to empty. Treating that emptiness as
  // detachment would permanently demote a valid comment and sync the wrong
  // anchor to every peer. A genuinely deleted cell keeps its (now inert) anchor.
  if (!state.cellExists) return false;
  // Need a loaded current execution to compare against; null means the runtime
  // state has not bootstrapped yet.
  if (state.currentExecutionId === null) return false;
  if (anchor.execution_id) {
    // Pinned to an execution: demote once that execution is replaced by a re-run,
    // or once the specific output is gone from that still-current execution.
    if (anchor.execution_id !== state.currentExecutionId) return true;
    if (anchor.output_id && !state.currentOutputIds.includes(anchor.output_id)) return true;
    return false;
  }
  // No execution pinned (a cell-outputs-level anchor): never demote on output id
  // alone, because the current execution's outputs are a different run than the
  // one the comment was made against. The create path always pins an execution,
  // so this is a guard against a future unpinned anchor, not today's behavior.
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
  /** Returns true once the demote has committed. A false result is retried on
   *  the next execution/output change, so a transient failure never strands a
   *  thread in the wrong state. */
  demoteThreadToNotebook: (threadId: string) => boolean;
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
      // Mark attempted only after the demote commits, so a failed write is
      // retried on the next structure-version bump instead of being silenced.
      if (demoteThreadToNotebook(thread.id)) {
        attemptedThreadIds.current.add(thread.id);
      }
    }
  }, [
    commentsProjection,
    demoteThreadToNotebook,
    enabled,
    executionStructureVersion,
    outputStructureVersion,
  ]);
}
