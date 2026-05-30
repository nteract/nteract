"use client";

import { Boxes, ListTree, ShieldCheck, Variable } from "lucide-react";
import { useState } from "react";
import {
  KERNEL_STATUS,
  RUNTIME_STATUS,
  type NotebookOutlineItem,
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

const outlineItems: NotebookOutlineItem[] = [
  {
    id: "cell-load-data:heading:0",
    cellId: "cell-load-data",
    title: "Load data",
    level: 1,
    kind: "heading",
    cellAnchorId: "notebook-cell-cell-load-data",
    headingAnchorId: "notebook-cell-cell-load-data-heading-load-data",
    href: "#notebook-cell-cell-load-data",
    anchor: "load-data",
    statusLabel: "markdown",
  },
  {
    id: "cell-clean-columns:heading:0",
    cellId: "cell-clean-columns",
    title: "Clean columns",
    level: 2,
    kind: "heading",
    cellAnchorId: "notebook-cell-cell-clean-columns",
    headingAnchorId: "notebook-cell-cell-clean-columns-heading-clean-columns",
    href: "#notebook-cell-cell-clean-columns",
    anchor: "clean-columns",
    detail: "code",
  },
  {
    id: "cell-explore-shape:heading:0",
    cellId: "cell-explore-shape",
    title: "Explore shape",
    level: 1,
    kind: "heading",
    cellAnchorId: "notebook-cell-cell-explore-shape",
    headingAnchorId: "notebook-cell-cell-explore-shape-heading-explore-shape",
    href: "#notebook-cell-cell-explore-shape",
    anchor: "explore-shape",
  },
  {
    id: "cell-model-run:heading:0",
    cellId: "cell-model-run",
    title: "Model run",
    level: 1,
    kind: "heading",
    cellAnchorId: "notebook-cell-cell-model-run",
    headingAnchorId: "notebook-cell-cell-model-run-heading-model-run",
    href: "#notebook-cell-cell-model-run",
    anchor: "model-run",
  },
  {
    id: "cell-findings:heading:0",
    cellId: "cell-findings",
    title: "Findings",
    level: 2,
    kind: "heading",
    cellAnchorId: "notebook-cell-cell-findings",
    headingAnchorId: "notebook-cell-cell-findings-heading-findings",
    href: "#notebook-cell-cell-findings",
    anchor: "findings",
  },
];

const cells = [
  {
    label: "Markdown",
    title: "Load data",
    body: "Notebook sections are derived from markdown headings first. Code-cell section metadata can come later.",
  },
  {
    label: "Code",
    title: "Clean columns",
    body: "df = pandas.read_csv('runs.csv')",
  },
  {
    label: "Output",
    title: "Explore shape",
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
  const [selectedOutlineItemId, setSelectedOutlineItemId] = useState(outlineItems[1]?.id ?? null);
  const selectedOutlineItem =
    outlineItems.find((item) => item.id === selectedOutlineItemId) ?? outlineItems[0];

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
      <div className="grid min-h-[500px] grid-cols-[auto_minmax(320px,1fr)] overflow-x-auto">
        <NotebookRail
          activePanelId={activePanel}
          collapsed={railCollapsed}
          outlineItems={outlineItems}
          selectedOutlineItemId={selectedOutlineItemId}
          selectedOutlineCellId={selectedOutlineItem?.cellId ?? null}
          packagesSummary="uv:inline · 4 packages"
          packagesPanel={
            <NotebookPackagesPanel>
              <PackagePanelContent />
            </NotebookPackagesPanel>
          }
          onActivePanelChange={setActivePanel}
          onCollapsedChange={setRailCollapsed}
          onSelectOutlineItem={(item) => setSelectedOutlineItemId(item.id)}
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
                The docs app owns fixture state only: selected outline item, collapsed state,
                package callbacks, and inert anchor navigation.
              </p>
            </div>
            {cells.map((cell) => (
              <section
                key={cell.title}
                className={cn(
                  "rounded-lg border border-fd-border bg-fd-background p-4 shadow-sm",
                  selectedOutlineItem?.title === cell.title && "border-fd-primary/50",
                )}
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
            <section className="rounded-lg border border-dashed border-fd-border bg-fd-background p-4">
              <div className="mb-3 flex items-center gap-2">
                <ListTree className="size-4 text-fd-muted-foreground" aria-hidden="true" />
                <h4 className="text-sm font-semibold">Planned sibling panels</h4>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
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
