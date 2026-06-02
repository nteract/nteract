"use client";

import { FileCode2, FileText, Rows3, ShieldCheck } from "lucide-react";
import { useLayoutEffect, useMemo, useState } from "react";
import { CodeCell, type HiddenGroupCellSummary } from "@/notebook-components/CodeCell";
import { MarkdownCell } from "@/notebook-components/MarkdownCell";
import { NotebookView } from "@/notebook-components/NotebookView";
import { RawCell } from "@/notebook-components/RawCell";
import {
  getElementsNotebookPrimaryCodeCell,
  getElementsNotebookScenario,
  resolveElementsNotebookLanguage,
} from "@/components/notebook-scenarios";
import type { NotebookViewCell } from "@/components/notebook";
import { CrdtBridgeProvider } from "../../notebook/src/hooks/useCrdtBridge";
import {
  flushCellUIState,
  setExecutingCellIds,
  setFocusedCellId,
  setQueuedCellIds,
  setSearchCurrentMatch,
  setSearchQuery,
} from "@/components/notebook/state/cell-ui-state";
import { replaceNotebookCells } from "@/components/notebook/state/cell-store";
import {
  resetNotebookExecutions,
  setCellExecutionPointer,
  setExecution,
} from "@/components/notebook/state/execution-store";
import { resetNotebookOutputs, setOutput } from "@/components/notebook/state/output-store";
import type {
  CodeCell as CodeCellType,
  JupyterOutput,
  MarkdownCell as MarkdownCellType,
  NotebookCell,
  RawCell as RawCellType,
} from "../../notebook/src/types";

const fullCellScenario = getElementsNotebookScenario("desktop-local-owner");
const primaryScenarioCodeCell = getElementsNotebookPrimaryCodeCell(fullCellScenario.cells);
const standaloneCodeCellId = "elements-full-code-cell";
const standaloneCodeCellExecutionId = "elements-full-code-execution";
const standaloneCodeCellOutputs = primaryScenarioCodeCell.outputs.map((output, index) => ({
  ...output,
  output_id: standaloneCodeCellOutputId(output, index),
})) as JupyterOutput[];
const codeCellLanguage =
  resolveElementsNotebookLanguage(primaryScenarioCodeCell.language) ?? "plain";

const codeCell: CodeCellType = scenarioCodeCellToStandaloneCodeCell(
  primaryScenarioCodeCell,
  standaloneCodeCellId,
  standaloneCodeCellOutputs,
);

const hiddenCodeCellRows = [
  hiddenCodeCellFixture({
    id: "elements-hidden-source-cell",
    label: "Input hidden",
    detail: "Production CodeCell renders a quiet input reveal line while outputs remain visible.",
    sourceHidden: true,
    outputsHidden: false,
  }),
  hiddenCodeCellFixture({
    id: "elements-hidden-output-cell",
    label: "Output hidden",
    detail:
      "Production CodeCell keeps the input and current line visible while the output reveal owns the result row.",
    sourceHidden: false,
    outputsHidden: true,
  }),
  hiddenCodeCellFixture({
    id: "elements-hidden-both-cell",
    label: "Source and outputs hidden",
    detail: "Production CodeCell collapses to the shared hidden-cell reveal affordance.",
    sourceHidden: true,
    outputsHidden: true,
    hiddenGroupCount: 1,
  }),
  hiddenCodeCellFixture({
    id: "elements-hidden-group-cell",
    label: "Hidden group",
    detail:
      "Consecutive fully-hidden cells merge into one quiet document line with targeted reveal rows.",
    sourceHidden: true,
    outputsHidden: true,
    hiddenGroupCount: 5,
    hiddenGroupItems: [
      {
        id: "elements-hidden-group-load",
        preview: "load_dataset('mathnet/topic-viz')",
        outputCount: 1,
        hasError: false,
      },
      {
        id: "elements-hidden-group-schema",
        preview: "schema = topics_df.dtypes",
        outputCount: 1,
        hasError: false,
      },
      {
        id: "elements-hidden-group-sunburst",
        preview: "fig = px.sunburst(topic_tree)",
        outputCount: 2,
        hasError: false,
      },
      {
        id: "elements-hidden-group-invalid",
        preview: "render_topic_panel(topic='missing')",
        outputCount: 1,
        hasError: true,
      },
    ],
  }),
];

const markdownFixtureSource = [
  "## Forecast review",
  "",
  "The production `MarkdownCell` owns edit/preview switching and the isolated markdown iframe.",
  "This catalog renders the preview path through the docs `IsolatedFrame` adapter.",
].join("\n");

const markdownCell: MarkdownCellType = {
  cell_type: "markdown",
  id: "elements-full-markdown-cell",
  source: markdownFixtureSource,
  metadata: {},
};

const rawCell: RawCellType = {
  cell_type: "raw",
  id: "elements-full-raw-cell",
  source: ["---", "title: Forecast Review", "format: dashboard", "kernel: python3", "---"].join(
    "\n",
  ),
  metadata: {
    format: "yaml",
  },
};

const notebookViewCells = fullCellScenario.cells.map(scenarioCellToNotebookCell);
const initialNotebookViewCellIds = fullCellScenario.viewModel.cellIds;

const fullCellRows = [
  {
    label: "CodeCell",
    source: "apps/notebook/src/components/CodeCell.tsx",
    detail:
      "Rendered with seeded execution and output stores, ribbon-first CellContainer, code-cell current line, OutputArea, and hidden input/output states.",
  },
  {
    label: "MarkdownCell",
    source: "apps/notebook/src/components/MarkdownCell.tsx",
    detail:
      "Rendered in preview mode through the docs IsolatedFrame adapter, with the production edit button still available.",
  },
  {
    label: "RawCell",
    source: "apps/notebook/src/components/RawCell.tsx",
    detail:
      "Rendered with current raw-format detection, CodeMirror source editor, and shared cell chrome.",
  },
];

const fullCellBoundaryRows = [
  {
    surface: "Cell document state",
    catalogPath: "ElementsNotebookScenario -> replaceNotebookCells",
    productionBoundary: "NotebookView document projection",
    detail:
      "The catalog writes shared scenario cells into the notebook cell store so the production cells can subscribe normally without opening a notebook document.",
  },
  {
    surface: "Execution and output state",
    catalogPath: "scenario outputs -> setExecution/setOutput",
    productionBoundary: "runtimed execution pipeline",
    detail:
      "Scenario code cells seed the same execution pointer and output ID stores as production, but queueing, kernel lifecycle, and output mutation still stay outside the docs runtime.",
  },
  {
    surface: "Hidden input/output state",
    catalogPath: "fixture metadata.jupyter flags",
    productionBoundary: "NotebookView source/output visibility mutations",
    detail:
      "The catalog renders production CodeCell hidden affordances from static metadata, including grouped hidden-cell previews. Production writes those flags back through notebook document mutations.",
  },
  {
    surface: "Transient cell UI state",
    catalogPath: "focused/search/queued store setters",
    productionBoundary: "NotebookView focus, search, and runtime events",
    detail:
      "Focus and search state are seeded directly so cell chrome can render focused and preview states without notebook keyboard routing or global find ownership.",
  },
  {
    surface: "Source CRDT bridge",
    catalogPath: "CrdtBridgeProvider with null handle",
    productionBoundary: "WASM NotebookHandle and Automerge sync",
    detail:
      "Editors receive the production provider shape, but edits cannot call splice_source or schedule daemon sync from the catalog.",
  },
  {
    surface: "Markdown preview output",
    catalogPath: "docs IsolatedFrame adapter",
    productionBoundary: "isolated markdown iframe bundle",
    detail:
      "The production MarkdownCell preview path stays visible while renderer bootstrapping and untrusted markdown execution remain behind the output adapter.",
  },
  {
    surface: "NotebookView shell",
    catalogPath: "seeded cell store plus local cellIds order",
    productionBoundary: "Automerge order, DnD mutations, and keyboard navigation",
    detail:
      "The catalog can render the production workspace shell with fixture cells, but moving, adding, and deleting cells stop at local state callbacks.",
  },
];

const noop = () => {};

function standaloneCodeCellOutputId(output: { output_id?: string }, index: number) {
  return `elements-full-code:${output.output_id ?? `output-${index}`}`;
}

function scenarioCodeCellToStandaloneCodeCell(
  cell: NotebookViewCell,
  id: string,
  outputs: JupyterOutput[],
): CodeCellType {
  return {
    cell_type: "code",
    id,
    source: cell.source,
    execution_count: cell.executionCount,
    outputs,
    metadata: cell.metadata,
  };
}

function hiddenCodeCellFixture({
  id,
  label,
  detail,
  sourceHidden,
  outputsHidden,
  hiddenGroupCount,
  hiddenGroupItems,
}: {
  id: string;
  label: string;
  detail: string;
  sourceHidden: boolean;
  outputsHidden: boolean;
  hiddenGroupCount?: number;
  hiddenGroupItems?: HiddenGroupCellSummary[];
}) {
  const outputs = primaryScenarioCodeCell.outputs.map((output, index) => ({
    ...output,
    output_id: `${id}:output:${output.output_id ?? index}`,
  })) as JupyterOutput[];
  const cell = scenarioCodeCellToStandaloneCodeCell(primaryScenarioCodeCell, id, outputs);

  cell.metadata = {
    ...cell.metadata,
    jupyter: {
      ...(cell.metadata?.jupyter as Record<string, unknown> | undefined),
      source_hidden: sourceHidden,
      outputs_hidden: outputsHidden,
    },
  };

  return {
    id,
    label,
    detail,
    sourceHidden,
    outputsHidden,
    hiddenGroupCount,
    hiddenGroupItems,
    executionId: `${id}:execution`,
    outputs,
    cell,
  };
}

function scenarioCellToNotebookCell(cell: NotebookViewCell): NotebookCell {
  if (cell.cellType === "code") {
    return {
      cell_type: "code",
      id: cell.id,
      source: cell.source,
      execution_count: cell.executionCount,
      outputs: cell.outputs as JupyterOutput[],
      metadata: cell.metadata,
    };
  }

  if (cell.cellType === "markdown") {
    return {
      cell_type: "markdown",
      id: cell.id,
      source: cell.source,
      metadata: cell.metadata,
    };
  }

  return {
    cell_type: "raw",
    id: cell.id,
    source: cell.source,
    metadata: cell.metadata,
  };
}

function seedFullCellFixtures() {
  replaceNotebookCells([codeCell, markdownCell, rawCell, ...notebookViewCells]);
  resetNotebookOutputs();
  resetNotebookExecutions();

  for (const output of standaloneCodeCellOutputs) {
    if (!output.output_id) continue;
    setOutput(output.output_id, output);
  }
  setExecution(standaloneCodeCellExecutionId, {
    execution_count: primaryScenarioCodeCell.executionCount,
    status: primaryScenarioCodeCell.executionCount === null ? "queued" : "done",
    success: primaryScenarioCodeCell.executionCount === null ? null : true,
    output_ids: standaloneCodeCellOutputs
      .map((output) => output.output_id)
      .filter((outputId): outputId is string => Boolean(outputId)),
    submitted_by_actor_label: fullCellScenario.capabilities.access.actorLabel,
  });
  setCellExecutionPointer(codeCell.id, standaloneCodeCellExecutionId);

  for (const row of hiddenCodeCellRows) {
    const outputIds = row.outputs
      .map((output) => output.output_id)
      .filter((outputId): outputId is string => Boolean(outputId));

    for (const output of row.outputs) {
      if (!output.output_id) continue;
      setOutput(output.output_id, output);
    }

    setExecution(row.executionId, {
      execution_count: primaryScenarioCodeCell.executionCount,
      status: "done",
      success: true,
      output_ids: outputIds,
      submitted_by_actor_label: fullCellScenario.capabilities.access.actorLabel,
    });
    setCellExecutionPointer(row.cell.id, row.executionId);
  }

  for (const cell of fullCellScenario.cells) {
    if (cell.cellType !== "code" || !cell.executionId) continue;
    const outputIds = cell.outputs
      .map((output, index) => output.output_id ?? `${cell.executionId}:output:${index}`)
      .filter((outputId): outputId is string => outputId.length > 0);

    cell.outputs.forEach((output, index) => {
      const outputId = output.output_id ?? `${cell.executionId}:output:${index}`;
      setOutput(outputId, { ...output, output_id: outputId } as JupyterOutput);
    });
    setExecution(cell.executionId, {
      execution_count: cell.executionCount,
      status: cell.executionCount === null ? "queued" : "done",
      success: cell.executionCount === null ? null : true,
      output_ids: outputIds,
      submitted_by_actor_label: fullCellScenario.capabilities.access.actorLabel,
    });
    setCellExecutionPointer(cell.id, cell.executionId);
  }

  setFocusedCellId(codeCell.id);
  setExecutingCellIds(new Set());
  setQueuedCellIds(new Set());
  setSearchQuery(undefined);
  setSearchCurrentMatch(null);
  flushCellUIState();
}

function focusFixtureCell(cellId: string) {
  setFocusedCellId(cellId);
  flushCellUIState();
}

export function FullCellSurfacesExample() {
  const [fixturesSeeded, setFixturesSeeded] = useState(false);
  const [notebookViewCellIds, setNotebookViewCellIds] = useState(initialNotebookViewCellIds);

  useLayoutEffect(() => {
    seedFullCellFixtures();
    setFixturesSeeded(true);
  }, []);

  const adapterValue = useMemo(
    () => ({
      getHandle: () => null,
      onSyncNeeded: noop,
      localActor: "elements-fixture",
    }),
    [],
  );

  if (!fixturesSeeded) {
    return (
      <div className="not-prose rounded-lg border border-fd-border bg-fd-card p-4 text-sm text-fd-muted-foreground">
        Loading full cell fixtures...
      </div>
    );
  }

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
    <div className="not-prose space-y-6">
      <section className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-emerald-900 dark:text-emerald-100">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-4 flex-none" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold">Full cell fixtures</h2>
            <p className="mt-1 text-xs leading-5">
              These examples import the notebook app cell components directly. Store-backed state is
              seeded from fixture data, while the CRDT bridge exposes a null handle so edits never
              leave the docs app.
            </p>
          </div>
        </div>
      </section>

      <CrdtBridgeProvider {...adapterValue}>
        <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
          <div className="border-b border-fd-border p-4">
            <div className="flex items-center gap-2">
              <FileCode2 className="size-4 text-fd-muted-foreground" aria-hidden="true" />
              <h2 className="text-sm font-semibold">CodeCell</h2>
            </div>
            <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
              The code-cell current line and rendered text outputs come from the same stores the
              notebook app consumes.
            </p>
          </div>
          <div className="bg-background py-4 pl-4 pr-2">
            <CodeCell
              cell={codeCell}
              language={codeCellLanguage}
              onFocus={() => focusFixtureCell(codeCell.id)}
              onExecute={noop}
              onInterrupt={noop}
              onDelete={noop}
              onFocusPrevious={noop}
              onFocusNext={() => focusFixtureCell(markdownCell.id)}
              onInsertCellAfter={noop}
              rightGutterContent={
                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                  seeded runtime
                </span>
              }
            />
          </div>
        </section>

        <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
          <div className="border-b border-fd-border p-4">
            <div className="flex items-center gap-2">
              <FileCode2 className="size-4 text-fd-muted-foreground" aria-hidden="true" />
              <h2 className="text-sm font-semibold">CodeCell hidden states</h2>
            </div>
            <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
              Input-hidden, output-hidden, and fully-hidden affordances are owned by the production
              `CodeCell`. The catalog seeds metadata and output stores, then supplies inert toggle
              callbacks so the rows can be evaluated as document boundary language.
            </p>
          </div>
          <div className="divide-y divide-border bg-background">
            {hiddenCodeCellRows.map((row) => (
              <div key={row.id} className="grid gap-4 p-4 xl:grid-cols-[220px_minmax(0,1fr)]">
                <div>
                  <h3 className="text-sm font-semibold">{row.label}</h3>
                  <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">{row.detail}</p>
                </div>
                <div className="min-w-0 rounded-md border border-border bg-background py-3 pl-3 pr-2">
                  <CodeCell
                    cell={row.cell}
                    language={codeCellLanguage}
                    onFocus={() => focusFixtureCell(row.cell.id)}
                    onExecute={noop}
                    onInterrupt={noop}
                    onDelete={noop}
                    onFocusPrevious={noop}
                    onFocusNext={noop}
                    onInsertCellAfter={noop}
                    onToggleSourceHidden={noop}
                    onToggleOutputsHidden={noop}
                    hiddenGroupCount={row.hiddenGroupCount}
                    hiddenGroupItems={row.hiddenGroupItems}
                    onExpandHiddenGroup={noop}
                    onExpandHiddenGroupCell={noop}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
          <div className="border-b border-fd-border p-4">
            <div className="flex items-center gap-2">
              <FileText className="size-4 text-fd-muted-foreground" aria-hidden="true" />
              <h2 className="text-sm font-semibold">MarkdownCell</h2>
            </div>
            <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
              The production component is rendered in preview mode. Its markdown output is routed
              through the docs IsolatedFrame adapter instead of a runtime iframe bundle.
            </p>
          </div>
          <div className="grid gap-4 bg-background p-4 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="min-w-0 pl-6 pr-2">
              <MarkdownCell
                cell={markdownCell}
                onFocus={() => focusFixtureCell(markdownCell.id)}
                onDelete={noop}
                onFocusPrevious={() => focusFixtureCell(codeCell.id)}
                onFocusNext={() => focusFixtureCell(rawCell.id)}
                onInsertCellAfter={noop}
                rightGutterContent={
                  <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-[11px] font-medium text-sky-700 dark:text-sky-300">
                    preview adapter
                  </span>
                }
              />
            </div>
            <div className="rounded-lg border border-fd-border bg-fd-background p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-fd-muted-foreground">
                <Rows3 className="size-3.5" aria-hidden="true" />
                IsolatedFrame payload
              </div>
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-fd-muted-foreground">
                {markdownFixtureSource}
              </pre>
            </div>
          </div>
        </section>

        <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
          <div className="border-b border-fd-border p-4">
            <div className="flex items-center gap-2">
              <Rows3 className="size-4 text-fd-muted-foreground" aria-hidden="true" />
              <h2 className="text-sm font-semibold">RawCell</h2>
            </div>
            <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
              Raw format detection and the shared editor chrome run from the current notebook app
              component.
            </p>
          </div>
          <div className="bg-background py-4 pl-4 pr-2">
            <RawCell
              cell={rawCell}
              onFocus={() => focusFixtureCell(rawCell.id)}
              onDelete={noop}
              onFocusPrevious={() => focusFixtureCell(markdownCell.id)}
              onFocusNext={noop}
              onInsertCellAfter={noop}
              rightGutterContent={
                <span className="rounded-full border border-fd-border bg-fd-background px-2 py-1 font-mono text-[11px] text-fd-muted-foreground">
                  yaml
                </span>
              }
            />
          </div>
        </section>
      </CrdtBridgeProvider>

      <CrdtBridgeProvider {...adapterValue}>
        <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
          <div className="border-b border-fd-border p-4">
            <div className="flex items-center gap-2">
              <Rows3 className="size-4 text-fd-muted-foreground" aria-hidden="true" />
              <h2 className="text-sm font-semibold">NotebookView workspace shell</h2>
            </div>
            <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
              This fixture imports the production workspace renderer, seeds it from the shared
              Elements notebook scenario, then hands `NotebookView` a local visual order. Stable DOM
              ordering, adders, and cell navigation remain visible without opening a notebook
              document or WASM handle.
            </p>
          </div>
          <div className="bg-background p-3">
            <div className="flex h-[560px] flex-col overflow-hidden rounded-lg border border-border bg-background">
              <NotebookView
                cellIds={notebookViewCellIds}
                runtime="python"
                sessionRuntimeState="ready"
                onFocusCell={focusFixtureCell}
                onExecuteCell={noop}
                onInterruptKernel={noop}
                onDeleteCell={noop}
                onAddCell={() => null}
                onMoveCell={moveNotebookViewCell}
                onSetCellSourceHidden={noop}
                onSetCellOutputsHidden={noop}
              />
            </div>
          </div>
        </section>
      </CrdtBridgeProvider>

      <section className="rounded-lg border border-fd-border bg-fd-card p-4">
        <h2 className="text-sm font-semibold">Full Cell Boundary Map</h2>
        <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
          These rows describe why the page can import the full notebook cell components while still
          staying runtime-free. The catalog seeds the same stores and provider shapes the cells read
          in production, then stops before notebook documents, kernel execution, iframe bootstrap,
          or Automerge sync can run.
        </p>
        <div className="mt-4 grid gap-2">
          {fullCellBoundaryRows.map((row) => (
            <div
              key={row.surface}
              className="rounded-md border border-fd-border bg-fd-card p-3 text-xs"
            >
              <div className="grid gap-3 md:grid-cols-[150px_minmax(0,1fr)]">
                <div className="font-semibold">{row.surface}</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <div className="text-[11px] font-medium uppercase text-fd-muted-foreground">
                      Catalog path
                    </div>
                    <div className="mt-1 break-words font-mono text-[11px] leading-4 text-emerald-700 dark:text-emerald-300">
                      {row.catalogPath}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] font-medium uppercase text-fd-muted-foreground">
                      Production boundary
                    </div>
                    <div className="mt-1 break-words font-mono text-[11px] leading-4 text-amber-700 dark:text-amber-300">
                      {row.productionBoundary}
                    </div>
                  </div>
                </div>
              </div>
              <p className="mt-3 leading-5 text-fd-muted-foreground">{row.detail}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-3">
        {fullCellRows.map((row) => (
          <div key={row.label} className="rounded-lg border border-fd-border bg-fd-card p-4">
            <h3 className="text-sm font-semibold">{row.label}</h3>
            <p className="mt-2 font-mono text-[11px] leading-5 text-fd-muted-foreground">
              {row.source}
            </p>
            <p className="mt-3 text-xs leading-5 text-fd-muted-foreground">{row.detail}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
