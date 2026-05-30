"use client";

import { Cloud, Eye, FileCode2, Loader2, Rows3 } from "lucide-react";
import { CellSkeleton } from "@/notebook-components/CellSkeleton";
import {
  ReadOnlyNotebook,
  type ReadOnlyNotebookCellData,
} from "@/components/cell/ReadOnlyNotebook";
import { ReadOnlyNotebookCell } from "@/components/cell/ReadOnlyNotebookCell";

const notebookCells: ReadOnlyNotebookCellData[] = [
  {
    id: "hosted-intro",
    cellType: "markdown",
    source: [
      "## Hosted forecast report",
      "",
      "Read-only notebook surfaces keep notebook structure and output rendering without a live kernel.",
    ].join("\n"),
  },
  {
    id: "hosted-model",
    cellType: "code",
    language: "python",
    source: [
      "features = orders.assign(month=orders.date.dt.month)",
      "predictions = model.predict(features[columns])",
      "display(metrics)",
    ].join("\n"),
    executionCount: 12,
    outputs: [
      {
        output_id: "hosted-model-stream",
        output_type: "stream",
        name: "stdout",
        text: "validated 16 week backtest window\n",
      },
      {
        output_id: "hosted-model-json",
        output_type: "execute_result",
        execution_count: 12,
        data: {
          "application/json": {
            mae: 8.42,
            mape: "6.8%",
            holdout_weeks: 16,
          },
          "text/plain": "MAE 8.42, MAPE 6.8%, holdout 16 weeks",
        },
        metadata: {},
      },
    ],
  },
  {
    id: "hosted-summary",
    cellType: "code",
    language: "python",
    source: "display(summary_markdown)",
    executionCount: 13,
    outputs: [
      {
        output_id: "hosted-summary-markdown",
        output_type: "display_data",
        data: {
          "text/markdown": [
            "### Summary",
            "",
            "- Forecast error stayed within the review threshold.",
            "- The hosted renderer uses the docs isolated-frame adapter.",
          ].join("\n"),
        },
        metadata: {},
      },
    ],
  },
];

const singleCellOutputs = [
  {
    output_id: "single-cell-json",
    output_type: "display_data" as const,
    data: {
      "application/json": {
        renderer: "cell",
        displayMode: "report",
        outputs: 1,
      },
      "text/plain": "ReadOnlyNotebookCell report mode",
    },
    metadata: {},
  },
];

export function ReadOnlyNotebookSurfacesExample() {
  return (
    <div className="not-prose space-y-6" data-testid="read-only-notebook-surfaces-example">
      <section className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-4 text-sky-900 dark:text-sky-100">
        <div className="flex items-start gap-3">
          <Cloud className="mt-0.5 size-4 flex-none" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold">Hosted notebook fixture</h2>
            <p className="mt-1 text-xs leading-5">
              These examples render the shared read-only notebook components used by cloud and
              published artifact paths. Outputs are static nbformat fixtures, and markdown uses the
              docs app isolated-frame adapter instead of a runtime iframe bundle.
            </p>
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="flex items-start justify-between gap-3 border-b border-fd-border p-4">
          <div className="flex min-w-0 items-center gap-2">
            <Rows3 className="size-4 flex-none text-fd-muted-foreground" aria-hidden="true" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">ReadOnlyNotebook</h2>
              <div className="mt-1 break-words font-mono text-[11px] leading-4 text-fd-muted-foreground [overflow-wrap:anywhere]">
                src/components/cell/ReadOnlyNotebook.tsx
              </div>
            </div>
          </div>
          <span className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
            rendered
          </span>
        </div>
        <div className="bg-background p-4">
          <ReadOnlyNotebook
            cells={notebookCells}
            displayMode="notebook"
            className="gap-3"
            cellClassName="rounded-lg border border-fd-border bg-fd-background pl-1"
            label="Hosted notebook fixture"
          />
        </div>
      </section>

      <section className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
          <div className="flex items-start justify-between gap-3 border-b border-fd-border p-4">
            <div className="flex min-w-0 items-center gap-2">
              <FileCode2 className="size-4 flex-none text-fd-muted-foreground" aria-hidden="true" />
              <div className="min-w-0">
                <h2 className="text-sm font-semibold">ReadOnlyNotebookCell</h2>
                <div className="mt-1 break-words font-mono text-[11px] leading-4 text-fd-muted-foreground [overflow-wrap:anywhere]">
                  src/components/cell/ReadOnlyNotebookCell.tsx
                </div>
              </div>
            </div>
            <span className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
              rendered
            </span>
          </div>
          <div className="bg-background p-4">
            <ReadOnlyNotebookCell
              id="single-read-only-cell"
              cellType="code"
              source="summary = {'renderer': 'cell'}"
              language="python"
              executionCount={7}
              outputs={singleCellOutputs}
              displayMode="report"
              className="rounded-lg border border-fd-border bg-fd-background p-3"
            />
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
          <div className="flex items-start justify-between gap-3 border-b border-fd-border p-4">
            <div className="flex min-w-0 items-center gap-2">
              <Loader2 className="size-4 flex-none text-fd-muted-foreground" aria-hidden="true" />
              <div className="min-w-0">
                <h2 className="text-sm font-semibold">CellSkeleton</h2>
                <div className="mt-1 break-words font-mono text-[11px] leading-4 text-fd-muted-foreground [overflow-wrap:anywhere]">
                  apps/notebook/src/components/CellSkeleton.tsx
                </div>
              </div>
            </div>
            <span className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
              rendered
            </span>
          </div>
          <div className="bg-background p-4">
            <div className="rounded-lg border border-fd-border bg-fd-background">
              <CellSkeleton />
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-fd-border bg-fd-card p-4">
        <div className="flex items-start gap-3">
          <Eye className="mt-0.5 size-4 flex-none text-fd-muted-foreground" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold">Adapter boundary</h2>
            <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
              The production components still route through `OutputArea`. The catalog uses the local
              isolated-frame adapter for markdown output, so this page stays runtime-free while
              exercising the same read-only cell composition path.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
