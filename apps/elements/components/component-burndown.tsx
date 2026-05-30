import {
  CheckCircle2,
  CircleDotDashed,
  Cloud,
  Code2,
  FileCode2,
  ListChecks,
  Palette,
  PanelLeft,
  Rows3,
  Search,
  ShieldCheck,
} from "lucide-react";

const stats = [
  { label: "shadcn primitives", value: "24", detail: "current generic UI floor" },
  { label: "notebook domains", value: "11", detail: "first catalog targets" },
  { label: "component forks", value: "0", detail: "current sources stay canonical" },
  {
    label: "current imports",
    value: "100+",
    detail:
      "used shell toolbar, notebook rail, package headers, search, full cells, read-only cells, cell gutter, cell presence, runtime dialogs and banners, theme, output area, isolated output policy, widget-view MIME handoff, plugin renderer, editor, widget controls, widget media, hydrated widget buffers, widget output, ipycanvas, and anywidget surfaces",
  },
];

const phases = [
  {
    title: "Catalog the notebook shell",
    state: "active",
    icon: PanelLeft,
    summary: "Left rail, workspace chrome, toolbar, and notebook-level navigation.",
  },
  {
    title: "Document cell anatomy",
    state: "active",
    icon: Rows3,
    summary: "Render production-used cell shell pieces, then add editor and output adapters.",
  },
  {
    title: "Separate renderers",
    state: "active",
    icon: FileCode2,
    summary: "ANSI, JSON, image, traceback, MIME priority, frame policy, and isolated adapters.",
  },
  {
    title: "Expose notebook themes",
    state: "active",
    icon: Palette,
    summary: "Classic and cream palette checks on top of the shared notebook base CSS.",
  },
  {
    title: "Document runtime surfaces",
    state: "active",
    icon: ShieldCheck,
    summary: "Trust, dependency headers, environment decisions, daemon state, and launch banners.",
  },
  {
    title: "Capture hosted notebooks",
    state: "active",
    icon: Cloud,
    summary: "Read-only notebook cells, cloud/report paths, loading states, and output adapters.",
  },
];

const families = [
  {
    family: "Notebook workspace",
    source:
      "apps/notebook/src/components/{NotebookView,NotebookToolbar,DependencyHeader}.tsx + src/components/notebook-rail/NotebookRail.tsx",
    target: "nteract shell",
    status: "active",
    intent:
      "NotebookToolbar now has a dedicated runtime-state matrix, while NotebookRail, NotebookPackagesPanel, and the package panel DependencyHeader render from current source with fixture-owned panel state and inert host callbacks.",
  },
  {
    family: "Notebook search",
    source: "apps/notebook/src/components/{GlobalFindBar,HistorySearchDialog}.tsx",
    target: "nteract shell",
    status: "active",
    intent:
      "GlobalFindBar and HistorySearchDialog now render from fixture search state; the history dialog uses a docs-local NotebookHost transport that only serves get_history.",
  },
  {
    family: "Package managers",
    source:
      "apps/notebook/src/components/{DependencyHeader,CondaDependencyHeader,PixiDependencyHeader,DenoDependencyHeader}.tsx",
    target: "nteract shell",
    status: "active",
    intent:
      "The package manager page renders the current uv, Conda, Pixi, and Deno dependency headers with static metadata and inert callbacks, giving the rail package panel real notebook UI to converge on.",
  },
  {
    family: "Cells",
    source: "apps/notebook/src/components/{CodeCell,MarkdownCell,RawCell}.tsx",
    target: "nteract cells",
    status: "active",
    intent:
      "CodeCell, MarkdownCell, and RawCell now render with seeded store state and a null CRDT handle; markdown preview still documents its isolated-renderer adapter boundary.",
  },
  {
    family: "Read-only notebooks",
    source:
      "src/components/cell/{ReadOnlyNotebook,ReadOnlyNotebookCell}.tsx + apps/notebook/src/components/CellSkeleton.tsx",
    target: "nteract hosted",
    status: "active",
    intent:
      "ReadOnlyNotebook, ReadOnlyNotebookCell, and CellSkeleton now render from fixture nbformat output data, covering the shared cloud and hosted artifact path without live runtime state.",
  },
  {
    family: "Cell internals",
    source: "src/components/cell/**",
    target: "nteract cells",
    status: "active",
    intent:
      "CellContainer, CompactExecutionButton, ExecutionCount, and CellPresenceIndicators now render from current source; unused legacy helpers have been removed instead of cataloged.",
  },
  {
    family: "Editors",
    source: "src/components/editor/**",
    target: "nteract editor",
    status: "active",
    intent:
      "CodeMirrorEditor, ReadOnlyCodeMirror, StaticCodeBlock, search highlighting, remote cursors, text attribution, languages, and themes now render from fixtures.",
  },
  {
    family: "Theme surfaces",
    source: "src/styles/notebook-base.css + apps/elements/components/notebook-palette-toggle.tsx",
    target: "nteract shell",
    status: "active",
    intent:
      "The docs app now imports the shared notebook base CSS and exposes a runtime-free classic/cream palette switch for previewing catalog components.",
  },
  {
    family: "Outputs",
    source:
      "src/components/cell/OutputArea.tsx + src/components/outputs/** + packages/sift/src/react.tsx",
    target: "nteract renderers",
    status: "active",
    intent:
      "OutputArea lane composition, top-level widget-view MIME handoff, nested OutputModel widget-view routing, AnsiStreamOutput, AnsiErrorOutput, JsonOutput, ImageOutput, MathOutput, SvgOutput, AudioOutput, JavaScriptOutput, PlotlyOutput, VegaOutput, GeoJsonOutput, PdfOutput, VideoOutput, TracebackOutput, MIME priority, SiftTable, and a fixture-backed Sift parquet URL handoff now render from fixtures; live JavaScript execution, third-party renderer loading, live widget comms, and generated Sift WASM decoding remain explicit adapter boundaries.",
  },
  {
    family: "Output isolation",
    source:
      "src/components/isolated/{host-context,mcp-app-structured-content,output-frame-sizing,output-lane-policy}.ts + apps/elements/components/isolated/{index.tsx,frame-config-adapter.ts}",
    target: "nteract renderers",
    status: "active",
    intent:
      "Host-context theme merging, output lane routing, sizing, MCP structured output mapping, and the docs IsolatedFrame and frame-config adapters now render without booting production iframe scripts.",
  },
  {
    family: "Widgets",
    source:
      "src/components/widgets/{widget-view,widget-store-context,widget-store}.tsx + src/components/widgets/controls/index.ts",
    target: "nteract widgets",
    status: "active",
    intent:
      "WidgetView, WidgetStore, AnyWidgetView, the AFM model proxy, inline and URL-backed anywidget assets, the current built-in controls registry, form, selection, numeric, status, media, hydrated DataView image buffers, file upload, OutputModel with nested widget-view output, layout containers, controller sub-controls, ipycanvas CanvasModel command replay, unsupported fallback, and static snapshots now render from comm-state fixtures.",
  },
  {
    family: "Runtime decisions",
    source: "apps/notebook/src/components/{*Dialog,*Banner,DependencyHeader}.tsx",
    target: "nteract runtime",
    status: "active",
    intent:
      "TrustDialog, RuntimeDecisionDialog, EnvBuildDecisionDialog, DependencyHeader, and runtime banners now render with fixture state and a host adapter for settings actions.",
  },
  {
    family: "Generic primitives",
    source: "src/components/ui/**",
    target: "shadcn floor",
    status: "hold",
    intent:
      "Keep low-level Button, Dialog, Select, Sheet, and form controls boring until a notebook semantic wrapper exists.",
  },
];

const statusClasses = {
  active: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  next: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  planned: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  queued: "border-fd-border bg-fd-muted text-fd-muted-foreground",
  hold: "border-fd-border bg-fd-background text-fd-muted-foreground",
};

const rules = [
  {
    title: "Use current components first",
    icon: ShieldCheck,
    body: "Catalog pages render existing components through fixtures as soon as isolation allows. Cell, runtime, theme, editor, output, and widget pages now start with real notebook pieces.",
  },
  {
    title: "Audit before cataloging",
    icon: Search,
    body: "A catalog entry should trace to production usage, a current migration target, or a clearly labeled adapter blocker. Dead helpers should be deleted, not preserved as examples.",
  },
  {
    title: "Own notebook semantics",
    icon: ListChecks,
    body: "If a component knows about cells, outputs, kernels, trust, packages, variables, or notebook navigation, it belongs in the nteract catalog.",
  },
];

function statusLabel(status: keyof typeof statusClasses) {
  if (status === "active") return "active";
  if (status === "next") return "next";
  if (status === "hold") return "hold";
  return "planned";
}

export function ComponentBurndown() {
  return (
    <div className="not-prose space-y-8">
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((item) => (
          <div key={item.label} className="rounded-lg border border-fd-border bg-fd-card p-4">
            <div className="text-2xl font-semibold text-fd-foreground">{item.value}</div>
            <div className="mt-1 text-sm font-medium">{item.label}</div>
            <div className="mt-2 text-xs leading-5 text-fd-muted-foreground">{item.detail}</div>
          </div>
        ))}
      </section>

      <section className="rounded-lg border border-fd-border bg-fd-card p-4">
        <div className="mb-4 flex items-center gap-2">
          <CircleDotDashed className="size-4 text-fd-muted-foreground" aria-hidden="true" />
          <h2 className="text-sm font-semibold">Next Phases</h2>
        </div>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {phases.map((phase, index) => (
            <div
              key={phase.title}
              className="rounded-lg border border-fd-border bg-fd-background p-3"
            >
              <div className="mb-3 flex items-center justify-between">
                <phase.icon className="size-4 text-fd-muted-foreground" aria-hidden="true" />
                <span className="text-xs tabular-nums text-fd-muted-foreground">0{index + 1}</span>
              </div>
              <h3 className="text-sm font-semibold">{phase.title}</h3>
              <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">{phase.summary}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="border-b border-fd-border p-4">
          <div className="flex items-center gap-2">
            <Code2 className="size-4 text-fd-muted-foreground" aria-hidden="true" />
            <h2 className="text-sm font-semibold">Component Burn-Down</h2>
          </div>
          <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
            The target is a catalog of existing nteract-owned notebook components. shadcn stays as
            the interaction floor, not the public component identity, and this app should not fork
            production UI while cataloging it.
          </p>
        </div>
        <div className="divide-y divide-fd-border">
          {families.map((item) => (
            <div
              key={item.family}
              className="grid gap-3 p-4 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.2fr)_150px]"
            >
              <div>
                <h3 className="text-sm font-semibold">{item.family}</h3>
                <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">{item.intent}</p>
              </div>
              <div className="min-w-0">
                <div className="text-[11px] font-medium uppercase text-fd-muted-foreground">
                  Current source
                </div>
                <div className="mt-1 break-words font-mono text-xs leading-5 text-fd-muted-foreground [overflow-wrap:anywhere]">
                  {item.source}
                </div>
              </div>
              <div className="flex flex-wrap items-start gap-2 md:flex-col md:items-end">
                <span className="rounded-full border border-fd-border bg-fd-background px-2 py-1 text-xs text-fd-muted-foreground">
                  {item.target}
                </span>
                <span
                  className={[
                    "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-medium",
                    statusClasses[item.status as keyof typeof statusClasses],
                  ].join(" ")}
                >
                  {item.status === "active" ? (
                    <CheckCircle2 className="size-3" aria-hidden="true" />
                  ) : (
                    <CircleDotDashed className="size-3" aria-hidden="true" />
                  )}
                  {statusLabel(item.status as keyof typeof statusClasses)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-3">
        {rules.map((rule) => (
          <div key={rule.title} className="rounded-lg border border-fd-border bg-fd-card p-4">
            <rule.icon className="mb-3 size-4 text-fd-muted-foreground" aria-hidden="true" />
            <h3 className="text-sm font-semibold">{rule.title}</h3>
            <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">{rule.body}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
