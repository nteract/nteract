import {
  CircleAlert,
  CircleCheck,
  Cloud,
  Cpu,
  FolderOpen,
  MemoryStick,
  Monitor,
} from "lucide-react";
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
  const defaultEnvironmentLabel =
    target.defaultEnvironmentLabel ??
    target.environmentLabel ??
    runtimeResourceLabel(capabilities, target);
  const capabilityLabel = runtimeCapabilityLabel(capabilities);
  const hasCpuCount = typeof target.cpuCount === "number" && target.cpuCount > 0;
  const memoryLabel = formatMemoryBytes(target.memoryBytes);

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
            {target.id ? (
              <div className="mb-0.5 truncate text-[11px] font-medium uppercase tracking-normal text-muted-foreground">
                {target.id}
              </div>
            ) : null}
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="truncate text-sm font-semibold">{status.title}</h3>
              <span className={cn("shrink-0 text-xs font-medium", status.textClassName)}>
                {status.badge}
              </span>
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="truncate">{target.providerLabel ?? source.label}</span>
              <span className="truncate">{defaultEnvironmentLabel}</span>
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
        <WorkstationFact icon={Cpu} label="Default env" value={defaultEnvironmentLabel} />
        {hasCpuCount ? (
          <WorkstationFact icon={Cpu} label="CPUs" value={`${target.cpuCount}`} />
        ) : null}
        {memoryLabel ? (
          <WorkstationFact icon={MemoryStick} label="RAM" value={memoryLabel} />
        ) : null}
        {!hasCpuCount && !memoryLabel && target.resourceLabel ? (
          <WorkstationFact icon={Cpu} label="Resources" value={target.resourceLabel} />
        ) : null}
        {target.workingDirectoryLabel ? (
          <WorkstationFact
            icon={FolderOpen}
            label="Working dir"
            value={target.workingDirectoryLabel}
          />
        ) : null}
        <WorkstationFact
          icon={capabilities.runtime.canWriteRuntimeState ? CircleCheck : CircleAlert}
          label="State"
          value={capabilityLabel}
        />
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
  detail: string | null;
  badge: string;
  icon: LucideIcon;
  iconClassName: string;
  panelClassName: string;
  textClassName: string;
} {
  if (capabilities.runtime.executionAvailable && capabilities.canExecute) {
    return {
      title: target.kind === "local_daemon" ? target.label : `${target.label} ready`,
      detail: null,
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
      detail: null,
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
      detail: null,
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
      id: "local-daemon",
      kind: "local_daemon",
      status: capabilities.runtime.executionAvailable ? "ready" : "offline",
      label: "This machine",
      statusLabel: capabilities.runtime.executionAvailable ? "Ready" : "Offline",
      providerLabel: source.label,
      defaultEnvironmentLabel: capabilities.runtime.executionAvailable
        ? "Notebook runtime"
        : "Unavailable",
      environmentLabel: capabilities.runtime.executionAvailable
        ? "Notebook runtime"
        : "Unavailable",
    };
  }
  if (capabilities.runtime.connected) {
    return {
      id: "runtime-peer",
      kind: "runtime_peer",
      status: capabilities.runtime.executionAvailable ? "ready" : "attached",
      label: "Runtime peer",
      statusLabel: capabilities.runtime.executionAvailable ? "Ready" : "Attached",
      providerLabel: source.label,
      defaultEnvironmentLabel: "Runtime peer",
      environmentLabel: "Runtime peer",
    };
  }
  return {
    id: capabilities.runtime.source === "cloud" ? "workstation:none" : "runtime:none",
    kind: capabilities.runtime.source === "fixture" ? "fixture" : "unknown",
    status: "offline",
    label:
      capabilities.runtime.source === "cloud" ? "No workstation attached" : "No runtime target",
    statusLabel: "Offline",
    providerLabel: source.label,
    defaultEnvironmentLabel: "Not attached",
    environmentLabel: "Not attached",
  };
}

function formatMemoryBytes(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const gib = value / 1024 ** 3;
  if (gib >= 1) {
    return `${formatNumber(gib)} GiB`;
  }
  const mib = value / 1024 ** 2;
  if (mib >= 1) {
    return `${formatNumber(mib)} MiB`;
  }
  return `${Math.round(value / 1024)} KiB`;
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return `${value}`;
  }
  return value >= 10 ? value.toFixed(1) : value.toFixed(2);
}

function workstationSource(source: NotebookShellCapabilities["runtime"]["source"]): {
  label: string;
  icon: LucideIcon;
} {
  switch (source) {
    case "local":
      return {
        label: "Local",
        icon: Monitor,
      };
    case "cloud":
      return {
        label: "Cloud",
        icon: Cloud,
      };
    case "fixture":
      return {
        label: "Fixture",
        icon: Cpu,
      };
    default:
      return {
        label: "Unknown",
        icon: Cpu,
      };
  }
}
