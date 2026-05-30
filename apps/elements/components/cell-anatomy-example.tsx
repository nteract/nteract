"use client";

import {
  Braces,
  CheckCircle2,
  CircleDot,
  FileText,
  Rows3,
  Search,
  ShieldCheck,
} from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { CellContainer } from "@/components/cell/CellContainer";
import { CompactExecutionButton } from "@/components/cell/CompactExecutionButton";
import { ExecutionCount } from "@/components/cell/ExecutionCount";
import { OutputArea, type JupyterOutput } from "@/components/cell/OutputArea";
import { CodeMirrorEditor } from "@/components/editor/codemirror-editor";
import { CellPresenceIndicators } from "@/notebook-components/cell/CellPresenceIndicators";
import { startCursorDispatch } from "../../notebook/src/lib/cursor-registry";
import { emitPresence } from "../../notebook/src/lib/notebook-frame-bus";

const primaryCellId = "fixture-code-cell";
const sourceFixture = `features = orders.assign(month=orders.date.dt.month)
model.fit(features[columns], target)
predictions = model.predict(features_holdout)`;

const outputFixtures: JupyterOutput[] = [
  {
    output_id: "cell-anatomy-stream",
    output_type: "stream",
    name: "stdout",
    text: "training fold=01 mae=8.91\nvalidating fold=02 mae=8.42",
  },
  {
    output_id: "cell-anatomy-result",
    output_type: "execute_result",
    execution_count: 12,
    data: {
      "text/plain": "MAE=8.42  MAPE=6.8%  Backtest=16 weeks",
    },
    metadata: {},
  },
];

const layers = [
  {
    name: "CellContainer",
    source: "src/components/cell/CellContainer.tsx",
    role: "Frame, focus state, gutter ribbon, drag handle, and segmented source/output layout.",
    status: "rendered",
  },
  {
    name: "CompactExecutionButton",
    source: "src/components/cell/CompactExecutionButton.tsx",
    role: "Run/interrupt affordance that belongs to code cells, not a generic button variant.",
    status: "rendered",
  },
  {
    name: "ExecutionCount",
    source: "src/components/cell/ExecutionCount.tsx",
    role: "Read-only gutter count used when notebook cells are rendered without execution controls.",
    status: "rendered",
  },
  {
    name: "CellPresenceIndicators",
    source: "apps/notebook/src/components/cell/CellPresenceIndicators.tsx",
    role: "Remote peer markers in the cell gutter, backed by the cursor registry and presence bus.",
    status: "rendered",
  },
  {
    name: "CodeMirrorEditor",
    source: "src/components/editor/codemirror-editor.tsx",
    role: "Source editing, search highlighting, remote cursors, completion, and attribution.",
    status: "rendered",
  },
  {
    name: "OutputArea",
    source: "src/components/cell/OutputArea.tsx",
    role: "Output focus, display mode controls, and frame-level output interaction.",
    status: "rendered",
  },
];

const cellTypeFixtures = [
  {
    id: "fixture-code-count",
    type: "code",
    label: "Code cell",
    count: 7,
    body: "Read-only code cells use the execution count while editable code cells use the compact run control.",
  },
  {
    id: "fixture-markdown-count",
    type: "markdown",
    label: "Markdown cell",
    count: null,
    body: "Markdown keeps the same container contract but shifts to the markdown gutter accent when focused.",
  },
  {
    id: "fixture-raw-count",
    type: "raw",
    label: "Raw cell",
    count: null,
    body: "Raw cells use the raw gutter accent while sharing the same frame and drag affordance.",
  },
];

const contracts = [
  "Catalog examples import current components before adding fixture-only wrappers.",
  "Fixture content may stand in for runtime/editor/output systems until an adapter exists.",
  "Cell identity and stable DOM order stay outside the visual component.",
  "Runtime state enters as explicit props or fixture data, never through hooks in catalog examples.",
];

const presenceSnapshot = {
  type: "snapshot",
  peer_id: "local-docs-peer",
  peers: [
    {
      peer_id: "peer-forecast",
      peer_label: "forecast reviewer",
      actor_label: "Forecast Reviewer",
      channels: [
        {
          channel: "cursor",
          data: { cell_id: primaryCellId, line: 2, column: 18 },
        },
      ],
    },
    {
      peer_id: "peer-runtime",
      peer_label: "runtime analyst",
      actor_label: "Runtime Analyst",
      channels: [
        {
          channel: "focus",
          data: { cell_id: primaryCellId },
        },
      ],
    },
    {
      peer_id: "peer-output",
      peer_label: "output reviewer",
      actor_label: "Output Reviewer",
      channels: [
        {
          channel: "selection",
          data: {
            cell_id: primaryCellId,
            anchor_line: 1,
            anchor_col: 0,
            head_line: 1,
            head_col: 16,
          },
        },
        {
          channel: "cursor",
          data: { cell_id: primaryCellId, line: 1, column: 16 },
        },
      ],
    },
  ],
};

function PresenceFixtureProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const stopCursorDispatch = startCursorDispatch("local-docs-peer");

    emitPresence(presenceSnapshot);
    const retry = window.setTimeout(() => emitPresence(presenceSnapshot), 0);

    return () => {
      window.clearTimeout(retry);
      stopCursorDispatch();
    };
  }, []);

  return children;
}

function SourceFixture() {
  return (
    <div className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Rows3 className="size-4 flex-none text-fd-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">Code cell frame</h3>
            <p className="text-xs text-fd-muted-foreground">
              Current CellContainer, CodeMirrorEditor, and OutputArea
            </p>
          </div>
        </div>
        <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-900">
          existing component
        </span>
      </div>

      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-fd-muted-foreground">
        <Braces className="size-4" aria-hidden="true" />
        CodeMirrorEditor
      </div>
      <div className="overflow-hidden rounded-md border border-border bg-background">
        <CodeMirrorEditor
          initialValue={sourceFixture}
          language="python"
          lineWrapping
          maxHeight="190px"
          readOnly
        />
      </div>
    </div>
  );
}

function OutputFixture() {
  return (
    <div className="px-3 py-3">
      <div className="mb-3 flex items-center gap-2 text-xs font-medium text-fd-muted-foreground">
        <FileText className="size-4" aria-hidden="true" />
        OutputArea
      </div>
      <div className="rounded-md border border-border bg-background py-2">
        <OutputArea
          outputs={outputFixtures}
          cellId={primaryCellId}
          executionCount={12}
          isolated={false}
          useOutputWell={false}
        />
      </div>
    </div>
  );
}

export function CellAnatomyExample() {
  return (
    <div className="not-prose space-y-6">
      <section className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-4 text-sky-900 dark:text-sky-900">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-4 flex-none" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold">Catalog fidelity rule</h2>
            <p className="mt-1 text-xs leading-5">
              This page renders the cell shell, editor, output, and presence pieces the notebook app
              imports today. Runtime state is supplied as fixture props instead of hooks.
            </p>
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="grid border-b border-fd-border bg-fd-muted/20 px-4 py-3 text-xs text-fd-muted-foreground sm:grid-cols-[96px_1fr_190px]">
          <div>gutter</div>
          <div>source and output</div>
          <div className="hidden text-right sm:block">real shell, fixture content</div>
        </div>
        <div className="bg-background py-4 pl-12 pr-2">
          <PresenceFixtureProvider>
            <CellContainer
              id={primaryCellId}
              cellType="code"
              isFocused
              className="mx-0 px-0"
              gutterContent={<CompactExecutionButton count={12} />}
              codeContent={<SourceFixture />}
              outputContent={<OutputFixture />}
              rightGutterContent={
                <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-900">
                  real
                </span>
              }
              outputRightGutterContent={
                <span className="rounded-full bg-fd-muted px-1.5 py-0.5 text-[10px] font-medium text-fd-muted-foreground">
                  fixture
                </span>
              }
              presenceIndicators={<CellPresenceIndicators cellId={primaryCellId} />}
              dragHandleProps={{ "aria-label": "Fixture drag handle" }}
            />
          </PresenceFixtureProvider>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="border-b border-fd-border p-4">
          <h2 className="text-sm font-semibold">Cell Type Gutters</h2>
          <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
            These rows reuse the current CellContainer gutter colors and ExecutionCount component,
            with fixture content standing in for the editor or renderer.
          </p>
        </div>
        <div className="divide-y divide-fd-border bg-background py-2">
          {cellTypeFixtures.map((cell) => (
            <div key={cell.id} className="py-2 pl-12 pr-2">
              <CellContainer
                id={cell.id}
                cellType={cell.type}
                isFocused
                className="mx-0 px-0"
                gutterContent={
                  cell.type === "code" ? (
                    <ExecutionCount count={cell.count} />
                  ) : (
                    <ExecutionCount count={cell.count} className="opacity-50" />
                  )
                }
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <h3 className="truncate text-sm font-semibold">{cell.label}</h3>
                    <span className="rounded-full border border-fd-border bg-fd-background px-2 py-1 font-mono text-[11px] text-fd-muted-foreground">
                      {cell.type}
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">{cell.body}</p>
                </div>
              </CellContainer>
            </div>
          ))}
          <div className="py-2 pl-12 pr-2">
            <CellContainer
              id="fixture-executing-count"
              cellType="code"
              isFocused
              className="mx-0 px-0"
              gutterContent={<ExecutionCount count={null} isExecuting />}
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <h3 className="truncate text-sm font-semibold">Executing count state</h3>
                  <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-[11px] font-medium text-sky-700 dark:text-sky-300">
                    running
                  </span>
                </div>
                <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
                  ExecutionCount renders the notebook convention for active read-only cells without
                  requiring kernel state in the catalog.
                </p>
              </div>
            </CellContainer>
          </div>
        </div>
      </section>

      <section className="grid gap-3">
        <div className="rounded-lg border border-fd-border bg-fd-card">
          <div className="border-b border-fd-border p-4">
            <h2 className="text-sm font-semibold">Current Pieces</h2>
          </div>
          <div className="divide-y divide-fd-border">
            {layers.map((layer) => (
              <div
                key={layer.name}
                className="grid gap-3 p-4 md:grid-cols-[190px_minmax(0,1fr)_130px]"
              >
                <div>
                  <div className="text-sm font-semibold">{layer.name}</div>
                  <div className="mt-1 break-words font-mono text-xs text-fd-muted-foreground [overflow-wrap:anywhere]">
                    {layer.source}
                  </div>
                </div>
                <p className="text-xs leading-5 text-fd-muted-foreground">{layer.role}</p>
                <div>
                  <span className="inline-flex items-center gap-1 rounded-full border border-fd-border bg-fd-background px-2 py-1 text-[11px] text-fd-muted-foreground">
                    {layer.status === "rendered" && (
                      <CheckCircle2 className="size-3 text-emerald-600" aria-hidden="true" />
                    )}
                    {layer.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-fd-border bg-fd-card p-4">
          <div className="mb-3 flex items-center gap-2">
            <Search className="size-4 text-fd-muted-foreground" aria-hidden="true" />
            <h2 className="text-sm font-semibold">Extraction Contract</h2>
          </div>
          <div className="space-y-3">
            {contracts.map((contract) => (
              <div key={contract} className="flex gap-2 text-xs leading-5 text-fd-muted-foreground">
                <CircleDot className="mt-0.5 size-3 flex-none" aria-hidden="true" />
                <span>{contract}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
