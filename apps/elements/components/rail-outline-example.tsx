"use client";

import { Boxes, ListTree, Package, PanelLeft, ShieldCheck, Variable } from "lucide-react";
import { KERNEL_STATUS, RUNTIME_STATUS, type RuntimeLifecycle } from "runtimed";
import { NotebookToolbar } from "@/notebook-components/NotebookToolbar";

const noop = () => {};

const runningIdleLifecycle: RuntimeLifecycle = {
  lifecycle: "Running",
  activity: "Idle",
};

const outlineItems = [
  { title: "Load data", depth: 0, active: true },
  { title: "Clean columns", depth: 1, active: false },
  { title: "Explore shape", depth: 0, active: false },
  { title: "Model run", depth: 0, active: false },
  { title: "Findings", depth: 1, active: false },
];

const cells = [
  {
    label: "Markdown",
    title: "Load data",
    body: "Notebook sections are derived from markdown headings first. Code-cell section metadata can come later.",
  },
  {
    label: "Code",
    title: "read_csv",
    body: "df = pandas.read_csv('runs.csv')",
  },
  {
    label: "Output",
    title: "Preview",
    body: "2,148 rows x 18 columns",
  },
];

export function RailOutlineExample() {
  return (
    <div className="not-prose overflow-hidden rounded-lg border border-fd-border bg-fd-card text-fd-card-foreground shadow-sm">
      <NotebookToolbar
        kernelStatus={KERNEL_STATUS.IDLE}
        statusKey={RUNTIME_STATUS.RUNNING_IDLE}
        lifecycle={runningIdleLifecycle}
        errorReason={null}
        kernelErrorMessage={null}
        envSource="uv:inline"
        envTypeHint="uv"
        envProgress={null}
        runtime="python"
        focusedCellId="cell-clean-columns"
        lastCellId="cell-findings"
        onStartKernel={noop}
        onInterruptKernel={noop}
        onRestartKernel={noop}
        onRunAllCells={noop}
        onRestartAndRunAll={noop}
        onAddCell={noop}
        onToggleDependencies={noop}
        isDepsOpen={false}
        depsOutOfSync={false}
      />
      <div className="grid min-h-[420px] grid-cols-[48px_260px_minmax(420px,1fr)] overflow-x-auto">
        <aside className="flex flex-col items-center gap-2 border-r border-fd-border bg-fd-muted/40 px-2 py-3">
          <div className="mb-3 flex size-8 items-center justify-center rounded-md bg-fd-primary text-fd-primary-foreground">
            <PanelLeft className="size-4" aria-hidden="true" />
          </div>
          {[
            { icon: ListTree, label: "Outline", active: true },
            { icon: Package, label: "Packages", active: false },
            { icon: Variable, label: "Variables", active: false },
            { icon: Boxes, label: "Renderers", active: false },
          ].map((item) => (
            <div
              key={item.label}
              className={[
                "flex size-8 items-center justify-center rounded-md border text-xs",
                item.active
                  ? "border-fd-primary bg-fd-primary text-fd-primary-foreground"
                  : "border-transparent text-fd-muted-foreground",
              ].join(" ")}
              title={item.label}
            >
              <item.icon className="size-4" aria-hidden="true" />
            </div>
          ))}
        </aside>

        <aside className="border-r border-fd-border bg-fd-background p-4">
          <div className="mb-4">
            <p className="text-xs font-medium uppercase tracking-[0.08em] text-fd-muted-foreground">
              Notebook
            </p>
            <h3 className="mt-1 text-sm font-semibold">Outline</h3>
          </div>
          <nav className="space-y-1" aria-label="Notebook outline preview">
            {outlineItems.map((item) => (
              <div
                key={item.title}
                className={[
                  "flex items-center rounded-md px-2 py-1.5 text-sm",
                  item.depth === 1 ? "ml-4" : "",
                  item.active
                    ? "bg-fd-primary text-fd-primary-foreground"
                    : "text-fd-muted-foreground",
                ].join(" ")}
              >
                {item.title}
              </div>
            ))}
          </nav>
          <div className="mt-6 rounded-md border border-dashed border-fd-border p-3 text-xs leading-5 text-fd-muted-foreground">
            Packages and variables become sibling panels on the same rail, not sections inside the
            outline.
          </div>
        </aside>

        <main className="bg-fd-muted/20 p-6">
          <div className="mx-auto max-w-2xl space-y-3">
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs leading-5 text-emerald-900 dark:text-emerald-300">
              <div className="mb-1 flex items-center gap-2 font-semibold">
                <ShieldCheck className="size-3.5" aria-hidden="true" />
                NotebookToolbar is rendered from the notebook app.
              </div>
              <p>
                The rail and outline data remain fixture-backed until the app has a production rail
                component and heading adapter.
              </p>
            </div>
            {cells.map((cell) => (
              <section
                key={cell.title}
                className="rounded-lg border border-fd-border bg-fd-background p-4 shadow-sm"
              >
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h4 className="text-sm font-semibold">{cell.title}</h4>
                  <span className="rounded-full bg-fd-muted px-2 py-0.5 text-[11px] text-fd-muted-foreground">
                    {cell.label}
                  </span>
                </div>
                <p className="font-mono text-xs leading-6 text-fd-muted-foreground">{cell.body}</p>
              </section>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
