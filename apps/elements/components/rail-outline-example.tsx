"use client";

import { Boxes, ListTree, Package, PanelLeft, ShieldCheck, Variable } from "lucide-react";
import { useState } from "react";
import { KERNEL_STATUS, RUNTIME_STATUS, type RuntimeLifecycle } from "runtimed";
import { cn } from "@/lib/utils";
import { DependencyHeader } from "@/notebook-components/DependencyHeader";
import { NotebookToolbar } from "@/notebook-components/NotebookToolbar";

const noop = () => {};
const asyncNoop = async () => {};
const asyncTrue = async () => true;

type RailPanelKey = "outline" | "packages" | "variables" | "renderers";

const runningIdleLifecycle: RuntimeLifecycle = {
  lifecycle: "Running",
  activity: "Idle",
};

const outlineItems = [
  { title: "Load data", depth: 0 },
  { title: "Clean columns", depth: 1 },
  { title: "Explore shape", depth: 0 },
  { title: "Model run", depth: 0 },
  { title: "Findings", depth: 1 },
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

const variableItems = [
  { name: "orders", type: "DataFrame", value: "2,148 rows x 18 columns" },
  { name: "features", type: "DataFrame", value: "2,148 rows x 32 columns" },
  { name: "model", type: "Pipeline", value: "StandardScaler -> Ridge" },
  { name: "mae", type: "float", value: "8.42" },
];

const rendererItems = [
  { name: "text/html", state: "isolated" },
  { name: "application/vnd.apache.arrow.file", state: "sift" },
  { name: "image/png", state: "inline" },
];

const railItems = [
  { key: "outline", icon: ListTree, label: "Outline" },
  { key: "packages", icon: Package, label: "Packages" },
  { key: "variables", icon: Variable, label: "Variables" },
  { key: "renderers", icon: Boxes, label: "Renderers" },
] satisfies Array<{ key: RailPanelKey; icon: typeof ListTree; label: string }>;

export function RailOutlineExample() {
  const [activePanel, setActivePanel] = useState<RailPanelKey>("outline");
  const panelTitle = railItems.find((item) => item.key === activePanel)?.label ?? "Outline";
  const panelDetail =
    activePanel === "outline"
      ? `${outlineItems.length} headings`
      : activePanel === "packages"
        ? "uv:inline · 4 packages"
        : activePanel === "variables"
          ? `${variableItems.length} live names`
          : `${rendererItems.length} renderers`;

  return (
    <div
      className="not-prose overflow-hidden rounded-lg border border-fd-border bg-fd-card text-fd-card-foreground shadow-sm"
      data-elements-slot="rail-outline-example"
    >
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
      <div className="grid min-h-[500px] grid-cols-[48px_minmax(260px,300px)_minmax(320px,1fr)] overflow-x-auto">
        <aside className="flex flex-col items-center gap-2 border-r border-fd-border bg-fd-muted/40 px-2 py-3">
          <div className="mb-3 flex size-8 items-center justify-center rounded-md bg-fd-primary text-fd-primary-foreground">
            <PanelLeft className="size-4" aria-hidden="true" />
          </div>
          {railItems.map((item) => (
            <button
              key={item.label}
              type="button"
              aria-pressed={activePanel === item.key}
              onClick={() => setActivePanel(item.key)}
              className={cn(
                "flex size-8 items-center justify-center rounded-md border text-xs",
                "transition-colors hover:border-fd-border hover:bg-fd-background hover:text-fd-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-primary/40",
                activePanel === item.key
                  ? "border-fd-primary bg-fd-primary text-fd-primary-foreground"
                  : "border-transparent text-fd-muted-foreground",
              )}
              title={item.label}
            >
              <item.icon className="size-4" aria-hidden="true" />
            </button>
          ))}
        </aside>

        <aside className="min-h-0 overflow-y-auto border-r border-fd-border bg-fd-background p-4">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.08em] text-fd-muted-foreground">
                Notebook
              </p>
              <h3 className="mt-1 text-sm font-semibold">{panelTitle}</h3>
            </div>
            <span className="rounded-full border border-fd-border bg-fd-muted px-2 py-1 text-[11px] text-fd-muted-foreground">
              {panelDetail}
            </span>
          </div>

          {activePanel === "outline" && <OutlinePanel />}
          {activePanel === "packages" && <PackagePanel />}
          {activePanel === "variables" && <VariablesPanel />}
          {activePanel === "renderers" && <RenderersPanel />}
        </aside>

        <main className="bg-fd-muted/20 p-6">
          <div className="mx-auto max-w-2xl space-y-3">
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs leading-5 text-emerald-900 dark:text-emerald-300">
              <div className="mb-1 flex items-center gap-2 font-semibold">
                <ShieldCheck className="size-3.5" aria-hidden="true" />
                NotebookToolbar and DependencyHeader are rendered from the notebook app.
              </div>
              <p>
                The rail shell stays fixture-backed while package management starts using current
                dependency UI inside the left-side panel.
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

function OutlinePanel() {
  return (
    <>
      <nav className="space-y-1" aria-label="Notebook outline preview">
        {outlineItems.map((item, index) => (
          <div
            key={item.title}
            className={cn(
              "flex items-center rounded-md px-2 py-1.5 text-sm",
              item.depth === 1 && "ml-4",
              index === 0 ? "bg-fd-primary text-fd-primary-foreground" : "text-fd-muted-foreground",
            )}
          >
            {item.title}
          </div>
        ))}
      </nav>
      <div className="mt-6 rounded-md border border-dashed border-fd-border p-3 text-xs leading-5 text-fd-muted-foreground">
        Packages and variables are sibling rail panels, not sections inside the outline.
      </div>
    </>
  );
}

function PackagePanel() {
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-fd-border bg-fd-muted/40 p-3 text-xs leading-5 text-fd-muted-foreground">
        This uses the current notebook dependency panel in a rail-sized frame. The catalog owns only
        the fixture state and inert callbacks.
      </div>
      <div className="overflow-hidden rounded-md border border-fd-border bg-fd-card">
        <DependencyHeader
          dependencies={["pandas>=2", "polars", "plotly", "scikit-learn"]}
          requiresPython=">=3.13"
          loading={false}
          onAdd={asyncNoop}
          onRemove={asyncNoop}
          onSetRequiresPython={asyncNoop}
          syncState={{ status: "dirty", added: ["altair"], removed: [] }}
          onSyncNow={asyncTrue}
          pyprojectInfo={null}
          pyprojectDeps={null}
          isUsingProjectEnv={false}
          justSynced={false}
        />
      </div>
    </div>
  );
}

function VariablesPanel() {
  return (
    <div className="space-y-2">
      {variableItems.map((variable) => (
        <div key={variable.name} className="rounded-md border border-fd-border px-2 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate font-mono text-xs text-fd-foreground">
              {variable.name}
            </span>
            <span className="rounded bg-fd-muted px-1.5 py-0.5 text-[10px] text-fd-muted-foreground">
              {variable.type}
            </span>
          </div>
          <div className="mt-1 truncate text-[11px] text-fd-muted-foreground">{variable.value}</div>
        </div>
      ))}
    </div>
  );
}

function RenderersPanel() {
  return (
    <div className="space-y-2">
      {rendererItems.map((renderer) => (
        <div
          key={renderer.name}
          className="flex items-center justify-between gap-3 rounded-md border border-fd-border px-2 py-2"
        >
          <span className="min-w-0 truncate font-mono text-xs text-fd-foreground">
            {renderer.name}
          </span>
          <span className="rounded bg-fd-muted px-1.5 py-0.5 text-[10px] text-fd-muted-foreground">
            {renderer.state}
          </span>
        </div>
      ))}
    </div>
  );
}
