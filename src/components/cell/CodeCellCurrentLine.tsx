import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface CodeCellCurrentLineProps {
  languageLabel: string;
  count: number | null;
  elapsedMs?: number | null;
  isExecuting?: boolean;
  isQueued?: boolean;
  isErrored?: boolean;
  isFocused?: boolean;
  compactIdle?: boolean;
  activityContent?: ReactNode;
  className?: string;
}

type ExecutionBoundaryState = "idle" | "ran" | "queued" | "running" | "error";

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
  isErrored,
}: {
  count: number | null;
  elapsedMs: number | null;
  isExecuting: boolean;
  isQueued: boolean;
  isErrored: boolean;
}): string {
  const runPrefix = count === null ? null : `Run ${formatExecutionCount(count)}`;

  if (isExecuting) return "Running";
  if (isQueued) return "Queued";
  if (isErrored) return runPrefix === null ? "Error" : `${runPrefix} failed`;
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
  isErrored,
}: {
  count: number | null;
  elapsedMs: number | null;
  isExecuting: boolean;
  isQueued: boolean;
  isErrored: boolean;
}): string {
  const runPrefix = count === null ? null : `Run ${formatExecutionCount(count)}`;

  if (isExecuting) return "Running";
  if (isQueued) return "Queued";
  if (isErrored) return runPrefix === null ? "Execution failed" : `${runPrefix} failed`;
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

function executionLineClass({ isQueued, isFocused }: { isQueued: boolean; isFocused: boolean }) {
  if (isQueued) {
    return "bg-sky-400/30";
  }

  if (isFocused) {
    return "bg-border/30";
  }

  return "bg-border/15 group-hover:bg-border/25 group-focus-within:bg-border/25";
}

function ExecutionBoundaryRule({
  state,
  isQuietResting,
  isQueued,
  isFocused,
}: {
  state: ExecutionBoundaryState;
  isQuietResting: boolean;
  isQueued: boolean;
  isFocused: boolean;
}) {
  if (state === "running") {
    return (
      <div
        data-slot="code-cell-current-line-rule"
        className="relative h-3 min-w-14 flex-1 overflow-hidden text-emerald-500/65 dark:text-emerald-300/65 [mask-image:linear-gradient(to_right,transparent,black_0.75rem,black_calc(100%-0.5rem),transparent)]"
      >
        <svg
          className="absolute inset-y-0 left-0 h-full w-[200%] animate-exec-signal-wave"
          viewBox="0 0 240 12"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path
            d="M0 6 C5 1 10 1 15 6 S25 11 30 6 S40 1 45 6 S55 11 60 6 S70 1 75 6 S85 11 90 6 S100 1 105 6 S115 11 120 6 S130 1 135 6 S145 11 150 6 S160 1 165 6 S175 11 180 6 S190 1 195 6 S205 11 210 6 S220 1 225 6 S235 11 240 6"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="1.4"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
    );
  }

  if (state === "queued") {
    return (
      <div
        data-slot="code-cell-current-line-rule"
        className="flex h-3 min-w-12 flex-1 items-center gap-1 text-sky-500/60 dark:text-sky-300/60"
      >
        {[0, 120, 240].map((delay) => (
          <span
            key={delay}
            className="size-1 rounded-full bg-current animate-queue-breathe"
            style={{ animationDelay: `${delay}ms` }}
            aria-hidden="true"
          />
        ))}
        <span className="h-px min-w-4 flex-1 rounded-full bg-sky-400/20" aria-hidden="true" />
      </div>
    );
  }

  if (state === "error") {
    return (
      <div
        data-slot="code-cell-current-line-rule"
        className="relative h-3 min-w-12 flex-1 overflow-hidden text-destructive/60"
      >
        <span
          className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-[repeating-linear-gradient(to_right,currentColor_0_0.375rem,transparent_0.375rem_0.625rem)]"
          aria-hidden="true"
        />
        <span
          className="absolute left-0 top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-current"
          aria-hidden="true"
        />
      </div>
    );
  }

  return (
    <div
      data-slot="code-cell-current-line-rule"
      className={cn(
        "h-px min-w-4 rounded-full transition-[background-color,width,flex-basis] duration-150",
        isQuietResting ? "w-10 flex-none group-hover:w-14 group-focus-within:w-14" : "flex-1",
        executionLineClass({ isQueued, isFocused }),
        isQueued && "animate-queue-breathe",
      )}
    />
  );
}

export function CodeCellCurrentLine({
  languageLabel,
  count,
  elapsedMs = null,
  isExecuting = false,
  isQueued = false,
  isErrored = false,
  isFocused = false,
  compactIdle = false,
  activityContent,
  className,
}: CodeCellCurrentLineProps) {
  const state: ExecutionBoundaryState = isExecuting
    ? "running"
    : isQueued
      ? "queued"
      : isErrored
        ? "error"
        : count !== null
          ? "ran"
          : "idle";
  const isCompactIdle = compactIdle && state === "idle";
  const isQuietResting = state === "idle" || state === "ran";
  const detailLabel = visualExecutionDetail({
    count,
    elapsedMs,
    isExecuting,
    isQueued,
    isErrored,
  });
  const accessibleDetailLabel = accessibleExecutionDetail({
    count,
    elapsedMs,
    isExecuting,
    isQueued,
    isErrored,
  });
  const countLabel = executionCountLabel(count);
  return (
    <div
      data-slot="code-cell-current-line"
      data-execution-state={state}
      data-execution-count={count ?? undefined}
      data-execution-label={countLabel ?? undefined}
      className={cn(
        "mt-1.5 flex items-center gap-1.5 text-[11px] leading-none text-muted-foreground/60",
        isCompactIdle ? "min-h-3.5" : isQuietResting ? "min-h-4" : "min-h-5",
        className,
      )}
    >
      <span
        data-slot="code-cell-current-line-status"
        aria-label={`${languageLabel}: ${accessibleDetailLabel}`}
        aria-live={isExecuting || isQueued || isErrored ? "polite" : undefined}
        className={cn(
          "flex min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap font-medium transition-[color,opacity,max-width] duration-150",
          isQuietResting
            ? "max-w-0 overflow-hidden opacity-0 group-hover:max-w-64 group-hover:opacity-100 group-focus-within:max-w-64 group-focus-within:opacity-100"
            : "max-w-64 opacity-100",
          isFocused && "text-foreground/70",
          isExecuting && "text-primary",
          isQueued && "text-sky-700 dark:text-sky-300",
          isErrored && "text-destructive/80",
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
            isErrored && "bg-destructive/10 text-destructive/90",
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
          <ExecutionBoundaryRule
            state={state}
            isQuietResting={isQuietResting}
            isQueued={isQueued}
            isFocused={isFocused}
          />
        </>
      )}
    </div>
  );
}
