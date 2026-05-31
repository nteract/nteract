"use client";

import { Code, LetterText, Plus } from "lucide-react";
import { CellInsertionRibbon } from "@/components/cell/CellInsertionRibbon";
import { notebookCellLayoutVars } from "@/components/cell/cell-layout";
import { cn } from "@/lib/utils";

type Intent = "code" | "markdown";

const concepts = [
  {
    label: "Production row",
    body: "The row wakes in a neutral insertion state; color appears only when code or markdown is targeted.",
    render: <ProductionInsertionPreview />,
  },
  {
    label: "Threaded line",
    body: "Actions attach directly to the document rule, reducing the floating-button feeling.",
    render: <ThreadedLinePreview />,
  },
  {
    label: "Split landing zone",
    body: "The left channel stays a broad insert target while the explicit choices sit in the document column.",
    render: <SplitLandingPreview />,
  },
];

export function CellInsertionAffordancesExample() {
  return (
    <div className="not-prose space-y-6">
      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="border-b border-fd-border p-4">
          <h2 className="text-sm font-semibold">Between-cell direction set</h2>
          <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
            These sketches keep the same rail-gripped ribbon and document column, but change how
            much chrome the code and markdown choices carry.
          </p>
        </div>
        <div className="divide-y divide-fd-border bg-background">
          {concepts.map((concept) => (
            <div key={concept.label} className="grid gap-4 p-4 lg:grid-cols-[220px_minmax(0,1fr)]">
              <div>
                <h3 className="text-sm font-semibold">{concept.label}</h3>
                <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">{concept.body}</p>
              </div>
              <div className="min-w-0 overflow-hidden rounded-md border border-fd-border bg-fd-background">
                {concept.render}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="border-b border-fd-border p-4">
          <h2 className="text-sm font-semibold">Document tail</h2>
          <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
            The final add row needs a softer ending than an ordinary between-cell row.
          </p>
        </div>
        <div className="grid gap-4 bg-background p-4 lg:grid-cols-2">
          <div className="min-w-0 overflow-hidden rounded-md border border-fd-border bg-fd-background">
            <CellInsertionRibbon
              activeType="code"
              terminal
              forceActionsVisible
              onInsert={() => undefined}
            />
          </div>
          <div className="min-w-0 overflow-hidden rounded-md border border-fd-border bg-fd-background">
            <TailFadePreview />
          </div>
        </div>
      </section>
    </div>
  );
}

function ProductionInsertionPreview() {
  return <CellInsertionRibbon forceActionsVisible onInsert={() => undefined} />;
}

function ThreadedLinePreview() {
  return (
    <div className={cn("flex h-9 w-full items-center", notebookCellLayoutVars)}>
      <Ribbon intent="markdown" />
      <div className="h-full w-[var(--cell-content-column-inset,3.25rem)] shrink-0 bg-emerald-500/5" />
      <div className="flex min-w-0 flex-1 items-center">
        <div className="h-px w-6 bg-border/70" />
        <ThreadedAction intent="code" muted />
        <ThreadedAction intent="markdown" />
        <div className="h-px min-w-8 flex-1 bg-border/70" />
      </div>
    </div>
  );
}

function SplitLandingPreview() {
  return (
    <div className={cn("flex h-9 w-full items-center", notebookCellLayoutVars)}>
      <Ribbon intent="code" />
      <div className="flex h-full w-[var(--cell-content-column-inset,3.25rem)] shrink-0 items-center justify-center bg-sky-500/6">
        <Plus className="size-3 text-sky-600/70" aria-hidden="true" />
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <SplitAction intent="code" />
        <span className="h-px min-w-4 flex-1 bg-border/65" />
        <SplitAction intent="markdown" muted />
      </div>
    </div>
  );
}

function TailFadePreview() {
  return (
    <div
      className={cn("flex h-[clamp(3.5rem,9vh,5.5rem)] w-full items-start", notebookCellLayoutVars)}
    >
      <div className="relative h-full w-1 shrink-0 overflow-hidden [mask-image:linear-gradient(to_bottom,black_0,black_calc(100%-1.5rem),transparent_100%)]">
        <div className="absolute inset-0 bg-gray-200/70 dark:bg-gray-700/55" />
        <div className="absolute left-0 top-0 h-7 w-full bg-gradient-to-b from-emerald-400 via-emerald-400/50 to-emerald-400/0 dark:from-emerald-600 dark:via-emerald-600/50 dark:to-emerald-600/0" />
      </div>
      <div className="h-7 w-[var(--cell-content-column-inset,3.25rem)] shrink-0 bg-emerald-500/5" />
      <div className="flex h-7 min-w-0 flex-1 items-center">
        <div className="h-px w-5 bg-border/55" />
        <SplitAction intent="code" muted />
        <SplitAction intent="markdown" />
        <div className="h-px min-w-8 flex-1 bg-gradient-to-r from-border/55 to-transparent" />
      </div>
    </div>
  );
}

function Ribbon({ intent }: { intent: Intent }) {
  return (
    <div className="relative h-full w-1 shrink-0 overflow-hidden">
      <div className="absolute inset-0 bg-gray-200/55 dark:bg-gray-700/55" />
      <div
        className={cn(
          "absolute inset-0",
          intent === "code" ? "bg-sky-400 dark:bg-sky-600" : "bg-emerald-400 dark:bg-emerald-600",
        )}
      />
    </div>
  );
}

function ThreadedAction({ intent, muted = false }: { intent: Intent; muted?: boolean }) {
  const Icon = intent === "code" ? Code : LetterText;

  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 border-y border-border/70 px-2.5 text-xs font-medium transition-colors first:border-l first:rounded-l-full last:border-r last:rounded-r-full",
        muted
          ? "bg-background text-muted-foreground/50"
          : intent === "code"
            ? "bg-sky-500/10 text-sky-700 dark:text-sky-300"
            : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      )}
    >
      <Plus className="size-3" aria-hidden="true" />
      <Icon className="size-3" aria-hidden="true" />
      <span>{intent === "code" ? "Code" : "Markdown"}</span>
    </button>
  );
}

function SplitAction({ intent, muted = false }: { intent: Intent; muted?: boolean }) {
  const Icon = intent === "code" ? Code : LetterText;

  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
        muted
          ? "text-muted-foreground/50 hover:bg-muted/50 hover:text-foreground"
          : intent === "code"
            ? "bg-sky-500/10 text-sky-700 ring-1 ring-sky-500/15 dark:text-sky-300"
            : "bg-emerald-500/10 text-emerald-700 ring-1 ring-emerald-500/15 dark:text-emerald-300",
      )}
    >
      <Plus className="size-3" aria-hidden="true" />
      <Icon className="size-3" aria-hidden="true" />
      <span>{intent === "code" ? "Code" : "Markdown"}</span>
    </button>
  );
}
