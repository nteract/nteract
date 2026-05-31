import { Play, Square } from "lucide-react";
import { cn } from "@/lib/utils";

interface CompactExecutionButtonProps {
  /** Execution count - null means never executed */
  count: number | null;
  /** Whether the cell is currently executing */
  isExecuting?: boolean;
  /** Whether the cell is queued for execution */
  isQueued?: boolean;
  /** Whether the latest execution finished with an error */
  isErrored?: boolean;
  /** Authenticated actor label for the client that submitted the active execution */
  submittedByActorLabel?: string | null;
  /** Whether the owning cell currently has notebook focus */
  isCellFocused?: boolean;
  /** Whether execution controls are available in this shell */
  canExecute?: boolean;
  /** Called when user clicks to execute */
  onExecute?: () => void;
  /** Called when user clicks to interrupt */
  onInterrupt?: () => void;
  /** Additional classes */
  className?: string;
}

function formatExecutionCount(count: number): string {
  return count > 999 ? "999" : String(count);
}

/**
 * Compact execution button for the cell state lane.
 *
 * The button keeps execution state visible without reserving the old
 * bracket-counter width in every cell state lane.
 */
export function CompactExecutionButton({
  count,
  isExecuting = false,
  isQueued = false,
  isErrored = false,
  submittedByActorLabel = null,
  isCellFocused = false,
  canExecute = true,
  onExecute,
  onInterrupt,
  className,
}: CompactExecutionButtonProps) {
  const state = isExecuting
    ? "running"
    : isQueued
      ? "queued"
      : isErrored
        ? "error"
        : count !== null
          ? "ran"
          : "idle";
  const displayCount = count === null ? null : formatExecutionCount(count);
  const handleClick = () => {
    if (!canExecute) return;
    if (isQueued) return; // already in queue — no-op
    if (isExecuting) {
      onInterrupt?.();
    } else {
      onExecute?.();
    }
  };

  const title = canExecute
    ? isExecuting
      ? submittedByActorLabel
        ? `Stop execution submitted by ${submittedByActorLabel}`
        : "Stop execution"
      : isQueued
        ? submittedByActorLabel
          ? `Queued for execution by ${submittedByActorLabel}`
          : "Queued for execution"
        : count !== null
          ? isErrored
            ? `Run cell again; last execution ${count} failed`
            : `Run cell again; last execution ${count}`
          : "Run cell"
    : "Execution unavailable";

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        "group/exec inline-flex size-5 items-center justify-center rounded-full",
        "transition-colors duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
        state === "idle" &&
          "text-muted-foreground/35 opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100",
        state === "idle" && isCellFocused && "opacity-70",
        state === "ran" && "text-muted-foreground/45 hover:bg-primary/5 hover:text-primary",
        state === "queued" && "text-sky-600 dark:text-sky-400",
        state === "running" && "text-destructive hover:bg-destructive/10",
        state === "error" && "text-destructive/70 hover:bg-destructive/10 hover:text-destructive",
        isQueued || !canExecute ? "cursor-default" : "cursor-pointer",
        !canExecute && "opacity-35 hover:bg-transparent hover:text-muted-foreground/45",
        className,
      )}
      title={title}
      aria-label={title}
      aria-disabled={isQueued || !canExecute || undefined}
      aria-busy={isExecuting || undefined}
      data-execution-state={state}
      data-execution-count={count ?? undefined}
      data-testid="execute-button"
    >
      {state === "running" ? (
        <Square className="size-2.5 fill-current animate-exec-squish" aria-hidden="true" />
      ) : state === "queued" ? (
        <span
          className="block size-1.5 rounded-full bg-current animate-queue-breathe"
          aria-hidden="true"
        />
      ) : (
        <Play className="size-2.5 fill-current" aria-hidden="true" />
      )}
      {state === "ran" && displayCount !== null ? (
        <span className="sr-only">Last run {displayCount}</span>
      ) : null}
    </button>
  );
}
