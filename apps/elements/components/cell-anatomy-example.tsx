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
import { CellContainer } from "@/components/cell/CellContainer";
import { CellInsertionRibbon } from "@/components/cell/CellInsertionRibbon";
import { CodeCellCurrentLine } from "@/components/cell/CodeCellCurrentLine";
import { CellPresenceIndicators } from "@/components/cell/CellPresenceIndicators";
import { OutputArea } from "@/components/cell/OutputArea";
import { CodeMirrorEditor } from "@/components/editor/codemirror-editor";
import {
  getElementsNotebookPrimaryCodeCell,
  getElementsNotebookScenario,
  resolveElementsNotebookLanguage,
} from "@/components/notebook-scenarios";

const anatomyScenario = getElementsNotebookScenario("desktop-local-owner");
const primaryCell = getElementsNotebookPrimaryCodeCell(anatomyScenario.cells);
const primaryCellId = primaryCell.id;
const sourceFixture = primaryCell.source;
const outputFixtures = primaryCell.outputs;
const executionCount = primaryCell.executionCount;
const languageLabel =
  primaryCell.language === "python" ? "Python" : (primaryCell.language ?? "Cell");
const editorLanguage = resolveElementsNotebookLanguage(primaryCell.language) ?? "plain";

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
    role: "Source/result boundary with a quiet run affordance and revealable execution metadata.",
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
    source: "src/components/cell/CellPresenceIndicators.tsx",
    role: "Remote peer markers rendered from adapter-provided presence peers.",
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
    line: <CodeCellCurrentLine languageLabel="Python" count={null} />,
  },
  {
    label: "Focused idle",
    detail: "Cell selection colors the rule; metadata waits for hover or keyboard focus.",
    line: <CodeCellCurrentLine languageLabel="Python" count={null} isFocused />,
  },
  {
    label: "Queued",
    detail: "Waiting keeps a simple blue boundary with only a small pulse.",
    line: <CodeCellCurrentLine languageLabel="Python" count={12} isQueued />,
  },
  {
    label: "Next queued",
    detail: "Queue priority can proportionally tighten the pulse without exposing queue order.",
    line: <CodeCellCurrentLine languageLabel="Python" count={12} isQueued queuePriority={1} />,
  },
  {
    label: "Running",
    detail:
      "Runtime work starts as a line, then earns the green wave if it stays busy long enough.",
    line: <CodeCellCurrentLine languageLabel="Python" count={12} isExecuting />,
  },
  {
    label: "Errored",
    detail: "Failures keep the run context visible and break the boundary instead of pulsing.",
    line: <CodeCellCurrentLine languageLabel="Python" count={12} isErrored />,
  },
  {
    label: "Completed",
    detail: "Finished cells keep run metadata collapsed into the boundary until directly engaged.",
    line: (
      <CodeCellCurrentLine
        languageLabel="Python"
        count={12}
        elapsedMs={1476}
        activityContent={<StaticPresenceActivity />}
      />
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
    detail: "The neutral spine stays continuous; the compact palette supplies insertion intent.",
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

const presencePeers = [
  { peerId: "peer-forecast", peerLabel: "forecast reviewer", color: "#0ea5e9" },
  { peerId: "peer-runtime", peerLabel: "runtime analyst", color: "#10b981" },
  { peerId: "peer-output", peerLabel: "output reviewer", color: "#a855f7" },
];

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
          language={editorLanguage}
          lineWrapping
          maxHeight="190px"
          readOnly
        />
      </div>
      <CodeCellCurrentLine
        languageLabel={languageLabel}
        count={executionCount}
        elapsedMs={1476}
        isFocused
        activityContent={
          <CellPresenceIndicators peers={presencePeers} variant="inline" prefixSeparator />
        }
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
          executionCount={executionCount}
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
            while the hovered or focused icon palette paints the insertion intent.
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
            and resting run metadata stays collapsed until the boundary is engaged.
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
