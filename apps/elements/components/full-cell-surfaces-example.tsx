"use client";

import { FileCode2, FileText, Rows3, ShieldCheck } from "lucide-react";
import { useLayoutEffect, useMemo, useState } from "react";
import { CodeCell } from "@/notebook-components/CodeCell";
import { MarkdownCell } from "@/notebook-components/MarkdownCell";
import { RawCell } from "@/notebook-components/RawCell";
import { CrdtBridgeProvider } from "../../notebook/src/hooks/useCrdtBridge";
import {
  flushCellUIState,
  setExecutingCellIds,
  setFocusedCellId,
  setQueuedCellIds,
  setSearchCurrentMatch,
  setSearchQuery,
} from "../../notebook/src/lib/cell-ui-state";
import { replaceNotebookCells } from "../../notebook/src/lib/notebook-cells";
import {
  resetNotebookExecutions,
  setCellExecutionPointer,
  setExecution,
} from "../../notebook/src/lib/notebook-executions";
import { resetNotebookOutputs, setOutput } from "../../notebook/src/lib/notebook-outputs";
import type {
  CodeCell as CodeCellType,
  MarkdownCell as MarkdownCellType,
  RawCell as RawCellType,
} from "../../notebook/src/types";

const codeCell: CodeCellType = {
  cell_type: "code",
  id: "elements-full-code-cell",
  source: [
    "features = orders.assign(month=orders.date.dt.month)",
    "model.fit(features[columns], target)",
    "predictions = model.predict(features_holdout)",
  ].join("\n"),
  execution_count: 12,
  outputs: [],
  metadata: {},
};

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

const fullCellRows = [
  {
    label: "CodeCell",
    source: "apps/notebook/src/components/CodeCell.tsx",
    detail:
      "Rendered with seeded execution and output stores, real CodeMirror source, CompactExecutionButton, and OutputArea.",
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
    catalogPath: "replaceNotebookCells fixture seed",
    productionBoundary: "NotebookView document projection",
    detail:
      "The catalog writes three static cells into the notebook cell store so CodeCell, MarkdownCell, and RawCell can subscribe normally without opening a notebook document.",
  },
  {
    surface: "Execution and output state",
    catalogPath: "setExecution and setOutput fixtures",
    productionBoundary: "runtimed execution pipeline",
    detail:
      "The code cell sees the same execution pointer and output IDs as production, but queueing, kernel lifecycle, and output mutation still stay outside the docs runtime.",
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
];

const noop = () => {};

function seedFullCellFixtures() {
  replaceNotebookCells([codeCell, markdownCell, rawCell]);
  resetNotebookOutputs();
  resetNotebookExecutions();

  setOutput("elements-output-stream", {
    output_id: "elements-output-stream",
    output_type: "stream",
    name: "stdout",
    text: "loaded 22,767 rows\nvalidated 16 week backtest window\n",
  });
  setOutput("elements-output-result", {
    output_id: "elements-output-result",
    output_type: "execute_result",
    execution_count: 12,
    data: {
      "text/plain": "MAE 8.42\nMAPE 6.8%\nBacktest 16 weeks",
    },
    metadata: {},
  });
  setExecution("elements-execution", {
    execution_count: 12,
    status: "done",
    success: true,
    output_ids: ["elements-output-stream", "elements-output-result"],
    submitted_by_actor_label: "local:kyle",
  });
  setCellExecutionPointer(codeCell.id, "elements-execution");

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
              The output count, execution button, and rendered text outputs come from the same
              stores the notebook app consumes.
            </p>
          </div>
          <div className="bg-background py-4 pl-12 pr-2">
            <CodeCell
              cell={codeCell}
              language="python"
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
              <FileText className="size-4 text-fd-muted-foreground" aria-hidden="true" />
              <h2 className="text-sm font-semibold">MarkdownCell</h2>
            </div>
            <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
              The production component is rendered in preview mode. Its markdown output is routed
              through the docs IsolatedFrame adapter instead of a runtime iframe bundle.
            </p>
          </div>
          <div className="grid gap-4 bg-background p-4 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="min-w-0 pl-8 pr-2">
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
          <div className="bg-background py-4 pl-12 pr-2">
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

      <section className="rounded-lg border border-fd-border bg-fd-card p-4">
        <h2 className="text-sm font-semibold">Full Cell Boundary Map</h2>
        <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
          These rows describe why the page can import the full notebook cell components while still
          staying runtime-free. The catalog seeds the same stores and provider shapes the cells read
          in production, then stops before notebook documents, kernel execution, iframe bootstrap,
          or Automerge sync can run.
        </p>
        <div className="mt-4 overflow-hidden rounded-md border border-fd-border">
          <div className="hidden grid-cols-[180px_220px_230px_minmax(0,1fr)] gap-3 border-b border-fd-border bg-fd-muted/40 px-3 py-2 text-[11px] font-medium uppercase text-fd-muted-foreground xl:grid">
            <span>Surface</span>
            <span>Catalog path</span>
            <span>Production boundary</span>
            <span>Notes</span>
          </div>
          {fullCellBoundaryRows.map((row) => (
            <div
              key={row.surface}
              className="grid gap-2 border-b border-fd-border px-3 py-3 text-xs last:border-b-0 xl:grid-cols-[180px_220px_230px_minmax(0,1fr)] xl:gap-3"
            >
              <div>
                <div className="text-[11px] font-medium uppercase text-fd-muted-foreground xl:hidden">
                  Surface
                </div>
                <div className="font-semibold">{row.surface}</div>
              </div>
              <div>
                <div className="text-[11px] font-medium uppercase text-fd-muted-foreground xl:hidden">
                  Catalog path
                </div>
                <div className="font-mono text-[11px] text-emerald-700 dark:text-emerald-300">
                  {row.catalogPath}
                </div>
              </div>
              <div>
                <div className="text-[11px] font-medium uppercase text-fd-muted-foreground xl:hidden">
                  Production boundary
                </div>
                <div className="font-mono text-[11px] text-amber-700 dark:text-amber-300">
                  {row.productionBoundary}
                </div>
              </div>
              <p className="leading-5 text-fd-muted-foreground">{row.detail}</p>
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
