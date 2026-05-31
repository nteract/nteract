import { Play, Square } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface CodeCellCurrentLineProps {
  languageLabel: string;
  count: number | null;
  elapsedMs?: number | null;
  isExecuting?: boolean;
  isQueued?: boolean;
  isFocused?: boolean;
  compactIdle?: boolean;
  submittedByActorLabel?: string | null;
  activityContent?: ReactNode;
  canExecute?: boolean;
  onExecute: () => void;
  onInterrupt: () => void;
  className?: string;
}

function formatExecutionCount(count: number): string {
  return count > 999 ? "999+" : String(count);
}

function formatElapsedMs(elapsedMs: number): string {
  if (elapsedMs < 1_000) return `${Math.max(1, Math.round(elapsedMs))}ms`;

  const seconds = elapsedMs / 1_000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
}

function visualExecutionDetail({
  count,
  elapsedMs,
  isExecuting,
  isQueued,
}: {
  count: number | null;
  elapsedMs: number | null;
  isExecuting: boolean;
  isQueued: boolean;
}): string {
  const runPrefix = count === null ? null : `Run ${formatExecutionCount(count)}`;

  if (isExecuting) return "Running";
  if (isQueued) return "Queued";
  if (count !== null) {
    return elapsedMs === null ? `${runPrefix}` : `${runPrefix} · ${formatElapsedMs(elapsedMs)}`;
  }

  return "Ready";
}

function accessibleExecutionDetail({
  count,
  elapsedMs,
  isExecuting,
  isQueued,
}: {
  count: number | null;
  elapsedMs: number | null;
  isExecuting: boolean;
  isQueued: boolean;
}): string {
  const runPrefix = count === null ? null : `Run ${formatExecutionCount(count)}`;

  if (isExecuting) return "Running";
  if (isQueued) return "Queued";
  if (count !== null) {
    return elapsedMs === null
      ? `${runPrefix} completed`
      : `${runPrefix} completed in ${formatElapsedMs(elapsedMs)}`;
  }

  return "Ready";
}

function executionCountLabel(count: number | null): string | null {
  return count === null ? null : `Execution ${formatExecutionCount(count)}`;
}

function executionLineClass({
  isExecuting,
  isQueued,
  isFocused,
}: {
  isExecuting: boolean;
  isQueued: boolean;
  isFocused: boolean;
}) {
  if (isExecuting) {
    return "bg-primary/45";
  }

  if (isQueued) {
    return "bg-sky-400/35";
  }

  if (isFocused) {
    return "bg-border/50";
  }

  return "bg-border/25 group-hover:bg-border/45";
}

export function CodeCellCurrentLine({
  languageLabel,
  count,
  elapsedMs = null,
  isExecuting = false,
  isQueued = false,
  isFocused = false,
  compactIdle = false,
  submittedByActorLabel = null,
  activityContent,
  canExecute = true,
  onExecute,
  onInterrupt,
  className,
}: CodeCellCurrentLineProps) {
  const state = isExecuting ? "running" : isQueued ? "queued" : count !== null ? "ran" : "idle";
  const isCompactIdle = compactIdle && state === "idle";
  const isQuietResting = (state === "idle" || state === "ran") && !isFocused;
  const detailLabel = visualExecutionDetail({ count, elapsedMs, isExecuting, isQueued });
  const accessibleDetailLabel = accessibleExecutionDetail({
    count,
    elapsedMs,
    isExecuting,
    isQueued,
  });
  const countLabel = executionCountLabel(count);
  const actionTitle = isExecuting
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
  const scopedActionTitle = canExecute ? actionTitle : "Execution unavailable";

  const handleClick = () => {
    if (!canExecute) return;
    if (isQueued) return;
    if (isExecuting) {
      onInterrupt();
    } else {
      onExecute();
    }
  };

  return (
    <div
      data-slot="code-cell-current-line"
      data-execution-state={state}
      data-execution-count={count ?? undefined}
      data-execution-label={countLabel ?? undefined}
      className={cn(
        "mt-1.5 flex items-center gap-1.5 text-[11px] leading-none text-muted-foreground/60",
        isCompactIdle ? "min-h-5" : "min-h-6",
        className,
      )}
    >
      <button
        type="button"
        onClick={handleClick}
        disabled={isQueued || !canExecute}
        title={scopedActionTitle}
        aria-label={scopedActionTitle}
        aria-busy={isExecuting || undefined}
        data-testid="execute-button"
        data-execution-state={state}
        data-execution-count={count ?? undefined}
        className={cn(
          "inline-flex size-4 shrink-0 items-center justify-center rounded-full",
          "transition-colors duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
          !isFocused &&
            (state === "idle" || state === "ran") &&
            "opacity-45 group-hover:opacity-100",
          !isExecuting && state !== "queued" && "text-muted-foreground/55",
          isCompactIdle && "opacity-45 hover:opacity-100",
          state === "idle" && "hover:bg-muted hover:text-foreground",
          state === "ran" && "hover:bg-primary/5 hover:text-primary",
          state === "queued" && "cursor-default text-sky-600 dark:text-sky-400",
          state === "running" && "text-destructive hover:bg-destructive/10",
          !canExecute &&
            "cursor-default opacity-35 hover:bg-transparent hover:text-muted-foreground/55",
        )}
      >
        {isExecuting ? (
          <Square className="size-2.5 fill-current animate-exec-squish" aria-hidden="true" />
        ) : isQueued ? (
          <span
            className="block size-1.5 rounded-full bg-current animate-queue-breathe"
            aria-hidden="true"
          />
        ) : (
          <Play className="size-2.5 fill-current" aria-hidden="true" />
        )}
      </button>
      <span
        data-slot="code-cell-current-line-status"
        aria-label={`${languageLabel}: ${accessibleDetailLabel}`}
        aria-live={isExecuting || isQueued ? "polite" : undefined}
        className={cn(
          "flex min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap font-medium transition-[color,opacity,max-width] duration-150",
          isQuietResting
            ? "max-w-0 overflow-hidden opacity-0 group-hover:max-w-64 group-hover:opacity-100 group-focus-within:max-w-64 group-focus-within:opacity-100"
            : "max-w-64 opacity-100",
          isFocused && "text-foreground/70",
          isExecuting && "text-primary",
          isQueued && "text-sky-700 dark:text-sky-300",
        )}
      >
        <span
          data-slot="code-cell-current-line-language"
          className={cn(
            "rounded-sm px-0.5 py-0.5 text-foreground/60 transition-colors duration-150",
            "group-hover:bg-muted/50 group-hover:text-foreground/70 group-focus-within:bg-muted/50 group-focus-within:text-foreground/70",
            isFocused && "bg-muted/45 text-foreground/70",
            isExecuting && "bg-primary/10 text-primary",
            isQueued && "bg-sky-500/10 text-sky-700 dark:text-sky-300",
          )}
        >
          {languageLabel}
        </span>
        <span
          className={cn("text-muted-foreground/35", isCompactIdle && "sr-only")}
          aria-hidden="true"
        >
          ·
        </span>
        <span
          data-slot="code-cell-current-line-detail"
          className={cn("tabular-nums", isCompactIdle && "sr-only")}
        >
          {detailLabel}
        </span>
      </span>
      {!isCompactIdle && (
        <>
          {activityContent ? (
            <div
              data-slot="code-cell-current-line-activity"
              className={cn(
                "flex min-w-0 shrink-0 items-center overflow-hidden transition-[max-width,opacity] duration-150",
                isQuietResting
                  ? "max-w-0 opacity-0 group-hover:max-w-24 group-hover:opacity-100 group-focus-within:max-w-24 group-focus-within:opacity-100"
                  : "max-w-24 opacity-100",
              )}
            >
              {activityContent}
            </div>
          ) : null}
          <div
            data-slot="code-cell-current-line-rule"
            className={cn(
              "h-px min-w-6 flex-1 rounded-full transition-colors duration-150",
              executionLineClass({ isExecuting, isQueued, isFocused }),
            )}
          />
        </>
      )}
    </div>
  );
}
