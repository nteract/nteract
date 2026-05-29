import { Braces, CircleDot, FileText, GripVertical, Play, Rows3, Search } from "lucide-react";

const layers = [
  {
    name: "CellContainer",
    source: "src/components/cell/CellContainer.tsx",
    role: "Frame, focus state, gutter ribbon, drag handle, and segmented source/output layout.",
  },
  {
    name: "CompactExecutionButton",
    source: "src/components/cell/CompactExecutionButton.tsx",
    role: "Run/interrupt affordance that belongs to code cells, not a generic button variant.",
  },
  {
    name: "CodeMirrorEditor",
    source: "src/components/editor/codemirror-editor.tsx",
    role: "Source editing, search highlighting, remote cursors, completion, and attribution.",
  },
  {
    name: "OutputArea",
    source: "src/components/cell/OutputArea.tsx",
    role: "Output focus, display mode controls, and frame-level output interaction.",
  },
];

const contracts = [
  "Cell identity and stable DOM order stay outside the visual component.",
  "Runtime state enters as explicit props or fixture data, never through hooks in catalog examples.",
  "Source, output, gutter, and presence areas should be independently documented.",
];

export function CellAnatomyExample() {
  return (
    <div className="not-prose space-y-6">
      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="grid border-b border-fd-border bg-fd-muted/20 px-4 py-3 text-xs text-fd-muted-foreground sm:grid-cols-[96px_1fr_120px]">
          <div>gutter</div>
          <div>source and output</div>
          <div className="hidden text-right sm:block">cell chrome</div>
        </div>
        <div className="grid min-h-[360px] grid-cols-[52px_1fr]">
          <aside className="flex flex-col items-center border-r border-fd-border bg-fd-muted/30 py-4">
            <button
              type="button"
              className="flex size-8 items-center justify-center rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              aria-label="Run cell"
            >
              <Play className="size-4" aria-hidden="true" />
            </button>
            <div className="mt-4 h-full w-1 rounded-full bg-sky-500/70" />
            <GripVertical className="mt-3 size-4 text-fd-muted-foreground" aria-hidden="true" />
          </aside>

          <main className="min-w-0">
            <div className="flex items-center justify-between gap-3 border-b border-fd-border px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <Rows3 className="size-4 text-fd-muted-foreground" aria-hidden="true" />
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">Code cell frame</h3>
                  <p className="text-xs text-fd-muted-foreground">execution_count=12 · python</p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <span className="size-2 rounded-full bg-rose-500" />
                <span className="size-2 rounded-full bg-amber-500" />
                <span className="size-2 rounded-full bg-sky-500" />
              </div>
            </div>

            <div className="border-b border-fd-border bg-fd-background p-4">
              <div className="mb-3 flex items-center gap-2 text-xs font-medium text-fd-muted-foreground">
                <Braces className="size-4" aria-hidden="true" />
                Source editor
              </div>
              <pre className="overflow-x-auto rounded-md border border-fd-border bg-fd-muted/40 p-3 font-mono text-xs leading-6 text-fd-foreground">
                <code>{`features = orders.assign(month=orders.date.dt.month)
model.fit(features[columns], target)
predictions = model.predict(features_holdout)`}</code>
              </pre>
            </div>

            <div className="bg-fd-muted/20 p-4">
              <div className="mb-3 flex items-center gap-2 text-xs font-medium text-fd-muted-foreground">
                <FileText className="size-4" aria-hidden="true" />
                Output area
              </div>
              <div className="rounded-md border border-fd-border bg-fd-background p-3">
                <div className="grid gap-2 text-xs sm:grid-cols-3">
                  <div>
                    <div className="text-fd-muted-foreground">MAE</div>
                    <div className="mt-1 text-sm font-semibold">8.42</div>
                  </div>
                  <div>
                    <div className="text-fd-muted-foreground">MAPE</div>
                    <div className="mt-1 text-sm font-semibold">6.8%</div>
                  </div>
                  <div>
                    <div className="text-fd-muted-foreground">Backtest</div>
                    <div className="mt-1 text-sm font-semibold">16 weeks</div>
                  </div>
                </div>
              </div>
            </div>
          </main>
        </div>
      </section>

      <section className="grid gap-3 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-lg border border-fd-border bg-fd-card">
          <div className="border-b border-fd-border p-4">
            <h2 className="text-sm font-semibold">Current Pieces</h2>
          </div>
          <div className="divide-y divide-fd-border">
            {layers.map((layer) => (
              <div key={layer.name} className="grid gap-2 p-4 sm:grid-cols-[180px_1fr]">
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
