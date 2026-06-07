import { CircleAlert, CircleCheck, Cloud, Cpu, Monitor, UserRound } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  NotebookShellCapabilities,
  NotebookShellRuntimeTargetProjection,
} from "./capabilities";
import { cn } from "@/lib/utils";

export interface NotebookWorkstationsPanelProps {
  capabilities: NotebookShellCapabilities;
  className?: string;
}

export function NotebookWorkstationsPanel({
  capabilities,
  className,
}: NotebookWorkstationsPanelProps) {
  const target = capabilities.runtime.target ?? fallbackRuntimeTarget(capabilities);
  const status = workstationStatus(capabilities, target);
  const source = workstationSource(capabilities.runtime.source);
  const principalLabel =
    capabilities.runtime.actor?.principal.label ??
    capabilities.access.actor?.principal.label ??
    capabilities.runtime.identityLabel ??
    capabilities.access.identityLabel ??
    source.defaultPrincipalLabel;
  const operatorLabel =
    capabilities.runtime.actor?.operator.label ??
    (target.kind === "local_daemon"
      ? "Local daemon"
      : capabilities.runtime.connected
        ? "Runtime"
        : "Not attached");
  const runtimeLabel = target.environmentLabel ?? runtimeResourceLabel(capabilities, target);
  const capabilityLabel = runtimeCapabilityLabel(capabilities);

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
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="truncate text-sm font-semibold">{status.title}</h3>
              <span className={cn("shrink-0 text-xs font-medium", status.textClassName)}>
                {status.badge}
              </span>
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="truncate">{target.providerLabel ?? source.label}</span>
              <span className="truncate">{runtimeLabel}</span>
            </div>
            {status.detail ? (
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{status.detail}</p>
            ) : null}
          </div>
        </div>
      </section>

      <section
        className="flex min-w-0 flex-wrap gap-x-3 gap-y-1.5 text-xs"
        aria-label="Workstation resources"
      >
        <WorkstationFact
          icon={source.icon}
          label="Provider"
          value={target.providerLabel ?? source.label}
        />
        <WorkstationFact icon={Cpu} label="Runtime" value={runtimeLabel} />
        <WorkstationFact icon={UserRound} label="Principal" value={principalLabel} />
        <WorkstationFact
          icon={capabilities.runtime.canWriteRuntimeState ? CircleCheck : CircleAlert}
          label="State"
          value={capabilityLabel}
        />
        <WorkstationFact icon={Cpu} label="Operator" value={operatorLabel} subtle />
        {target.kind === "local_daemon" ? (
          <WorkstationFact icon={Cloud} label="Remote" value="Coming soon" subtle />
        ) : null}
      </section>
    </div>
  );
}

function WorkstationFact({
  icon: Icon,
  label,
  subtle = false,
  value,
}: {
  icon: LucideIcon;
  label: string;
  subtle?: boolean;
  value: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", subtle && "opacity-80")}>
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate font-medium text-foreground">{value}</span>
    </span>
  );
}

function workstationStatus(
  capabilities: NotebookShellCapabilities,
  target: NotebookShellRuntimeTargetProjection,
): {
  title: string;
  detail: string;
  badge: string;
  icon: LucideIcon;
  iconClassName: string;
  panelClassName: string;
  textClassName: string;
} {
  if (capabilities.runtime.executionAvailable && capabilities.canExecute) {
    return {
      title: target.kind === "local_daemon" ? target.label : `${target.label} ready`,
      detail: target.detail ?? "Execution requests are enabled for this notebook.",
      badge: target.statusLabel ?? "Ready",
      icon: CircleCheck,
      iconClassName: "text-emerald-700 dark:text-emerald-300",
      panelClassName: "border-emerald-500/70 bg-emerald-500/[0.04]",
      textClassName: "text-emerald-700 dark:text-emerald-300",
    };
  }
  if (capabilities.runtime.executionAvailable) {
    return {
      title: `${target.label} available`,
      detail: "A runtime is available, but this connection cannot request execution.",
      badge: target.statusLabel ?? "Limited",
      icon: Cpu,
      iconClassName: "text-sky-700 dark:text-sky-300",
      panelClassName: "border-sky-500/70 bg-sky-500/[0.04]",
      textClassName: "text-sky-700 dark:text-sky-300",
    };
  }
  if (capabilities.runtime.connected) {
    return {
      title: `${target.label} attached`,
      detail: target.detail ?? "Runtime state is connected without executable cell controls.",
      badge: target.statusLabel ?? "Attached",
      icon: Cpu,
      iconClassName: "text-sky-700 dark:text-sky-300",
      panelClassName: "border-sky-500/70 bg-sky-500/[0.04]",
      textClassName: "text-sky-700 dark:text-sky-300",
    };
  }

  return {
    title: capabilities.runtime.source === "local" ? `${target.label} unavailable` : target.label,
    detail:
      target.detail ??
      (capabilities.runtime.source === "local"
        ? "The local daemon is not exposing an executable runtime."
        : "No runtime peer is attached to this room."),
    badge: target.statusLabel ?? "Offline",
    icon: CircleAlert,
    iconClassName: "text-muted-foreground",
    panelClassName: "border-border bg-muted/[0.03]",
    textClassName: "text-muted-foreground",
  };
}

function runtimeResourceLabel(
  capabilities: NotebookShellCapabilities,
  target: NotebookShellRuntimeTargetProjection,
): string {
  if (target.kind === "local_daemon") {
    return capabilities.runtime.executionAvailable ? "Notebook runtime" : "Unavailable";
  }
  if (target.kind === "runtime_peer") {
    return "Runtime peer";
  }
  if (capabilities.runtime.executionAvailable) {
    return "Current Python";
  }
  return "Not attached";
}

function runtimeCapabilityLabel(capabilities: NotebookShellCapabilities): string {
  if (capabilities.runtime.executionAvailable && capabilities.canExecute) {
    return "Can run";
  }
  if (capabilities.runtime.executionAvailable) {
    return "View only";
  }
  if (capabilities.runtime.canWriteRuntimeState) {
    return "Runtime state";
  }
  return "Not runnable";
}

function fallbackRuntimeTarget(
  capabilities: NotebookShellCapabilities,
): NotebookShellRuntimeTargetProjection {
  const source = workstationSource(capabilities.runtime.source);
  if (capabilities.runtime.source === "local") {
    return {
      kind: "local_daemon",
      status: capabilities.runtime.executionAvailable ? "ready" : "offline",
      label: "This machine",
      statusLabel: capabilities.runtime.executionAvailable ? "Ready" : "Offline",
      providerLabel: source.label,
      environmentLabel: capabilities.runtime.executionAvailable
        ? "Notebook runtime"
        : "Unavailable",
    };
  }
  if (capabilities.runtime.connected) {
    return {
      kind: "runtime_peer",
      status: capabilities.runtime.executionAvailable ? "ready" : "attached",
      label: "Runtime peer",
      statusLabel: capabilities.runtime.executionAvailable ? "Ready" : "Attached",
      providerLabel: source.label,
      environmentLabel: "Runtime peer",
    };
  }
  return {
    kind: capabilities.runtime.source === "fixture" ? "fixture" : "unknown",
    status: "offline",
    label:
      capabilities.runtime.source === "cloud" ? "No workstation attached" : "No runtime target",
    statusLabel: "Offline",
    providerLabel: source.label,
    environmentLabel: "Not attached",
  };
}

function workstationSource(source: NotebookShellCapabilities["runtime"]["source"]): {
  label: string;
  defaultPrincipalLabel: string;
  icon: LucideIcon;
} {
  switch (source) {
    case "local":
      return {
        label: "Local",
        defaultPrincipalLabel: "Local principal",
        icon: Monitor,
      };
    case "cloud":
      return {
        label: "Cloud",
        defaultPrincipalLabel: "Room principal",
        icon: Cloud,
      };
    case "fixture":
      return {
        label: "Fixture",
        defaultPrincipalLabel: "Fixture principal",
        icon: Cpu,
      };
    default:
      return {
        label: "Unknown",
        defaultPrincipalLabel: "Unknown principal",
        icon: Cpu,
      };
  }
}
