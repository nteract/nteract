import {
  Box,
  Braces,
  ChevronLeft,
  ChevronRight,
  Circle,
  FileText,
  Hash,
  Layers3,
  ListTree,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Search,
  Settings2,
  TerminalSquare,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

type VariantKey = "A" | "B" | "C";
type PanelKey = "outline" | "packages" | "variables";

interface OutlineItem {
  id: string;
  level: 1 | 2 | 3;
  title: string;
  cellLabel: string;
  estimatedProgress: number;
}

interface NotebookCell {
  id: string;
  kind: "markdown" | "code";
  title?: string;
  source: string[];
  output?: string[];
}

interface VariableItem {
  name: string;
  type: string;
  value: string;
}

interface PackageItem {
  name: string;
  version: string;
  state: "ready" | "pending" | "project";
}

const variants: Array<{ key: VariantKey; label: string }> = [
  { key: "A", label: "Rail outline" },
  { key: "B", label: "Inspector panel" },
  { key: "C", label: "Reader map" },
];

const outlineItems: OutlineItem[] = [
  {
    id: "intro",
    level: 1,
    title: "Sales Forecast Readthrough",
    cellLabel: "md 1",
    estimatedProgress: 6,
  },
  {
    id: "inputs",
    level: 2,
    title: "Inputs and Assumptions",
    cellLabel: "md 3",
    estimatedProgress: 19,
  },
  {
    id: "cleaning",
    level: 2,
    title: "Cleaning Pipeline",
    cellLabel: "md 6",
    estimatedProgress: 34,
  },
  { id: "model", level: 2, title: "Model Fit", cellLabel: "md 10", estimatedProgress: 58 },
  {
    id: "diagnostics",
    level: 3,
    title: "Residual Diagnostics",
    cellLabel: "md 13",
    estimatedProgress: 72,
  },
  { id: "next", level: 2, title: "Next Actions", cellLabel: "md 16", estimatedProgress: 88 },
];

const packageItems: PackageItem[] = [
  { name: "pandas", version: "2.3.1", state: "ready" },
  { name: "numpy", version: "2.4.0", state: "ready" },
  { name: "scikit-learn", version: "1.9.0", state: "pending" },
  { name: "plotly", version: "6.1.2", state: "project" },
];

const variableItems: VariableItem[] = [
  { name: "raw_orders", type: "DataFrame", value: "18,240 rows x 14 columns" },
  { name: "features", type: "DataFrame", value: "18,240 rows x 32 columns" },
  { name: "model", type: "Pipeline", value: "StandardScaler -> Ridge" },
  { name: "mae", type: "float", value: "8.42" },
];

const notebookCells: NotebookCell[] = [
  {
    id: "intro",
    kind: "markdown",
    title: "Sales Forecast Readthrough",
    source: [
      "This notebook explains the current monthly forecast and the checks used before publishing it.",
      "The left navigation should help a reader move through the story without touching execution controls.",
    ],
  },
  {
    id: "setup",
    kind: "code",
    source: [
      "import pandas as pd",
      "from sklearn.pipeline import Pipeline",
      "from sklearn.linear_model import Ridge",
    ],
    output: ["Python 3.13 · uv:inline · kernel idle"],
  },
  {
    id: "inputs",
    kind: "markdown",
    title: "Inputs and Assumptions",
    source: [
      "The model starts from order history, calendar features, and a small hand-maintained promotions sheet.",
      "Promotions remain the highest variance input.",
    ],
  },
  {
    id: "cleaning",
    kind: "markdown",
    title: "Cleaning Pipeline",
    source: [
      "Source data is normalized into weekly buckets, then joined with fiscal calendar and event windows.",
    ],
  },
  {
    id: "model",
    kind: "code",
    source: ["pipeline.fit(features, target)", "predictions = pipeline.predict(features_holdout)"],
    output: ["MAE 8.42", "MAPE 6.8%", "Backtest window: 16 weeks"],
  },
  {
    id: "diagnostics",
    kind: "markdown",
    title: "Residual Diagnostics",
    source: [
      "Residuals are centered overall, but the northwest segment still shows a persistent holiday spike.",
    ],
  },
  {
    id: "next",
    kind: "markdown",
    title: "Next Actions",
    source: [
      "Review the promotion source, rerun the forecast, and publish the summary to the operating dashboard.",
    ],
  },
];

function coerceVariant(value: string | null): VariantKey {
  return value === "B" || value === "C" ? value : "A";
}

function useUrlVariant() {
  const [variant, setVariantState] = useState<VariantKey>(() =>
    coerceVariant(new URLSearchParams(window.location.search).get("variant")),
  );

  const setVariant = useCallback((next: VariantKey) => {
    const url = new URL(window.location.href);
    url.searchParams.set("variant", next);
    window.history.replaceState(null, "", url);
    setVariantState(next);
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      setVariantState(coerceVariant(new URLSearchParams(window.location.search).get("variant")));
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  return [variant, setVariant] as const;
}

function usePrototypeState() {
  const [activePanel, setActivePanel] = useState<PanelKey>("outline");
  const [activeHeading, setActiveHeading] = useState("inputs");
  const [sidebarOpen, setSidebarOpen] = useState(true);

  return {
    activePanel,
    setActivePanel,
    activeHeading,
    setActiveHeading,
    sidebarOpen,
    setSidebarOpen,
  };
}

function ActivityButton({
  icon: Icon,
  label,
  selected,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "flex h-9 w-9 items-center justify-center rounded text-muted-foreground transition-colors",
        "hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        selected && "bg-foreground text-background hover:bg-foreground hover:text-background",
      )}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

function OutlineList({
  activeHeading,
  onSelect,
  dense = false,
}: {
  activeHeading: string;
  onSelect: (id: string) => void;
  dense?: boolean;
}) {
  return (
    <div className={cn("flex flex-col", dense ? "gap-0.5" : "gap-1")}>
      {outlineItems.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onSelect(item.id)}
          className={cn(
            "group grid grid-cols-[1fr_auto] items-start gap-2 rounded px-2 py-1.5 text-left transition-colors",
            "hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            item.level === 2 && "ml-3",
            item.level === 3 && "ml-6",
            activeHeading === item.id && "bg-muted text-foreground",
          )}
        >
          <span
            className={cn(
              "min-w-0 truncate text-xs",
              item.level === 1 ? "font-semibold text-foreground" : "text-muted-foreground",
              activeHeading === item.id && "text-foreground",
            )}
          >
            {item.title}
          </span>
          <span className="text-[10px] tabular-nums text-muted-foreground/70">
            {item.cellLabel}
          </span>
        </button>
      ))}
    </div>
  );
}

function PackagePanel() {
  return (
    <div className="space-y-2">
      {packageItems.map((pkg) => (
        <div
          key={pkg.name}
          className="flex items-center justify-between gap-3 rounded border px-2 py-1.5"
        >
          <div className="min-w-0">
            <div className="truncate font-mono text-xs text-foreground">{pkg.name}</div>
            <div className="text-[10px] text-muted-foreground">{pkg.version}</div>
          </div>
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-medium",
              pkg.state === "ready" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
              pkg.state === "pending" && "bg-amber-500/10 text-amber-700 dark:text-amber-400",
              pkg.state === "project" && "bg-sky-500/10 text-sky-700 dark:text-sky-400",
            )}
          >
            {pkg.state}
          </span>
        </div>
      ))}
    </div>
  );
}

function VariablesPanel() {
  return (
    <div className="space-y-2">
      {variableItems.map((variable) => (
        <div key={variable.name} className="rounded border px-2 py-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate font-mono text-xs text-foreground">
              {variable.name}
            </span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {variable.type}
            </span>
          </div>
          <div className="mt-1 truncate text-[11px] text-muted-foreground">{variable.value}</div>
        </div>
      ))}
    </div>
  );
}

function NotebookCellView({ cell, active }: { cell: NotebookCell; active: boolean }) {
  return (
    <section
      className={cn(
        "grid grid-cols-[2.5rem_minmax(0,1fr)] gap-3 border-l-2 py-3 pr-3 transition-colors",
        active ? "border-sky-500 bg-sky-500/[0.04]" : "border-transparent",
      )}
      data-cell-id={cell.id}
    >
      <div className="flex justify-end pt-1 font-mono text-[10px] text-muted-foreground">
        {cell.kind === "code" ? "In" : "md"}
      </div>
      <div className="min-w-0">
        {cell.title && (
          <h2 className="mb-2 text-base font-semibold text-foreground">{cell.title}</h2>
        )}
        <div
          className={cn(
            "rounded border px-3 py-2",
            cell.kind === "code" ? "bg-muted/70 font-mono text-xs" : "bg-background text-sm",
          )}
        >
          {cell.source.map((line) => (
            <p key={line} className="leading-6 text-foreground">
              {line}
            </p>
          ))}
        </div>
        {cell.output && (
          <div className="mt-2 rounded border bg-emerald-500/[0.04] px-3 py-2 font-mono text-xs text-emerald-800 dark:text-emerald-300">
            {cell.output.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function MockNotebook({
  activeHeading,
  compact = false,
}: {
  activeHeading: string;
  compact?: boolean;
}) {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-background">
      <div className={cn("mx-auto w-full py-4", compact ? "max-w-3xl px-4" : "max-w-4xl px-6")}>
        {notebookCells.map((cell) => (
          <NotebookCellView key={cell.id} cell={cell} active={cell.id === activeHeading} />
        ))}
      </div>
    </main>
  );
}

function TopNotebookBar({ title = "forecast_readthrough.ipynb" }: { title?: string }) {
  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b bg-background/95 px-3">
      <button
        type="button"
        className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        title="Run all cells"
        aria-label="Run all cells"
      >
        <Play className="h-3.5 w-3.5" />
      </button>
      <div className="h-4 w-px bg-border" />
      <div className="min-w-0 truncate text-xs font-medium text-foreground">{title}</div>
      <div className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground">
        <Circle className="h-2 w-2 fill-emerald-500 text-emerald-500" />
        Python · idle
      </div>
    </header>
  );
}

function VariantA({
  activePanel,
  setActivePanel,
  activeHeading,
  setActiveHeading,
  sidebarOpen,
  setSidebarOpen,
}: ReturnType<typeof usePrototypeState>) {
  return (
    <div className="flex h-full bg-background text-foreground">
      <aside className="flex w-12 shrink-0 flex-col items-center gap-1 border-r bg-muted/30 py-2">
        <ActivityButton
          icon={ListTree}
          label="Outline"
          selected={activePanel === "outline"}
          onClick={() => {
            setActivePanel("outline");
            setSidebarOpen(true);
          }}
        />
        <ActivityButton
          icon={Box}
          label="Packages"
          selected={activePanel === "packages"}
          onClick={() => {
            setActivePanel("packages");
            setSidebarOpen(true);
          }}
        />
        <ActivityButton
          icon={Braces}
          label="Variables"
          selected={activePanel === "variables"}
          onClick={() => {
            setActivePanel("variables");
            setSidebarOpen(true);
          }}
        />
        <div className="mt-auto">
          <ActivityButton
            icon={sidebarOpen ? PanelLeftClose : PanelLeftOpen}
            label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
            selected={false}
            onClick={() => setSidebarOpen(!sidebarOpen)}
          />
        </div>
      </aside>
      {sidebarOpen && (
        <aside className="flex w-64 shrink-0 flex-col border-r bg-background">
          <div className="border-b px-3 py-2">
            <div className="text-xs font-semibold text-foreground">
              {activePanel === "outline" && "Outline"}
              {activePanel === "packages" && "Packages"}
              {activePanel === "variables" && "Variables"}
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground">
              {activePanel === "outline" && `${outlineItems.length} headings`}
              {activePanel === "packages" && `${packageItems.length} packages`}
              {activePanel === "variables" && `${variableItems.length} live names`}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {activePanel === "outline" && (
              <OutlineList activeHeading={activeHeading} onSelect={setActiveHeading} />
            )}
            {activePanel === "packages" && <PackagePanel />}
            {activePanel === "variables" && <VariablesPanel />}
          </div>
        </aside>
      )}
      <section className="flex min-w-0 flex-1 flex-col">
        <TopNotebookBar />
        <MockNotebook activeHeading={activeHeading} />
      </section>
    </div>
  );
}

function VariantB({
  activePanel,
  setActivePanel,
  activeHeading,
  setActiveHeading,
}: ReturnType<typeof usePrototypeState>) {
  const tabs: Array<{ key: PanelKey; icon: LucideIcon; label: string }> = [
    { key: "outline", icon: Hash, label: "Outline" },
    { key: "packages", icon: Box, label: "Packages" },
    { key: "variables", icon: Braces, label: "Variables" },
  ];

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <TopNotebookBar title="forecast_readthrough.ipynb · read mode" />
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-80 shrink-0 flex-col border-r bg-muted/20">
          <div className="flex items-center gap-1 border-b p-2">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActivePanel(tab.key)}
                title={tab.label}
                aria-label={tab.label}
                className={cn(
                  "flex h-8 flex-1 items-center justify-center rounded text-muted-foreground transition-colors",
                  "hover:bg-background hover:text-foreground",
                  activePanel === tab.key && "bg-background text-foreground shadow-sm",
                )}
              >
                <tab.icon className="h-4 w-4" />
              </button>
            ))}
          </div>
          <div className="border-b p-3">
            <div className="flex items-center gap-2 rounded border bg-background px-2 py-1.5 text-muted-foreground">
              <Search className="h-3.5 w-3.5" />
              <span className="text-xs">Search headings, packages, variables</span>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {activePanel === "outline" && (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-2">
                  <Metric label="Cells" value="17" />
                  <Metric label="Heads" value="6" />
                  <Metric label="Run" value="Idle" />
                </div>
                <OutlineList activeHeading={activeHeading} onSelect={setActiveHeading} />
              </div>
            )}
            {activePanel === "packages" && <PackagePanel />}
            {activePanel === "variables" && <VariablesPanel />}
          </div>
        </aside>
        <MockNotebook activeHeading={activeHeading} compact />
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border bg-background px-2 py-1.5">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="truncate text-xs font-semibold text-foreground">{value}</div>
    </div>
  );
}

function VariantC({ activeHeading, setActiveHeading }: ReturnType<typeof usePrototypeState>) {
  return (
    <div className="grid h-full grid-cols-[18rem_minmax(0,1fr)] bg-background text-foreground">
      <aside className="flex min-h-0 flex-col border-r bg-zinc-950 text-zinc-100 dark:bg-zinc-950">
        <div className="border-b border-white/10 p-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <FileText className="h-4 w-4 text-sky-300" />
            forecast_readthrough
          </div>
          <div className="mt-1 text-[11px] text-zinc-400">Reader map · Python idle</div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="mb-3 grid grid-cols-3 gap-1.5">
            <Pill icon={Layers3} label="17 cells" />
            <Pill icon={TerminalSquare} label="4 runs" />
            <Pill icon={Settings2} label="uv" />
          </div>
          <div className="relative h-[30rem] rounded border border-white/10 bg-white/[0.03]">
            <div className="absolute inset-y-4 left-6 w-px bg-white/15" />
            {outlineItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveHeading(item.id)}
                className={cn(
                  "absolute left-3 right-3 flex items-center gap-2 rounded px-2 py-1 text-left transition-colors",
                  "hover:bg-white/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-300",
                  activeHeading === item.id && "bg-sky-400/20 text-sky-100",
                )}
                style={{ top: `${item.estimatedProgress}%` }}
              >
                <span
                  className={cn(
                    "h-2.5 w-2.5 shrink-0 rounded-full border border-white/40 bg-zinc-950",
                    activeHeading === item.id && "border-sky-200 bg-sky-300",
                  )}
                />
                <span className="min-w-0 truncate text-xs">{item.title}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="border-t border-white/10 p-3">
          <div className="grid grid-cols-2 gap-2">
            <DarkSummary label="Packages" value="3 ready · 1 pending" />
            <DarkSummary label="Variables" value="4 names" />
          </div>
        </div>
      </aside>
      <section className="flex min-w-0 flex-col">
        <header className="flex h-12 shrink-0 items-center border-b px-5">
          <div className="text-sm font-semibold text-foreground">
            {outlineItems.find((item) => item.id === activeHeading)?.title ?? "Notebook"}
          </div>
          <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
            <span>Outline synced to focus</span>
            <span className="rounded bg-emerald-500/10 px-2 py-1 text-emerald-700 dark:text-emerald-400">
              Ready
            </span>
          </div>
        </header>
        <MockNotebook activeHeading={activeHeading} />
      </section>
    </div>
  );
}

function Pill({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1 rounded bg-white/10 px-1.5 py-1 text-[10px] text-zinc-300">
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </div>
  );
}

function DarkSummary({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded border border-white/10 bg-white/[0.03] px-2 py-1.5">
      <div className="text-[10px] text-zinc-500">{label}</div>
      <div className="truncate text-[11px] text-zinc-200">{value}</div>
    </div>
  );
}

function PrototypeSwitcher({
  variant,
  onChange,
  state,
}: {
  variant: VariantKey;
  onChange: (variant: VariantKey) => void;
  state: ReturnType<typeof usePrototypeState>;
}) {
  const currentIndex = variants.findIndex((item) => item.key === variant);
  const current = variants[currentIndex] ?? variants[0];
  const move = useCallback(
    (delta: number) => {
      const next = variants[(currentIndex + delta + variants.length) % variants.length];
      onChange(next.key);
    },
    [currentIndex, onChange],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement) {
        const tag = event.target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || event.target.isContentEditable) return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        move(-1);
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        move(1);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [move]);

  if (import.meta.env.PROD) return null;

  return (
    <div className="fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <div className="flex max-w-full items-center gap-2 rounded-full border bg-zinc-950 px-2 py-1 text-white shadow-xl">
        <button
          type="button"
          onClick={() => move(-1)}
          className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-300 hover:bg-white/10 hover:text-white"
          title="Previous variant"
          aria-label="Previous variant"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 px-2 text-center">
          <div className="truncate text-xs font-semibold">
            {current.key} - {current.label}
          </div>
          <div className="truncate text-[10px] text-zinc-400">
            panel={state.activePanel} · heading={state.activeHeading} · sidebar=
            {state.sidebarOpen ? "open" : "closed"}
          </div>
        </div>
        <button
          type="button"
          onClick={() => move(1)}
          className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-300 hover:bg-white/10 hover:text-white"
          title="Next variant"
          aria-label="Next variant"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export function SidebarTocPrototype() {
  const [variant, setVariant] = useUrlVariant();
  const state = usePrototypeState();
  const content = useMemo(() => {
    if (variant === "B") return <VariantB {...state} />;
    if (variant === "C") return <VariantC {...state} />;
    return <VariantA {...state} />;
  }, [state, variant]);

  return (
    <div className="h-full overflow-hidden bg-background">
      {content}
      <PrototypeSwitcher variant={variant} onChange={setVariant} state={state} />
    </div>
  );
}
