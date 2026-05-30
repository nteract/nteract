"use client";

import { Boxes, ListTree, ShieldCheck, Variable } from "lucide-react";
import { useState } from "react";
import {
  KERNEL_STATUS,
  RUNTIME_STATUS,
  projectNotebookOutline,
  resolveNotebookOutlineSelection,
  type NotebookOutlineItem,
  type NotebookOutlineSourceCell,
  type RuntimeLifecycle,
} from "runtimed";
import {
  NotebookPackagesPanel,
  NotebookRail,
  type NotebookRailPanelId,
} from "@/components/notebook-rail";
import { cn } from "@/lib/utils";
import { DependencyHeader } from "@/notebook-components/DependencyHeader";
import { NotebookToolbar } from "@/notebook-components/NotebookToolbar";

const noop = () => {};
const asyncNoop = async () => {};
const asyncTrue = async () => true;

const runningIdleLifecycle: RuntimeLifecycle = {
  lifecycle: "Running",
  activity: "Idle",
};

const notebookCells: NotebookOutlineSourceCell[] = [
  {
    id: "cell-load-data",
    cell_type: "markdown",
    source: "# Load data\n\nImport the order history and make dates explicit.",
  },
  {
    id: "cell-load-code",
    cell_type: "code",
    source: "orders = pandas.read_csv('orders.csv', parse_dates=['date'])",
    execution_count: 12,
  },
  {
    id: "cell-clean-columns",
    cell_type: "markdown",
    source: "## Clean columns\n\nNormalize status values before joining lookup tables.",
  },
  {
    id: "cell-clean-code",
    cell_type: "code",
    source: "orders = clean_columns(orders)",
    execution_count: 13,
  },
  {
    id: "cell-explore-shape",
    cell_type: "markdown",
    source: "# Explore shape\n\nCheck the model-ready feature table.",
  },
  {
    id: "cell-shape-output",
    cell_type: "code",
    source: "features.shape",
    execution_count: 14,
  },
  {
    id: "cell-model-run",
    cell_type: "markdown",
    source: "# Model run\n\nTrain the weekly backtest model.",
  },
  {
    id: "cell-model-code",
    cell_type: "code",
    source: "model.fit(features[columns], target)",
    execution_count: null,
  },
  {
    id: "cell-findings",
    cell_type: "markdown",
    source: "## Findings\n\nSummarize the backtest before export.",
  },
];

const executingCellId = "cell-model-code";
const queuedCellIds = new Set(["cell-shape-output"]);

const outlineItems: NotebookOutlineItem[] = projectNotebookOutline(notebookCells, {
  getStatusLabel: (cell) => {
    if (cell.id === executingCellId) return "Running";
    if (queuedCellIds.has(cell.id)) return "Queued";
    if (cell.cell_type === "code" && cell.execution_count !== null) {
      return `In [${cell.execution_count}]`;
    }
    return null;
  },
}).items;
const outlineCellIds = notebookCells.map((cell) => cell.id);
const activeOutlineItemId = "cell-explore-shape:heading:0";

const notebookCellCards = notebookCells.map((cell) => {
  const firstLine = cell.source
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const title = firstLine?.replace(/^#{1,6}\s+/, "") ?? cell.id;
  const kind = cell.cell_type === "markdown" ? "Markdown" : "Code";
  const status =
    cell.id === executingCellId ? "Running" : queuedCellIds.has(cell.id) ? "Queued" : null;
  return {
    id: cell.id,
    label: kind,
    title,
    body: cell.source ?? "",
    status,
  };
});

const outlineBoundaryRows = [
  {
    label: "Projection source",
    catalog: "projectNotebookOutline(fixture cells)",
    production: "getNotebookCellsSnapshot() + RuntimeStateDoc cell materialization",
  },
  {
    label: "Context selection",
    catalog: "focusedCellId fixture + outlineCellIds",
    production: "useActiveOutlineItemId + resolveNotebookOutlineSelection",
  },
  {
    label: "Heading anchors",
    catalog: "static cards with generated outline ids",
    production: "NotebookView passes markdownHeadingAnchorsByCellId into MarkdownCell",
  },
  {
    label: "Heading navigation",
    catalog: "inert anchor callback",
    production: "navigateMarkdownHeading, scrollIntoView, and history.replaceState",
  },
  {
    label: "DOM order",
    catalog: "fixture cell order",
    production: "stableDomOrder renders DOM while CSS order controls visual position",
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

const plannedRailPanels = [
  {
    icon: Variable,
    title: "Variables",
    detail: `${variableItems.length} fixture names`,
    body: "A future rail sibling for live namespace inspection once the app has a current variable surface.",
  },
  {
    icon: Boxes,
    title: "Renderers",
    detail: `${rendererItems.length} fixture MIME lanes`,
    body: "A future diagnostics panel for output MIME routing, plugin loading, and renderer health.",
  },
];

export function RailOutlineExample() {
  const [activePanel, setActivePanel] = useState<NotebookRailPanelId>("outline");
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [selectedOutlineItemId, setSelectedOutlineItemId] = useState<string | null>(null);
  const [focusedCellId, setFocusedCellId] = useState("cell-clean-code");
  const resolvedOutlineItemId = resolveNotebookOutlineSelection(outlineItems, {
    selectedItemId: selectedOutlineItemId,
    selectedCellId: focusedCellId,
    cellIds: outlineCellIds,
  });
  const selectedOutlineItem =
    outlineItems.find((item) => item.id === resolvedOutlineItemId) ?? outlineItems[0];

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
        focusedCellId={focusedCellId}
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
      <div className="grid min-h-[500px] grid-cols-[auto_minmax(320px,1fr)] overflow-x-auto">
        <NotebookRail
          activePanelId={activePanel}
          collapsed={railCollapsed}
          outlineItems={outlineItems}
          outlineCellIds={outlineCellIds}
          activeOutlineItemId={activeOutlineItemId}
          selectedOutlineItemId={selectedOutlineItemId}
          selectedOutlineCellId={focusedCellId}
          packagesSummary="uv:inline · 4 packages"
          packagesPanel={
            <NotebookPackagesPanel>
              <PackagePanelContent />
            </NotebookPackagesPanel>
          }
          onActivePanelChange={setActivePanel}
          onCollapsedChange={setRailCollapsed}
          onSelectOutlineItem={(item) => {
            setSelectedOutlineItemId(item.id);
            setFocusedCellId(item.cellId);
          }}
          onNavigateOutlineItem={() => true}
        />

        <main className="min-w-[320px] bg-fd-muted/20 p-6">
          <div className="mx-auto max-w-2xl space-y-3">
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs leading-5 text-emerald-900 dark:text-emerald-300">
              <div className="mb-1 flex items-center gap-2 font-semibold">
                <ShieldCheck className="size-3.5" aria-hidden="true" />
                NotebookToolbar, NotebookRail, and DependencyHeader render from current sources.
              </div>
              <p>
                The docs app owns fixture state only: focused cell, active scroll item, collapsed
                state, package callbacks, and inert anchor navigation.
              </p>
            </div>
            <div className="rounded-lg border border-fd-border bg-fd-background p-3 text-xs leading-5 text-fd-muted-foreground">
              <span className="font-medium text-fd-foreground">Context selection:</span> focused
              cell <code className="rounded bg-fd-muted px-1 py-0.5">{focusedCellId}</code> resolves
              to{" "}
              <span className="font-medium text-fd-foreground">{selectedOutlineItem?.title}</span>.
            </div>
            {notebookCellCards.map((cell) => (
              <section
                key={cell.id}
                role="button"
                tabIndex={0}
                onClick={() => {
                  setFocusedCellId(cell.id);
                  setSelectedOutlineItemId(null);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  setFocusedCellId(cell.id);
                  setSelectedOutlineItemId(null);
                }}
                className={cn(
                  "rounded-lg border border-fd-border bg-fd-background p-4 shadow-sm transition-colors",
                  "focus:outline-none focus:ring-2 focus:ring-fd-primary/30",
                  focusedCellId === cell.id && "border-fd-primary/60 bg-fd-primary/5",
                )}
              >
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h4 className="text-sm font-semibold">{cell.title}</h4>
                  <div className="flex items-center gap-1.5">
                    {cell.status ? (
                      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-800 dark:text-amber-300">
                        {cell.status}
                      </span>
                    ) : null}
                    <span className="rounded-full bg-fd-muted px-2 py-0.5 text-[11px] text-fd-muted-foreground">
                      {cell.label}
                    </span>
                  </div>
                </div>
                <p className="font-mono text-xs leading-6 text-fd-muted-foreground">{cell.body}</p>
              </section>
            ))}
            <section className="rounded-lg border border-dashed border-fd-border bg-fd-background p-4">
              <div className="mb-3 flex items-center gap-2">
                <ListTree className="size-4 text-fd-muted-foreground" aria-hidden="true" />
                <h4 className="text-sm font-semibold">Adapter boundary</h4>
              </div>
              <div className="space-y-2">
                {outlineBoundaryRows.map((row) => (
                  <div
                    key={row.label}
                    className="space-y-2 rounded-md border border-fd-border p-3 text-xs leading-5"
                  >
                    <div className="font-medium text-fd-foreground">{row.label}</div>
                    <div className="min-w-0">
                      <span className="mb-1 block text-[10px] uppercase tracking-[0.08em] text-fd-muted-foreground">
                        Catalog
                      </span>
                      <span className="break-words text-fd-muted-foreground">{row.catalog}</span>
                    </div>
                    <div className="min-w-0">
                      <span className="mb-1 block text-[10px] uppercase tracking-[0.08em] text-fd-muted-foreground">
                        Production
                      </span>
                      <span className="break-words text-fd-muted-foreground">{row.production}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
            <section className="rounded-lg border border-dashed border-fd-border bg-fd-background p-4">
              <div className="mb-3 flex items-center gap-2">
                <ListTree className="size-4 text-fd-muted-foreground" aria-hidden="true" />
                <h4 className="text-sm font-semibold">Planned sibling panels</h4>
              </div>
              <div className="grid gap-2">
                {plannedRailPanels.map((panel) => (
                  <div key={panel.title} className="rounded-md border border-fd-border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <panel.icon
                          className="size-4 text-fd-muted-foreground"
                          aria-hidden="true"
                        />
                        <h5 className="text-sm font-medium">{panel.title}</h5>
                      </div>
                      <span className="shrink-0 rounded bg-fd-muted px-1.5 py-0.5 text-[10px] text-fd-muted-foreground">
                        {panel.detail}
                      </span>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">{panel.body}</p>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}

function PackagePanelContent() {
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
