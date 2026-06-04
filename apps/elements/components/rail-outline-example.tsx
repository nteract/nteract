"use client";

import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { resolveNotebookOutlineSelection } from "runtimed";
import { ReadOnlyNotebookCell } from "@/components/cell/ReadOnlyNotebookCell";
import {
  NotebookCellList,
  NotebookCommandToolbar,
  NotebookDocumentHeader,
  NotebookDocumentRail,
  NotebookDocumentShell,
  NotebookPackageSummaryPanel,
  type NotebookViewCell,
} from "@/components/notebook";
import {
  type NotebookContentSection,
  NotebookPackagesPanel,
  type NotebookRailPanelId,
} from "@/components/notebook-rail";
import { cn } from "@/lib/utils";
import { EnvironmentSummary, UvDependencyPanel } from "@/components/environment";
import {
  getElementsNotebookScenario,
  resolveElementsNotebookLanguage,
  type ElementsNotebookScenario,
  type ElementsNotebookScenarioId,
} from "@/components/notebook-scenarios";

const noop = () => {};
const asyncNoop = async () => {};
const asyncTrue = async () => true;

const scenarioIds: ElementsNotebookScenarioId[] = [
  "desktop-local-owner",
  "desktop-read-only",
  "desktop-remote-room",
  "cloud-public-viewer",
  "cloud-editor",
  "cloud-owner",
  "agent-on-behalf",
  "credential-attention",
  "multi-operator",
  "mixed-idp-room",
  "runtime-peer",
  "system-schema",
  "runtime-unavailable",
  "untrusted-dependencies",
];

const executingCellId = "cell-model-code";
const queuedCellIds = new Set(["cell-shape-output"]);

export function RailOutlineExample() {
  const [scenarioId, setScenarioId] = useState<ElementsNotebookScenarioId>("desktop-local-owner");
  const scenario = getElementsNotebookScenario(scenarioId);
  const [activePanel, setActivePanel] = useState<NotebookRailPanelId>("outline");
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [selectedOutlineItemId, setSelectedOutlineItemId] = useState<string | null>(null);
  const [focusedCellId, setFocusedCellId] = useState("cell-clean-code");
  const { viewModel } = scenario;
  const contentSections = scenarioContentSections(scenario);
  const contentSummary = scenario.id.startsWith("cloud") ? "Hosted" : "Desktop";
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
      className="not-prose min-h-[560px] overflow-hidden rounded-lg border border-fd-border bg-fd-card text-fd-card-foreground shadow-sm md:min-h-[700px] max-[599.98px]:[&_[data-slot=notebook-document-stage]]:hidden max-[599.98px]:[&_[data-slot=notebook-rail-panel]]:min-w-0 max-[599.98px]:[&_[data-slot=notebook-rail-panel]]:max-w-none max-[599.98px]:[&_[data-slot=notebook-rail-panel]]:flex-1 max-[599.98px]:[&_[data-testid=notebook-rail]]:w-full"
      stageClassName="min-w-[320px] bg-fd-muted/20"
      toolbarClassName="border-b border-fd-border"
      toolbarLabel="Notebook fixture toolbar"
      stageLabel="Elements notebook scenario"
      capabilities={scenario.capabilities}
      toolbar={
        <NotebookDocumentHeader
          capabilities={scenario.capabilities}
          runtimeControls={
            <NotebookCommandToolbar
              runtime="python"
              environmentManager="uv"
              runtimeStatus={{
                state: scenario.capabilities.canExecute ? "idle" : "unknown",
                label: scenario.capabilities.canExecute ? "Idle" : "Read only",
                ariaLabel: scenario.capabilities.canExecute
                  ? "Kernel: Idle"
                  : "Kernel controls unavailable",
                title: scenario.runtimeLabel,
              }}
              environmentPanelOpen={activePanel === "packages"}
              environmentOutOfSync={!scenario.capabilities.canManagePackages}
              addAfterCellId={focusedCellId ?? "cell-findings"}
              capabilities={scenario.capabilities}
              onAddCell={noop}
              onStartRuntime={noop}
              onInterruptRuntime={noop}
              onRestartRuntime={noop}
              onRunAllCells={noop}
              onRestartAndRunAll={noop}
              onTogglePackages={() => setActivePanel("packages")}
            />
          }
        />
      }
      rail={
        <NotebookDocumentRail
          viewModel={viewModel}
          activePanelId={activePanel}
          collapsed={railCollapsed}
          contentSections={contentSections}
          contentSummary={contentSummary}
          outlineCellIds={viewModel.cellIds}
          activeOutlineItemId={activeOutlineItemId}
          selectedOutlineItemId={selectedOutlineItemId}
          selectedOutlineCellId={focusedCellId}
          packagesSummary={scenario.packageSummary}
          packagesPanel={
            scenario.capabilities.canManagePackages ? (
              <NotebookPackagesPanel>
                <PackagePanelContent scenario={scenario} />
              </NotebookPackagesPanel>
            ) : (
              <NotebookPackageSummaryPanel
                packages={viewModel.packages}
                readOnly
                header={
                  <EnvironmentSummary
                    capabilities={scenario.capabilities}
                    packages={viewModel.packages}
                    environment={scenario.environment}
                    showPackageDetails={false}
                    className="shadow-none"
                  />
                }
              />
            )
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

function scenarioContentSections(
  scenario: ElementsNotebookScenario,
): readonly NotebookContentSection[] {
  if (scenario.id.startsWith("cloud")) {
    return [
      {
        id: "recently-opened",
        title: "Recently opened",
        summary: "2",
        items: [
          {
            id: "cloud-current",
            kind: "notebook",
            title: scenario.title,
            detail: "Current hosted notebook",
            meta: "open",
          },
          {
            id: "cloud-metrics",
            kind: "remote",
            title: "Metrics review",
            detail: "Private workspace",
            meta: "2h ago",
          },
        ],
      },
      {
        id: "shared",
        title: "Shared with me",
        summary: "2",
        items: [
          {
            id: "cloud-shared-launch",
            kind: "shared",
            title: "Launch plan analysis",
            detail: "Shared by Product Ops",
            meta: "edit",
          },
          {
            id: "cloud-shared-cost",
            kind: "shared",
            title: "Cost model",
            detail: "Shared by Finance",
            meta: "view",
          },
        ],
      },
    ];
  }

  return [
    {
      id: "recent",
      title: "Recent notebooks",
      summary: "3",
      items: [
        {
          id: "desktop-current",
          kind: "notebook",
          title: scenario.title,
          detail: "~/Notebooks/current-analysis.ipynb",
          meta: "open",
        },
        {
          id: "desktop-run-quality",
          kind: "notebook",
          title: "run-quality-checks.ipynb",
          detail: "~/Notebooks/run-quality-checks.ipynb",
          meta: "today",
        },
        {
          id: "desktop-audit",
          kind: "notebook",
          title: "model-audit.ipynb",
          detail: "~/Notebooks/research/model-audit.ipynb",
          meta: "Mon",
        },
      ],
    },
    {
      id: "local",
      title: "Local files",
      summary: "2",
      items: [
        {
          id: "desktop-folder",
          kind: "folder",
          title: "Notebook folder",
          detail: "~/Notebooks",
          meta: "local",
        },
        {
          id: "desktop-project",
          kind: "file",
          title: "pyproject.toml",
          detail: "~/Notebooks/pyproject.toml",
          meta: "env",
        },
      ],
    },
  ];
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
          The docs app owns only scenario facts: capabilities, fixture cells, package details,
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
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-fd-border bg-fd-muted/40 p-3 text-xs leading-5 text-fd-muted-foreground">
        Current notebook package controls in a rail-sized frame. The preview owns only scenario
        facts and inert callbacks.
      </div>
      <div className="overflow-hidden rounded-md border border-fd-border bg-fd-card">
        <UvDependencyPanel
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
    </div>
  );
}
