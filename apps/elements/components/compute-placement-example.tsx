"use client";

import {
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Cloud,
  Layers3,
  Monitor,
  PackageCheck,
  PanelLeft,
  PlayCircle,
  Server,
  TerminalSquare,
  WifiOff,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Eyebrow } from "@/components/surface-primitives";

type ComputePlacementId = "rail" | "environment" | "launcher";

interface ComputePlacement {
  id: ComputePlacementId;
  title: string;
  shortLabel: string;
  icon: LucideIcon;
  stance: string;
  bestFor: string;
  risk: string;
}

const placements = [
  {
    id: "rail",
    title: "Rail target",
    shortLabel: "Rail",
    icon: PanelLeft,
    stance: "Treat compute sources as room-level targets alongside outline and packages.",
    bestFor: "Browsing Local Desktop, registered workstations, and SSH targets before attachment.",
    risk: "The rail can start to feel like it owns runtime authority unless copy stays target-focused.",
  },
  {
    id: "environment",
    title: "Environment group",
    shortLabel: "Environment",
    icon: PackageCheck,
    stance: "Show only the active target's interpreter, kernelspec, packages, and readiness.",
    bestFor: "Explaining the current notebook environment after compute is attached.",
    risk: "Putting all targets here confuses available compute with the current notebook environment.",
  },
  {
    id: "launcher",
    title: "Connect compute",
    shortLabel: "Connect",
    icon: Workflow,
    stance: "Make remote compute a launch/attach flow from notebook chrome.",
    bestFor: "First-run selection, owner-only local compute, provider auth, and SSH key access.",
    risk: "Good for setup, weaker as a persistent place to monitor connected workstations.",
  },
] satisfies readonly ComputePlacement[];

const computeSourceGroups = [
  {
    title: "Local Desktop",
    icon: Monitor,
    security: "Owner only",
    protocol: "local daemon",
    detail:
      "The desktop app can offer its own machine as compute, similar to a local runtime surface. It should not be shared as remote compute for other room participants.",
  },
  {
    title: "Workstations",
    icon: Cloud,
    security: "API registered",
    protocol: "host peer -> runtime_peer",
    detail:
      "Outerbounds and JupyterHub targets register with the hosted API, then attach to a room only after selection.",
  },
  {
    title: "SSH",
    icon: TerminalSquare,
    security: "direct key access",
    protocol: "tunnel bridge",
    detail:
      "The SSH prototype is direct cross-compute access. It behaves like a workstation target, but its trust boundary comes from SSH keys and local Desktop ownership.",
  },
] satisfies Array<{
  title: string;
  icon: LucideIcon;
  security: string;
  protocol: string;
  detail: string;
}>;

const computeTargets = [
  {
    name: "This MacBook",
    provider: "Local Desktop",
    group: "Local Desktop",
    runtime: "Owner-only local Python",
    status: "Ready",
    tone: "ready",
  },
  {
    name: "Forecast GPU",
    provider: "Outerbounds",
    group: "Workstations",
    runtime: "Current Python",
    status: "Ready",
    tone: "ready",
  },
  {
    name: "JupyterLab server",
    provider: "JupyterHub",
    group: "Workstations",
    runtime: "Python 3 kernelspec",
    status: "Online",
    tone: "online",
  },
  {
    name: "Desktop SSH bridge",
    provider: "SSH",
    group: "SSH",
    runtime: "Remote daemon bridge",
    status: "Offline",
    tone: "offline",
  },
] satisfies Array<{
  name: string;
  provider: string;
  group: string;
  runtime: string;
  status: string;
  tone: "ready" | "online" | "offline";
}>;

export function ComputePlacementExample() {
  const [selectedId, setSelectedId] = useState<ComputePlacementId>("rail");
  const selected = placements.find((placement) => placement.id === selectedId) ?? placements[0]!;

  return (
    <div className="not-prose space-y-6" data-elements-slot="compute-placement">
      <section className="grid gap-4 lg:grid-cols-[minmax(16rem,0.42fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-3">
          <div className="inline-flex w-max rounded-md border border-fd-border bg-fd-background p-1">
            {placements.map((placement) => {
              const Icon = placement.icon;
              const active = placement.id === selected.id;
              return (
                <button
                  key={placement.id}
                  type="button"
                  onClick={() => setSelectedId(placement.id)}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors",
                    active
                      ? "bg-fd-foreground text-fd-background"
                      : "text-fd-muted-foreground hover:bg-fd-muted hover:text-fd-foreground",
                  )}
                  aria-pressed={active}
                >
                  <Icon className="size-3.5" aria-hidden="true" />
                  {placement.shortLabel}
                </button>
              );
            })}
          </div>

          <div className="rounded-lg border border-fd-border bg-fd-card p-4">
            <div className="flex items-center gap-2">
              <selected.icon className="size-4 text-fd-muted-foreground" aria-hidden="true" />
              <h2 className="text-sm font-semibold">{selected.title}</h2>
            </div>
            <p className="mt-3 text-sm leading-6 text-fd-muted-foreground">{selected.stance}</p>
            <div className="mt-4 grid gap-3 text-xs leading-5">
              <PlacementFact label="Useful for" value={selected.bestFor} />
              <PlacementFact label="Risk" value={selected.risk} />
            </div>
          </div>
        </div>

        <NotebookComputePreview placement={selected.id} />
      </section>

      <ComputeSourceBoundaryTable />

      <PlacementComparison selectedId={selected.id} onSelect={setSelectedId} />

      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="border-b border-fd-border px-4 py-3">
          <h2 className="text-sm font-semibold">Placement pressure test</h2>
        </div>
        <div className="divide-y divide-fd-border">
          <PressureRow
            question="Is this room state or notebook state?"
            answer="The selected compute target is room state. The current Python or kernelspec is runtime environment state after attachment."
          />
          <PressureRow
            question="Where does launch belong?"
            answer="Launch and provider auth want an explicit connect flow. Persistent monitoring can move into rail or chrome after a target exists."
          />
          <PressureRow
            question="Does this belong with packages?"
            answer="Only the active target's execution environment belongs near packages. The list of possible compute sources does not."
          />
          <PressureRow
            question="Are all compute sources shareable?"
            answer="No. Local Desktop should be owner-only; registered workstations can be room-mediated; SSH follows direct key access and should stay explicit."
          />
        </div>
      </section>
    </div>
  );
}

function PlacementFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-semibold text-fd-foreground">{label}</div>
      <div className="mt-0.5 text-fd-muted-foreground">{value}</div>
    </div>
  );
}

function ComputeSourceBoundaryTable() {
  return (
    <section className="border-y border-fd-border" aria-label="Compute source boundaries">
      <div className="grid gap-2 border-b border-fd-border py-3 md:grid-cols-[minmax(10rem,0.24fr)_minmax(0,1fr)_minmax(8rem,0.18fr)_minmax(10rem,0.22fr)]">
        <h2 className="text-sm font-semibold">Compute source boundaries</h2>
        <Eyebrow className="hidden md:block">Runtime boundary</Eyebrow>
        <Eyebrow className="hidden md:block">Security</Eyebrow>
        <Eyebrow className="hidden md:block">Protocol</Eyebrow>
      </div>
      <div className="divide-y divide-fd-border">
        {computeSourceGroups.map((group) => (
          <ComputeSourceBoundaryRow key={group.title} group={group} />
        ))}
      </div>
    </section>
  );
}

function ComputeSourceBoundaryRow({ group }: { group: (typeof computeSourceGroups)[number] }) {
  const Icon = group.icon;
  return (
    <div className="grid gap-2 py-3 text-sm md:grid-cols-[minmax(10rem,0.24fr)_minmax(0,1fr)_minmax(8rem,0.18fr)_minmax(10rem,0.22fr)]">
      <div className="flex min-w-0 items-center gap-2 font-semibold">
        <Icon className="size-4 shrink-0 text-fd-muted-foreground" aria-hidden="true" />
        <span className="truncate">{group.title}</span>
      </div>
      <p className="text-fd-muted-foreground">{group.detail}</p>
      <BoundaryFact label="Security" value={group.security} />
      <BoundaryFact label="Protocol" value={group.protocol} />
    </div>
  );
}

function BoundaryFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 text-xs">
      <Eyebrow className="md:hidden">{label}</Eyebrow>
      <div className="truncate text-xs font-semibold">{value}</div>
    </div>
  );
}

function PlacementComparison({
  onSelect,
  selectedId,
}: {
  onSelect: (placementId: ComputePlacementId) => void;
  selectedId: ComputePlacementId;
}) {
  return (
    <section className="border-y border-fd-border" aria-label="Placement comparison">
      <div className="grid gap-2 border-b border-fd-border py-3 md:grid-cols-[minmax(10rem,0.26fr)_minmax(0,1fr)]">
        <h2 className="text-sm font-semibold">Placement comparison</h2>
        <Eyebrow className="hidden md:block">Read</Eyebrow>
      </div>
      <div className="divide-y divide-fd-border">
        {placements.map((placement) => (
          <PlacementComparisonRow
            key={placement.id}
            placement={placement}
            selected={placement.id === selectedId}
            onSelect={() => onSelect(placement.id)}
          />
        ))}
      </div>
    </section>
  );
}

function PlacementComparisonRow({
  placement,
  onSelect,
  selected,
}: {
  onSelect: () => void;
  placement: ComputePlacement;
  selected: boolean;
}) {
  const Icon = placement.icon;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "grid w-full min-w-0 gap-2 py-3 text-left text-sm transition-colors md:grid-cols-[minmax(10rem,0.26fr)_minmax(0,1fr)]",
        selected ? "text-fd-foreground" : "text-fd-muted-foreground hover:text-fd-foreground",
      )}
      aria-pressed={selected}
    >
      <span className="flex min-w-0 items-center gap-2 font-semibold">
        <Icon className="size-4 shrink-0 text-fd-muted-foreground" aria-hidden="true" />
        <span className="truncate">{placement.title}</span>
      </span>
      <span className="text-fd-muted-foreground">{placement.bestFor}</span>
    </button>
  );
}

function NotebookComputePreview({ placement }: { placement: ComputePlacementId }) {
  return (
    <section
      className="overflow-hidden rounded-lg border border-fd-border bg-fd-card"
      aria-label="Static compute placement design fixture"
      data-elements-fixture="compute-placement-preview"
    >
      <div className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 border-b border-fd-border bg-fd-muted/20 px-3 py-2 text-[11px] text-fd-muted-foreground">
        <span className="font-semibold uppercase tracking-normal text-fd-foreground">
          Elements fixture
        </span>
        <span className="min-w-0">
          Static mock shell for placement review. The controls inside this frame are illustrative.
        </span>
      </div>
      <div
        className="flex min-h-10 items-center gap-2 border-b border-fd-border px-3 text-xs"
        data-elements-fixture-part="mock-notebook-header"
      >
        <span className="rounded border border-fd-border bg-fd-background px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-normal text-fd-muted-foreground">
          Fixture
        </span>
        <span className="font-semibold">MathNet topic visualization</span>
        <span
          className="ml-auto inline-flex h-7 items-center gap-1 rounded-md bg-fd-foreground px-2 text-fd-background"
          data-elements-fixture-control="run"
        >
          <PlayCircle className="size-3.5" aria-hidden="true" />
          Run
        </span>
      </div>

      <div className="grid min-h-[34rem] bg-fd-background text-fd-foreground lg:grid-cols-[3rem_minmax(15rem,0.42fr)_minmax(0,1fr)]">
        <MockRail active={placement === "rail" ? "compute" : "outline"} />
        <MockPanel placement={placement} />
        <MockNotebookStage placement={placement} />
      </div>
    </section>
  );
}

function MockRail({ active }: { active: "outline" | "compute" }) {
  return (
    <nav className="flex flex-col items-center gap-2 border-r border-fd-border bg-fd-card px-2 py-4">
      <RailButton active={active === "outline"} icon={Layers3} label="Outline" />
      <RailButton active={active === "compute"} icon={Server} label="Compute" />
      <RailButton active={false} icon={PackageCheck} label="Packages" />
    </nav>
  );
}

function RailButton({
  active,
  icon: Icon,
  label,
}: {
  active: boolean;
  icon: LucideIcon;
  label: string;
}) {
  return (
    <div
      className={cn(
        "flex size-8 items-center justify-center rounded-md transition-colors",
        active
          ? "bg-fd-foreground text-fd-background"
          : "text-fd-muted-foreground hover:bg-fd-muted hover:text-fd-foreground",
      )}
      title={label}
      aria-label={label}
      data-elements-fixture-control="rail-button"
    >
      <Icon className="size-4" aria-hidden="true" />
    </div>
  );
}

function MockPanel({ placement }: { placement: ComputePlacementId }) {
  if (placement === "rail") {
    return (
      <aside className="border-r border-fd-border bg-fd-card p-4">
        <PanelHeader label="Compute" detail="Room target" icon={Server} />
        <div className="mt-4 grid gap-2">
          {computeSourceGroups.map((group) => (
            <ComputeTargetGroup key={group.title} group={group.title} />
          ))}
        </div>
      </aside>
    );
  }

  if (placement === "environment") {
    return (
      <aside className="border-r border-fd-border bg-fd-card p-4">
        <PanelHeader label="Environment" detail="Current notebook" icon={PackageCheck} />
        <div className="mt-4 grid gap-3">
          <EnvironmentBlock title="Runtime target" icon={Server}>
            <ComputeTargetRow target={computeTargets[1]!} selected compact />
          </EnvironmentBlock>
          <EnvironmentBlock title="Packages" icon={PackageCheck}>
            <div className="grid gap-1.5 text-xs text-fd-muted-foreground">
              <span>pandas&gt;=2</span>
              <span>polars</span>
              <span>plotly</span>
              <span>scikit-learn</span>
            </div>
          </EnvironmentBlock>
        </div>
      </aside>
    );
  }

  return (
    <aside className="border-r border-fd-border bg-fd-card p-4">
      <PanelHeader label="Notebook" detail="Outline" icon={Layers3} />
      <ol className="mt-4 grid gap-3 text-sm text-fd-muted-foreground">
        <li className="font-medium text-fd-foreground">Load data</li>
        <li>Clean columns</li>
        <li>Explore shape</li>
        <li>Model run</li>
      </ol>
    </aside>
  );
}

function PanelHeader({
  detail,
  icon: Icon,
  label,
}: {
  detail: string;
  icon: LucideIcon;
  label: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 size-4 text-fd-muted-foreground" aria-hidden="true" />
      <div>
        <Eyebrow>{detail}</Eyebrow>
        <h3 className="text-sm font-semibold">{label}</h3>
      </div>
    </div>
  );
}

function EnvironmentBlock({
  children,
  icon: Icon,
  title,
}: {
  children: ReactNode;
  icon: LucideIcon;
  title: string;
}) {
  return (
    <section className="rounded-md border border-fd-border bg-fd-background p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
        <Icon className="size-3.5 text-fd-muted-foreground" aria-hidden="true" />
        {title}
      </div>
      {children}
    </section>
  );
}

function ComputeTargetGroup({ group }: { group: string }) {
  return (
    <section>
      <Eyebrow as="h4" className="mb-1.5">
        {group}
      </Eyebrow>
      <div className="grid gap-1.5">
        {computeTargets
          .filter((target) => target.group === group)
          .map((target) => (
            <ComputeTargetRow
              key={target.name}
              target={target}
              selected={target.name === "Forecast GPU"}
            />
          ))}
      </div>
    </section>
  );
}

function ComputeTargetRow({
  compact = false,
  selected,
  target,
}: {
  compact?: boolean;
  selected: boolean;
  target: (typeof computeTargets)[number];
}) {
  const status = workstationTone(target.tone);
  const StatusIcon = status.icon;
  return (
    <div
      className={cn(
        "grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-2 rounded-md border p-2 text-left",
        selected ? "border-emerald-500/30 bg-emerald-500/10" : "border-fd-border bg-fd-background",
      )}
      data-elements-fixture-control="compute-target"
    >
      <StatusIcon className={cn("mt-0.5 size-3.5", status.className)} aria-hidden="true" />
      <span className="min-w-0">
        <span className="block truncate text-xs font-semibold">{target.name}</span>
        <span className="mt-0.5 block truncate text-[11px] text-fd-muted-foreground">
          {target.provider} · {compact ? target.runtime : target.runtime}
        </span>
      </span>
    </div>
  );
}

function workstationTone(tone: (typeof computeTargets)[number]["tone"]): {
  icon: LucideIcon;
  className: string;
} {
  switch (tone) {
    case "ready":
      return { icon: CheckCircle2, className: "text-emerald-700 dark:text-emerald-300" };
    case "online":
      return { icon: CircleDot, className: "text-blue-700 dark:text-blue-300" };
    case "offline":
      return { icon: WifiOff, className: "text-fd-muted-foreground" };
  }
}

function MockNotebookStage({ placement }: { placement: ComputePlacementId }) {
  return (
    <div className="relative min-w-0 p-5">
      {placement === "launcher" ? <ConnectComputePanel /> : null}
      <div className="mx-auto grid max-w-2xl gap-4">
        <MockCodeCell
          count="12"
          source="orders = pandas.read_csv('orders.csv')"
          output="loaded 2,148 orders"
        />
        <MockCodeCell
          count="13"
          source="orders = clean_columns(orders)"
          output="ready on Forecast GPU"
        />
        <MockCodeCell count="14" source="features.shape" output="(2148, 32)" />
      </div>
    </div>
  );
}

function ConnectComputePanel() {
  return (
    <div className="absolute left-5 right-5 top-5 z-10 mx-auto max-w-xl rounded-lg border border-fd-border bg-fd-card p-4 shadow-lg">
      <div className="flex items-start gap-3">
        <Workflow className="mt-0.5 size-5 text-fd-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Connect compute</h3>
          <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
            Choose a compute source, attach it to this room, then expose execution controls.
          </p>
        </div>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <ProviderButton icon={Monitor} label="Local Desktop" detail="Owner-only local compute" />
        <ProviderButton icon={Server} label="JupyterHub" detail="Launch or select server" />
        <ProviderButton icon={Cloud} label="Outerbounds" detail="Attach workstation" />
        <ProviderButton icon={TerminalSquare} label="SSH" detail="Use direct key access" />
      </div>
    </div>
  );
}

function ProviderButton({
  detail,
  icon: Icon,
  label,
}: {
  detail: string;
  icon: LucideIcon;
  label: string;
}) {
  return (
    <div
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-2 rounded-md border border-fd-border bg-fd-background p-3 text-left hover:bg-fd-muted/40"
      data-elements-fixture-control="provider"
    >
      <Icon className="mt-0.5 size-4 text-fd-muted-foreground" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block truncate text-xs font-semibold">{label}</span>
        <span className="mt-0.5 block truncate text-[11px] text-fd-muted-foreground">{detail}</span>
      </span>
    </div>
  );
}

function MockCodeCell({
  count,
  output,
  source,
}: {
  count: string;
  output: string;
  source: string;
}) {
  return (
    <div className="rounded-md border border-fd-border bg-fd-card p-3 font-mono text-xs">
      <div className="flex gap-2 text-fd-muted-foreground">
        <span>[{count}]</span>
        <span className="text-blue-700 dark:text-blue-300">{source}</span>
      </div>
      <div className="mt-3 border-t border-fd-border pt-2 text-fd-muted-foreground">{output}</div>
    </div>
  );
}

function PressureRow({ answer, question }: { answer: string; question: string }) {
  return (
    <div className="grid gap-2 px-4 py-3 text-sm md:grid-cols-[18rem_minmax(0,1fr)]">
      <div className="flex items-center gap-2 font-semibold">
        <TerminalSquare className="size-4 text-fd-muted-foreground" aria-hidden="true" />
        {question}
      </div>
      <div className="flex items-center gap-2 text-fd-muted-foreground">
        <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
        <span>{answer}</span>
      </div>
    </div>
  );
}
