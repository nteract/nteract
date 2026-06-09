import {
  CircleAlert,
  CircleCheck,
  Cloud,
  FolderOpen,
  Gauge,
  MemoryStick,
  Monitor,
  PlugZap,
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
            Run the workstation agent on a machine you own, then attach it here to start compute.
          </p>
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
              <span className="text-xs font-medium text-primary">Attached</span>
            ) : null}
            {workstation.isDefault ? (
              <span className="text-xs font-medium text-muted-foreground">Default</span>
            ) : null}
            <span className={cn("text-xs font-medium", status.textClassName)}>
              {workstation.statusLabel}
            </span>
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs">
            {workstation.facts.map((fact) => (
              <RegisteredWorkstationFact
                key={fact.kind}
                fact={fact}
                icon={registeredWorkstationFactIcon(fact)}
              />
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
            {workstation.isAttached ? "Attached" : busy ? "Attaching" : "Attach"}
          </Button>
        ) : null}
      </div>
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
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", fact.subtle && "opacity-75")}>
      <Icon
        className={cn("size-3.5 shrink-0", workstationFactIconClassName(fact.tone))}
        aria-hidden="true"
      />
      <span className="shrink-0 text-muted-foreground">{fact.label}</span>
      <span className="min-w-0 truncate font-medium text-foreground">{fact.value}</span>
    </span>
  );
}

function RegisteredWorkstationFact({
  fact,
  icon: Icon,
}: {
  fact: NotebookRegisteredWorkstationFactProjection;
  icon: LucideIcon;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="shrink-0">{fact.label}</span>
      <span className="min-w-0 truncate font-medium text-foreground">{fact.value}</span>
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

function registeredWorkstationFactIcon(
  fact: NotebookRegisteredWorkstationFactProjection,
): LucideIcon {
  switch (fact.kind) {
    case "cpu":
      return Gauge;
    case "memory":
      return MemoryStick;
    case "working_directory":
      return FolderOpen;
    default:
      return ServerCog;
  }
}
