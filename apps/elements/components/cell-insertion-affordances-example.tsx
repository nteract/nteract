"use client";

import { CheckCircle2, Rows3 } from "lucide-react";
import { CellInsertionRibbon } from "@/components/cell/CellInsertionRibbon";

const insertionRows = [
  {
    label: "Between cells",
    detail:
      "Default row between existing notebook cells. Hover and focus reveal production actions.",
    props: {},
  },
  {
    label: "Code target",
    detail:
      "The controlled code state shows the same color and action grammar used in NotebookView.",
    props: { activeType: "code" as const, forceActionsVisible: true },
  },
  {
    label: "Markdown target",
    detail: "The controlled markdown state uses the production markdown ribbon and insertion rule.",
    props: { activeType: "markdown" as const, forceActionsVisible: true },
  },
  {
    label: "Document tail",
    detail:
      "The terminal row fades the spine while keeping the production add-cell actions attached.",
    props: { activeType: "code" as const, terminal: true, forceActionsVisible: true },
  },
];

const componentRows = [
  {
    component: "CellInsertionRibbon",
    path: "src/components/cell/CellInsertionRibbon.tsx",
    role: "Between-cell and terminal add-cell row used by the notebook workspace.",
  },
  {
    component: "notebookCellLayoutVars",
    path: "src/components/cell/cell-layout.ts",
    role: "Shared content column and ribbon geometry for cells and add-cell rows.",
  },
];

const noopInsert = () => undefined;

export function CellInsertionAffordancesExample() {
  return (
    <div className="not-prose space-y-6">
      <section className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-emerald-900 dark:text-emerald-100">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 size-4 flex-none" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold">Production add-cell rows only</h2>
            <p className="mt-1 text-xs leading-5">
              This page renders `CellInsertionRibbon` states directly. Earlier alternative row
              studies have been removed so the catalog does not imply a second add-cell component.
            </p>
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="border-b border-fd-border p-4">
          <div className="flex items-center gap-2">
            <Rows3 className="size-4 text-fd-muted-foreground" aria-hidden="true" />
            <h2 className="text-sm font-semibold">Insertion row states</h2>
          </div>
          <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
            The catalog controls only the fixture state and inert insert callback. Layout, hover
            behavior, labels, icons, and terminal fading are all owned by the shared component.
          </p>
        </div>
        <div className="divide-y divide-fd-border bg-background">
          {insertionRows.map((row) => (
            <div key={row.label} className="grid gap-4 p-4 lg:grid-cols-[220px_minmax(0,1fr)]">
              <div>
                <h3 className="text-sm font-semibold">{row.label}</h3>
                <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">{row.detail}</p>
              </div>
              <div className="min-w-0 overflow-hidden rounded-md border border-fd-border bg-fd-background">
                <CellInsertionRibbon {...row.props} onInsert={noopInsert} />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2">
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
