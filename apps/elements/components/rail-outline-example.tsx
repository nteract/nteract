"use client";

import { NotebookHostProvider } from "@nteract/notebook-host";
import { ShieldCheck } from "lucide-react";
import { useLayoutEffect, useMemo, useState } from "react";
import { resolveNotebookOutlineSelection } from "runtimed";
import {
  NotebookCommandToolbar,
  NotebookDocumentHeader,
  NotebookDocumentRail,
  NotebookDocumentShell,
  NotebookPackageSummaryPanel,
  CrdtBridgeProvider,
  type NotebookViewCell,
} from "@/components/notebook";
import type { NotebookRailPanelId } from "@/components/notebook-rail";
import { cn } from "@/lib/utils";
import { NotebookView } from "../../notebook/src/notebook-surface";
import {
  flushCellUIState,
  setFocusedCellId as setNotebookFocusedCellId,
  setSearchCurrentMatch,
  setSearchQuery,
} from "@/components/notebook/state/cell-ui-state";
import {
  replaceNotebookCells,
  type NotebookStoreCell,
} from "@/components/notebook/state/cell-store";
import {
  resetNotebookExecutions,
  setCellExecutionPointer,
  setExecution,
  setNotebookQueueProjection,
} from "@/components/notebook/state/execution-store";
import { resetNotebookOutputs } from "@/components/notebook/state/output-store";
import type {
  MarkdownProjectionAnchor,
  MarkdownProjectionBlock,
  MarkdownProjectionPlan,
  MarkdownProjectionRun,
} from "../../../src/lib/markdown-projection";
import {
  getElementsNotebookScenario,
  type ElementsNotebookScenario,
  type ElementsNotebookScenarioId,
} from "@/components/notebook-scenarios";
import { createFixtureNotebookHost } from "./fixture-notebook-host";

const noop = () => {};
const markdownProjectionSpan = [0, 0] as const;
const markdownProjectionMeasurement = {
  estimatedHeight: 36,
  confidence: "medium",
  width: 720,
} as const;

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

export function RailOutlineExample() {
  const [scenarioId, setScenarioId] = useState<ElementsNotebookScenarioId>("desktop-local-owner");
  const scenario = getElementsNotebookScenario(scenarioId);
  const [activePanel, setActivePanel] = useState<NotebookRailPanelId>("outline");
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [selectedOutlineItemId, setSelectedOutlineItemId] = useState<string | null>(null);
  const [focusedCellId, setFocusedCellId] = useState("cell-clean-code");
  const [fixturesSeededFor, setFixturesSeededFor] = useState<ElementsNotebookScenarioId | null>(
    null,
  );
  const [notebookViewCellIds, setNotebookViewCellIds] = useState(() => [
    ...scenario.viewModel.cellIds,
  ]);
  const notebookHost = useMemo(() => createFixtureNotebookHost({ name: "outline-fixture" }), []);
  const adapterValue = useMemo(
    () => ({
      getHandle: () => null,
      onSyncNeeded: noop,
      localActor: "elements-outline-fixture",
    }),
    [],
  );
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

  useLayoutEffect(() => {
    seedOutlineNotebookFixtures(scenario, focusedCellId);
    setNotebookViewCellIds([...scenario.viewModel.cellIds]);
    setFixturesSeededFor(scenario.id);
  }, [focusedCellId, scenario]);

  const moveNotebookViewCell = (cellId: string, afterCellId?: string | null) => {
    setNotebookViewCellIds((current) => {
      const withoutMoved = current.filter((id) => id !== cellId);
      const nextIndex =
        afterCellId == null ? 0 : withoutMoved.findIndex((id) => id === afterCellId) + 1;
      if (nextIndex <= 0 && afterCellId != null) return current;
      return [...withoutMoved.slice(0, nextIndex), cellId, ...withoutMoved.slice(nextIndex)];
    });
  };

  return (
    <NotebookHostProvider host={notebookHost}>
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
            outlineCellIds={viewModel.cellIds}
            activeOutlineItemId={activeOutlineItemId}
            selectedOutlineItemId={selectedOutlineItemId}
            selectedOutlineCellId={focusedCellId}
            packagesPanel={
              <NotebookPackageSummaryPanel
                packages={viewModel.packages}
                readOnly={!scenario.capabilities.canManagePackages}
              />
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
        <CrdtBridgeProvider {...adapterValue}>
          {fixturesSeededFor === scenario.id ? (
            <section
              aria-label="Notebook scenario cells"
              className="min-h-0 flex-1 overflow-y-auto bg-fd-background p-4"
            >
              <NotebookView
                cellIds={notebookViewCellIds}
                capabilities={scenario.capabilities}
                canAcceptCellMutations={false}
                readOnly={!scenario.capabilities.canEditCells}
                runtime="python"
                sessionRuntimeState={scenario.capabilities.canExecute ? "ready" : "unavailable"}
                onFocusCell={(cellId) => {
                  setFocusedCellId(cellId);
                  setSelectedOutlineItemId(null);
                  focusOutlineFixtureCell(cellId);
                }}
                onExecuteCell={noop}
                onInterruptKernel={noop}
                onDeleteCell={noop}
                onAddCell={() => null}
                onMoveCell={moveNotebookViewCell}
                onSetCellSourceHidden={noop}
                onSetCellOutputsHidden={noop}
                autoFocusFirstCell={false}
              />
            </section>
          ) : (
            <div className="p-4 text-sm text-fd-muted-foreground">Loading notebook fixture...</div>
          )}
        </CrdtBridgeProvider>
      </NotebookDocumentShell>
    </NotebookHostProvider>
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
      <section className="border-l border-fd-border py-1 pl-4 text-fd-muted-foreground">
        <div className="mb-1 flex items-center gap-2 text-xs font-semibold leading-5">
          <ShieldCheck className="size-3.5" aria-hidden="true" />
          NotebookDocumentShell, NotebookRail, and NotebookView render from current sources.
        </div>
        <p className="text-xs leading-5">
          The docs app owns only scenario facts: capabilities, fixture cells, package details,
          focused cell, active panel, and inert navigation callbacks.
        </p>
      </section>

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

function seedOutlineNotebookFixtures(
  scenario: ElementsNotebookScenario,
  focusedCellId: string,
): void {
  replaceNotebookCells(scenario.cells.map(scenarioCellToNotebookCell));
  resetNotebookOutputs();
  resetNotebookExecutions();

  for (const cell of scenario.cells) {
    if (cell.cellType !== "code" || !cell.executionId) continue;

    setExecution(cell.executionId, {
      execution_count: cell.executionCount,
      status: "done",
      success: true,
      output_ids: [],
      submitted_by_actor_label: scenario.capabilities.access.actorLabel,
    });
    setCellExecutionPointer(cell.id, cell.executionId);
  }

  focusOutlineFixtureCell(focusedCellId);
  setNotebookQueueProjection({ executing_cell_id: null, queued_cell_ids: [] });
  setSearchQuery(undefined);
  setSearchCurrentMatch(null);
  flushCellUIState();
}

function focusOutlineFixtureCell(cellId: string): void {
  setNotebookFocusedCellId(cellId);
  flushCellUIState();
}

function scenarioCellToNotebookCell(cell: NotebookViewCell): NotebookStoreCell {
  if (cell.cellType === "code") {
    return {
      cell_type: "code",
      id: cell.id,
      source: cell.source,
      execution_count: cell.executionCount,
      outputs: [],
      metadata: cell.metadata,
    };
  }

  if (cell.cellType === "markdown") {
    return {
      cell_type: "markdown",
      id: cell.id,
      source: cell.source,
      metadata: cell.metadata,
      markdownProjection:
        cell.markdownProjection ?? markdownProjectionFixture(cell.id, cell.source),
    };
  }

  return {
    cell_type: "raw",
    id: cell.id,
    source: cell.source,
    metadata: cell.metadata,
  };
}

function markdownProjectionFixture(cellId: string, source: string): MarkdownProjectionPlan {
  const blocks: MarkdownProjectionBlock[] = [];
  const anchors: MarkdownProjectionAnchor[] = [];
  const runs: MarkdownProjectionRun[] = [];
  const chunks = source
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  chunks.forEach((chunk, index) => {
    const heading = /^(#{1,6})\s+(.+)$/.exec(chunk);
    const blockId = `${cellId}-markdown-${index}`;
    const text = heading ? heading[2] : chunk.replace(/\s+/g, " ");
    const level = heading?.[1].length ?? null;

    blocks.push({
      blockId,
      blockIndex: index,
      element: level ? `h${level}` : "p",
      kind: level ? "heading" : "paragraph",
      measurement: markdownProjectionMeasurement,
      sourceSpanByte: markdownProjectionSpan,
      sourceSpanUtf16: markdownProjectionSpan,
      syntaxSpans: [],
      text,
      ...(level
        ? {
            anchorSlug: markdownSlug(text),
          }
        : {}),
    });

    if (level) {
      anchors.push({
        anchorId: `${cellId}-${markdownSlug(text)}`,
        blockId,
        level,
        slug: markdownSlug(text),
        sourceSpanByte: markdownProjectionSpan,
        sourceSpanUtf16: markdownProjectionSpan,
        title: text,
      });
    }

    runs.push({
      blockId,
      inlineId: `${blockId}-text`,
      listItemIndex: null,
      renderedText: text,
      renderedTextUtf16: [0, text.length],
      semantic: "text",
      sourceSpanByte: markdownProjectionSpan,
      sourceSpanUtf16: markdownProjectionSpan,
    });
  });

  return {
    version: 1,
    engine: "elements-outline-fixture",
    byteLength: source.length,
    utf16Length: source.length,
    measurement: {
      estimatedHeight: Math.max(36, blocks.length * 34),
      confidence: "medium",
      width: 720,
    },
    anchors,
    blocks,
    runs,
  };
}

function markdownSlug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-") || "heading"
  );
}
