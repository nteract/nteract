import { Play, Square } from "lucide-react";
import { cn } from "@/lib/utils";

interface CompactExecutionButtonProps {
  /** Execution count - null means never executed */
  count: number | null;
  /** Whether the cell is currently executing */
  isExecuting?: boolean;
  /** Whether the cell is queued for execution */
  isQueued?: boolean;
  /** Authenticated actor label for the client that submitted the active execution */
  submittedByActorLabel?: string | null;
  /** Whether the owning cell currently has notebook focus */
  isCellFocused?: boolean;
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
  submittedByActorLabel = null,
  isCellFocused = false,
  onExecute,
  onInterrupt,
  className,
}: CompactExecutionButtonProps) {
  const state = isExecuting ? "running" : isQueued ? "queued" : count !== null ? "ran" : "idle";
  const displayCount = count === null ? null : formatExecutionCount(count);
  const handleClick = () => {
    if (isQueued) return; // already in queue — no-op
    if (isExecuting) {
      onInterrupt?.();
    } else {
      onExecute?.();
    }
  };

  const title = isExecuting
    ? submittedByActorLabel
      ? `Stop execution submitted by ${submittedByActorLabel}`
      : "Stop execution"
    : isQueued
      ? submittedByActorLabel
        ? `Queued for execution by ${submittedByActorLabel}`
        : "Queued for execution"
      : count !== null
        ? `Run cell again; last execution ${count}`
        : "Run cell";

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        "group/exec inline-flex h-6 min-w-9 items-center justify-end rounded-sm",
        "font-mono text-[11px] leading-none tabular-nums",
        "transition-colors duration-150",
        "focus-visible:outline-none focus-visible:text-primary",
        state === "idle" &&
          "text-muted-foreground/45 opacity-0 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100",
        state === "idle" && isCellFocused && "opacity-100",
        state === "ran" && "text-muted-foreground/70 hover:text-primary",
        state === "queued" && "text-sky-600 dark:text-sky-400",
        state === "running" && "text-destructive",
        isQueued ? "cursor-default" : "cursor-pointer",
        className,
      )}
      title={title}
      aria-label={title}
      aria-disabled={isQueued || undefined}
      aria-busy={isExecuting || undefined}
      data-execution-state={state}
      data-execution-count={count ?? undefined}
      data-testid="execute-button"
    >
      <span className="relative inline-flex min-w-[5ch] items-center justify-end">
        {state === "running" ? (
          <span className="inline-flex items-center gap-0">
            <span className="text-muted-foreground/50">[</span>
            <Square className="size-2.5 fill-current animate-exec-squish" aria-hidden="true" />
            <span className="text-muted-foreground/50">]</span>
          </span>
        ) : state === "queued" ? (
          <span className="inline-flex items-center gap-0">
            <span className="text-muted-foreground/50">[</span>
            <span
              className="mx-[0.2ch] block size-1.5 rounded-full bg-current animate-queue-breathe"
              aria-hidden="true"
            />
            <span className="text-muted-foreground/50">]</span>
          </span>
        ) : state === "ran" && displayCount !== null ? (
          <>
            <span className="transition-opacity group-hover/exec:opacity-0">
              <span className="text-muted-foreground/50">[</span>
              {displayCount}
              <span className="text-muted-foreground/50">]</span>
            </span>
            <span className="absolute inset-0 flex items-center justify-end opacity-0 transition-opacity group-hover/exec:opacity-100">
              <span className="text-muted-foreground/50">[</span>
              <Play className="size-3 fill-current" aria-hidden="true" />
              <span className="text-muted-foreground/50">]</span>
            </span>
          </>
        ) : (
          <span className="inline-flex items-center gap-0">
            <span className="text-muted-foreground/50">[</span>
            <Play className="size-3 fill-current" aria-hidden="true" />
            <span className="text-muted-foreground/50">]</span>
          </span>
        )}
      </span>
    </button>
  );
}
