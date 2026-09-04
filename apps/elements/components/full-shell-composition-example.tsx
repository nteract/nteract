"use client";

import { NotebookHostProvider } from "@nteract/notebook-host";
import { PanelLeftOpen, Share2 } from "lucide-react";
import Image from "next/image";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { resolveNotebookOutlineSelection } from "runtimed";
import {
  CrdtBridgeProvider,
  NotebookCommandToolbar,
  NotebookCommentsPanel,
  NotebookDocumentHeader,
  NotebookDocumentRail,
  NotebookDocumentShell,
  NotebookEditModeButton,
  NotebookIdentityGroup,
  NotebookPackageSummaryPanel,
  NotebookToolbarFrame,
  NotebookWorkstationsPanel,
  createNotebookInteractionModeProjection,
  projectNotebookWorkstationSelection,
  type CommentAuthor,
  type NotebookCommandToolbarStatus,
  type NotebookActorIdentity,
  type NotebookInteractionMode,
  type NotebookInteractionModeProjection,
  type NotebookShellCapabilities,
  type NotebookViewCell,
} from "@/components/notebook";
import type { CommentsProjection } from "@/components/notebook/comment-types";
import {
  NOTEBOOK_RAIL_TAKEOVER_MEDIA_QUERY,
  NOTEBOOK_RAIL_TAKEOVER_STAGE_CLASS_NAME,
  type NotebookRailPanelId,
} from "@/components/notebook-rail";
import {
  flushCellUIState,
  setFocusedCellId as setNotebookFocusedCellId,
  setSearchCurrentMatch,
  setSearchQuery,
} from "@/components/notebook/state/cell-ui-state";
import {
  replaceNotebookCells,
  type NotebookStoreCell,
  type NotebookStoreOutput,
} from "@/components/notebook/state/cell-store";
import {
  resetNotebookExecutions,
  setCellExecutionPointer,
  setExecution,
  setNotebookQueueProjection,
} from "@/components/notebook/state/execution-store";
import { resetNotebookOutputs, setOutput } from "@/components/notebook/state/output-store";
import { cn } from "@/lib/utils";
import logoDarkUrl from "../../../logo-dark.svg";
import logoLightUrl from "../../../logo.svg";
import { NotebookView } from "../../notebook/src/notebook-surface";
import { createFixtureNotebookHost } from "./fixture-notebook-host";
import {
  getElementsNotebookScenario,
  type ElementsNotebookScenario,
} from "@/components/notebook-scenarios";
import type {
  MarkdownProjectionAnchor,
  MarkdownProjectionBlock,
  MarkdownProjectionPlan,
  MarkdownProjectionRun,
} from "../../../src/lib/markdown-projection";

const noop = () => {};
const scenario = getElementsNotebookScenario("cloud-workstation-ready");
const initialFocusedCellId = "cell-model-code";

const ADA = "local:ada/desktop:1";
const CLAUDE = "local:ada/agent:claude-code:1";
const ADA_COLOR = "#16a34a";
const CLAUDE_COLOR = "#7c3aed";

const hostedPeople: NotebookActorIdentity[] = [
  {
    id: "cloud:kyle",
    label: "Kyle",
    detail: "Owner",
    kind: "human",
    status: "active",
  },
  {
    id: "cloud:morgan",
    label: "Morgan",
    detail: "Viewing",
    kind: "human",
    status: "active",
  },
];

const commentsProjection: CommentsProjection = {
  comments_doc_id: "comments:full-shell-composition",
  threads: [
    {
      id: "thread-model-run",
      anchor: {
        kind: "source_range",
        cell_id: "cell-model-code",
        start_line: 2,
        start_column: 0,
        end_line: 2,
        end_column: 34,
        exact_quote: "model.fit(features[columns], target)",
        prefix_quote: "features = orders.assign",
      },
      position: "10",
      status: "open",
      badge_cell_ids: ["cell-model-code"],
      created_at: "2026-06-18T16:24:00Z",
      created_by_actor_label: ADA,
      messages: [
        {
          id: "m-model-1",
          position: "10",
          body: "Can we make the training target explicit before this fit call?",
          created_at: "2026-06-18T16:24:00Z",
          created_by_actor_label: ADA,
        },
        {
          id: "m-model-2",
          position: "20",
          body: "I can split `target` into a named weekly demand series and rerun the fold.",
          created_at: "2026-06-18T16:28:00Z",
          created_by_actor_label: CLAUDE,
        },
      ],
    },
    {
      id: "thread-findings",
      anchor: { kind: "cell", cell_id: "cell-findings" },
      position: "20",
      status: "open",
      badge_cell_ids: ["cell-findings"],
      created_at: "2026-06-18T16:42:00Z",
      created_by_actor_label: ADA,
      messages: [
        {
          id: "m-findings-1",
          position: "10",
          body: "The summary should mention the 16 week backtest window.",
          created_at: "2026-06-18T16:42:00Z",
          created_by_actor_label: ADA,
        },
      ],
    },
    {
      id: "thread-imports",
      anchor: {
        kind: "source_range",
        cell_id: "cell-load-code",
        start_line: 1,
        start_column: 0,
        end_line: 1,
        end_column: 45,
        exact_quote: "orders = pandas.read_csv('orders.csv'",
      },
      position: "5",
      status: "resolved",
      badge_cell_ids: ["cell-load-code"],
      created_at: "2026-06-18T15:55:00Z",
      created_by_actor_label: ADA,
      resolved_at: "2026-06-18T16:12:00Z",
      resolved_by_actor_label: CLAUDE,
      messages: [
        {
          id: "m-imports-1",
          position: "10",
          body: "Let's parse dates on import so the month feature is deterministic.",
          created_at: "2026-06-18T15:55:00Z",
          created_by_actor_label: ADA,
        },
      ],
    },
  ],
};

const workstationSelection = projectNotebookWorkstationSelection({
  activeAttachment: {
    workstation_id: "outerbounds-forecast-gpu",
    display_name: "Forecast GPU",
    provider: "outerbounds",
    default_environment_label: "Current Python",
    environment_policy: "current_python",
    status: "ready",
    cpu_count: 16,
    memory_bytes: 64 * 1024 ** 3,
    working_directory: "~/work/mathnet",
  },
  canRegisterWorkstation: true,
  canSelectWorkstation: true,
  canSetDefaultWorkstation: true,
  defaultWorkstationId: "outerbounds-forecast-gpu",
  registeredWorkstations: [
    {
      id: "outerbounds-forecast-gpu",
      displayName: "Forecast GPU",
      provider: "runtime_peer",
      providerLabel: "Outerbounds",
      status: "online",
      defaultEnvironmentLabel: "Current Python",
      environmentPolicy: "current_python",
      workingDirectory: "~/work/mathnet",
      cpuCount: 16,
      memoryBytes: 64 * 1024 ** 3,
    },
    {
      id: "hub-lab-kyle",
      displayName: "JupyterLab server",
      provider: "runtime_peer",
      providerLabel: "JupyterHub",
      status: "online",
      defaultEnvironmentLabel: "Python 3 kernelspec",
      environmentPolicy: "kernelspec",
    },
  ],
  selectedWorkstationId: "outerbounds-forecast-gpu",
});

export function FullShellCompositionExample() {
  const [host, setHost] = useState<"cloud" | "desktop">("cloud");
  const [activePanel, setActivePanel] = useState<NotebookRailPanelId>("outline");
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [mode, setMode] = useState<NotebookInteractionMode>("edit");
  const [selectedOutlineItemId, setSelectedOutlineItemId] = useState<string | null>(null);
  const [focusedCellId, setFocusedCellId] = useState(initialFocusedCellId);
  const [notebookViewCellIds, setNotebookViewCellIds] = useState(() => [
    ...scenario.viewModel.cellIds,
  ]);
  const [fixturesSeeded, setFixturesSeeded] = useState(false);
  const [mounted, setMounted] = useState(false);
  const notebookHost = useMemo(
    () => createFixtureNotebookHost({ name: "full-shell-composition" }),
    [],
  );
  const crdtAdapter = useMemo(
    () => ({
      getHandle: () => null,
      onSyncNeeded: noop,
      localActor: "elements-full-shell",
    }),
    [],
  );
  const interaction = shellInteractionProjection(scenario, mode);
  const capabilities = withInteractionProjection(scenario.capabilities, interaction);
  const activeOutlineItemId =
    scenario.viewModel.outlineItems.find((item) => item.cellId === "cell-model-run")?.id ?? null;
  const selectedOutlineItem = resolveNotebookOutlineSelection(scenario.viewModel.outlineItems, {
    cellIds: scenario.viewModel.cellIds,
    selectedCellId: focusedCellId,
    selectedItemId: selectedOutlineItemId,
  });

  useEffect(() => setMounted(true), []);

  useLayoutEffect(() => {
    setHost(
      new URLSearchParams(window.location.search).get("host") === "desktop" ? "desktop" : "cloud",
    );
    setRailCollapsed(window.matchMedia(NOTEBOOK_RAIL_TAKEOVER_MEDIA_QUERY).matches);
    seedFullShellFixtures(scenario);
    setFixturesSeeded(true);
  }, []);

  useLayoutEffect(() => {
    focusFullShellCell(focusedCellId);
  }, [focusedCellId]);

  const commentsPanel = mounted ? (
    <NotebookCommentsPanelView focusedCellId={focusedCellId} onFocusCell={setFocusedCellId} />
  ) : (
    <div className="h-80" aria-hidden />
  );

  const moveNotebookViewCell = (cellId: string, afterCellId?: string | null) => {
    setNotebookViewCellIds((current) => {
      const withoutMoved = current.filter((id) => id !== cellId);
      const nextIndex =
        afterCellId == null ? 0 : withoutMoved.findIndex((id) => id === afterCellId) + 1;
      if (nextIndex <= 0 && afterCellId != null) return current;
      return [...withoutMoved.slice(0, nextIndex), cellId, ...withoutMoved.slice(nextIndex)];
    });
  };

  const togglePanel = (panel: NotebookRailPanelId) => {
    setActivePanel(panel);
    setRailCollapsed(activePanel === panel && !railCollapsed);
  };
  const commandToolbar = (
    <FullShellCommandToolbar
      capabilities={capabilities}
      activePanel={activePanel}
      railCollapsed={railCollapsed}
      onOpenPanels={host === "cloud" ? () => setRailCollapsed(false) : undefined}
      onTogglePackages={() => togglePanel("packages")}
      onToggleWorkstations={host === "cloud" ? () => togglePanel("workstations") : undefined}
    />
  );

  return (
    <NotebookHostProvider host={notebookHost}>
      <NotebookDocumentShell
        rootElement="main"
        className="h-dvh bg-background text-foreground"
        toolbarClassName="bg-background/95"
        toolbarLabel={host === "cloud" ? "Cloud notebook session" : "Notebook commands"}
        toolbarPlacement={host === "cloud" ? "shell" : "stage-content"}
        stageClassName="bg-background"
        stageLabel={`Full ${host} notebook composition`}
        railPanelPlacement="stage"
        capabilities={capabilities}
        toolbar={
          host === "cloud" ? (
            <FullShellHeader
              capabilities={capabilities}
              interaction={interaction}
              mode={mode}
              onModeChange={setMode}
            />
          ) : (
            commandToolbar
          )
        }
        stageToolbar={host === "cloud" ? commandToolbar : undefined}
        stageToolbarPlacement="stage-content"
        stageContentClassName={cn(!railCollapsed && NOTEBOOK_RAIL_TAKEOVER_STAGE_CLASS_NAME)}
        rail={
          <NotebookDocumentRail
            leadingSlot={host === "desktop" ? <FullShellBrandMark /> : undefined}
            viewModel={scenario.viewModel}
            activePanelId={activePanel}
            collapsed={railCollapsed}
            outlineCellIds={scenario.viewModel.cellIds}
            activeOutlineItemId={activeOutlineItemId}
            selectedOutlineItemId={selectedOutlineItemId ?? selectedOutlineItem}
            selectedOutlineCellId={focusedCellId}
            packagesPanel={
              <NotebookPackageSummaryPanel packages={scenario.viewModel.packages} readOnly />
            }
            commentsPanel={commentsPanel}
            workstationsPanel={
              host === "cloud" ? (
                <NotebookWorkstationsPanel
                  capabilities={capabilities}
                  selection={workstationSelection}
                />
              ) : undefined
            }
            onActivePanelChange={setActivePanel}
            onCollapsedChange={setRailCollapsed}
            onSelectOutlineItem={(item) => {
              setSelectedOutlineItemId(item.id);
              setFocusedCellId(item.cellId);
              focusFullShellCell(item.cellId);
            }}
            onNavigateOutlineItem={(item) => {
              setSelectedOutlineItemId(item.id);
              setFocusedCellId(item.cellId);
              focusFullShellCell(item.cellId);
              if (window.matchMedia(NOTEBOOK_RAIL_TAKEOVER_MEDIA_QUERY).matches) {
                setRailCollapsed(true);
              }
            }}
            className={cn(
              "bg-background",
              host === "cloud" && railCollapsed && "max-[599.98px]:hidden",
            )}
          />
        }
      >
        <CrdtBridgeProvider {...crdtAdapter}>
          <section
            aria-label="Notebook document"
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
            data-slot="full-shell-notebook-stage"
          >
            {fixturesSeeded ? (
              <NotebookView
                cellIds={notebookViewCellIds}
                capabilities={capabilities}
                canAcceptCellMutations={false}
                readOnly={!capabilities.canEditCells}
                runtime="python"
                sessionRuntimeState={capabilities.canExecute ? "ready" : "unavailable"}
                onFocusCell={(cellId) => {
                  setFocusedCellId(cellId);
                  setSelectedOutlineItemId(null);
                  focusFullShellCell(cellId);
                }}
                onExecuteCell={noop}
                onInterruptKernel={noop}
                onDeleteCell={noop}
                onAddCell={() => null}
                onMoveCell={moveNotebookViewCell}
                onSetCellSourceHidden={noop}
                onSetCellOutputsHidden={noop}
                onCreateSourceComment={(anchor) => {
                  setFocusedCellId(anchor.cell_id);
                  focusFullShellCell(anchor.cell_id);
                }}
                onActivateCommentThread={(threadId) => {
                  const thread = commentsProjection.threads.find((item) => item.id === threadId);
                  const cellId =
                    thread?.anchor.kind === "source_range" || thread?.anchor.kind === "cell"
                      ? thread.anchor.cell_id
                      : null;
                  if (cellId) {
                    setFocusedCellId(cellId);
                    focusFullShellCell(cellId);
                  }
                }}
                autoFocusFirstCell={false}
              />
            ) : (
              <div className="px-4 py-6 text-sm text-muted-foreground">
                Loading notebook fixture...
              </div>
            )}
          </section>
        </CrdtBridgeProvider>
      </NotebookDocumentShell>
    </NotebookHostProvider>
  );
}

function FullShellHeader({
  capabilities,
  interaction,
  mode,
  onModeChange,
}: {
  capabilities: NotebookShellCapabilities;
  interaction: NotebookInteractionModeProjection;
  mode: NotebookInteractionMode;
  onModeChange: (mode: NotebookInteractionMode) => void;
}) {
  return (
    <NotebookToolbarFrame className="static top-auto z-auto bg-background/95">
      <div className="flex min-w-0" data-slot="full-shell-cloud-header">
        <NotebookDocumentHeader
          capabilities={capabilities}
          className={cn(
            "min-h-15 border-b pl-0 pr-[clamp(0.5rem,2vw,1rem)]",
            "[&_[data-slot=notebook-document-header-presence]]:flex [&_[data-slot=notebook-document-header-presence]]:items-center [&_[data-slot=notebook-document-header-presence]]:gap-2",
            "[&_[data-slot=notebook-document-header-presence]]:flex-[1_1_min(24rem,44vw)] [&_[data-slot=notebook-document-header-presence]]:max-w-[min(38rem,48vw)]",
            "[&_[data-slot=notebook-document-header-controls]]:flex-none [&_[data-slot=notebook-document-header-controls]]:min-w-max [&_[data-slot=notebook-document-header-controls]]:gap-[clamp(0.375rem,1vw,0.75rem)]",
            "max-[900px]:flex-nowrap max-[900px]:content-center max-[900px]:gap-1.5 max-[900px]:py-1.5",
            "max-[900px]:[&_[data-slot=notebook-document-header-presence]]:flex-auto max-[900px]:[&_[data-slot=notebook-document-header-presence]]:max-w-none",
            "max-[900px]:[&_[data-slot=notebook-document-header-controls]]:min-w-0 max-[900px]:[&_[data-slot=notebook-document-header-controls]]:gap-x-2.5 max-[900px]:[&_[data-slot=notebook-document-header-controls]]:gap-y-1",
            "max-[520px]:[&_[data-slot=notebook-document-header-controls]]:gap-x-1.5 max-[520px]:[&_[data-slot=notebook-document-header-controls]]:gap-y-0.5",
          )}
          presence={
            <>
              <a
                href="/n"
                aria-label="Notebook home"
                title="Notebook home"
                className="flex h-11 w-14 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
              >
                <FullShellBrandMark className="size-8" />
              </a>
              <FullShellTitle />
            </>
          }
          utilityControls={
            <>
              <NotebookIdentityGroup
                actors={hostedPeople}
                maxVisible={2}
                label="Hosted participants"
              />
              <NotebookEditModeButton
                mode={mode}
                state={interaction.state}
                onModeChange={onModeChange}
                variant="segmented"
                className="bg-muted/35"
              />
            </>
          }
          sharingControls={
            <button
              type="button"
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Share notebook"
              title="Share notebook"
            >
              <Share2 className="size-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Share</span>
            </button>
          }
        />
      </div>
    </NotebookToolbarFrame>
  );
}

function FullShellCommandToolbar({
  activePanel,
  capabilities,
  railCollapsed,
  onOpenPanels,
  onTogglePackages,
  onToggleWorkstations,
}: {
  activePanel: NotebookRailPanelId;
  capabilities: NotebookShellCapabilities;
  railCollapsed: boolean;
  onOpenPanels?: () => void;
  onTogglePackages: () => void;
  onToggleWorkstations?: () => void;
}) {
  const runtimeStatus: NotebookCommandToolbarStatus = {
    state: capabilities.canExecute ? "idle" : "unknown",
    label: "Current Python",
    ariaLabel: "Runtime: Current Python idle",
    title: scenario.runtimeLabel,
  };

  return (
    <NotebookToolbarFrame
      className={cn(
        "static top-auto z-auto bg-background/95",
        !railCollapsed && NOTEBOOK_RAIL_TAKEOVER_STAGE_CLASS_NAME,
      )}
    >
      <div className="min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <NotebookCommandToolbar
          capabilities={capabilities}
          leadingControls={
            onOpenPanels ? (
              <button
                type="button"
                className="hidden size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-[599.98px]:inline-flex"
                aria-label="Open notebook panels"
                aria-expanded={!railCollapsed}
                title="Notebook panels"
                onClick={onOpenPanels}
              >
                <PanelLeftOpen className="size-4" aria-hidden="true" />
              </button>
            ) : undefined
          }
          runtime="python"
          runtimeTarget={capabilities.runtime.target ?? null}
          environmentManager={null}
          environmentPanelOpen={activePanel === "packages" && !railCollapsed}
          runtimeStatus={runtimeStatus}
          addAfterCellId={initialFocusedCellId}
          onAddCell={noop}
          onStartRuntime={noop}
          onInterruptRuntime={noop}
          onRestartRuntime={noop}
          onRunAllCells={noop}
          onRestartAndRunAll={noop}
          onTogglePackages={onTogglePackages}
          workstationAction={
            onToggleWorkstations
              ? {
                  label: "Workstation",
                  title: "Open workstation panel",
                  onClick: onToggleWorkstations,
                }
              : undefined
          }
          className={cn(
            "w-max min-w-full border-b-0",
            onOpenPanels &&
              "max-[599.98px]:h-11 max-[599.98px]:[&_button]:min-h-8 max-[599.98px]:[&_button]:min-w-8",
          )}
        />
      </div>
    </NotebookToolbarFrame>
  );
}

function FullShellBrandMark({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="nteract"
      className={cn("block size-6 shrink-0 select-none", className)}
      data-slot="full-shell-brand-mark"
    >
      <Image
        src={logoLightUrl}
        alt=""
        aria-hidden="true"
        width={24}
        height={24}
        draggable={false}
        className="block size-full dark:hidden"
      />
      <Image
        src={logoDarkUrl}
        alt=""
        aria-hidden="true"
        width={24}
        height={24}
        draggable={false}
        className="hidden size-full dark:block"
      />
    </span>
  );
}

function FullShellTitle() {
  return (
    <div className="grid min-w-0 text-left" data-slot="full-shell-title">
      <span className="truncate text-sm font-semibold text-foreground">
        MathNet topic visualization
      </span>
      <span className="truncate text-[11px] leading-4 text-muted-foreground max-[900px]:hidden">
        Hosted preview - preview.runt.run/n/topic-viz/topic-viz
      </span>
    </div>
  );
}

function NotebookCommentsPanelView({
  focusedCellId,
  onFocusCell,
}: {
  focusedCellId: string;
  onFocusCell: (cellId: string) => void;
}) {
  const focusedThread =
    commentsProjection.threads.find((thread) => {
      if (thread.anchor.kind !== "source_range" && thread.anchor.kind !== "cell") return false;
      return thread.anchor.cell_id === focusedCellId;
    }) ?? null;

  return (
    <NotebookCommentsPanel
      projection={commentsProjection}
      resolveCommentAuthor={resolveCommentAuthor}
      resolveSourceLanguage={resolveSourceLanguage}
      focusedThreadId={focusedThread?.id ?? null}
      onCreateThread={noop}
      onReplyThread={noop}
      onResolveThread={noop}
      onReopenThread={noop}
      onFocusThreadAnchor={(thread) => {
        if (thread.anchor.kind === "source_range" || thread.anchor.kind === "cell") {
          onFocusCell(thread.anchor.cell_id);
          focusFullShellCell(thread.anchor.cell_id);
        }
      }}
    />
  );
}

function shellInteractionProjection(
  selectedScenario: ElementsNotebookScenario,
  mode: NotebookInteractionMode,
): NotebookInteractionModeProjection {
  return createNotebookInteractionModeProjection({
    selectedMode: mode,
    permission: {
      canEditCells: selectedScenario.capabilities.canEditCells,
      canEditMarkdown: selectedScenario.capabilities.canEditMarkdown,
      canEditStructure: selectedScenario.capabilities.canEditStructure,
    },
    hostSupport: {
      canEditCells: selectedScenario.capabilities.canEditCells,
      canEditMarkdown: selectedScenario.capabilities.canEditMarkdown,
      canEditStructure: selectedScenario.capabilities.canEditStructure,
      canRequestEdit: selectedScenario.capabilities.canRequestEdit,
    },
  });
}

function withInteractionProjection(
  capabilities: NotebookShellCapabilities,
  interaction: NotebookInteractionModeProjection,
): NotebookShellCapabilities {
  return {
    ...capabilities,
    canEditCells: interaction.canEditCells,
    canEditMarkdown: interaction.canEditMarkdown,
    canEditStructure: interaction.canEditStructure,
    canRequestEdit: interaction.canRequestEdit,
    interaction,
  };
}

function resolveCommentAuthor(actorLabel: string): CommentAuthor {
  if (actorLabel === CLAUDE) {
    return {
      displayName: "Claude Code",
      color: CLAUDE_COLOR,
      imageUrl: null,
      isAgent: true,
      agentSlug: "claude-code",
      onBehalfOf: "Ada",
    };
  }
  return { displayName: "Ada", color: ADA_COLOR, imageUrl: null };
}

function resolveSourceLanguage(cellId: string): string | undefined {
  return scenario.cells.find((cell) => cell.id === cellId)?.language ?? undefined;
}

function seedFullShellFixtures(selectedScenario: ElementsNotebookScenario) {
  replaceNotebookCells(selectedScenario.cells.map(scenarioCellToNotebookCell));
  resetNotebookOutputs();
  resetNotebookExecutions();

  for (const cell of selectedScenario.cells) {
    if (cell.cellType !== "code" || !cell.executionId) continue;

    const outputIds = cell.outputs.map((output, index) => {
      return output.output_id ?? `${cell.executionId}:output:${index}`;
    });

    cell.outputs.forEach((output, index) => {
      const outputId = output.output_id ?? `${cell.executionId}:output:${index}`;
      setOutput(outputId, { ...output, output_id: outputId } as NotebookStoreOutput);
    });

    setExecution(cell.executionId, {
      execution_count: cell.executionCount,
      status: cell.executionCount === null ? "queued" : "done",
      success: cell.executionCount === null ? null : true,
      output_ids: outputIds,
      submitted_by_actor_label: selectedScenario.capabilities.access.actorLabel,
    });
    setCellExecutionPointer(cell.id, cell.executionId);
  }

  focusFullShellCell(initialFocusedCellId);
  setNotebookQueueProjection({ executing_cell_id: null, queued_cell_ids: [] });
  setSearchQuery(undefined);
  setSearchCurrentMatch(null);
  flushCellUIState();
}

function focusFullShellCell(cellId: string) {
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
      outputs: cell.outputs as NotebookStoreOutput[],
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

const markdownProjectionSpan = [0, 0] as const;
const markdownProjectionMeasurement = {
  estimatedHeight: 36,
  confidence: "medium",
  width: 720,
} as const;

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
    engine: "elements-full-shell-fixture",
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
