import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface CodeCellCurrentLineProps {
  languageLabel: string;
  count: number | null;
  elapsedMs?: number | null;
  isExecuting?: boolean;
  isQueued?: boolean;
  queuePriority?: number;
  isErrored?: boolean;
  isFocused?: boolean;
  compactIdle?: boolean;
  activityContent?: ReactNode;
  className?: string;
}

type ExecutionBoundaryState = "idle" | "ran" | "queued" | "running" | "error";
type RunningSignalPhase = "resting" | "building" | "active" | "settling";

const RUNNING_SIGNAL_DELAY_MS = 120;
const RUNNING_SIGNAL_SETTLE_MS = 320;

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
  if (isExecuting) return "running";
  if (isQueued) return "queued";
  if (isErrored) return "failed";
  if (count !== null) {
    const runPrefix = `run ${formatExecutionCount(count)}`;
    return elapsedMs === null ? runPrefix : `${runPrefix} · ${formatElapsedMs(elapsedMs)}`;
  }

  return "ready";
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

function quietBoundaryState(count: number | null): ExecutionBoundaryState {
  return count === null ? "idle" : "ran";
}

function executionLineClass({ isFocused }: { isFocused: boolean }) {
  if (isFocused) {
    return "bg-border/30";
  }

  return "bg-border/15 group-hover:bg-border/25 group-focus-within:bg-border/25";
}

function clampQueuePriority(priority: number): number {
  return Math.max(0, Math.min(1, priority));
}

function queueSignalStyle(priority: number): CSSProperties {
  const durationMs = Math.round(2_900 - priority * 1_450);
  const lowOpacity = 0.34 + priority * 0.1;
  const highOpacity = 0.58 + priority * 0.18;

  return {
    "--queue-pulse-duration": `${durationMs}ms`,
    "--queue-pulse-low": lowOpacity.toFixed(2),
    "--queue-pulse-high": highOpacity.toFixed(2),
  } as CSSProperties;
}

function useRunningSignalPhase(isExecuting: boolean): RunningSignalPhase {
  const [phase, setPhase] = useState<RunningSignalPhase>(() =>
    isExecuting ? "building" : "resting",
  );
  const phaseRef = useRef(phase);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    if (isExecuting) {
      setPhase((current) => (current === "active" ? "active" : "building"));
      timeoutId = setTimeout(() => {
        setPhase("active");
      }, RUNNING_SIGNAL_DELAY_MS);
    } else if (phaseRef.current === "active") {
      setPhase("settling");
      timeoutId = setTimeout(() => {
        setPhase("resting");
      }, RUNNING_SIGNAL_SETTLE_MS);
    } else {
      setPhase("resting");
    }

    return () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    };
  }, [isExecuting]);

  return phase;
}

function ExecutionBoundaryRule({
  state,
  runningSignalPhase,
  queuePriority,
  isFocused,
}: {
  state: ExecutionBoundaryState;
  runningSignalPhase: RunningSignalPhase;
  queuePriority: number;
  isFocused: boolean;
}) {
  if (state === "running") {
    const showSignal = runningSignalPhase === "active" || runningSignalPhase === "settling";

    return (
      <div
        data-slot="code-cell-current-line-rule"
        data-execution-signal={runningSignalPhase}
        className="relative h-3 min-w-14 flex-1 overflow-hidden text-emerald-500/65 dark:text-emerald-300/65 [mask-image:linear-gradient(to_right,transparent,black_0.75rem,black_calc(100%-0.5rem),transparent)]"
      >
        {!showSignal ? (
          <span
            data-slot="code-cell-current-line-resting-rule"
            className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 rounded-full bg-current/25"
            aria-hidden="true"
          />
        ) : null}
        {showSignal ? (
          <span
            data-slot="code-cell-current-line-signal"
            className={cn(
              "absolute inset-0 overflow-hidden",
              runningSignalPhase === "active" && "animate-exec-signal-build",
              runningSignalPhase === "settling" && "animate-exec-signal-settle",
            )}
            aria-hidden="true"
          >
            <svg
              className="absolute inset-y-0 left-0 h-full w-[200%] animate-exec-signal-wave"
              viewBox="0 0 240 12"
              preserveAspectRatio="none"
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
          </span>
        ) : null}
      </div>
    );
  }

  if (state === "queued") {
    const normalizedQueuePriority = clampQueuePriority(queuePriority || 0.35);

    return (
      <div
        data-slot="code-cell-current-line-rule"
        data-queue-priority={normalizedQueuePriority.toFixed(2)}
        className="h-px min-w-12 flex-1 rounded-full bg-sky-400/45 animate-queue-boundary-pulse dark:bg-sky-300/35"
        style={queueSignalStyle(normalizedQueuePriority)}
      />
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
        "h-px min-w-8 flex-1 rounded-full transition-colors duration-150",
        executionLineClass({ isFocused }),
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
  queuePriority = 0,
  isErrored = false,
  isFocused = false,
  compactIdle = false,
  activityContent,
  className,
}: CodeCellCurrentLineProps) {
  const runningSignalPhase = useRunningSignalPhase(isExecuting);
  const state: ExecutionBoundaryState = isExecuting
    ? "running"
    : isQueued
      ? "queued"
      : isErrored
        ? "error"
        : count !== null
          ? "ran"
          : "idle";
  const hasRunningSignal =
    !isErrored &&
    !isQueued &&
    ((state === "running" && runningSignalPhase === "active") || runningSignalPhase === "settling");
  const boundaryState =
    state === "running" && !hasRunningSignal
      ? quietBoundaryState(count)
      : hasRunningSignal
        ? "running"
        : state;
  const visualIsExecuting = state === "running" && runningSignalPhase === "active";
  const isCompactIdle = compactIdle && boundaryState === "idle";
  const isQuietResting = boundaryState === "idle" || boundaryState === "ran";
  const detailLabel = visualExecutionDetail({
    count,
    elapsedMs,
    isExecuting: visualIsExecuting,
    isQueued,
    isErrored,
  });
  const isIdleReadyDetail = boundaryState === "idle" && detailLabel === "ready";
  const isQuietContextualState = boundaryState === "idle" || boundaryState === "ran";
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
      data-execution-visual-state={boundaryState}
      data-execution-count={count ?? undefined}
      data-execution-label={countLabel ?? undefined}
      className={cn(
        "mt-1.5 flex items-center gap-1.5 text-[11px] leading-none text-muted-foreground/60",
        isCompactIdle ? "min-h-3.5" : isQuietResting ? "min-h-4" : "min-h-5",
        className,
      )}
    >
      {!isCompactIdle ? (
        <ExecutionBoundaryRule
          state={boundaryState}
          runningSignalPhase={runningSignalPhase}
          queuePriority={queuePriority}
          isFocused={isFocused}
        />
      ) : null}
      {!isCompactIdle && activityContent ? (
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
      <span
        data-slot="code-cell-current-line-status"
        aria-label={`${languageLabel}: ${accessibleDetailLabel}`}
        aria-live={isExecuting || isQueued || isErrored ? "polite" : undefined}
        className={cn(
          "flex min-w-0 shrink-0 items-center whitespace-nowrap font-medium transition-[color,opacity,max-width,gap] duration-150",
          isCompactIdle ? "max-w-0 overflow-hidden opacity-0" : "max-w-64 opacity-100",
          isQuietContextualState
            ? "gap-0 group-hover:gap-1.5 group-focus-within:gap-1.5"
            : "gap-1.5",
          isFocused && "text-foreground/70",
        )}
      >
        <span
          data-slot="code-cell-current-line-language-context"
          className={cn(
            "flex shrink-0 items-center gap-1.5 overflow-hidden transition-[color,opacity,max-width] duration-150",
            isQuietContextualState
              ? "max-w-0 opacity-0 group-hover:max-w-20 group-hover:opacity-100 group-focus-within:max-w-20 group-focus-within:opacity-100"
              : "max-w-20 opacity-100",
          )}
        >
          <span
            data-slot="code-cell-current-line-language"
            className={cn(
              "text-foreground/60 transition-colors duration-150",
              isFocused && "text-foreground/70",
            )}
          >
            {languageLabel}
          </span>
          <span
            className={cn("text-muted-foreground/35", isCompactIdle && "sr-only")}
            aria-hidden="true"
          >
            /
          </span>
        </span>
        <span
          data-slot="code-cell-current-line-detail"
          className={cn(
            "shrink-0 tabular-nums transition-[max-width,opacity] duration-150",
            isCompactIdle && "sr-only",
            isIdleReadyDetail
              ? "max-w-0 overflow-hidden opacity-0 group-hover:max-w-16 group-hover:opacity-100 group-focus-within:max-w-16 group-focus-within:opacity-100"
              : "max-w-64 opacity-100",
            visualIsExecuting && "font-semibold text-emerald-700 dark:text-emerald-300",
            isQueued && "font-semibold text-sky-700 dark:text-sky-300",
            isErrored && "font-semibold text-destructive/80",
            !visualIsExecuting && !isQueued && !isErrored && "text-muted-foreground/70",
          )}
        >
          {detailLabel}
        </span>
      </span>
    </div>
  );
}
