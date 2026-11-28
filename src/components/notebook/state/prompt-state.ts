import { useMemo } from "react";
import {
  derivePromptRunView,
  promptErrorMessage,
  promptMarkdownText,
  promptStoppedMarker,
  type PromptRunView,
} from "@/lib/prompt-cells";
import { useCellExecutionId, useExecution } from "./execution-store";
import { useExecutionOutputs } from "./output-store";

interface PromptCellRunState extends PromptRunView {
  /** Error text of a failed run that produced no answer. */
  errorMessage: string | null;
  /** The failed run was stopped by the user (output marker `nteract.prompt_stopped`). */
  stopped: boolean;
}

/** Run state of a prompt cell, read through its execution pointer like a code cell's. */
export function usePromptCellRunState(cellId: string): PromptCellRunState {
  const executionId = useCellExecutionId(cellId);
  const execution = useExecution(executionId);
  const view = useMemo(() => derivePromptRunView(execution), [execution]);
  // Outputs only explain a failed run; subscribing otherwise would re-render
  // the header on every streaming rewrite.
  const outputs = useExecutionOutputs(view.failed ? executionId : null);
  return {
    ...view,
    errorMessage: view.failed ? promptErrorMessage(outputs) : null,
    stopped: view.failed && promptStoppedMarker(outputs),
  };
}

/**
 * Whether a streaming answer placeholder renders the execution's live markdown
 * (false: render the ordinary cell). Live while the execution is queued or
 * running; after it ended, only until its text landed in the cell source. A
 * missing or terminal execution without text never leaves a "Thinking..." stub.
 */
export function usePromptAnswerLive(executionId: string | null, hasSource: boolean): boolean {
  const execution = useExecution(executionId);
  const active = execution?.status === "queued" || execution?.status === "running";
  const outputs = useExecutionOutputs(execution && !active && !hasSource ? executionId : null);
  return active || (!!execution && !hasSource && promptMarkdownText(outputs) !== "");
}
