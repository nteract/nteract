"use client";

import {
  Braces,
  ChevronRight,
  Code2,
  CheckCircle2,
  CircleDot,
  FileText,
  Play,
  Rows3,
  Search,
  ShieldCheck,
} from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { CellContainer } from "@/components/cell/CellContainer";
import { CellInsertionRibbon } from "@/components/cell/CellInsertionRibbon";
import { CodeCellCurrentLine } from "@/components/cell/CodeCellCurrentLine";
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
    role: "Frame, focus state, ribbon separator, drag handle, and segmented source/output layout.",
    status: "rendered",
  },
  {
    name: "CodeCellCurrentLine",
    source: "src/components/cell/CodeCellCurrentLine.tsx",
    role: "Natural-language run state, execution count, and bottom run/stop affordance.",
    status: "rendered",
  },
  {
    name: "ExecutionCount",
    source: "src/components/cell/ExecutionCount.tsx",
    role: "Read-only execution marker used by report-style notebook renders.",
    status: "rendered",
  },
  {
    name: "CellPresenceIndicators",
    source: "apps/notebook/src/components/cell/CellPresenceIndicators.tsx",
    role: "Remote peer markers backed by the cursor registry and presence bus.",
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
    body: "Editable code cells keep the ribbon clean and move execution state into a quiet current line.",
  },
  {
    id: "fixture-markdown-count",
    type: "markdown",
    label: "Markdown cell",
    count: null,
    body: "Markdown keeps the same container contract but shifts to the markdown ribbon accent when focused.",
  },
  {
    id: "fixture-raw-count",
    type: "raw",
    label: "Raw cell",
    count: null,
    body: "Raw cells use the raw ribbon accent while sharing the same frame and drag affordance.",
  },
];

const currentLineStateFixtures = [
  {
    label: "Idle",
    detail: "Quiet until hover, focus, or keyboard focus.",
    line: (
      <CodeCellCurrentLine
        languageLabel="Python"
        count={null}
        onExecute={() => {}}
        onInterrupt={() => {}}
      />
    ),
  },
  {
    label: "Focused idle",
    detail: "Language becomes readable when the cell owns focus.",
    line: (
      <CodeCellCurrentLine
        languageLabel="Python"
        count={null}
        isFocused
        onExecute={() => {}}
        onInterrupt={() => {}}
      />
    ),
  },
  {
    label: "Queued",
    detail: "Waiting uses the queue accent without becoming an error.",
    line: (
      <CodeCellCurrentLine
        languageLabel="Python"
        count={12}
        isQueued
        submittedByActorLabel="local:kyle"
        onExecute={() => {}}
        onInterrupt={() => {}}
      />
    ),
  },
  {
    label: "Running",
    detail: "Status reads active; the stop control carries danger.",
    line: (
      <CodeCellCurrentLine
        languageLabel="Python"
        count={12}
        isExecuting
        submittedByActorLabel="local:kyle"
        onExecute={() => {}}
        onInterrupt={() => {}}
      />
    ),
  },
  {
    label: "Completed",
    detail: "Finished cells keep run metadata collapsed until hover or focus.",
    line: (
      <CodeCellCurrentLine
        languageLabel="Python"
        count={12}
        elapsedMs={1476}
        activityContent={<StaticPresenceActivity />}
        onExecute={() => {}}
        onInterrupt={() => {}}
      />
    ),
  },
];

const currentLineConceptFixtures = [
  {
    label: "Production",
    detail: "Default reading mode keeps completed metadata collapsed into the boundary line.",
    line: (
      <CodeCellCurrentLine
        languageLabel="Python"
        count={26}
        elapsedMs={1476}
        activityContent={<StaticPresenceActivity />}
        onExecute={() => {}}
        onInterrupt={() => {}}
      />
    ),
  },
  {
    label: "Run state chip",
    detail: "Makes completion feel like metadata instead of sentence copy.",
    line: (
      <CurrentLineConcept>
        <span className="rounded-sm bg-muted/60 px-1.5 py-0.5 font-medium text-foreground/70">
          Python
        </span>
        <span className="rounded-full border border-border bg-background px-2 py-0.5 font-medium tabular-nums text-foreground/65">
          Run 26
        </span>
        <span className="text-muted-foreground/55">1.5s</span>
        <StaticPresenceDots />
      </CurrentLineConcept>
    ),
  },
  {
    label: "Activity edge",
    detail: "Keeps the run text shorter and lets peer activity sit against the rule.",
    line: (
      <CurrentLineConcept>
        <span className="rounded-sm bg-muted/60 px-1.5 py-0.5 font-medium text-foreground/70">
          Python
        </span>
        <span className="font-medium tabular-nums text-foreground/65">Run 26</span>
        <span className="text-muted-foreground/45">1.5s</span>
        <div className="h-px min-w-8 flex-1 rounded-full bg-border/45" />
        <StaticPresenceDots />
      </CurrentLineConcept>
    ),
  },
];

const contracts = [
  "Catalog examples import current components before adding fixture-only wrappers.",
  "Fixture content may stand in for runtime/editor/output systems until an adapter exists.",
  "Cell identity and stable DOM order stay outside the visual component.",
  "Runtime state enters as explicit props or fixture data, never through hooks in catalog examples.",
  "The rail owns notebook navigation; the ribbon owns type, focus, insertion intent, and document continuity.",
  "The code-cell current line owns the source/result boundary and run state.",
  "Hidden source keeps the current line when output remains visible; fully hidden cells collapse to one reveal affordance.",
];

const insertionRibbonRows = [
  {
    label: "Between cells",
    detail: "The neutral spine stays continuous; the active add action supplies the color.",
    activeType: "markdown" as const,
    terminal: false,
  },
  {
    label: "Document tail",
    detail:
      "The final add row keeps the action line in place while the spine fades into whitespace.",
    activeType: "code" as const,
    terminal: true,
  },
];

const hiddenBoundaryRows = [
  {
    id: "source-hidden-output-visible",
    label: "Input hidden",
    detail: "The source reveal sits above the current line; output still follows the boundary.",
    codeContent: <BoundarySourceFixture sourceHidden />,
    outputContent: <BoundaryOutputFixture />,
    hideOutput: false,
  },
  {
    id: "output-hidden-source-visible",
    label: "Output hidden",
    detail: "The current line stays with the source; the hidden output reveal owns the output row.",
    codeContent: <BoundarySourceFixture />,
    outputContent: <HiddenOutputFixture />,
    hideOutput: false,
  },
  {
    id: "both-hidden",
    label: "Input and output hidden",
    detail: "When both sides disappear, the cell collapses to one reveal affordance.",
    codeContent: <HiddenCellFixture />,
    outputContent: <HiddenOutputFixture />,
    hideOutput: true,
  },
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
    <div className="group min-w-0">
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
      <CodeCellCurrentLine
        languageLabel="Python"
        count={12}
        elapsedMs={1476}
        isFocused
        activityContent={
          <CellPresenceIndicators cellId={primaryCellId} variant="inline" prefixSeparator />
        }
        onExecute={() => {}}
        onInterrupt={() => {}}
      />
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

function InsertionRibbonFixture({
  activeType,
  terminal,
}: {
  activeType: "code" | "markdown";
  terminal?: boolean;
}) {
  return (
    <CellInsertionRibbon
      activeType={activeType}
      terminal={terminal}
      forceActionsVisible
      onInsert={() => undefined}
    />
  );
}

function BoundarySourceFixture({ sourceHidden = false }: { sourceHidden?: boolean }) {
  return (
    <div className="group min-w-0">
      {sourceHidden ? (
        <button
          type="button"
          className="inline-flex max-w-full items-center gap-1 rounded bg-muted/50 px-2 py-0.5 font-mono text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Code2 className="size-3 flex-none" aria-hidden="true" />
          <span className="truncate">{sourceFixture.split("\n")[0]}</span>
          <ChevronRight className="size-3 flex-none" aria-hidden="true" />
        </button>
      ) : (
        <pre className="m-0 overflow-hidden rounded border border-border bg-background px-3 py-2 font-mono text-xs leading-5 text-foreground">
          {sourceFixture.split("\n").slice(0, 2).join("\n")}
        </pre>
      )}
      <CodeCellCurrentLine
        languageLabel="Python"
        count={12}
        elapsedMs={1476}
        isFocused
        onExecute={() => {}}
        onInterrupt={() => {}}
      />
    </div>
  );
}

function BoundaryOutputFixture() {
  return (
    <div className="px-3 py-2 text-xs leading-5 text-fd-muted-foreground">
      MAE=8.42&nbsp;&nbsp;MAPE=6.8%&nbsp;&nbsp;Backtest=16 weeks
    </div>
  );
}

function HiddenOutputFixture() {
  return (
    <div className="px-3 py-2">
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded bg-muted/50 px-2 py-0.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <span>2 outputs</span>
        <ChevronRight className="size-3" aria-hidden="true" />
      </button>
    </div>
  );
}

function HiddenCellFixture() {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded bg-muted/50 px-2 py-0.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <span>Cell hidden</span>
      <ChevronRight className="size-3" aria-hidden="true" />
    </button>
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
        <div className="grid border-b border-fd-border bg-fd-muted/20 px-4 py-3 text-xs text-fd-muted-foreground sm:grid-cols-[72px_1fr_190px]">
          <div>ribbon</div>
          <div>source and output</div>
          <div className="hidden text-right sm:block">real shell, fixture content</div>
        </div>
        <div className="bg-background py-4 pl-4 pr-2">
          <PresenceFixtureProvider>
            <CellContainer
              id={primaryCellId}
              cellType="code"
              isFocused
              className="mx-0 px-0"
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
              dragHandleProps={{ "aria-label": "Fixture drag handle" }}
            />
          </PresenceFixtureProvider>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="border-b border-fd-border p-4">
          <h2 className="text-sm font-semibold">Cell Type Ribbons</h2>
          <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
            These rows reuse the current CellContainer ribbon colors with fixture content standing
            in for the editor or renderer.
          </p>
        </div>
        <div className="divide-y divide-fd-border bg-background py-2">
          {cellTypeFixtures.map((cell) => (
            <div key={cell.id} className="py-2 pl-4 pr-2">
              <CellContainer id={cell.id} cellType={cell.type} isFocused className="mx-0 px-0">
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
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="border-b border-fd-border p-4">
          <h2 className="text-sm font-semibold">Insertion Ribbon</h2>
          <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
            Add-cell rows are part of the same document spine. The quiet continuation stays neutral,
            while the hovered or focused action paints the insertion intent.
          </p>
        </div>
        <div className="divide-y divide-fd-border bg-background py-2">
          {insertionRibbonRows.map((row) => (
            <div key={row.label} className="grid gap-3 p-4 lg:grid-cols-[220px_minmax(0,1fr)]">
              <div>
                <h3 className="text-sm font-semibold">{row.label}</h3>
                <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">{row.detail}</p>
              </div>
              <div className="min-w-0 overflow-hidden rounded-md border border-fd-border bg-fd-background">
                <InsertionRibbonFixture activeType={row.activeType} terminal={row.terminal} />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="border-b border-fd-border p-4">
          <h2 className="text-sm font-semibold">Current Line States</h2>
          <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
            Execution state sits at the source/result boundary. The language leads as cell identity,
            and the run state reads as compact metadata.
          </p>
        </div>
        <div className="grid gap-3 bg-background p-4 lg:grid-cols-2">
          {currentLineStateFixtures.map((state) => (
            <div
              key={state.label}
              className="group rounded-md border border-fd-border bg-fd-card p-3"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium">{state.label}</div>
                <div className="mt-1 text-xs text-fd-muted-foreground">{state.detail}</div>
              </div>
              <div className="mt-3 min-w-0">{state.line}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="border-b border-fd-border p-4">
          <h2 className="text-sm font-semibold">Current Line Studio</h2>
          <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
            These are low-risk composition sketches for the source/result boundary. They keep the
            production run button and layout nearby while letting the activity and completion copy
            move around.
          </p>
        </div>
        <div className="divide-y divide-fd-border bg-background">
          {currentLineConceptFixtures.map((concept) => (
            <div key={concept.label} className="grid gap-3 p-4 lg:grid-cols-[220px_minmax(0,1fr)]">
              <div>
                <h3 className="text-sm font-semibold">{concept.label}</h3>
                <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">{concept.detail}</p>
              </div>
              <div className="group min-w-0 rounded-md border border-fd-border bg-fd-card px-3 py-4">
                {concept.line}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="border-b border-fd-border p-4">
          <h2 className="text-sm font-semibold">Hidden Boundaries</h2>
          <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
            The current line belongs to the source/result boundary. It remains when either side is
            still visible and disappears only when the whole cell is intentionally collapsed.
          </p>
        </div>
        <div className="divide-y divide-fd-border bg-background py-2">
          {hiddenBoundaryRows.map((row) => (
            <div key={row.id} className="grid gap-3 p-4 lg:grid-cols-[220px_minmax(0,1fr)]">
              <div>
                <h3 className="text-sm font-semibold">{row.label}</h3>
                <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">{row.detail}</p>
              </div>
              <CellContainer
                id={row.id}
                cellType="code"
                isFocused
                className="mx-0 px-0"
                codeContent={row.codeContent}
                outputContent={row.outputContent}
                hideOutput={row.hideOutput}
              />
            </div>
          ))}
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

function StaticPresenceDots() {
  return (
    <span
      className="inline-flex items-center gap-0.5"
      title="forecast reviewer, runtime analyst, output reviewer"
      aria-label="forecast reviewer, runtime analyst, output reviewer"
    >
      <span className="size-2 rounded-full bg-emerald-500" />
      <span className="size-2 rounded-full bg-sky-500" />
      <span className="size-2 rounded-full bg-violet-500" />
    </span>
  );
}

function StaticPresenceActivity() {
  return (
    <>
      <span className="text-muted-foreground/30" aria-hidden="true">
        ·
      </span>
      <StaticPresenceDots />
    </>
  );
}

function CurrentLineConcept({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-6 min-w-0 items-center gap-1.5 text-[11px] leading-none text-muted-foreground/70">
      <button
        type="button"
        className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/55 transition-colors hover:bg-muted hover:text-foreground"
        aria-label="Run cell"
      >
        <Play className="size-2.5 fill-current" aria-hidden="true" />
      </button>
      {children}
    </div>
  );
}
