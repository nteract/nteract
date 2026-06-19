"use client";

import { CircleDot, Search, ShieldCheck } from "lucide-react";
import { CellContainer } from "@/components/cell/CellContainer";
import { CellInsertionRibbon } from "@/components/cell/CellInsertionRibbon";
import { CodeCellCurrentLine } from "@/components/cell/CodeCellCurrentLine";

const layers = [
  {
    name: "CellContainer",
    source: "src/components/cell/CellContainer.tsx",
    role: "Frame, focus state, ribbon separator, drag handle, and segmented source/output layout.",
  },
  {
    name: "CodeCellCurrentLine",
    source: "src/components/cell/CodeCellCurrentLine.tsx",
    role: "Source/result boundary with a quiet run affordance and revealable execution metadata.",
  },
  {
    name: "CellInsertionRibbon",
    source: "src/components/cell/CellInsertionRibbon.tsx",
    role: "Between-cell and document-tail insertion affordance on the same visual spine.",
  },
  {
    name: "Full cell surface",
    source: "src/components/notebook/NotebookView.tsx",
    role: "Integrated editor, markdown, output, presence, hidden-cell, and notebook ordering behavior. Rendered in the full surface below instead of restaged as a schematic.",
  },
];

const cellTypeFixtures = [
  {
    id: "fixture-code-count",
    type: "code",
    label: "Code cell",
    body: "Editable code cells keep the ribbon clean and move execution state into a quiet current line.",
  },
  {
    id: "fixture-markdown-count",
    type: "markdown",
    label: "Markdown cell",
    body: "Markdown keeps the same container contract but shifts to the markdown ribbon accent when focused.",
  },
  {
    id: "fixture-raw-count",
    type: "raw",
    label: "Raw cell",
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
      "Runtime work starts as a line, then earns a monotonic green wave if it stays busy long enough.",
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
    line: <CodeCellCurrentLine languageLabel="Python" count={12} elapsedMs={1476} />,
  },
];

const contracts = [
  "This map documents boundary ownership only; the full cell surface below is the integrated UI example.",
  "Component names, adapter labels, and fixture badges are documentation, not proposed notebook chrome.",
  "Cell identity and stable DOM order stay outside the visual component.",
  "Runtime state enters as explicit props or fixture data, never through hooks in catalog examples.",
  "The rail owns notebook navigation; the ribbon owns type, focus, insertion intent, and document continuity.",
  "The code-cell current line owns the source/result boundary and run state.",
  "Hidden input keeps the current line when output remains visible; fully hidden cells collapse to one reveal affordance.",
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
      <section className="border-l border-fd-border py-1 pl-4 text-fd-muted-foreground">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-4 flex-none" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold">Boundary map rule</h2>
            <p className="mt-1 text-xs leading-5">
              This page names the cell chrome boundaries. It does not turn component names, adapter
              labels, or fixture badges into notebook UI. Use the full cell surface below to inspect
              integrated editor, output, presence, and notebook ordering behavior.
            </p>
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="border-b border-fd-border p-4">
          <h2 className="text-sm font-semibold">Cell Type Accents</h2>
          <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
            These rows show only the production ribbon accent. Cell type should not be repeated as a
            floating label when the ribbon already carries that state.
          </p>
        </div>
        <div className="divide-y divide-fd-border bg-background py-2">
          {cellTypeFixtures.map((cell) => (
            <div key={cell.id} className="py-2 pl-4 pr-2">
              <CellContainer id={cell.id} cellType={cell.type} isFocused className="mx-0 px-0">
                <div className="grid min-w-0 gap-2 sm:grid-cols-[160px_minmax(0,1fr)]">
                  <h3 className="text-sm font-semibold">{cell.label}</h3>
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
            <h2 className="text-sm font-semibold">Boundary Ownership</h2>
          </div>
          <div className="divide-y divide-fd-border">
            {layers.map((layer) => (
              <div key={layer.name} className="grid gap-3 p-4 md:grid-cols-[210px_minmax(0,1fr)]">
                <div>
                  <div className="text-sm font-semibold">{layer.name}</div>
                  <div className="mt-1 break-words font-mono text-xs text-fd-muted-foreground [overflow-wrap:anywhere]">
                    {layer.source}
                  </div>
                </div>
                <p className="text-xs leading-5 text-fd-muted-foreground">{layer.role}</p>
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
