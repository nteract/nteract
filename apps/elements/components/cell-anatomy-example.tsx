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
import { CompactExecutionButton } from "@/components/cell/CompactExecutionButton";

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
    name: "CodeMirrorEditor",
    source: "src/components/editor/codemirror-editor.tsx",
    role: "Source editing, search highlighting, remote cursors, completion, and attribution.",
    status: "adapter needed",
  },
  {
    name: "OutputArea",
    source: "src/components/cell/OutputArea.tsx",
    role: "Output focus, display mode controls, and frame-level output interaction.",
    status: "adapter needed",
  },
];

const contracts = [
  "Catalog examples import current components before using schematic markup.",
  "Fixture content may stand in for runtime/editor/output systems until an adapter exists.",
  "Cell identity and stable DOM order stay outside the visual component.",
  "Runtime state enters as explicit props or fixture data, never through hooks in catalog examples.",
];

function SourceFixture() {
  return (
    <div className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Rows3 className="size-4 flex-none text-fd-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">Code cell frame</h3>
            <p className="text-xs text-fd-muted-foreground">
              Current CellContainer with fixture source content
            </p>
          </div>
        </div>
        <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
          existing component
        </span>
      </div>

      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-fd-muted-foreground">
        <Braces className="size-4" aria-hidden="true" />
        Source editor fixture
      </div>
      <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-6 text-foreground">
        <code>{`features = orders.assign(month=orders.date.dt.month)
model.fit(features[columns], target)
predictions = model.predict(features_holdout)`}</code>
      </pre>
    </div>
  );
}

function OutputFixture() {
  return (
    <div className="px-3 py-2">
      <div className="mb-3 flex items-center gap-2 text-xs font-medium text-fd-muted-foreground">
        <FileText className="size-4" aria-hidden="true" />
        OutputArea fixture
      </div>
      <div className="rounded-md border border-border bg-background p-3">
        <div className="grid gap-2 text-xs sm:grid-cols-3">
          <div>
            <div className="text-muted-foreground">MAE</div>
            <div className="mt-1 text-sm font-semibold">8.42</div>
          </div>
          <div>
            <div className="text-muted-foreground">MAPE</div>
            <div className="mt-1 text-sm font-semibold">6.8%</div>
          </div>
          <div>
            <div className="text-muted-foreground">Backtest</div>
            <div className="mt-1 text-sm font-semibold">16 weeks</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function CellAnatomyExample() {
  return (
    <div className="not-prose space-y-6">
      <section className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-4 text-sky-900 dark:text-sky-100">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-4 flex-none" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold">Catalog fidelity rule</h2>
            <p className="mt-1 text-xs leading-5">
              This page renders only the cell shell pieces the notebook app imports today. Editor
              and output regions remain fixture-backed until their runtime-free adapters exist.
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
          <CellContainer
            id="fixture-code-cell"
            cellType="code"
            isFocused
            className="mx-0 px-0"
            gutterContent={<CompactExecutionButton count={12} />}
            codeContent={<SourceFixture />}
            outputContent={<OutputFixture />}
            rightGutterContent={
              <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                real
              </span>
            }
            outputRightGutterContent={
              <span className="rounded-full bg-fd-muted px-1.5 py-0.5 text-[10px] font-medium text-fd-muted-foreground">
                fixture
              </span>
            }
            presenceIndicators={
              <div className="mt-1 flex flex-col gap-1" aria-label="Fixture presence markers">
                <span className="size-1.5 rounded-full bg-rose-500" />
                <span className="size-1.5 rounded-full bg-amber-500" />
                <span className="size-1.5 rounded-full bg-sky-500" />
              </div>
            }
            dragHandleProps={{ "aria-label": "Fixture drag handle" }}
          />
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
