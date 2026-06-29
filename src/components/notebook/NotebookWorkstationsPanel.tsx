import { useEffect, useState } from "react";
import {
  Check,
  CircleAlert,
  CircleCheck,
  Cloud,
  Copy,
  FolderOpen,
  Gauge,
  MemoryStick,
  Monitor,
  PlugZap,
  Plus,
  Server,
  ServerCog,
  ServerOff,
  X,
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

export interface NotebookWorkstationPairingView {
  code: string;
  connectCommand: string;
  commands?: readonly NotebookWorkstationPairingCommandView[];
  expiresAt: string;
  status: "pending" | "redeemed" | "registered" | "expired";
  workstationName: string | null;
  error: string | null;
}

export interface NotebookWorkstationPairingCommandView {
  id: string;
  label: string;
  command: string;
  optional?: boolean;
}

export interface NotebookWorkstationsPanelProps {
  capabilities: NotebookShellCapabilities;
  selection?: NotebookWorkstationSelectionProjection | null;
  busyWorkstationId?: string | null;
  className?: string;
  onAttachWorkstation?: (workstationId: string) => void;
  onSetDefaultWorkstation?: (workstationId: string) => void;
  pairing?: NotebookWorkstationPairingView | null;
  onStartPairing?: () => void;
  onCancelPairing?: () => void;
  statusMessage?: string | null;
}

export function NotebookWorkstationsPanel({
  busyWorkstationId = null,
  capabilities,
  selection = null,
  className,
  onAttachWorkstation,
  onSetDefaultWorkstation,
  pairing = null,
  onStartPairing,
  onCancelPairing,
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

      {pairing ? (
        <WorkstationPairingCard
          pairing={pairing}
          onCancel={onCancelPairing}
          onRestart={onStartPairing}
        />
      ) : null}

      {showRegistrationPrompt && !pairing ? (
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

      {!showRegistrationPrompt && !pairing && onStartPairing ? (
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

function WorkstationPairingCard({
  pairing,
  onCancel,
  onRestart,
}: {
  pairing: NotebookWorkstationPairingView;
  onCancel?: () => void;
  onRestart?: () => void;
}) {
  const pairingCommands =
    pairing.commands && pairing.commands.length > 0
      ? pairing.commands
      : [
          {
            id: "connect",
            label: "Connect workstation",
            command: pairing.connectCommand,
          },
        ];
  const hasServiceCommand = pairingCommands.some((command) =>
    command.command.includes("workstation service"),
  );
  const hasForegroundFallback = pairingCommands.some((command) => command.id === "foreground-run");

  return (
    <section
      className="space-y-2 rounded-md border border-border/70 px-2.5 py-2"
      aria-label="Connect a machine"
      data-testid="workstation-pairing-card"
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium">Connect a machine</h4>
        {onCancel ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Dismiss pairing"
            onClick={onCancel}
          >
            <X className="size-3.5" aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      {pairing.status === "registered" ? (
        <div className="space-y-2 text-xs" aria-live="polite">
          <div className="flex min-w-0 items-center gap-2 text-foreground">
            <CircleCheck className="size-4 shrink-0 text-emerald-500" aria-hidden="true" />
            <span data-testid="workstation-pairing-status">
              {pairing.workstationName ?? "Workstation"} is connected.
            </span>
          </div>
          {onCancel ? (
            <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
              Done
            </Button>
          ) : null}
        </div>
      ) : pairing.status === "expired" ? (
        <div className="space-y-2 text-xs" aria-live="polite">
          <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <CircleAlert className="size-4 shrink-0 text-amber-500" aria-hidden="true" />
            <span data-testid="workstation-pairing-status">
              {pairing.error ?? "The pairing code expired before a machine connected."}
            </span>
          </div>
          {onRestart ? (
            <Button type="button" variant="outline" size="sm" onClick={onRestart}>
              Generate a new code
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="space-y-2 text-xs">
          <p className="leading-5 text-muted-foreground">
            {pairingCommands.length === 1
              ? "Run this in a terminal on the machine you want to attach:"
              : "Run these in a terminal on the machine you want to attach:"}
          </p>
          <PairingCommandList commands={pairingCommands} />
          <p className="leading-5 text-muted-foreground">
            {hasServiceCommand && hasForegroundFallback
              ? "The Linux service command keeps this workstation available. Use the foreground fallback in tmux for macOS, non-systemd hosts, or manual testing."
              : hasServiceCommand
                ? "The Linux service command keeps this workstation available after pairing."
                : "Keep the command running until the workstation appears in the panel."}
          </p>
          <p className="leading-5 text-muted-foreground" aria-live="polite">
            {pairing.status === "redeemed" ? (
              <span data-testid="workstation-pairing-status">
                Machine connected; registering...
              </span>
            ) : (
              <span data-testid="workstation-pairing-status">
                Waiting for the machine to connect.
                <PairingCountdown expiresAt={pairing.expiresAt} />
              </span>
            )}
          </p>
        </div>
      )}
    </section>
  );
}

function PairingCommandList({
  commands,
}: {
  commands: readonly NotebookWorkstationPairingCommandView[];
}) {
  const requiredCommandText = commands
    .filter((command) => command.optional !== true)
    .map((command) => command.command)
    .join("\n");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div className="space-y-1.5" data-testid="workstation-pairing-command-list">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10.5px] font-medium uppercase tracking-normal text-muted-foreground">
          Setup commands
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label={
            copied
              ? "Copied required workstation setup commands"
              : "Copy required workstation setup commands"
          }
          title={copied ? "Copied" : "Copy required commands"}
          disabled={!requiredCommandText}
          onClick={() => {
            void navigator.clipboard.writeText(requiredCommandText).then(() => setCopied(true));
          }}
        >
          {copied ? (
            <Check className="size-3.5 text-emerald-500" aria-hidden="true" />
          ) : (
            <Copy className="size-3.5" aria-hidden="true" />
          )}
        </Button>
      </div>
      <ol className="space-y-1.5">
        {commands.map((command, index) => (
          <li key={command.id} className="space-y-1">
            <div className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-muted-foreground">
              <span className="font-medium text-foreground">{index + 1}.</span>
              <span className="truncate">{command.label}</span>
              {command.optional ? (
                <span className="shrink-0 text-muted-foreground">(optional)</span>
              ) : null}
            </div>
            <PairingCommand command={command.command} label={command.label} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function PairingCommand({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div className="flex items-start gap-1.5">
      <code
        className="min-w-0 flex-1 rounded bg-muted/40 px-2 py-1.5 font-mono text-[11px] leading-4 break-all whitespace-pre-wrap"
        data-testid="workstation-pairing-command"
      >
        {command}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label={copied ? `Copied ${label} command` : `Copy ${label} command`}
        title={copied ? "Copied" : `Copy ${label}`}
        onClick={() => {
          void navigator.clipboard.writeText(command).then(() => setCopied(true));
        }}
      >
        {copied ? (
          <Check className="size-3.5 text-emerald-500" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
      </Button>
    </div>
  );
}

function PairingCountdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const remainingMs = Date.parse(expiresAt) - now;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return null;
  }
  const totalSeconds = Math.floor(remainingMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return (
    <span>
      {" "}
      Code expires in {minutes}:{seconds.toString().padStart(2, "0")}.
    </span>
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
}: {
  fact: NotebookRegisteredWorkstationFactProjection;
}) {
  return (
    <span className="grid min-w-0 grid-cols-[2.25rem_minmax(0,1fr)] items-baseline gap-1 text-muted-foreground">
      <span className="text-[11px]">{fact.label}</span>
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
