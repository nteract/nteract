import { Sparkles } from "lucide-react";
import { CompactExecutionButton } from "@/components/cell/CompactExecutionButton";
import { usePromptCellRunState } from "@/components/notebook/state/prompt-state";
import type { PromptRunStatus } from "@/lib/prompt-cells";

const STATUS_LABEL: Record<Exclude<PromptRunStatus, "idle">, { text: string; title: string }> = {
  waiting: { text: "waiting…", title: "Waiting for the cells above to finish" },
  queued: { text: "queued", title: "Waiting for the prompt agent" },
  running: { text: "running…", title: "The agent is answering" },
};

const OUTCOME_LABEL = {
  stopped: { text: "Stopped", title: "The run was stopped; any partial answer was kept" },
  failed: { text: "Failed", title: "The run ended without an answer" },
};

/**
 * Run/Stop control in the prompt cell's state lane, the same control and
 * animation a code cell shows. Any active state (waiting, queued, running)
 * shows as running, so a click stops the prompt before or while it answers.
 */
export function PromptRunControl({
  cellId,
  isCellFocused,
  onRun,
  onStop,
}: {
  cellId: string;
  isCellFocused: boolean;
  /** Undefined disables Run (read-only notebook, no execute capability). */
  onRun?: () => void;
  onStop?: () => void;
}) {
  const run = usePromptCellRunState(cellId);
  const active = run.status !== "idle";
  return (
    <CompactExecutionButton
      count={null}
      isExecuting={active}
      isErrored={run.failed && !run.stopped}
      isCellFocused={isCellFocused}
      // While active the button is Stop, so it needs onStop; idle it needs onRun.
      canExecute={active ? onStop !== undefined : onRun !== undefined}
      onExecute={onRun}
      onInterrupt={onStop}
    />
  );
}

/** Header of a prompt cell: the Prompt label, run state and error text. */
export function PromptCellHeader({ cellId }: { cellId: string }) {
  const run = usePromptCellRunState(cellId);
  const { status, errorMessage } = run;
  const label = status !== "idle" ? STATUS_LABEL[status] : null;
  // A failed run with error text shows the text; without it, how the run ended.
  const outcome =
    run.failed && !errorMessage ? OUTCOME_LABEL[run.stopped ? "stopped" : "failed"] : null;
  const note = label ?? outcome;

  return (
    // notebookEditorTheme pulls .cm-editor up 0.75rem over this row; stack the
    // header above it so the editor does not cover it.
    <div data-slot="prompt-cell-header" data-prompt-status={status} className="relative z-10 py-1">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1 font-medium">
          <Sparkles className="size-3" aria-hidden="true" />
          Prompt
        </span>
        {note ? (
          <span
            role={label ? "status" : undefined}
            title={note.title}
            data-testid={label ? "prompt-status" : "prompt-outcome"}
          >
            {note.text}
          </span>
        ) : null}
      </div>
      {errorMessage ? (
        <p
          role="alert"
          data-testid="prompt-error"
          className="mt-1 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive"
        >
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
