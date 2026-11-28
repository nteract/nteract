import { CornerDownRight, Sparkles, Square } from "lucide-react";
import { type ReactNode, useSyncExternalStore } from "react";
import { CellContainer, CellGutterToneContext } from "@/components/cell/CellContainer";
import { cellContentColumnInset } from "@/components/cell/cell-layout";
import {
  useIsCellFocused,
  useIsNextCellFromFocused,
  useIsPreviousCellFromFocused,
} from "@/components/notebook/state/cell-ui-state";
import { getCellById, subscribeIds } from "@/components/notebook/state/cell-store";
import { useExecutionOutputs } from "@/components/notebook/state/output-store";
import { usePromptAnswerLive } from "@/components/notebook/state/prompt-state";
import { canRenderMarkdownProjectionInHost, projectMarkdownPlan } from "@/lib/markdown-projection";
import { promptMarkdownText } from "@/lib/prompt-cells";
import { cn } from "@/lib/utils";
import { ProjectedMarkdownView } from "./markdown/ProjectedMarkdownView";

/**
 * Small "answer to ✦" line for an answer cell. `inset` aligns it with the
 * content column when it sits above a cell rendered by its own component.
 */
export function PromptAnswerLabel({
  stopped,
  onJumpToPrompt,
  inset,
}: {
  /** The run was stopped; the cell holds only the partial text. */
  stopped?: boolean;
  /** Scroll to the prompt cell this answer belongs to. */
  onJumpToPrompt?: () => void;
  inset?: boolean;
}) {
  return (
    <div
      data-slot="prompt-answer-label"
      className={cn(
        "flex items-center gap-2 py-0.5 text-xs text-muted-foreground",
        inset && cn("pr-3", cellContentColumnInset),
      )}
    >
      <button
        type="button"
        tabIndex={-1}
        onClick={onJumpToPrompt}
        disabled={!onJumpToPrompt}
        title="Go to the prompt"
        className="flex items-center gap-1 rounded-md transition-colors hover:text-foreground focus-visible:ring-1 ring-ring disabled:hover:text-muted-foreground"
      >
        <CornerDownRight className="size-3" aria-hidden="true" />
        answer to
        <Sparkles className="size-3" aria-hidden="true" />
      </button>
      {stopped ? (
        <span
          data-testid="prompt-answer-stopped"
          className="flex items-center gap-1"
          title="The run was stopped; this is the partial answer"
        >
          <Square className="size-2.5" aria-hidden="true" />
          stopped
        </span>
      ) : null}
    </div>
  );
}

/** Whether the prompt cell still exists; follows structural changes only, not edits. */
function usePromptCellExists(promptCellId: string | null): boolean {
  return useSyncExternalStore(subscribeIds, () =>
    promptCellId ? getCellById(promptCellId) !== undefined : false,
  );
}

/**
 * Frame of a finished answer cell: the "answer to" label and the prompt's
 * output-style gutter. Once its prompt is deleted the answer is an ordinary
 * cell and renders without either.
 */
export function PromptAnswerFrame({
  promptCellId,
  stopped,
  onJumpToPrompt,
  children,
}: {
  promptCellId: string | null;
  stopped?: boolean;
  onJumpToPrompt?: () => void;
  children: ReactNode;
}) {
  const promptExists = usePromptCellExists(promptCellId);
  if (!promptExists) return <>{children}</>;
  return (
    <CellGutterToneContext.Provider value="promptAnswer">
      <PromptAnswerLabel inset stopped={stopped} onJumpToPrompt={onJumpToPrompt} />
      {children}
    </CellGutterToneContext.Provider>
  );
}

/** Live answer text, rendered as markdown from the execution's `text/markdown` output. */
function PromptAnswerStreamBody({ executionId }: { executionId: string | null }) {
  const text = promptMarkdownText(useExecutionOutputs(executionId));
  const plan = text ? projectMarkdownPlan(text) : null;
  return (
    <div
      data-testid="prompt-answer-stream"
      aria-live="polite"
      aria-busy="true"
      className="relative py-2"
    >
      {!text ? (
        <p className="text-muted-foreground italic">Thinking…</p>
      ) : plan && canRenderMarkdownProjectionInHost(plan) ? (
        <ProjectedMarkdownView plan={plan} />
      ) : (
        <p className="whitespace-pre-wrap text-sm">{text}</p>
      )}
    </div>
  );
}

/**
 * Placeholder answer cell while the agent answers: shows the execution's live
 * markdown read-only in place of the still empty source. Once there is nothing
 * live left to show (crash, restart, deleted execution) it renders `fallback`,
 * so a placeholder can never stay a "Thinking..." stub.
 */
export function PromptAnswerStreamCell({
  cellId,
  promptCellId,
  executionId,
  hasSource,
  fallback,
  onFocus,
  onJumpToPrompt,
  dragHandleProps,
  isDragging,
  rightGutterContent,
}: {
  cellId: string;
  promptCellId: string | null;
  executionId: string | null;
  /** The placeholder cell already holds answer text in its source. */
  hasSource: boolean;
  /** The ordinary cell, shown once the live view is over. */
  fallback: ReactNode;
  onFocus: () => void;
  onJumpToPrompt?: () => void;
  dragHandleProps?: Record<string, unknown>;
  isDragging?: boolean;
  rightGutterContent?: ReactNode;
}) {
  const live = usePromptAnswerLive(executionId, hasSource);
  const isFocused = useIsCellFocused(cellId);
  const isPreviousCellFromFocused = useIsPreviousCellFromFocused(cellId);
  const isNextCellFromFocused = useIsNextCellFromFocused(cellId);
  const promptExists = usePromptCellExists(promptCellId);
  if (!live) return <>{fallback}</>;
  // Like PromptAnswerFrame: label and prompt tone only while the prompt exists.
  const cell = (
    <CellContainer
      id={cellId}
      cellType="markdown"
      isFocused={isFocused}
      isPreviousCellFromFocused={isPreviousCellFromFocused}
      isNextCellFromFocused={isNextCellFromFocused}
      onFocus={onFocus}
      dragHandleProps={dragHandleProps}
      isDragging={isDragging}
      rightGutterContent={rightGutterContent}
      codeContent={
        <>
          {promptExists ? <PromptAnswerLabel onJumpToPrompt={onJumpToPrompt} /> : null}
          <PromptAnswerStreamBody executionId={executionId} />
        </>
      }
    />
  );
  return promptExists ? (
    <CellGutterToneContext.Provider value="promptAnswer">{cell}</CellGutterToneContext.Provider>
  ) : (
    cell
  );
}
