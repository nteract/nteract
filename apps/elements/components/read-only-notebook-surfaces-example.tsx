"use client";

import { Cloud, Eye, FileCode2, Loader2, Rows3 } from "lucide-react";
import { CellSkeleton } from "@/components/cell/CellSkeleton";
import { ReadOnlyNotebook } from "@/components/cell/ReadOnlyNotebook";
import { ReadOnlyNotebookCell } from "@/components/cell/ReadOnlyNotebookCell";
import {
  getElementsNotebookScenario,
  resolveElementsNotebookLanguage,
} from "@/components/notebook-scenarios";

export function ReadOnlyNotebookSurfacesExample() {
  const scenario = getElementsNotebookScenario("cloud-public-viewer");
  const reportCell =
    scenario.cells.find((cell) => cell.id === "cell-shape-output") ?? scenario.cells[0];

  return (
    <div className="not-prose space-y-6" data-testid="read-only-notebook-surfaces-example">
      <section className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-4 text-sky-900 dark:text-sky-100">
        <div className="flex items-start gap-3">
          <Cloud className="mt-0.5 size-4 flex-none" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold">Hosted notebook fixture</h2>
            <p className="mt-1 text-xs leading-5">
              These examples render the shared read-only notebook components used by cloud and
              published artifact paths. Cells come from the Elements notebook scenario projection,
              outputs are static nbformat fixtures, and markdown uses the docs app isolated-frame
              adapter instead of a runtime iframe bundle.
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
            cells={scenario.viewModel.readOnlyCells}
            displayMode="notebook"
            className="gap-3"
            cellClassName="rounded-lg border border-fd-border bg-fd-background pl-1"
            label={`${scenario.title} notebook fixture`}
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
              id={reportCell.id}
              cellType={reportCell.cellType}
              source={reportCell.source}
              language={resolveElementsNotebookLanguage(reportCell.language)}
              executionCount={reportCell.executionCount}
              outputs={reportCell.outputs}
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
                  src/components/cell/CellSkeleton.tsx
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
              The production components still route through `OutputArea`. The catalog receives the
              same read-only cells the shared shell view model produces, then uses the local
              isolated-frame adapter for markdown output so this page stays runtime-free.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
