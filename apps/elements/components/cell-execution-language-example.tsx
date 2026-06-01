"use client";

import { Check, Clock3, Play, Sparkles, X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { CodeCellCurrentLine } from "@/components/cell/CodeCellCurrentLine";
import { CompactExecutionButton } from "@/components/cell/CompactExecutionButton";
import { notebookCellLayoutVars } from "@/components/cell/cell-layout";
import { cn } from "@/lib/utils";

type ExecutionState = "ready" | "queued" | "running" | "completed" | "failed";
type Variant = "production" | "quiet" | "sentence" | "signal";

const states: Array<{
  state: ExecutionState;
  label: string;
  detail: string;
  count: number | null;
  elapsedMs?: number | null;
}> = [
  { state: "ready", label: "Ready", detail: "waiting for first run", count: null },
  { state: "queued", label: "Queued", detail: "next in line", count: null },
  { state: "running", label: "Running", detail: "building signal", count: null },
  { state: "completed", label: "Completed", detail: "Run 12 in 180ms", count: 12, elapsedMs: 180 },
  { state: "failed", label: "Failed", detail: "Run 13 stopped", count: 13 },
];

const variants: Array<{
  variant: Variant;
  label: string;
  body: string;
}> = [
  {
    variant: "production",
    label: "Production grammar",
    body: "Quiet cells rest as punctuation: completed cells show only the run marker, ready cells stay visually silent, and full language context returns on approach.",
  },
  {
    variant: "quiet",
    label: "Quiet unless focused",
    body: "An earlier sketch kept language visible at rest and bloomed the run metadata later; useful, but louder than the production direction.",
  },
  {
    variant: "sentence",
    label: "Short sentence",
    body: "Treat the metadata as one compact phrase after the signal: Python, run 12 in 180ms.",
  },
  {
    variant: "signal",
    label: "Signal-led",
    body: "Let the rule own state. Text becomes a soft caption instead of the primary visual event.",
  },
];

export function CellExecutionLanguageExample() {
  return (
    <div className="not-prose space-y-6">
      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="border-b border-fd-border p-4">
          <h2 className="text-sm font-semibold">Run line direction set</h2>
          <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
            The target is a cell boundary that usually reads as punctuation in the notebook rhythm.
            Active states get words; quiet states keep their context available but tucked away.
          </p>
        </div>
        <div className="divide-y divide-fd-border bg-background">
          {variants.map((variant) => (
            <div key={variant.label} className="grid gap-4 p-4 lg:grid-cols-[220px_minmax(0,1fr)]">
              <div>
                <h3 className="text-sm font-semibold">{variant.label}</h3>
                <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">{variant.body}</p>
              </div>
              <NotebookPreview variant={variant.variant} />
            </div>
          ))}
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="border-b border-fd-border p-4">
          <h2 className="text-sm font-semibold">State vocabulary</h2>
          <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
            The same line should carry ready, queued, running, completed, and failed states while
            making quiet cells feel like document structure, not a status table.
          </p>
        </div>
        <div className="grid gap-3 bg-background p-4 md:grid-cols-2">
          {states.map((state) => (
            <StateSample key={state.state} {...state} />
          ))}
        </div>
      </section>
    </div>
  );
}

function NotebookPreview({ variant }: { variant: Variant }) {
  return (
    <div
      className={cn(
        "min-w-0 overflow-hidden rounded-md border border-fd-border bg-fd-background",
        notebookCellLayoutVars,
      )}
    >
      <PreviewCell
        variant={variant}
        state="completed"
        count={12}
        elapsedMs={180}
        source={<CodeSample tokens={["total", " = ", "sum", "(", "values", ")"]} />}
        output="42"
      />
      <PreviewCell
        variant={variant}
        state="running"
        count={null}
        source={<CodeSample tokens={["fit", "(", "model", ", ", "frame", ")"]} />}
      />
    </div>
  );
}

function PreviewCell({
  variant,
  state,
  count,
  elapsedMs,
  source,
  output,
}: {
  variant: Variant;
  state: ExecutionState;
  count: number | null;
  elapsedMs?: number | null;
  source: ReactNode;
  output?: string;
}) {
  const isRunning = state === "running";
  const isQueued = state === "queued";
  const isFailed = state === "failed";

  return (
    <div data-preview-state={state} className="cell-container group flex bg-background/95">
      <div
        className={cn(
          "w-1 shrink-0 transition-colors",
          state === "failed" ? "bg-red-400" : state === "running" ? "bg-emerald-400" : "bg-sky-400",
        )}
      />
      <div className="min-w-0 flex-1 py-3 pl-[var(--cell-content-column-inset,3.25rem)] pr-5">
        <div className="relative min-h-10">
          <div className="absolute left-[calc(-1*var(--cell-content-column-inset,3.25rem)+0.4rem)] top-1">
            <CompactExecutionButton
              count={count}
              isExecuting={isRunning}
              isQueued={isQueued}
              isErrored={isFailed}
              isCellFocused
            />
          </div>
          <div className="font-mono text-[15px] leading-7 tracking-normal text-foreground">
            {source}
          </div>
          {variant === "production" ? (
            <CodeCellCurrentLine
              languageLabel="Python"
              count={count}
              elapsedMs={elapsedMs}
              isExecuting={isRunning}
              isQueued={isQueued}
              isErrored={isFailed}
              isFocused
            />
          ) : (
            <ExecutionLanguageLine
              variant={variant}
              state={state}
              count={count}
              elapsedMs={elapsedMs}
            />
          )}
        </div>
        {output ? (
          <div className="mt-5 font-mono text-[15px] leading-6 text-foreground">{output}</div>
        ) : null}
      </div>
    </div>
  );
}

function ExecutionLanguageLine({
  variant,
  state,
  count,
  elapsedMs,
}: {
  variant: Exclude<Variant, "production">;
  state: ExecutionState;
  count: number | null;
  elapsedMs?: number | null;
}) {
  const copy = executionCopy(state, count, elapsedMs);

  if (variant === "quiet") {
    return (
      <div className="mt-1.5 flex min-h-4 items-center gap-1.5 text-[11px] font-medium leading-none text-muted-foreground/55">
        <LanguagePill state={state} />
        <div className="h-px w-8 rounded-full bg-border/20 transition-all group-hover:w-12 group-hover:bg-border/35" />
        <span className="max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-[max-width,opacity] duration-150 group-hover:max-w-48 group-hover:opacity-100 group-focus-within:max-w-48 group-focus-within:opacity-100">
          {copy.short}
        </span>
        <SignalRule state={state} quiet />
      </div>
    );
  }

  if (variant === "sentence") {
    return (
      <div className="mt-1.5 flex min-h-4 items-center gap-1.5 text-[11px] font-medium leading-none text-muted-foreground/60">
        <StateGlyph state={state} />
        <span className="whitespace-nowrap">
          <span className="text-foreground/65">Python</span>
          <span className="px-1 text-muted-foreground/35">/</span>
          <span className={stateTone(state)}>{copy.short}</span>
        </span>
        <SignalRule state={state} />
      </div>
    );
  }

  return (
    <div className="mt-1.5 grid min-h-4 grid-cols-[auto_minmax(3rem,1fr)_auto] items-center gap-2 text-[11px] font-medium leading-none text-muted-foreground/55">
      <StateGlyph state={state} />
      <SignalRule state={state} strong />
      <span className="whitespace-nowrap">
        <span className="text-foreground/65">Python</span>
        <span className="px-1 text-muted-foreground/35">/</span>
        <span className={stateTone(state)}>{copy.tiny}</span>
      </span>
    </div>
  );
}

function StateSample({
  state,
  label,
  detail,
  count,
  elapsedMs,
}: {
  state: ExecutionState;
  label: string;
  detail: string;
  count: number | null;
  elapsedMs?: number | null;
}) {
  return (
    <div className="rounded-md border border-fd-border bg-fd-background p-3">
      <div className="flex items-center gap-2 text-xs font-semibold">
        <StateGlyph state={state} />
        <span>{label}</span>
      </div>
      <div className="mt-4">
        <ExecutionLanguageLine variant="signal" state={state} count={count} elapsedMs={elapsedMs} />
      </div>
      <p className="mt-3 text-xs leading-5 text-fd-muted-foreground">{detail}</p>
    </div>
  );
}

function LanguagePill({ state }: { state: ExecutionState }) {
  return (
    <span
      className={cn(
        "rounded-sm px-1 py-0.5 transition-colors",
        state === "running" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        state === "queued" && "bg-sky-500/10 text-sky-700 dark:text-sky-300",
        state === "failed" && "bg-red-500/10 text-red-700 dark:text-red-300",
        (state === "ready" || state === "completed") && "bg-muted/45 text-foreground/65",
      )}
    >
      Python
    </span>
  );
}

function StateGlyph({ state }: { state: ExecutionState }) {
  const className = cn(
    "size-3 shrink-0",
    state === "running" && "text-emerald-600 dark:text-emerald-300",
    state === "queued" && "text-sky-600 dark:text-sky-300",
    state === "failed" && "text-red-600 dark:text-red-300",
    state === "completed" && "text-muted-foreground/55",
    state === "ready" && "text-muted-foreground/35",
  );

  if (state === "running") return <Sparkles className={className} aria-hidden="true" />;
  if (state === "queued") return <Clock3 className={className} aria-hidden="true" />;
  if (state === "failed") return <X className={className} aria-hidden="true" />;
  if (state === "completed") return <Check className={className} aria-hidden="true" />;
  return <Play className={cn(className, "fill-current")} aria-hidden="true" />;
}

function SignalRule({
  state,
  quiet = false,
  strong = false,
}: {
  state: ExecutionState;
  quiet?: boolean;
  strong?: boolean;
}) {
  if (state === "running") {
    return (
      <span className="relative h-3 min-w-12 flex-1 overflow-hidden text-emerald-500/65 [mask-image:linear-gradient(to_right,transparent,black_0.5rem,black_calc(100%-0.5rem),transparent)]">
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
            strokeWidth={strong ? "1.5" : "1.2"}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </span>
    );
  }

  if (state === "queued") {
    return (
      <span
        className={cn(
          "h-px min-w-12 flex-1 rounded-full bg-sky-400/45 animate-queue-boundary-pulse",
          strong && "bg-sky-400/60",
        )}
        style={{ "--queue-pulse-duration": "2s" } as CSSProperties}
      />
    );
  }

  if (state === "failed") {
    return (
      <span className="h-px min-w-12 flex-1 bg-[repeating-linear-gradient(to_right,rgb(248_113_113/.7)_0_0.35rem,transparent_0.35rem_0.6rem)]" />
    );
  }

  return (
    <span
      className={cn(
        "h-px min-w-8 flex-1 rounded-full",
        quiet ? "bg-border/15" : "bg-border/25",
        strong && "bg-border/35",
      )}
    />
  );
}

function executionCopy(state: ExecutionState, count: number | null, elapsedMs?: number | null) {
  if (state === "running") return { short: "running", tiny: "running" };
  if (state === "queued") return { short: "queued", tiny: "queued" };
  if (state === "failed")
    return { short: count === null ? "failed" : `run ${count} failed`, tiny: "failed" };
  if (state === "completed") {
    const run = count === null ? "run" : `run ${count}`;
    const elapsed = typeof elapsedMs === "number" ? ` in ${formatElapsed(elapsedMs)}` : "";
    return { short: `${run}${elapsed}`, tiny: count === null ? "done" : `run ${count}` };
  }
  return { short: "ready", tiny: "ready" };
}

function stateTone(state: ExecutionState) {
  if (state === "running") return "text-emerald-700 dark:text-emerald-300";
  if (state === "queued") return "text-sky-700 dark:text-sky-300";
  if (state === "failed") return "text-red-700 dark:text-red-300";
  return "text-muted-foreground/70";
}

function formatElapsed(ms: number) {
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`;
  const seconds = ms / 1_000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

function CodeSample({ tokens }: { tokens: string[] }) {
  return (
    <>
      <span className="text-blue-600">{tokens[0]}</span>
      <span className="text-muted-foreground">{tokens[1]}</span>
      <span className="text-purple-600">{tokens[2]}</span>
      <span className="text-muted-foreground">{tokens[3]}</span>
      <span className="text-blue-600">{tokens[4]}</span>
      <span className="text-muted-foreground">{tokens[5]}</span>
    </>
  );
}
