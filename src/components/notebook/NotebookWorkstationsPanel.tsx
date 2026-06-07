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

  return (
    <div className={cn("space-y-3", className)} data-testid="notebook-workstations-panel">
      <section className="rounded-md border bg-muted/20 p-3">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-md border",
              status.iconClassName,
            )}
          >
            <status.icon className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <h3 className="truncate text-sm font-semibold">{status.title}</h3>
              <span
                className={cn(
                  "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                  status.badgeClassName,
                )}
              >
                {status.badge}
              </span>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{status.detail}</p>
          </div>
        </div>
      </section>

      <section className="space-y-2" aria-label="Runtime attachment details">
        <WorkstationDetail icon={source.icon} label="Target" value={target.label} />
        <WorkstationDetail
          icon={source.icon}
          label="Provider"
          value={target.providerLabel ?? source.label}
        />
        <WorkstationDetail icon={UserRound} label="Principal" value={principalLabel} />
        <WorkstationDetail icon={Cpu} label="Operator" value={operatorLabel} />
        <WorkstationDetail
          icon={capabilities.runtime.canWriteRuntimeState ? CircleCheck : CircleAlert}
          label="Runtime state"
          value={capabilities.runtime.canWriteRuntimeState ? "Writable" : "Read-only"}
        />
      </section>
    </div>
  );
}

function WorkstationDetail({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-2 text-xs">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate text-right font-medium text-foreground">
        {value}
      </span>
    </div>
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
  badgeClassName: string;
} {
  if (capabilities.runtime.executionAvailable && capabilities.canExecute) {
    return {
      title: target.kind === "local_daemon" ? target.label : `${target.label} ready`,
      detail: target.detail ?? "Execution requests are enabled for this notebook.",
      badge: target.statusLabel ?? "Ready",
      icon: CircleCheck,
      iconClassName: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700",
      badgeClassName: "bg-emerald-500/10 text-emerald-700",
    };
  }
  if (capabilities.runtime.executionAvailable) {
    return {
      title: `${target.label} available`,
      detail: "A runtime is available, but this connection cannot request execution.",
      badge: target.statusLabel ?? "Limited",
      icon: Cpu,
      iconClassName: "border-sky-500/30 bg-sky-500/10 text-sky-700",
      badgeClassName: "bg-sky-500/10 text-sky-700",
    };
  }
  if (capabilities.runtime.connected) {
    return {
      title: `${target.label} attached`,
      detail: target.detail ?? "Runtime state is connected without executable cell controls.",
      badge: target.statusLabel ?? "Attached",
      icon: Cpu,
      iconClassName: "border-sky-500/30 bg-sky-500/10 text-sky-700",
      badgeClassName: "bg-sky-500/10 text-sky-700",
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
    iconClassName: "border-muted bg-background text-muted-foreground",
    badgeClassName: "bg-muted text-muted-foreground",
  };
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
    };
  }
  if (capabilities.runtime.connected) {
    return {
      kind: "runtime_peer",
      status: capabilities.runtime.executionAvailable ? "ready" : "attached",
      label: "Runtime peer",
      statusLabel: capabilities.runtime.executionAvailable ? "Ready" : "Attached",
      providerLabel: source.label,
    };
  }
  return {
    kind: capabilities.runtime.source === "fixture" ? "fixture" : "unknown",
    status: "offline",
    label:
      capabilities.runtime.source === "cloud" ? "No workstation attached" : "No runtime target",
    statusLabel: "Offline",
    providerLabel: source.label,
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
