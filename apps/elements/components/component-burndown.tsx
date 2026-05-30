import {
  CheckCircle2,
  CircleDotDashed,
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
  { label: "notebook domains", value: "7", detail: "first catalog targets" },
  { label: "component forks", value: "0", detail: "current sources stay canonical" },
  {
    label: "current imports",
    value: "31",
    detail:
      "used shell toolbar, package header, full cells, cell gutter, runtime dialogs and banners, theme, renderer, editor, and widget surfaces",
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
    summary: "ANSI, JSON, image, traceback, MIME priority, and isolated-renderer blockers.",
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
];

const families = [
  {
    family: "Notebook workspace",
    source: "apps/notebook/src/components/{NotebookView,NotebookToolbar,DependencyHeader}.tsx",
    target: "nteract shell",
    status: "active",
    intent:
      "NotebookToolbar renders from current source; the sidebar rail remains a fixture-backed adapter, and its package panel now hosts the current DependencyHeader instead of a catalog-only package list.",
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
    family: "Cell internals",
    source: "src/components/cell/**",
    target: "nteract cells",
    status: "active",
    intent:
      "CellContainer, CompactExecutionButton, and ExecutionCount now render from current source; unused legacy helpers have been removed instead of cataloged.",
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
    source: "src/components/outputs/** + packages/sift/src/react.tsx",
    target: "nteract renderers",
    status: "active",
    intent:
      "AnsiStreamOutput, AnsiErrorOutput, JsonOutput, ImageOutput, TracebackOutput, MIME priority, and SiftTable now render from fixtures; Sift parquet/Arrow URL loading remains an explicit WASM asset adapter boundary.",
  },
  {
    family: "Widgets",
    source: "src/components/widgets/**",
    target: "nteract widgets",
    status: "active",
    intent:
      "WidgetView, WidgetStore, selected built-in controls, unsupported fallback, and static snapshots now render from comm-state fixtures.",
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
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
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
