"use client";

import { Boxes, ListTree, ShieldCheck, Variable } from "lucide-react";
import { useState } from "react";
import {
  KERNEL_STATUS,
  RUNTIME_STATUS,
  resolveNotebookOutlineSelection,
  type RuntimeLifecycle,
} from "runtimed";
import { ReadOnlyNotebookCell } from "@/components/cell/ReadOnlyNotebookCell";
import {
  NotebookCellList,
  NotebookDocumentHeader,
  NotebookDocumentRail,
  NotebookDocumentShell,
  type NotebookViewCell,
} from "@/components/notebook-shell";
import { NotebookPackagesPanel, type NotebookRailPanelId } from "@/components/notebook-rail";
import { cn } from "@/lib/utils";
import { DependencyHeader } from "@/notebook-components/DependencyHeader";
import { NotebookToolbar } from "@/notebook-components/NotebookToolbar";
import {
  getElementsNotebookScenario,
  resolveElementsNotebookLanguage,
  type ElementsNotebookScenario,
  type ElementsNotebookScenarioId,
} from "@/components/notebook-scenarios";

const noop = () => {};
const asyncNoop = async () => {};
const asyncTrue = async () => true;

const runningIdleLifecycle: RuntimeLifecycle = {
  lifecycle: "Running",
  activity: "Idle",
};

const scenarioIds: ElementsNotebookScenarioId[] = [
  "desktop-local-owner",
  "cloud-public-viewer",
  "cloud-editor",
  "cloud-owner",
  "agent-on-behalf",
  "runtime-unavailable",
];

const executingCellId = "cell-model-code";
const queuedCellIds = new Set(["cell-shape-output"]);

const outlineBoundaryRows = [
  {
    label: "Projection source",
    catalog: "createNotebookViewModel(fixture cells)",
    production: "host adapter materializes cells before the shared shell projection",
  },
  {
    label: "Shell capabilities",
    catalog: "ElementsNotebookScenario.capabilities",
    production: "desktop local state or cloud ACL/auth adapter",
  },
  {
    label: "Context selection",
    catalog: "focusedCellId fixture + viewModel.cellIds",
    production: "NotebookView focus state + shared outline selection",
  },
  {
    label: "Header chrome",
    catalog: "outline title without item count",
    production: "packages may summarize state; outline stays reading-first",
  },
  {
    label: "Heading anchors",
    catalog: "viewModel.markdownHeadingAnchorsByCellId",
    production: "MarkdownCell receives anchors from the shell view model",
  },
  {
    label: "Heading navigation",
    catalog: "inert outline callback updates fixture focus",
    production: "navigateNotebookOutlineItem, heading measurement, and cell-anchor fallback",
  },
  {
    label: "Drag policy",
    catalog: "outline rows cancel native drag previews",
    production: "navigation-only until the app owns true outline reordering",
  },
  {
    label: "DOM order",
    catalog: "fixture cell order",
    production: "stableDomOrder renders DOM while CSS order controls visual position",
  },
];

export function RailOutlineExample() {
  const [scenarioId, setScenarioId] = useState<ElementsNotebookScenarioId>("desktop-local-owner");
  const scenario = getElementsNotebookScenario(scenarioId);
  const [activePanel, setActivePanel] = useState<NotebookRailPanelId>("outline");
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [selectedOutlineItemId, setSelectedOutlineItemId] = useState<string | null>(null);
  const [focusedCellId, setFocusedCellId] = useState("cell-clean-code");
  const { viewModel } = scenario;
  const activeOutlineItemId =
    viewModel.outlineItems.find((item) => item.cellId === "cell-explore-shape")?.id ?? null;
  const resolvedOutlineItemId = resolveNotebookOutlineSelection(viewModel.outlineItems, {
    selectedItemId: selectedOutlineItemId,
    selectedCellId: focusedCellId,
    cellIds: viewModel.cellIds,
  });
  const selectedOutlineItem =
    viewModel.outlineItems.find((item) => item.id === resolvedOutlineItemId) ??
    viewModel.outlineItems[0];

  return (
    <NotebookDocumentShell
      className="not-prose min-h-[700px] overflow-hidden rounded-lg border border-fd-border bg-fd-card text-fd-card-foreground shadow-sm"
      stageClassName="min-w-[320px] bg-fd-muted/20"
      toolbarClassName="border-b border-fd-border"
      toolbarLabel="Notebook fixture toolbar"
      stageLabel="Elements notebook scenario"
      capabilities={scenario.capabilities}
      toolbar={
        <NotebookDocumentHeader
          capabilities={scenario.capabilities}
          runtimeControls={
            <NotebookToolbar
              kernelStatus={KERNEL_STATUS.IDLE}
              statusKey={RUNTIME_STATUS.RUNNING_IDLE}
              lifecycle={runningIdleLifecycle}
              errorReason={scenario.capabilities.canExecute ? null : scenario.runtimeLabel}
              kernelErrorMessage={null}
              envSource="uv:inline"
              envTypeHint="uv"
              envProgress={null}
              runtime="python"
              focusedCellId={focusedCellId}
              lastCellId="cell-findings"
              canEditStructure={scenario.capabilities.canEditStructure}
              canExecute={scenario.capabilities.canExecute}
              canViewPackages={scenario.capabilities.canViewPackages}
              onStartKernel={noop}
              onInterruptKernel={noop}
              onRestartKernel={noop}
              onRunAllCells={noop}
              onRestartAndRunAll={noop}
              onAddCell={noop}
              onToggleDependencies={() => setActivePanel("packages")}
              isDepsOpen={activePanel === "packages"}
              depsOutOfSync={!scenario.capabilities.canManagePackages}
            />
          }
        />
      }
      rail={
        <NotebookDocumentRail
          viewModel={viewModel}
          activePanelId={activePanel}
          collapsed={railCollapsed}
          outlineCellIds={viewModel.cellIds}
          activeOutlineItemId={activeOutlineItemId}
          selectedOutlineItemId={selectedOutlineItemId}
          selectedOutlineCellId={focusedCellId}
          packagesSummary={scenario.packageSummary}
          packagesPanel={
            <NotebookPackagesPanel readOnly={!scenario.capabilities.canManagePackages}>
              <PackagePanelContent scenario={scenario} />
            </NotebookPackagesPanel>
          }
          onActivePanelChange={setActivePanel}
          onCollapsedChange={setRailCollapsed}
          onSelectOutlineItem={(item) => {
            setSelectedOutlineItemId(item.id);
            setFocusedCellId(item.cellId);
          }}
          onNavigateOutlineItem={(item) => {
            setFocusedCellId(item.cellId);
            return true;
          }}
        />
      }
      notices={
        <ScenarioNotice
          scenario={scenario}
          focusedCellId={focusedCellId}
          selectedOutlineTitle={selectedOutlineItem?.title}
          onScenarioChange={setScenarioId}
        />
      }
      noticesClassName="border-b border-fd-border bg-fd-muted/20 p-4"
    >
      <NotebookCellList
        cells={viewModel.cells}
        label="Notebook scenario cells"
        slot="elements-notebook-scenario-cell-list"
        className="gap-3 overflow-y-auto p-4"
        renderCell={(cell) => (
          <ScenarioNotebookCell
            cell={cell}
            focused={focusedCellId === cell.id}
            onFocus={() => {
              setFocusedCellId(cell.id);
              setSelectedOutlineItemId(null);
            }}
          />
        )}
      />
    </NotebookDocumentShell>
  );
}

function ScenarioNotice({
  scenario,
  focusedCellId,
  selectedOutlineTitle,
  onScenarioChange,
}: {
  scenario: ElementsNotebookScenario;
  focusedCellId: string;
  selectedOutlineTitle?: string;
  onScenarioChange: (scenarioId: ElementsNotebookScenarioId) => void;
}) {
  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(280px,420px)]">
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs leading-5 text-emerald-900 dark:text-emerald-300">
        <div className="mb-1 flex items-center gap-2 font-semibold">
          <ShieldCheck className="size-3.5" aria-hidden="true" />
          NotebookDocumentShell, NotebookRail, NotebookCellList, and ReadOnlyNotebookCell render
          from current sources.
        </div>
        <p>
          The docs app owns only scenario facts: capabilities, fixture cells, package metadata,
          focused cell, active panel, and inert navigation callbacks.
        </p>
      </div>

      <div className="rounded-lg border border-fd-border bg-fd-background p-3 text-xs leading-5 text-fd-muted-foreground">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {scenarioIds.map((id) => {
            const option = getElementsNotebookScenario(id);
            return (
              <button
                key={id}
                type="button"
                onClick={() => onScenarioChange(id)}
                className={cn(
                  "rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
                  scenario.id === id
                    ? "border-fd-primary bg-fd-primary text-fd-primary-foreground"
                    : "border-fd-border bg-fd-card text-fd-muted-foreground hover:text-fd-foreground",
                )}
              >
                {option.title}
              </button>
            );
          })}
        </div>
        <div className="font-medium text-fd-foreground">{scenario.summary}</div>
        <div className="mt-2">
          <span className="font-medium text-fd-foreground">Context selection:</span> focused cell{" "}
          <code className="rounded bg-fd-muted px-1 py-0.5">{focusedCellId}</code> resolves to{" "}
          <span className="font-medium text-fd-foreground">{selectedOutlineTitle}</span>.
        </div>
        <div className="mt-1">
          <span className="font-medium text-fd-foreground">Runtime:</span> {scenario.runtimeLabel}
        </div>
      </div>
    </div>
  );
}

function ScenarioNotebookCell({
  cell,
  focused,
  onFocus,
}: {
  cell: NotebookViewCell;
  focused: boolean;
  onFocus: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onFocus}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onFocus();
      }}
      className="relative rounded-lg focus:outline-none focus:ring-2 focus:ring-fd-primary/30"
    >
      <div className="pointer-events-none absolute right-3 top-3 z-20">
        <ScenarioCellBadge cell={cell} />
      </div>
      <ReadOnlyNotebookCell
        id={cell.id}
        cellType={cell.cellType}
        source={cell.source}
        language={resolveElementsNotebookLanguage(cell.language)}
        executionCount={cell.executionCount}
        outputs={cell.outputs}
        displayMode="notebook"
        className={cn(
          "rounded-lg border border-fd-border bg-fd-background transition-colors",
          focused && "border-fd-primary/60 bg-fd-primary/5",
        )}
        outputClassName="rounded-md"
      />
    </div>
  );
}

function ScenarioCellBadge({ cell }: { cell: NotebookViewCell }) {
  const label =
    cell.id === executingCellId
      ? "running"
      : queuedCellIds.has(cell.id)
        ? "queued"
        : cell.cellType === "code"
          ? cell.executionCount === null
            ? "ready"
            : `run ${cell.executionCount}`
          : "markdown";

  return (
    <span
      className={cn(
        "rounded-full border px-2 py-1 text-[11px] font-medium",
        cell.id === executingCellId || queuedCellIds.has(cell.id)
          ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          : "border-fd-border bg-fd-background text-fd-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

function PackagePanelContent({ scenario }: { scenario: ElementsNotebookScenario }) {
  const plannedRailPanels = [
    {
      icon: Variable,
      title: "Variables",
      detail: `${scenario.variables.length} fixture names`,
      body: "A future rail sibling for live namespace inspection once the app has a current variable surface.",
    },
    {
      icon: Boxes,
      title: "Renderers",
      detail: `${scenario.renderers.length} fixture MIME lanes`,
      body: "A future diagnostics panel for output MIME routing, plugin loading, and renderer health.",
    },
  ];

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-fd-border bg-fd-muted/40 p-3 text-xs leading-5 text-fd-muted-foreground">
        This uses the current notebook dependency panel in a rail-sized frame. The catalog owns only
        scenario metadata and inert callbacks.
      </div>
      <div className="overflow-hidden rounded-md border border-fd-border bg-fd-card">
        <DependencyHeader
          dependencies={[...scenario.packageState.dependencies]}
          requiresPython={scenario.packageState.requiresPython}
          loading={false}
          variant="rail"
          onAdd={asyncNoop}
          onRemove={asyncNoop}
          onSetRequiresPython={asyncNoop}
          syncState={
            scenario.capabilities.canManagePackages
              ? scenario.packageState.syncState
              : { status: "synced" }
          }
          onSyncNow={asyncTrue}
          pyprojectInfo={scenario.packageState.pyprojectInfo}
          pyprojectDeps={scenario.packageState.pyprojectDeps}
          isUsingProjectEnv={false}
          justSynced={false}
        />
      </div>
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
                  <panel.icon className="size-4 text-fd-muted-foreground" aria-hidden="true" />
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
  );
}
