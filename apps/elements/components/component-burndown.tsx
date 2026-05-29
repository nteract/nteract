import {
  Boxes,
  CheckCircle2,
  CircleDotDashed,
  Code2,
  FileCode2,
  Layers3,
  ListChecks,
  PanelLeft,
  Rows3,
  ShieldCheck,
} from "lucide-react";

const stats = [
  { label: "shadcn primitives", value: "24", detail: "current generic UI floor" },
  { label: "notebook domains", value: "6", detail: "first catalog targets" },
  { label: "old elements imports", value: "0", detail: "inspiration only" },
  { label: "starter examples", value: "2", detail: "outline plus burn-down" },
];

const phases = [
  {
    title: "Catalog the notebook shell",
    state: "active",
    icon: PanelLeft,
    summary: "Left rail, workspace chrome, toolbar, and notebook-level navigation.",
  },
  {
    title: "Promote cell anatomy",
    state: "next",
    icon: Rows3,
    summary: "Markdown, code, raw cells, execution controls, presence, and cell status.",
  },
  {
    title: "Separate renderers",
    state: "next",
    icon: FileCode2,
    summary: "Output frames, MIME routing, isolated renderers, and display metadata.",
  },
  {
    title: "Document runtime surfaces",
    state: "queued",
    icon: ShieldCheck,
    summary: "Trust, dependency headers, kernel errors, and environment decisions.",
  },
];

const families = [
  {
    family: "Notebook workspace",
    source: "apps/notebook/src/components/NotebookView.tsx",
    target: "nteract shell",
    status: "active",
    intent: "Own the reading frame, sidebar rail, scroll handles, and top-level notebook chrome.",
  },
  {
    family: "Cells",
    source: "apps/notebook/src/components/{CodeCell,MarkdownCell,RawCell}.tsx",
    target: "nteract cells",
    status: "next",
    intent: "Extract the cell frame and action surface before changing cell rendering behavior.",
  },
  {
    family: "Cell internals",
    source: "src/components/cell/**",
    target: "nteract cells",
    status: "next",
    intent: "Keep execution count, controls, status, and presence as notebook concepts.",
  },
  {
    family: "Editors",
    source: "src/components/editor/**",
    target: "nteract editor",
    status: "planned",
    intent: "Document CodeMirror wrappers, themes, keymaps, and source-editing affordances.",
  },
  {
    family: "Outputs",
    source: "src/components/outputs/**",
    target: "nteract renderers",
    status: "planned",
    intent:
      "Catalog MIME routing, media frames, text output, errors, and isolated renderer affordances.",
  },
  {
    family: "Widgets",
    source: "src/components/widgets/**",
    target: "nteract widgets",
    status: "planned",
    intent: "Treat widget controls as notebook output components, not generic form widgets.",
  },
  {
    family: "Runtime decisions",
    source: "apps/notebook/src/components/*Dialog.tsx",
    target: "nteract runtime",
    status: "planned",
    intent: "Make trust, environment, and launch decisions reusable catalog examples.",
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
    title: "Own notebook semantics",
    icon: ListChecks,
    body: "If a component knows about cells, outputs, kernels, trust, packages, variables, or notebook navigation, it belongs in the nteract catalog.",
  },
  {
    title: "Wrap generic interactions",
    icon: Layers3,
    body: "Use shadcn primitives as implementation details behind domain names such as CellAction, RuntimeDialog, or NotebookRailButton.",
  },
  {
    title: "Leave primitives generic",
    icon: Boxes,
    body: "Button, Select, Sheet, Popover, and similar controls should stay low-level until the notebook use case gives them a real contract.",
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
        <div className="grid gap-3 md:grid-cols-4">
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
            The target is a catalog of nteract-owned notebook components. shadcn stays as the
            interaction floor, not the public component identity.
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
