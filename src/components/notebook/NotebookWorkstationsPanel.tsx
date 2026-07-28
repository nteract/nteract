import {
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
import {
  projectNotebookWorkstationPanel,
  type NotebookShellCapabilities,
  type NotebookShellAccessSource,
  type NotebookRegisteredWorkstationFactProjection,
  type NotebookRegisteredWorkstationProjection,
  type NotebookWorkstationFactProjection,
  type NotebookWorkstationPanelTone,
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
  /**
   * Whether the host is currently showing the connect dialog. The panel does
   * not render the pairing surface itself — the host mounts
   * `WorkstationConnectDialog` — but it hides its own add affordances while the
   * dialog is up so the two cannot both invite the same action.
   */
  pairingOpen?: boolean;
  onStartPairing?: () => void;
  statusMessage?: string | null;
}

export function NotebookWorkstationsPanel({
  busyWorkstationId = null,
  capabilities,
  selection = null,
  className,
  onAttachWorkstation,
  onSetDefaultWorkstation,
  pairingOpen = false,
  onStartPairing,
  statusMessage = null,
}: NotebookWorkstationsPanelProps) {
  const projection = projectNotebookWorkstationPanel(capabilities);
  const status = workstationStatusTone(projection.tone);
  const showRegistrationPrompt = selection?.state === "needs_registration";
  const registeredWorkstations = selection?.registeredWorkstations ?? [];
  const compactDetachedTarget =
    projection.targetId === "workstation:none" && registeredWorkstations.length > 0;
  const compactRecoverableTarget =
    !compactDetachedTarget &&
    Boolean(
      projection.targetId &&
      projection.targetId !== "workstation:none" &&
      registeredWorkstations.some(
        (workstation) =>
          workstation.id === projection.targetId &&
          !workstation.isAttached &&
          workstation.canAttach,
      ),
    );
  const compactTargetFacts = compactDetachedTarget || compactRecoverableTarget;
  const activeRegisteredWorkstationId =
    registeredWorkstations.find((workstation) => workstation.isAttached)?.id ??
    (!selection && projection.targetId && projection.targetId !== "workstation:none"
      ? projection.targetId
      : null);
  const hasVisibleRegisteredWorkstations = registeredWorkstations.some((workstation) =>
    shouldShowRegisteredWorkstation(workstation, activeRegisteredWorkstationId),
  );
  const visibleStatusMessage =
    statusMessage &&
    !registeredWorkstations.some((workstation) => workstation.statusMessage === statusMessage)
      ? statusMessage
      : null;
  const visibleTargetId =
    projection.targetId &&
    !compactRecoverableTarget &&
    projection.targetKind !== "local_daemon" &&
    projection.targetId !== "workstation:none"
      ? `id ${projection.targetId}`
      : null;

  return (
    <div className={cn("space-y-3 text-sm", className)} data-testid="notebook-workstations-panel">
      <section
        className={cn("space-y-2 border-b border-border/70", compactTargetFacts ? "pb-2" : "pb-3")}
        aria-label="Active workstation target"
      >
        <div className="flex min-w-0 items-start gap-3">
          <status.icon
            className={cn("mt-0.5 size-4 shrink-0", status.iconClassName)}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="truncate text-sm font-semibold">{projection.title}</h3>
              <span className={cn("shrink-0 text-xs font-medium", status.textClassName)}>
                {projection.statusLabel}
              </span>
            </div>
            {projection.detail ? (
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{projection.detail}</p>
            ) : null}
            {visibleTargetId ? (
              <div className="mt-1 truncate font-mono text-[10.5px] tracking-normal text-muted-foreground">
                {visibleTargetId}
              </div>
            ) : null}
          </div>
        </div>

        {compactTargetFacts ? null : (
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
      </section>

      {visibleStatusMessage ? (
        <section className="text-xs leading-5 text-muted-foreground" aria-live="polite">
          {visibleStatusMessage}
        </section>
      ) : null}

      {hasVisibleRegisteredWorkstations ? (
        <section className="space-y-1.5" aria-label="Registered workstations">
          {registeredWorkstations.map((workstation) =>
            shouldShowRegisteredWorkstation(workstation, activeRegisteredWorkstationId) ? (
              <RegisteredWorkstationRow
                key={workstation.id}
                busy={busyWorkstationId === workstation.id}
                workstation={workstation}
                onAttachWorkstation={onAttachWorkstation}
                onSetDefaultWorkstation={onSetDefaultWorkstation}
              />
            ) : null,
          )}
        </section>
      ) : null}

      {showRegistrationPrompt && !pairingOpen ? (
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
          {onStartPairing ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-1"
              onClick={onStartPairing}
              data-testid="workstation-add-button"
            >
              <Plus className="size-3.5" aria-hidden="true" />
              Add workstation
            </Button>
          ) : null}
        </section>
      ) : null}

      {!showRegistrationPrompt && !pairingOpen && onStartPairing ? (
        <section aria-label="Workstation setup">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            onClick={onStartPairing}
            data-testid="workstation-add-button"
          >
            <Plus className="size-3.5" aria-hidden="true" />
            Add workstation
          </Button>
        </section>
      ) : null}
    </div>
  );
}

function shouldShowRegisteredWorkstation(
  workstation: NotebookRegisteredWorkstationProjection,
  activeRegisteredWorkstationId: string | null,
): boolean {
  return !workstation.isAttached && workstation.id !== activeRegisteredWorkstationId;
}

function RegisteredWorkstationRow({
  busy,
  workstation,
  onAttachWorkstation,
  onSetDefaultWorkstation,
}: {
  busy: boolean;
  workstation: NotebookRegisteredWorkstationProjection;
  onAttachWorkstation?: (workstationId: string) => void;
  onSetDefaultWorkstation?: (workstationId: string) => void;
}) {
  const status = registeredWorkstationStatusTone(workstation);
  const Icon = status.icon;
  return (
    <div
      className={cn(
        "rounded-md px-2.5 py-2 transition-colors",
        workstation.isAttached ? "bg-primary/[0.06]" : "hover:bg-muted/[0.06]",
      )}
      data-testid="registered-workstation"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <Icon className={cn("mt-0.5 size-4 shrink-0", status.iconClassName)} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h4 className="truncate text-sm font-medium">{workstation.displayName}</h4>
            {workstation.isAttached ? (
              <span className="text-xs font-medium text-primary">Running</span>
            ) : null}
            {workstation.isDefault ? (
              <span className="text-xs font-medium text-muted-foreground">Default</span>
            ) : null}
            <span className={cn("text-xs font-medium", status.textClassName)}>
              {workstation.statusLabel}
            </span>
          </div>
          <div className="mt-1.5 grid min-w-0 gap-1 text-xs">
            {workstation.facts.map((fact) => (
              <RegisteredWorkstationFact key={fact.kind} fact={fact} />
            ))}
          </div>
          {workstation.statusMessage ? (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {workstation.statusMessage}
            </p>
          ) : null}
          <div className="mt-1 truncate font-mono text-[10.5px] tracking-normal text-muted-foreground">
            {workstation.idLabel}
          </div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        {onSetDefaultWorkstation && !workstation.isDefault ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onSetDefaultWorkstation(workstation.id)}
          >
            Set default
          </Button>
        ) : null}
        {onAttachWorkstation ? (
          <Button
            type="button"
            variant={workstation.isAttached ? "secondary" : "outline"}
            size="sm"
            disabled={busy || workstation.isAttached || !workstation.canAttach}
            onClick={() => onAttachWorkstation(workstation.id)}
          >
            {workstation.isAttached ? "Running" : busy ? "Starting" : "Start"}
          </Button>
        ) : null}
      </div>
    </div>
  );
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

function RegisteredWorkstationFact({
  fact,
}: {
  fact: NotebookRegisteredWorkstationFactProjection;
}) {
  return (
    <span
      className="grid min-w-0 grid-cols-[2.25rem_minmax(0,1fr)] items-baseline gap-x-1 gap-y-0.5 text-muted-foreground"
      data-tone={fact.tone}
    >
      <span className="text-[11px]">{fact.label}</span>
      <span
        className={cn(
          "min-w-0 font-medium",
          fact.kind === "accelerator" ? "break-words" : "truncate",
          fact.tone === "attention" ? "text-[var(--sev-warn)]" : "text-foreground",
        )}
      >
        {fact.value}
      </span>
      {fact.detail ? (
        <span className="col-start-2 min-w-0 text-[11px] leading-4 text-muted-foreground">
          {fact.detail}
        </span>
      ) : null}
    </span>
  );
}

function workstationStatusTone(tone: NotebookWorkstationPanelTone): {
  icon: LucideIcon;
  iconClassName: string;
  textClassName: string;
} {
  if (tone === "ready") {
    return {
      icon: CircleCheck,
      iconClassName: "text-emerald-700 dark:text-emerald-300",
      textClassName: "text-emerald-700 dark:text-emerald-300",
    };
  }
  if (tone === "available") {
    return {
      icon: Server,
      iconClassName: "text-sky-700 dark:text-sky-300",
      textClassName: "text-sky-700 dark:text-sky-300",
    };
  }

  return {
    icon: CircleAlert,
    iconClassName: "text-muted-foreground",
    textClassName: "text-muted-foreground",
  };
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
