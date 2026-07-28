import { useEffect, useId, useState } from "react";
import { Check, ChevronDown, CircleAlert, CircleCheck, Copy, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

export interface WorkstationConnectDialogProps {
  pairing: NotebookWorkstationPairingView | null;
  onCancel?: () => void;
  onRestart?: () => void;
}

/**
 * The "Connect a machine" surface. Mount it once per host — above the rail
 * rather than inside the workstations panel — so a prompt raised from the
 * notice bar still opens it while the rail shows another panel.
 */
export function WorkstationConnectDialog({
  pairing,
  onCancel,
  onRestart,
}: WorkstationConnectDialogProps) {
  return (
    <Dialog
      open={pairing !== null}
      onOpenChange={(open) => {
        if (!open) onCancel?.();
      }}
    >
      {pairing ? (
        <DialogContent
          // The command list grows with the host's setup steps and the optional
          // disclosure, so it can outgrow a laptop viewport; without this the
          // footer scrolls off with no way back to Cancel.
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[520px]"
          aria-label="Connect a machine"
          data-testid="workstation-connect-dialog"
        >
          <DialogHeader>
            <DialogTitle>Connect a machine</DialogTitle>
            <DialogDescription>
              Connect a machine you own to run this notebook&rsquo;s compute there. We never
              provision hardware &mdash; you bring your own.
            </DialogDescription>
          </DialogHeader>

          <WorkstationConnectBody pairing={pairing} />

          <DialogFooter>
            {pairing.status === "expired" && onRestart ? (
              <Button type="button" variant="outline" size="sm" onClick={onRestart}>
                Generate a new code
              </Button>
            ) : null}
            {onCancel ? (
              <Button
                type="button"
                variant={pairing.status === "registered" ? "default" : "outline"}
                size="sm"
                onClick={onCancel}
              >
                {pairing.status === "registered" ? "Done" : "Cancel"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function WorkstationConnectBody({ pairing }: { pairing: NotebookWorkstationPairingView }) {
  const structuredCommands =
    pairing.commands && pairing.commands.length > 0 ? pairing.commands : null;
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

  if (pairing.status === "registered") {
    return (
      <div className="space-y-3 text-xs">
        <div className="flex min-w-0 items-center gap-2 text-sm text-foreground">
          <CircleCheck className="size-4 shrink-0 text-[var(--sev-ok)]" aria-hidden="true" />
          <span data-testid="workstation-pairing-status" aria-live="polite">
            {pairing.workstationName ?? "Workstation"} is connected.
          </span>
        </div>
        {structuredCommands ? (
          <>
            <p className="leading-5 text-muted-foreground">
              Finish setup with the keep-available command if you have not run it yet:
            </p>
            <PairingCommandList commands={pairingCommands} />
            {hasAdditionalCommands ? null : (
              <p className="leading-5 text-muted-foreground">{serviceHelpText}</p>
            )}
          </>
        ) : null}
      </div>
    );
  }

  if (pairing.status === "expired") {
    return (
      <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <CircleAlert className="size-4 shrink-0 text-[var(--sev-warn)]" aria-hidden="true" />
        <span data-testid="workstation-pairing-status" aria-live="polite">
          {pairing.error ?? "The pairing code expired before a machine connected."}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-3 text-xs">
      {pairing.code ? (
        <div className="flex flex-col items-center gap-2 rounded-md border border-border bg-muted/40 px-5 py-4">
          <div className="text-[10.5px] font-medium uppercase tracking-normal text-muted-foreground">
            Pairing code
          </div>
          <div className="font-mono text-2xl font-bold tracking-[0.1em]">{pairing.code}</div>
        </div>
      ) : null}
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
          <span
            className="inline-flex items-center gap-1.5"
            data-testid="workstation-pairing-status"
          >
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
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

function PairingCommandList({
  commands,
}: {
  commands: readonly NotebookWorkstationPairingCommandView[];
}) {
  const requiredCommands = commands.filter((command) => command.optional !== true);
  const primaryCommands = requiredCommands.length > 0 ? requiredCommands : commands;
  const additionalCommands =
    requiredCommands.length > 0 ? commands.filter((command) => command.optional === true) : [];
  const hasAdditionalCommands = additionalCommands.length > 0;
  const additionalPanelId = useId();
  const [additionalOpen, setAdditionalOpen] = useState(false);
  const bulkCommandText = primaryCommands.map((command) => command.command).join("\n");
  const hasLinuxServiceBundle = commands.some((command) =>
    command.command.includes("workstation service"),
  );
  const hasForegroundFallback = commands.some((command) => command.id === "foreground-run");
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
            <Check className="size-3.5 text-[var(--sev-ok)]" aria-hidden="true" />
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
        <div className="pt-0.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-1 h-7 px-1.5 text-[11px] text-muted-foreground"
            aria-expanded={additionalOpen}
            aria-controls={additionalPanelId}
            aria-label={
              additionalOpen ? "Hide additional setup options" : "Show additional setup options"
            }
            onClick={() => setAdditionalOpen((open) => !open)}
          >
            <ChevronDown
              className={cn("size-3.5 transition-transform", additionalOpen && "rotate-180")}
              aria-hidden="true"
            />
            Additional setup options
          </Button>
          {additionalOpen ? (
            <div
              id={additionalPanelId}
              className="mt-1.5 space-y-2 rounded-md border border-border/60 bg-muted/[0.03] p-2"
              data-testid="workstation-pairing-additional-commands"
            >
              <ul className="space-y-1.5">
                {additionalCommands.map((command) => (
                  <PairingCommandItem key={command.id} command={command} />
                ))}
              </ul>
              <p className="leading-5 text-muted-foreground">
                {hasLinuxServiceBundle && hasForegroundFallback
                  ? "Fresh Debian/Ubuntu hosts may need curl and tmux before the install command. Use the foreground fallback in tmux for macOS, non-systemd hosts, or manual testing."
                  : "Run optional setup commands only when they match the host you are attaching."}
              </p>
            </div>
          ) : null}
        </div>
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
          <Check className="size-3.5 text-[var(--sev-ok)]" aria-hidden="true" />
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
