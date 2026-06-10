import { Play, Square } from "lucide-react";
import {
  notebookActorIdentityFromProjection,
  notebookActorProjectionFromLabel,
} from "@/components/notebook/actor-projection";
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
  /** Whether the latest execution was cancelled without running */
  isCancelled?: boolean;
  /** Authenticated actor label for the client that submitted the active execution */
  submittedByActorLabel?: string | null;
  /** Whether the owning cell currently has notebook focus */
  isCellFocused?: boolean;
  /** Whether execution controls are available in this shell */
  canExecute?: boolean;
  /** Whether disabled historical execution state should still render as status */
  showReadoutWhenDisabled?: boolean;
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

function submittedByDisplayLabel(actorLabel: string | null): string | null {
  if (!actorLabel) return null;
  return notebookActorIdentityFromProjection(notebookActorProjectionFromLabel(actorLabel)).label;
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
  isCancelled = false,
  submittedByActorLabel = null,
  isCellFocused = false,
  canExecute = true,
  showReadoutWhenDisabled = false,
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
        : isCancelled
          ? "cancelled"
          : count !== null
            ? "ran"
            : "idle";
  const displayCount = count === null ? null : formatExecutionCount(count);
  const submittedByLabel = submittedByDisplayLabel(submittedByActorLabel);
  const handleClick = () => {
    if (!canExecute) return;
    if (isQueued) return; // already in queue — no-op
    if (isExecuting) {
      onInterrupt?.();
    } else {
      onExecute?.();
    }
  };

  const readoutTitle = isExecuting
    ? submittedByLabel
      ? `Execution running; submitted by ${submittedByLabel}`
      : "Execution running"
    : isQueued
      ? submittedByLabel
        ? `Queued for execution by ${submittedByLabel}`
        : "Queued for execution"
      : state === "cancelled"
        ? "Last execution was cancelled before it ran"
        : count !== null
          ? isErrored
            ? `Last execution ${count} failed`
            : `Last execution ${count}`
          : "Execution unavailable";
  const title = canExecute
    ? isExecuting
      ? submittedByLabel
        ? `Stop execution submitted by ${submittedByLabel}`
        : "Stop execution"
      : isQueued
        ? submittedByLabel
          ? `Queued for execution by ${submittedByLabel}`
          : "Queued for execution"
        : state === "cancelled"
          ? "Run cell; last execution was cancelled before it ran"
          : count !== null
            ? isErrored
              ? `Run cell again; last execution ${count} failed`
              : `Run cell again; last execution ${count}`
            : "Run cell"
    : readoutTitle;
  const classNameValue = cn(
    "group/exec inline-flex size-5 items-center justify-center rounded-full",
    "transition-colors duration-150",
    canExecute && "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
    state === "idle" &&
      "text-muted-foreground/35 opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100",
    state === "idle" && isCellFocused && "opacity-70",
    state === "ran" && "text-muted-foreground/45 hover:bg-primary/5 hover:text-primary",
    state === "queued" && "text-sky-600 dark:text-sky-400",
    state === "running" && "text-destructive hover:bg-destructive/10",
    state === "error" && "text-destructive/70 hover:bg-destructive/10 hover:text-destructive",
    state === "cancelled" && "text-muted-foreground/45 hover:bg-muted hover:text-foreground",
    isQueued || !canExecute ? "cursor-default" : "cursor-pointer",
    !canExecute && "opacity-65 hover:bg-transparent hover:text-muted-foreground/45",
    className,
  );
  const disabledHistoricalState =
    !canExecute && (state === "ran" || state === "error" || state === "cancelled");
  const content =
    disabledHistoricalState && showReadoutWhenDisabled && displayCount !== null ? (
      <span className="text-[10px] font-medium tabular-nums" aria-hidden="true">
        {displayCount}
      </span>
    ) : state === "running" ? (
      <Square className="size-2.5 fill-current animate-exec-squish" aria-hidden="true" />
    ) : state === "queued" ? (
      <span
        className="block size-1.5 rounded-full bg-current animate-queue-breathe"
        aria-hidden="true"
      />
    ) : (
      <Play className="size-2.5 fill-current" aria-hidden="true" />
    );

  if (!canExecute) {
    if (disabledHistoricalState && !showReadoutWhenDisabled) {
      return null;
    }

    return (
      <span
        className={classNameValue}
        title={title}
        aria-label={title}
        aria-busy={isExecuting || undefined}
        data-execution-state={state}
        data-execution-count={count ?? undefined}
        data-testid="execution-readout"
        role="status"
      >
        {content}
        {state === "ran" && displayCount !== null ? (
          <span className="sr-only">Last run {displayCount}</span>
        ) : null}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={classNameValue}
      title={title}
      aria-label={title}
      aria-disabled={isQueued || undefined}
      aria-busy={isExecuting || undefined}
      data-execution-state={state}
      data-execution-count={count ?? undefined}
      data-testid="execute-button"
    >
      {content}
      {state === "ran" && displayCount !== null ? (
        <span className="sr-only">Last run {displayCount}</span>
      ) : null}
    </button>
  );
}
