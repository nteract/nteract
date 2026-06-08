import {
  CircleAlert,
  CircleCheck,
  Cloud,
  Cpu,
  FolderOpen,
  MemoryStick,
  Monitor,
  PlugZap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  projectNotebookWorkstationPanel,
  type NotebookShellCapabilities,
  type NotebookShellAccessSource,
  type NotebookWorkstationFactProjection,
  type NotebookWorkstationPanelTone,
  type NotebookWorkstationSelectionProjection,
} from "./capabilities";
import { cn } from "@/lib/utils";

export interface NotebookWorkstationsPanelProps {
  capabilities: NotebookShellCapabilities;
  selection?: NotebookWorkstationSelectionProjection | null;
  className?: string;
}

export function NotebookWorkstationsPanel({
  capabilities,
  selection = null,
  className,
}: NotebookWorkstationsPanelProps) {
  const projection = projectNotebookWorkstationPanel(capabilities);
  const status = workstationStatusTone(projection.tone);
  const showRegistrationPrompt = selection?.state === "needs_registration";

  return (
    <div className={cn("space-y-3 text-sm", className)} data-testid="notebook-workstations-panel">
      <section
        className={cn("border-l-2 py-1.5 pl-3 pr-1", status.panelClassName)}
        aria-label="Active workstation target"
      >
        <div className="flex min-w-0 items-start gap-3">
          <status.icon
            className={cn("mt-0.5 size-4 shrink-0", status.iconClassName)}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            {projection.targetId ? (
              <div className="mb-0.5 truncate font-mono text-[10.5px] tracking-normal text-muted-foreground">
                {projection.targetId}
              </div>
            ) : null}
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="truncate text-sm font-semibold">{projection.title}</h3>
              <span className={cn("shrink-0 text-xs font-medium", status.textClassName)}>
                {projection.statusLabel}
              </span>
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="truncate">{projection.providerLabel}</span>
              <span className="truncate">{projection.defaultEnvironmentLabel}</span>
            </div>
            {projection.detail ? (
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{projection.detail}</p>
            ) : null}
          </div>
        </div>
      </section>

      <section
        className="flex min-w-0 flex-wrap gap-x-3 gap-y-1.5 text-xs"
        aria-label="Workstation resources"
      >
        {projection.facts.map((fact) => (
          <WorkstationFact
            key={fact.kind}
            fact={fact}
            icon={workstationFactIcon(fact, projection.source)}
          />
        ))}
      </section>

      {showRegistrationPrompt ? (
        <section
          className="rounded-md border border-dashed border-border/80 px-3 py-2 text-xs"
          aria-label="Workstation setup"
          data-testid="workstation-registration-empty"
        >
          <div className="flex min-w-0 items-center gap-2 font-medium text-foreground">
            <PlugZap className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span>No workstations yet</span>
          </div>
          <p className="mt-1 leading-5 text-muted-foreground">
            Register a workstation to make this notebook runnable from your compute.
          </p>
        </section>
      ) : null}
    </div>
  );
}

export function notebookWorkstationsSummary(capabilities: NotebookShellCapabilities): string {
  return projectNotebookWorkstationPanel(capabilities).summary;
}

function WorkstationFact({
  fact,
  icon: Icon,
}: {
  fact: NotebookWorkstationFactProjection;
  icon: LucideIcon;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", fact.subtle && "opacity-80")}>
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="shrink-0 text-muted-foreground">{fact.label}</span>
      <span className="min-w-0 truncate font-medium text-foreground">{fact.value}</span>
    </span>
  );
}

function workstationStatusTone(tone: NotebookWorkstationPanelTone): {
  icon: LucideIcon;
  iconClassName: string;
  panelClassName: string;
  textClassName: string;
} {
  if (tone === "ready") {
    return {
      icon: CircleCheck,
      iconClassName: "text-emerald-700 dark:text-emerald-300",
      panelClassName: "border-emerald-500/70 bg-emerald-500/[0.04]",
      textClassName: "text-emerald-700 dark:text-emerald-300",
    };
  }
  if (tone === "available") {
    return {
      icon: Cpu,
      iconClassName: "text-sky-700 dark:text-sky-300",
      panelClassName: "border-sky-500/70 bg-sky-500/[0.04]",
      textClassName: "text-sky-700 dark:text-sky-300",
    };
  }

  return {
    icon: CircleAlert,
    iconClassName: "text-muted-foreground",
    panelClassName: "border-border bg-muted/[0.03]",
    textClassName: "text-muted-foreground",
  };
}

function workstationSourceIcon(source: NotebookShellAccessSource): LucideIcon {
  switch (source) {
    case "local":
      return Monitor;
    case "cloud":
      return Cloud;
    case "fixture":
      return Cpu;
    default:
      return Cpu;
  }
}

function workstationFactIcon(
  fact: NotebookWorkstationFactProjection,
  source: NotebookShellAccessSource,
): LucideIcon {
  switch (fact.kind) {
    case "provider":
      return workstationSourceIcon(source);
    case "kernel":
      return Cpu;
    case "memory":
      return MemoryStick;
    case "working_directory":
      return FolderOpen;
    case "runtime_peers":
      return Cloud;
    case "execution_state":
      return fact.tone === "positive" ? CircleCheck : CircleAlert;
    case "remote_hint":
      return Cloud;
    default:
      return Cpu;
  }
}
