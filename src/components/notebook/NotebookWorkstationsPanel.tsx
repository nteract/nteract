import { useState, type ReactNode } from "react";
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Cloud,
  Cpu,
  FolderOpen,
  Gauge,
  MemoryStick,
  Monitor,
  PlugZap,
  Plus,
  Server,
  ServerCog,
  ServerOff,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  projectNotebookWorkstationPanel,
  type NotebookShellCapabilities,
  type NotebookShellAccessSource,
  type NotebookRegisteredWorkstationFactProjection,
  type NotebookRegisteredWorkstationProjection,
  type NotebookWorkstationFactProjection,
  type NotebookWorkstationSelectionProjection,
} from "./capabilities";
import { cn } from "@/lib/utils";

export interface NotebookWorkstationsPanelProps {
  capabilities: NotebookShellCapabilities;
  selection?: NotebookWorkstationSelectionProjection | null;
  busyWorkstationId?: string | null;
  className?: string;
  onAttachWorkstation?: (workstationId: string) => void;
  onSetDefaultWorkstation?: (workstationId: string) => void;
  statusMessage?: string | null;
}

export function NotebookWorkstationsPanel({
  busyWorkstationId = null,
  capabilities,
  selection = null,
  className,
  onAttachWorkstation,
  onSetDefaultWorkstation,
  statusMessage = null,
}: NotebookWorkstationsPanelProps) {
  const [selectedWorkstationId, setSelectedWorkstationId] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const projection = projectNotebookWorkstationPanel(capabilities);
  const showRegistrationPrompt = selection?.state === "needs_registration";
  const registeredWorkstations = selection?.registeredWorkstations ?? [];
  const hasVisibleRegisteredWorkstations = registeredWorkstations.length > 0;
  const selectedWorkstation =
    registeredWorkstations.find((workstation) => workstation.id === selectedWorkstationId) ?? null;
  // Per-workstation messages belong to the details section, never above the list.
  const visibleStatusMessage =
    statusMessage &&
    !registeredWorkstations.some((workstation) => workstation.statusMessage === statusMessage)
      ? statusMessage
      : null;

  return (
    <div
      className={cn("flex min-h-full flex-col gap-3 text-sm", className)}
      data-testid="notebook-workstations-panel"
    >
      {hasVisibleRegisteredWorkstations ? (
        <section aria-label="Registered workstations" className="-mx-3 -mt-3 flex-1">
          <ul className="divide-y divide-border/70 border-b border-border/70">
            {registeredWorkstations.map((workstation) => (
              <RegisteredWorkstationRow
                key={workstation.id}
                busy={busyWorkstationId === workstation.id}
                selected={workstation.id === selectedWorkstationId}
                workstation={workstation}
                onAttachWorkstation={onAttachWorkstation}
                onSelect={() => {
                  setSelectedWorkstationId(workstation.id);
                  setDetailsOpen(true);
                }}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {visibleStatusMessage ? (
        <section className="text-xs leading-5 text-muted-foreground" aria-live="polite">
          {visibleStatusMessage}
        </section>
      ) : null}

      <section
        aria-label="Workstation details"
        className={hasVisibleRegisteredWorkstations ? "mt-auto" : undefined}
      >
        <PanelSection title="Workstation details" open={detailsOpen} onOpenChange={setDetailsOpen}>
          {selectedWorkstation ? (
            <div className="space-y-2">
              <div className="min-w-0">
                <h4 className="truncate text-sm font-semibold text-foreground">
                  {selectedWorkstation.displayName}
                </h4>
                <div className="truncate font-mono text-[10.5px] tracking-normal text-muted-foreground">
                  {selectedWorkstation.idLabel}
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  {selectedWorkstation.isAttached ? "Running" : selectedWorkstation.statusLabel}
                </p>
              </div>
              <div className="grid min-w-0 gap-1.5">
                {registeredWorkstationDetailFacts(selectedWorkstation).map((fact) => (
                  <RegisteredWorkstationFact key={fact.kind} fact={fact} />
                ))}
              </div>
              {onSetDefaultWorkstation && !selectedWorkstation.isDefault ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busyWorkstationId === selectedWorkstation.id}
                  onClick={() => onSetDefaultWorkstation(selectedWorkstation.id)}
                >
                  Set default
                </Button>
              ) : null}
            </div>
          ) : hasVisibleRegisteredWorkstations ? (
            <p className="text-xs leading-5 text-muted-foreground">
              Select a workstation above to see its details.
            </p>
          ) : (
            <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1.5 text-xs">
              {projection.facts.map((fact) => (
                <WorkstationFact
                  key={fact.kind}
                  fact={fact}
                  icon={workstationFactIcon(fact, projection.source)}
                />
              ))}
            </div>
          )}
        </PanelSection>
      </section>

      {showRegistrationPrompt ? (
        <section
          className="space-y-1.5 text-xs"
          aria-label="Workstation setup"
          data-testid="workstation-registration-empty"
        >
          <div className="flex min-w-0 items-center gap-2 font-medium text-foreground">
            <ServerCog className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span>No workstation registered</span>
          </div>
          <p className="leading-5 text-muted-foreground">
            Connect a machine you own to run this notebook&rsquo;s compute there.
          </p>
        </section>
      ) : null}
    </div>
  );
}

export interface NotebookWorkstationsPanelActionProps {
  /** Hidden while the connect dialog is up; it already owns that flow. */
  pairingOpen?: boolean;
  onStartPairing?: () => void;
}

/** Add workstation control for the rail header, inline with the panel title. */
export function NotebookWorkstationsPanelAction({
  pairingOpen = false,
  onStartPairing,
}: NotebookWorkstationsPanelActionProps) {
  if (!onStartPairing || pairingOpen) return null;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="-my-1 h-7 px-2 text-xs text-muted-foreground"
      onClick={onStartPairing}
      data-testid="workstation-add-button"
    >
      <Plus className="size-3.5" aria-hidden="true" />
      Add workstation
    </Button>
  );
}

function PanelSection({
  title,
  defaultOpen = true,
  open,
  onOpenChange,
  bleed = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Let content span the full panel width instead of aligning to the title gutter. */
  bleed?: boolean;
  children: ReactNode;
}) {
  return (
    <Collapsible
      defaultOpen={open === undefined ? defaultOpen : undefined}
      open={open}
      onOpenChange={onOpenChange}
      className="-mx-3 border-t border-border/70"
    >
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 px-4 py-2 text-sm font-semibold text-foreground">
        {title}
        <ChevronDown
          className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn("border-t border-border/70 pt-2", bleed ? undefined : "px-4 pb-2")}
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function RegisteredWorkstationRow({
  busy,
  selected,
  workstation,
  onAttachWorkstation,
  onSelect,
}: {
  busy: boolean;
  selected: boolean;
  workstation: NotebookRegisteredWorkstationProjection;
  onAttachWorkstation?: (workstationId: string) => void;
  onSelect: () => void;
}) {
  const status = registeredWorkstationStatusTone(workstation);
  const Icon = status.icon;
  const statusLabel = workstation.isAttached
    ? "Running"
    : busy
      ? "Starting"
      : workstation.statusLabel;

  return (
    <li
      className={cn(
        "relative flex min-w-0 items-start gap-2 px-4 py-2.5 transition-colors hover:bg-muted/[0.06]",
        workstation.isAttached && "bg-primary/[0.06]",
        selected &&
          "bg-accent before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary",
      )}
      data-testid="registered-workstation"
      data-selected={selected ? "true" : "false"}
    >
      <button
        type="button"
        aria-pressed={selected}
        className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
        onClick={onSelect}
      >
        <Icon className={cn("mt-0.5 size-4 shrink-0", status.iconClassName)} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <h4 className="truncate text-sm font-medium">{workstation.displayName}</h4>
          <span className={cn("mt-0.5 block text-xs font-medium", status.textClassName)}>
            {statusLabel}
          </span>
        </span>
      </button>
      {onAttachWorkstation ? (
        <Button
          type="button"
          variant={workstation.isAttached ? "secondary" : "outline"}
          size="sm"
          className="shrink-0"
          disabled={busy || workstation.isAttached || !workstation.canAttach}
          title={registeredWorkstationStartTitle(workstation, busy)}
          onClick={() => onAttachWorkstation(workstation.id)}
        >
          {workstation.isAttached ? "Running" : busy ? "Starting" : "Start"}
        </Button>
      ) : null}
    </li>
  );
}

// Start is gated on the projection's canAttach; say why instead of going dead.
function registeredWorkstationStartTitle(
  workstation: NotebookRegisteredWorkstationProjection,
  busy: boolean,
): string {
  if (workstation.isAttached)
    return "This workstation is already running compute for this notebook";
  if (busy) return "Starting compute on this workstation";
  if (workstation.canAttach) return `Start compute on ${workstation.displayName}`;
  if (workstation.status === "connecting") return "This workstation is still connecting";
  if (workstation.status !== "online") {
    return "This workstation is not online. Run the workstation agent on that machine first.";
  }
  if (!workstation.workingDirectoryLabel) {
    return "This workstation has not reported a working directory yet";
  }
  return "This workstation has no available environment yet";
}

function WorkstationFact({
  fact,
  icon: Icon,
}: {
  fact: NotebookWorkstationFactProjection;
  icon: LucideIcon;
}) {
  return (
    <span
      className={cn(
        "inline-grid min-w-0 grid-cols-[auto_auto_minmax(0,1fr)] gap-x-1.5",
        fact.subtle && "opacity-75",
      )}
      data-tone={fact.tone}
    >
      <Icon
        className={cn("mt-px size-3.5 shrink-0", workstationFactIconClassName(fact.tone))}
        aria-hidden="true"
      />
      <span className="shrink-0 text-muted-foreground">{fact.label}</span>
      <span
        className={cn(
          "min-w-0 font-medium text-foreground",
          fact.kind === "accelerator" ? "break-words" : "truncate",
        )}
      >
        {fact.value}
      </span>
      {fact.detail ? (
        <span className="col-span-2 col-start-2 min-w-0 text-[11px] leading-4 text-muted-foreground">
          {fact.detail}
        </span>
      ) : null}
    </span>
  );
}

// The projection carries provider, agent build, and heartbeat facts the panel
// can show alongside the resource facts without another data source.
function registeredWorkstationDetailFacts(
  workstation: NotebookRegisteredWorkstationProjection,
): readonly NotebookRegisteredWorkstationFactProjection[] {
  const extras: NotebookRegisteredWorkstationFactProjection[] = [];
  const push = (
    kind: string,
    label: string,
    value: string | null,
    detail: string | null = null,
    tone: NotebookRegisteredWorkstationFactProjection["tone"] = "neutral",
  ) => {
    if (!value) return;
    extras.push({
      detail,
      kind: kind as NotebookRegisteredWorkstationFactProjection["kind"],
      label,
      tone,
      value,
    });
  };

  push("provider", "Provider", workstation.providerLabel);
  push(
    "build",
    "Agent build",
    workstation.installedBuild,
    workstation.isOutdated && workstation.latestBuild
      ? `Update to ${workstation.latestBuild}`
      : null,
    workstation.isOutdated ? "attention" : "neutral",
  );
  push("channel", "Channel", workstation.channel);
  push("last_seen", "Last seen", workstationLastSeenLabel(workstation));

  return [...workstation.facts, ...extras];
}

function workstationLastSeenLabel(
  workstation: NotebookRegisteredWorkstationProjection,
): string | null {
  if (workstation.status === "online") return "Active now";
  if (workstation.status === "connecting") return "Connecting…";
  if (!workstation.updatedAt) return null;
  const seenMs = Date.parse(workstation.updatedAt);
  if (!Number.isFinite(seenMs)) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(seenMs),
  );
}

function RegisteredWorkstationFact({
  fact,
}: {
  fact: NotebookRegisteredWorkstationFactProjection;
}) {
  return (
    <span className="grid min-w-0" data-tone={fact.tone}>
      <span className="text-[11px] leading-4 text-muted-foreground">{fact.label}</span>
      <span
        className={cn(
          "min-w-0 text-xs leading-5 font-medium",
          fact.kind === "accelerator" ? "break-words" : "truncate",
          fact.tone === "attention" ? "text-[var(--sev-warn)]" : "text-foreground",
        )}
      >
        {fact.value}
      </span>
      {fact.detail ? (
        <span className="min-w-0 text-[11px] leading-4 text-muted-foreground">{fact.detail}</span>
      ) : null}
    </span>
  );
}

function registeredWorkstationStatusTone(workstation: NotebookRegisteredWorkstationProjection): {
  icon: LucideIcon;
  iconClassName: string;
  textClassName: string;
} {
  if (workstation.isAttached) {
    return {
      icon: CircleCheck,
      iconClassName: "text-primary",
      textClassName: "text-primary",
    };
  }
  if (workstation.status === "online") {
    return {
      icon: Server,
      iconClassName: "text-emerald-700 dark:text-emerald-300",
      textClassName: "text-emerald-700 dark:text-emerald-300",
    };
  }
  if (workstation.status === "connecting") {
    return {
      icon: PlugZap,
      iconClassName: "text-sky-700 dark:text-sky-300",
      textClassName: "text-sky-700 dark:text-sky-300",
    };
  }
  if (workstation.status === "attention") {
    return {
      icon: CircleAlert,
      iconClassName: "text-amber-700 dark:text-amber-300",
      textClassName: "text-amber-700 dark:text-amber-300",
    };
  }
  return {
    icon: ServerOff,
    iconClassName: "text-muted-foreground",
    textClassName: "text-muted-foreground",
  };
}

function workstationFactIconClassName(tone: NotebookWorkstationFactProjection["tone"]): string {
  if (tone === "positive") {
    return "text-emerald-700 dark:text-emerald-300";
  }
  if (tone === "attention") {
    return "text-amber-700 dark:text-amber-300";
  }
  return "text-muted-foreground";
}

function workstationSourceIcon(source: NotebookShellAccessSource): LucideIcon {
  switch (source) {
    case "local":
      return Monitor;
    case "cloud":
      return Cloud;
    case "fixture":
      return Server;
    default:
      return Server;
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
      return Gauge;
    case "memory":
      return MemoryStick;
    case "accelerator":
      return Cpu;
    case "working_directory":
      return FolderOpen;
    case "runtime_peers":
      return Cloud;
    case "execution_state":
      return fact.tone === "positive" ? CircleCheck : CircleAlert;
    case "remote_hint":
      return Cloud;
    default:
      return Server;
  }
}
