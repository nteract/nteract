import { useEffect, useState, type ReactNode } from "react";
import {
  Boxes,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Clock,
  Cloud,
  Copy,
  Cpu,
  FolderOpen,
  Gauge,
  GitBranch,
  MemoryStick,
  Monitor,
  PlugZap,
  Plus,
  Server,
  ServerCog,
  ServerOff,
  Tag,
  X,
  Zap,
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
  /** Not the only way to satisfy this step, but the one most hosts should use. */
  recommended?: boolean;
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
  // A click wins, otherwise the projection decides. Derived rather than copied
  // into state: the projection resolves async, so seeding once would pin this to
  // whatever was known at mount and ignore every later selection.
  const [clickedWorkstationId, setClickedWorkstationId] = useState<string | null>(null);
  const [detailsOpenOverride, setDetailsOpenOverride] = useState<boolean | null>(null);
  const projection = projectNotebookWorkstationPanel(capabilities);
  const showRegistrationPrompt = selection?.state === "needs_registration";
  const registeredWorkstations = selection?.registeredWorkstations ?? [];
  const hasVisibleRegisteredWorkstations = registeredWorkstations.length > 0;
  const findWorkstation = (id: string | null) =>
    id === null
      ? null
      : (registeredWorkstations.find((workstation) => workstation.id === id) ?? null);
  // Falls back to the projection when the clicked workstation is unregistered,
  // so removing a machine reveals the current selection instead of blank details.
  const selectedWorkstation =
    findWorkstation(clickedWorkstationId) ??
    findWorkstation(selection?.selectedWorkstationId ?? null);
  const selectedWorkstationId = selectedWorkstation?.id ?? null;
  const detailsOpen = detailsOpenOverride ?? selectedWorkstationId !== null;
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
      {/* Pairing opens directly under the rail header so the flow reads top-down. */}
      {pairing ? (
        <WorkstationPairingCard
          pairing={pairing}
          onCancel={onCancelPairing}
          onRestart={onStartPairing}
        />
      ) : null}

      {hasVisibleRegisteredWorkstations ? (
        <section
          aria-label="Registered workstations"
          className={cn("-mx-3 flex-1", pairing ? undefined : "-mt-3")}
        >
          <ul className="divide-y divide-border/70 border-b border-border/70">
            {registeredWorkstations.map((workstation) => (
              <RegisteredWorkstationRow
                key={workstation.id}
                busy={busyWorkstationId === workstation.id}
                selected={workstation.id === selectedWorkstationId}
                workstation={workstation}
                onAttachWorkstation={onAttachWorkstation}
                onSelect={() => {
                  setClickedWorkstationId(workstation.id);
                  setDetailsOpenOverride(true);
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
        <PanelSection
          title="Workstation details"
          open={detailsOpen}
          onOpenChange={setDetailsOpenOverride}
          bleed
        >
          {selectedWorkstation ? (
            <div>
              <div className="min-w-0 border-b border-border/70 px-4 pb-2">
                <div className="flex min-w-0 items-center gap-2">
                  <h4 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                    {selectedWorkstation.displayName}
                  </h4>
                  <WorkstationStatusBadge workstation={selectedWorkstation} />
                </div>
                <div className="truncate font-mono text-[10.5px] tracking-normal text-muted-foreground">
                  {selectedWorkstation.idLabel}
                </div>
              </div>
              <FactRowList
                facts={registeredWorkstationDetailFacts(selectedWorkstation)}
                icon={(fact) => registeredWorkstationFactIcon(fact.kind)}
              />
              {onSetDefaultWorkstation && !selectedWorkstation.isDefault ? (
                <div className="px-4 py-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busyWorkstationId === selectedWorkstation.id}
                    onClick={() => onSetDefaultWorkstation(selectedWorkstation.id)}
                  >
                    Set default
                  </Button>
                </div>
              ) : null}
            </div>
          ) : hasVisibleRegisteredWorkstations ? (
            <p className="px-4 pb-2 text-xs leading-5 text-muted-foreground">
              Select a workstation above to see its details.
            </p>
          ) : (
            <FactRowList
              facts={projection.facts}
              icon={(fact) => workstationFactIcon(fact, projection.source)}
            />
          )}
        </PanelSection>
      </section>

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
        </section>
      ) : null}
    </div>
  );
}

export interface NotebookWorkstationsPanelActionProps {
  /** Hidden while pairing is in flight; the panel already shows that card. */
  pairing?: NotebookWorkstationPairingView | null;
  onStartPairing?: () => void;
}

/** Add workstation control for the rail header, inline with the panel title. */
export function NotebookWorkstationsPanelAction({
  pairing = null,
  onStartPairing,
}: NotebookWorkstationsPanelActionProps) {
  if (!onStartPairing || pairing) return null;

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

function WorkstationPairingCard({
  pairing,
  onCancel,
  onRestart,
}: {
  pairing: NotebookWorkstationPairingView;
  onCancel?: () => void;
  onRestart?: () => void;
}) {
  const structuredCommands =
    pairing.commands && pairing.commands.length > 0 ? pairing.commands : null;
  const hasStructuredCommands = structuredCommands !== null;
  const pairingCommands: readonly NotebookWorkstationPairingCommandView[] = structuredCommands ?? [
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
  const hasAdditionalCommands = pairingCommands.some((command) => command.optional === true);
  const serviceHelpText = pairingCommandHelpText(hasServiceCommand, hasForegroundFallback);

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
        <div className="space-y-2 text-xs">
          <div className="flex min-w-0 items-center gap-2 text-foreground">
            <CircleCheck className="size-4 shrink-0 text-emerald-500" aria-hidden="true" />
            <span data-testid="workstation-pairing-status" aria-live="polite">
              {pairing.workstationName ?? "Workstation"} is connected.
            </span>
          </div>
          {hasStructuredCommands ? (
            <div className="space-y-2">
              <p className="leading-5 text-muted-foreground">
                Finish setup with the keep-available command if you have not run it yet:
              </p>
              <PairingCommandList commands={pairingCommands} />
              {hasAdditionalCommands ? null : (
                <p className="leading-5 text-muted-foreground">{serviceHelpText}</p>
              )}
            </div>
          ) : null}
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
          {hasAdditionalCommands ? null : (
            <p className="leading-5 text-muted-foreground">{serviceHelpText}</p>
          )}
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

function pairingCommandHelpText(
  hasServiceCommand: boolean,
  hasForegroundFallback: boolean,
): string {
  if (hasServiceCommand && hasForegroundFallback) {
    return "The Linux service command keeps this workstation available. Use the foreground fallback in tmux for macOS, non-systemd hosts, or manual testing.";
  }
  if (hasServiceCommand) {
    return "The Linux service command keeps this workstation available after pairing.";
  }
  return "Keep the command running until the workstation appears in the panel.";
}

// Each optional step is hidden for a different reason; say why instead of a
// generic "run these if they apply" blurb once more than one is folded away.
function additionalSetupHelpText(
  additionalCommands: readonly NotebookWorkstationPairingCommandView[],
): string {
  const ids = new Set(additionalCommands.map((command) => command.id));
  const notes: string[] = [];
  if (ids.has("debian-prep")) {
    notes.push("Fresh Debian/Ubuntu hosts may need curl and tmux before the install command.");
  }
  if (ids.has("path")) {
    notes.push(
      "Only needed in the same terminal you ran the install command in — a new terminal already has it on PATH.",
    );
  }
  if (ids.has("foreground-run")) {
    notes.push(
      "Use the foreground fallback in tmux for macOS, non-systemd hosts, or manual testing.",
    );
  }
  if (notes.length > 0) {
    return notes.join(" ");
  }
  return "Run optional setup commands only when they match the host you are attaching.";
}

export function PairingCommandList({
  commands,
}: {
  commands: readonly NotebookWorkstationPairingCommandView[];
}) {
  const requiredCommands = commands.filter((command) => command.optional !== true);
  const primaryCommands = requiredCommands.length > 0 ? requiredCommands : commands;
  const additionalCommands =
    requiredCommands.length > 0 ? commands.filter((command) => command.optional === true) : [];
  const hasAdditionalCommands = additionalCommands.length > 0;
  const [additionalOpen, setAdditionalOpen] = useState(false);
  const bulkCommandText = primaryCommands.map((command) => command.command).join("\n");
  const hasLinuxServiceBundle = commands.some((command) =>
    command.command.includes("workstation service"),
  );
  const copyLabel = hasLinuxServiceBundle
    ? "Linux workstation setup commands"
    : "workstation setup commands";
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
          aria-label={copied ? `Copied ${copyLabel}` : `Copy ${copyLabel}`}
          title={copied ? "Copied" : `Copy ${copyLabel}`}
          disabled={!bulkCommandText}
          onClick={() => {
            void navigator.clipboard.writeText(bulkCommandText).then(() => setCopied(true));
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
        {primaryCommands.map((command, index) => (
          <PairingCommandItem key={command.id} command={command} index={index} />
        ))}
      </ol>
      {hasAdditionalCommands ? (
        <Collapsible open={additionalOpen} onOpenChange={setAdditionalOpen} className="pt-0.5">
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-1 h-7 px-1.5 text-[11px] text-muted-foreground"
              aria-label={
                additionalOpen ? "Hide additional setup options" : "Show additional setup options"
              }
            >
              <ChevronDown
                className={cn("size-3.5 transition-transform", additionalOpen && "rotate-180")}
                aria-hidden="true"
              />
              Additional setup options
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent
            className="mt-1.5 space-y-2 rounded-md border border-border/60 bg-muted/[0.03] p-2"
            data-testid="workstation-pairing-additional-commands"
          >
            <ul className="space-y-1.5">
              {additionalCommands.map((command) => (
                <PairingCommandItem key={command.id} command={command} />
              ))}
            </ul>
            <p className="leading-5 text-muted-foreground">
              {additionalSetupHelpText(additionalCommands)}
            </p>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

function PairingCommandItem({
  command,
  index,
}: {
  command: NotebookWorkstationPairingCommandView;
  index?: number;
}) {
  return (
    <li className="space-y-1">
      <div className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-muted-foreground">
        {typeof index === "number" ? (
          <span className="font-medium text-foreground">{index + 1}.</span>
        ) : null}
        <span className="truncate">{command.label}</span>
        {command.optional ? (
          <span className="shrink-0 text-muted-foreground">(optional)</span>
        ) : command.recommended ? (
          <span className="shrink-0 text-muted-foreground">(recommended)</span>
        ) : null}
      </div>
      <PairingCommand command={command.command} label={command.label} />
    </li>
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

export function PairingCountdown({ expiresAt }: { expiresAt: string }) {
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

type WorkstationFact = NotebookWorkstationFactProjection | WorkstationDetailFact;

/**
 * A workstation that has reported nothing yet yields no facts at all; an empty
 * bordered list would render as a stray rule, so say why it is blank instead.
 */
function FactRowList<Fact extends WorkstationFact>({
  facts,
  icon,
}: {
  facts: readonly Fact[];
  icon: (fact: Fact) => LucideIcon;
}) {
  if (facts.length === 0) {
    return (
      <p className="border-b border-border/70 px-4 py-2 text-xs leading-5 text-muted-foreground">
        This workstation has not reported any details yet.
      </p>
    );
  }

  return (
    <ul className="border-b border-border/70 text-xs">
      {facts.map((fact) => (
        <FactRow key={fact.kind} fact={fact} icon={icon(fact)} />
      ))}
    </ul>
  );
}

/**
 * One label/value row. Both fact projections share this shape, so capability
 * facts and registered-workstation facts render through the same row.
 */
function FactRow({ fact, icon: Icon }: { fact: WorkstationFact; icon: LucideIcon }) {
  const subtle = "subtle" in fact && fact.subtle;
  return (
    <li
      className={cn(
        "flex min-w-0 items-baseline gap-1.5 border-t border-border/70 px-4 py-1 first:border-t-0",
        subtle && "opacity-75",
      )}
      data-tone={fact.tone}
    >
      <Icon
        className={cn("size-3.5 shrink-0 translate-y-px", workstationFactIconClassName(fact.tone))}
        aria-hidden="true"
      />
      <span className="min-w-[4.5rem] shrink-0 leading-5 whitespace-nowrap text-muted-foreground">
        {fact.label}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block leading-5 font-medium",
            // Accelerator values name every device, so they wrap instead of hiding
            // devices behind an ellipsis.
            fact.kind === "accelerator" ? "break-words" : "truncate",
            fact.tone === "attention" ? "text-[var(--sev-warn)]" : "text-foreground",
          )}
        >
          {fact.value}
        </span>
        {fact.detail ? (
          <span className="block text-[11px] leading-4 text-muted-foreground">{fact.detail}</span>
        ) : null}
      </span>
    </li>
  );
}

/**
 * Panel-only fact rows. The projection's fact kinds cover reported resources;
 * provider, build, channel, and last-seen are read off the workstation itself,
 * so they widen `kind` rather than pretending to be projection facts.
 */
type WorkstationDetailFact = Omit<NotebookRegisteredWorkstationFactProjection, "kind"> & {
  kind:
    | NotebookRegisteredWorkstationFactProjection["kind"]
    | "provider"
    | "build"
    | "channel"
    | "last_seen";
};

function registeredWorkstationDetailFacts(
  workstation: NotebookRegisteredWorkstationProjection,
): readonly WorkstationDetailFact[] {
  const extras: WorkstationDetailFact[] = [];
  const push = (
    kind: WorkstationDetailFact["kind"],
    label: string,
    value: string | null,
    detail: string | null = null,
    tone: WorkstationDetailFact["tone"] = "neutral",
  ) => {
    if (!value) return;
    extras.push({ detail, kind, label, tone, value });
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

function registeredWorkstationFactIcon(kind: WorkstationDetailFact["kind"]): LucideIcon {
  switch (kind) {
    case "default_environment":
      return Boxes;
    case "cpu":
      return Cpu;
    case "memory":
      return MemoryStick;
    case "accelerator":
      return Zap;
    case "working_directory":
      return FolderOpen;
    case "provider":
      return Server;
    case "build":
      return Tag;
    case "channel":
      return GitBranch;
    case "last_seen":
      return Clock;
    default:
      return Server;
  }
}

function WorkstationStatusBadge({
  workstation,
}: {
  workstation: NotebookRegisteredWorkstationProjection;
}) {
  const status = registeredWorkstationStatusTone(workstation);
  return (
    <span
      // Tonal text on a neutral chip, so the badge reuses the row's status color
      // instead of maintaining a second per-status palette.
      className={cn(
        "shrink-0 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[10.5px] leading-4 font-medium",
        status.textClassName,
      )}
      data-testid="workstation-status-badge"
      data-status={workstation.isAttached ? "running" : workstation.status}
    >
      {workstation.isAttached ? "Running" : workstation.statusLabel}
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
