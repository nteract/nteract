"use client";

import { CheckCircle2, FileCode2, Rows3 } from "lucide-react";
import { CodeCellCurrentLine } from "@/components/cell/CodeCellCurrentLine";
import { CompactExecutionButton } from "@/components/cell/CompactExecutionButton";
import { notebookCellLayoutVars } from "@/components/cell/cell-layout";
import { cn } from "@/lib/utils";

type ExecutionState = {
  id: string;
  label: string;
  detail: string;
  count: number | null;
  elapsedMs?: number | null;
  isExecuting?: boolean;
  isQueued?: boolean;
  queuePriority?: number;
  isErrored?: boolean;
  submittedByActorLabel?: string | null;
};

const executionStates: ExecutionState[] = [
  {
    id: "ready",
    label: "Ready",
    detail: "Never-run cells keep the state lane quiet until hover, focus, or keyboard access.",
    count: null,
  },
  {
    id: "focused-ready",
    label: "Focused ready",
    detail: "Notebook focus makes the run affordance available without adding status copy.",
    count: null,
  },
  {
    id: "queued",
    label: "Queued",
    detail: "Queued cells use the production queue pulse and keep the interrupt action disabled.",
    count: 12,
    isQueued: true,
    queuePriority: 0.7,
    submittedByActorLabel: "user:anaconda:kyle/browser:cloud",
  },
  {
    id: "running",
    label: "Running",
    detail: "Active execution moves through the compact stop button and current-line signal.",
    count: 12,
    isExecuting: true,
    submittedByActorLabel: "user:anaconda:kyle/agent:codex:s1",
  },
  {
    id: "completed",
    label: "Completed",
    detail: "Finished runs collapse to the production run count and elapsed-time boundary.",
    count: 12,
    elapsedMs: 180,
  },
  {
    id: "failed",
    label: "Failed",
    detail: "Errors keep the retry affordance in the state lane and mark the boundary as failed.",
    count: 13,
    isErrored: true,
  },
];

const componentRows = [
  {
    component: "CompactExecutionButton",
    path: "src/components/cell/CompactExecutionButton.tsx",
    role: "Run, queued, running, error, and disabled execution affordance in the cell state lane.",
  },
  {
    component: "CodeCellCurrentLine",
    path: "src/components/cell/CodeCellCurrentLine.tsx",
    role: "Source/result boundary with language context, count, elapsed time, queue pulse, and running signal.",
  },
  {
    component: "notebookCellLayoutVars",
    path: "src/components/cell/cell-layout.ts",
    role: "Shared cell column geometry so catalog previews line up with the notebook app.",
  },
];

export function CellExecutionLanguageExample() {
  return (
    <div className="not-prose space-y-6">
      <section className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-emerald-900 dark:text-emerald-100">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 size-4 flex-none" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold">Production execution language only</h2>
            <p className="mt-1 text-xs leading-5">
              This page renders the current cell execution components directly. It no longer keeps
              alternate execution-line variants beside the production line, so catalog review stays
              focused on the UI the notebook app actually ships.
            </p>
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="border-b border-fd-border p-4">
          <div className="flex items-center gap-2">
            <FileCode2 className="size-4 text-fd-muted-foreground" aria-hidden="true" />
            <h2 className="text-sm font-semibold">Run lane in context</h2>
          </div>
          <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
            The preview below is fixture code around production execution controls. The buttons,
            boundary lines, labels, animation hooks, and accessibility text come from shared
            components.
          </p>
        </div>
        <div className={cn("divide-y divide-border bg-background", notebookCellLayoutVars)}>
          <PreviewCell
            state={executionStates[4]}
            source="features = orders.assign(month=orders.date.dt.month)"
          />
          <PreviewCell state={executionStates[3]} source="model.fit(features[columns], target)" />
          <PreviewCell
            state={executionStates[2]}
            source="predictions = model.predict(features_holdout)"
          />
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="border-b border-fd-border p-4">
          <div className="flex items-center gap-2">
            <Rows3 className="size-4 text-fd-muted-foreground" aria-hidden="true" />
            <h2 className="text-sm font-semibold">Execution state matrix</h2>
          </div>
          <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
            Each state is a production `CompactExecutionButton` paired with a production
            `CodeCellCurrentLine`.
          </p>
        </div>
        <div className="grid gap-3 bg-background p-4 md:grid-cols-2">
          {executionStates.map((state) => (
            <StateSample key={state.id} state={state} />
          ))}
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-3">
        {componentRows.map((row) => (
          <article
            key={row.component}
            className="rounded-lg border border-fd-border bg-fd-card p-4"
          >
            <h3 className="text-sm font-semibold">{row.component}</h3>
            <p className="mt-2 break-words font-mono text-[11px] leading-5 text-fd-muted-foreground">
              {row.path}
            </p>
            <p className="mt-3 text-xs leading-5 text-fd-muted-foreground">{row.role}</p>
          </article>
        ))}
      </section>
    </div>
  );
}

function PreviewCell({ state, source }: { state: ExecutionState; source: string }) {
  return (
    <div className="cell-container group flex bg-background/95">
      <div className="w-1 shrink-0 bg-sky-400 transition-colors dark:bg-sky-600" />
      <div className="relative min-w-0 flex-1 py-3 pl-[var(--cell-content-column-inset,3.25rem)] pr-5">
        <div className="absolute left-2 top-3.5">
          <CompactExecutionButton
            count={state.count}
            isExecuting={state.isExecuting}
            isQueued={state.isQueued}
            isErrored={state.isErrored}
            submittedByActorLabel={state.submittedByActorLabel}
            isCellFocused
          />
        </div>
        <pre className="m-0 overflow-x-auto whitespace-pre font-mono text-[13px] leading-6 text-foreground">
          {source}
        </pre>
        <CodeCellCurrentLine
          languageLabel="Python"
          count={state.count}
          elapsedMs={state.elapsedMs}
          isExecuting={state.isExecuting}
          isQueued={state.isQueued}
          queuePriority={state.queuePriority}
          isErrored={state.isErrored}
          isFocused
        />
      </div>
    </div>
  );
}

function StateSample({ state }: { state: ExecutionState }) {
  const focused = state.id === "focused-ready" || state.isExecuting || state.isQueued;

  return (
    <article className="group rounded-md border border-fd-border bg-fd-background p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{state.label}</h3>
          <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">{state.detail}</p>
        </div>
        <CompactExecutionButton
          count={state.count}
          isExecuting={state.isExecuting}
          isQueued={state.isQueued}
          isErrored={state.isErrored}
          submittedByActorLabel={state.submittedByActorLabel}
          isCellFocused={focused}
        />
      </div>
      <div className="mt-4">
        <CodeCellCurrentLine
          languageLabel="Python"
          count={state.count}
          elapsedMs={state.elapsedMs}
          isExecuting={state.isExecuting}
          isQueued={state.isQueued}
          queuePriority={state.queuePriority}
          isErrored={state.isErrored}
          isFocused={focused}
        />
      </div>
    </article>
  );
}
