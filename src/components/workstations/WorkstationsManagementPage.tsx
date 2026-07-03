import { useState } from "react";
import { ArrowUpRight, CircleAlert, CircleCheck, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  PairingCommandList,
  PairingCountdown,
  type NotebookWorkstationPairingView,
} from "@/components/notebook/NotebookWorkstationsPanel";
import { LanguageMark } from "@/components/runtime/LanguageMark";
import { RuntimeStatusDot } from "@/components/runtime/RuntimeStatusDot";
import { cn } from "@/lib/utils";
import type { WorkstationsPageItemView, WorkstationsPageView } from "./workstations-page-model";

/**
 * Full-page management surface for a user's own remote workstations: the
 * machines they've paired (or been granted), what's running on them, and the
 * pairing/unpair lifecycle. Attaching compute stays on the notebook side by
 * design — this page never grows a Connect button.
 *
 * Presentational and host-driven: every mutation is an optional callback, and
 * action affordances only render for callbacks the host provides. Hosts
 * without an API for a section (kernel inventory, idle policy, transport
 * controls) simply omit the data or callback and the section disappears.
 */
export interface WorkstationsManagementPageProps {
  view: WorkstationsPageView;
  selectedId: string | null;
  onSelect: (workstationId: string) => void;
  busyWorkstationId?: string | null;
  pairing?: NotebookWorkstationPairingView | null;
  onStartPairing?: () => void;
  onCancelPairing?: () => void;
  onUnpair?: (workstationId: string) => void;
  onReconnect?: (workstationId: string) => void;
  onRestart?: (workstationId: string) => void;
  onDisconnect?: (workstationId: string) => void;
  onOpenKernel?: (workstationId: string, kernelId: string) => void;
  onSetIdlePolicyEnabled?: (workstationId: string, enabled: boolean) => void;
  onSetIdleMinutes?: (workstationId: string, minutes: number) => void;
  className?: string;
}

export function WorkstationsManagementPage({
  view,
  selectedId,
  onSelect,
  busyWorkstationId = null,
  pairing = null,
  onStartPairing,
  onCancelPairing,
  onUnpair,
  onReconnect,
  onRestart,
  onDisconnect,
  onOpenKernel,
  onSetIdlePolicyEnabled,
  onSetIdleMinutes,
  className,
}: WorkstationsManagementPageProps) {
  const selected = view.items.find((item) => item.id === selectedId) ?? null;
  const [unpairCandidateId, setUnpairCandidateId] = useState<string | null>(null);
  const unpairCandidate = view.items.find((item) => item.id === unpairCandidateId) ?? null;

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-[0_1px_3px_rgba(0,0,0,0.05)]",
        className,
      )}
      data-testid="workstations-management-page"
    >
      <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
        <div className="flex min-w-0 items-baseline gap-3">
          <h2 className="text-[15px] font-semibold">Workstations</h2>
          <span className="truncate text-[12.5px] text-muted-foreground">{view.summaryLabel}</span>
        </div>
        {onStartPairing ? (
          <Button
            type="button"
            size="sm"
            onClick={onStartPairing}
            data-testid="workstations-page-add"
          >
            <Plus className="size-3.5" aria-hidden="true" />
            Add workstation
          </Button>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1">
        <aside
          className="flex w-[392px] shrink-0 flex-col border-r border-border"
          aria-label="Paired machines"
        >
          <div className="border-b border-border px-4 py-2.5 text-[11px] uppercase tracking-[0.07em] text-muted-foreground">
            Paired machines
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {view.items.length === 0 ? (
              <p className="px-4 py-6 text-xs leading-5 text-muted-foreground">
                No workstations paired yet. Add one to run notebook compute on a machine you own.
              </p>
            ) : (
              view.items.map((item) => (
                <WorkstationListRow
                  key={item.id}
                  item={item}
                  selected={item.id === selectedId}
                  onSelect={onSelect}
                />
              ))
            )}
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col" aria-label="Workstation detail">
          {selected ? (
            <WorkstationDetail
              item={selected}
              busy={busyWorkstationId === selected.id}
              onUnpair={onUnpair ? () => setUnpairCandidateId(selected.id) : undefined}
              onReconnect={onReconnect}
              onRestart={onRestart}
              onDisconnect={onDisconnect}
              onOpenKernel={onOpenKernel}
              onSetIdlePolicyEnabled={onSetIdlePolicyEnabled}
              onSetIdleMinutes={onSetIdleMinutes}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center px-10 text-center text-[13.5px] text-muted-foreground">
              Select a workstation to see its kernels and settings.
            </div>
          )}
        </section>
      </div>

      <WorkstationPairingDialog
        pairing={pairing}
        onCancel={onCancelPairing}
        onRestartPairing={onStartPairing}
      />

      <Dialog
        open={unpairCandidate !== null}
        onOpenChange={(open) => {
          if (!open) setUnpairCandidateId(null);
        }}
      >
        {unpairCandidate ? (
          <DialogContent className="sm:max-w-[440px]" showCloseButton={false}>
            <DialogHeader>
              <DialogTitle className="text-[17px]">Unpair {unpairCandidate.name}?</DialogTitle>
              <DialogDescription className="text-[13px] leading-[1.55]">
                We&rsquo;ll forget this machine and stop showing its kernels here. The workstation
                and everything on it stays put &mdash; you can pair it again anytime with a new
                code.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setUnpairCandidateId(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                data-testid="workstations-page-unpair-confirm"
                onClick={() => {
                  onUnpair?.(unpairCandidate.id);
                  setUnpairCandidateId(null);
                }}
              >
                Unpair workstation
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}

function WorkstationListRow({
  item,
  selected,
  onSelect,
}: {
  item: WorkstationsPageItemView;
  selected: boolean;
  onSelect: (workstationId: string) => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-stretch gap-3 py-[11px] pl-3.5 pr-4 text-left",
        selected ? "bg-muted" : "hover:bg-muted",
      )}
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(item.id)}
      data-testid="workstations-page-row"
    >
      <span className="ws-spine" data-status={item.spineStatus} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate font-mono text-sm font-semibold">{item.name}</span>
          {item.sourceLabel ? <WorkstationSourcePill label={item.sourceLabel} /> : null}
        </span>
        <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">
          {item.rowSublineLabel}
        </span>
      </span>
      <span className="shrink-0 self-center text-right">
        {item.kernelCountLabel ? (
          <span
            className={cn(
              "block text-[11.5px] font-semibold tabular-nums",
              item.hasLiveKernels ? "text-[var(--live-ink)]" : "text-muted-foreground",
            )}
          >
            {item.kernelCountLabel}
          </span>
        ) : null}
        {item.lastSeenLabel ? (
          <span className="mt-0.5 block whitespace-nowrap text-[10.5px] text-muted-foreground">
            {item.lastSeenLabel}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function WorkstationSourcePill({ label, subdued = false }: { label: string; subdued?: boolean }) {
  return (
    <span
      className={cn(
        "shrink-0 whitespace-nowrap rounded-full border border-border font-medium text-muted-foreground",
        subdued ? "bg-muted px-2 py-0.5 text-[11px]" : "px-1.5 py-px text-[10px]",
      )}
    >
      {label}
    </span>
  );
}

function WorkstationDetail({
  item,
  busy,
  onUnpair,
  onReconnect,
  onRestart,
  onDisconnect,
  onOpenKernel,
  onSetIdlePolicyEnabled,
  onSetIdleMinutes,
}: {
  item: WorkstationsPageItemView;
  busy: boolean;
  onUnpair?: () => void;
  onReconnect?: (workstationId: string) => void;
  onRestart?: (workstationId: string) => void;
  onDisconnect?: (workstationId: string) => void;
  onOpenKernel?: (workstationId: string, kernelId: string) => void;
  onSetIdlePolicyEnabled?: (workstationId: string, enabled: boolean) => void;
  onSetIdleMinutes?: (workstationId: string, minutes: number) => void;
}) {
  const hasActions = Boolean(onReconnect || onRestart || onDisconnect);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="workstations-page-detail">
      <div className="border-b border-border px-6 pb-[18px] pt-[22px]">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                className="ws-spine ws-spine-mark"
                data-status={item.spineStatus}
                aria-hidden="true"
              />
              <h3 className="truncate font-mono text-xl font-semibold tracking-tight">
                {item.name}
              </h3>
              {item.sourceLabel ? <WorkstationSourcePill label={item.sourceLabel} subdued /> : null}
            </div>
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              {item.detailContextLabel ? <>{item.detailContextLabel} &middot; </> : null}
              <span className="font-medium text-foreground">{item.statusLabel}</span>
            </p>
            {item.statusMessage ? (
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.statusMessage}</p>
            ) : null}
          </div>
          {onUnpair ? (
            <button
              type="button"
              className="shrink-0 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-muted-foreground hover:bg-muted hover:text-destructive"
              onClick={onUnpair}
              data-testid="workstations-page-unpair"
            >
              Unpair
            </button>
          ) : null}
        </div>

        {hasActions ? (
          <div className="mt-4 flex gap-2">
            {onReconnect ? (
              <Button
                type="button"
                size="sm"
                disabled={!item.canReconnect || busy}
                onClick={() => onReconnect(item.id)}
              >
                Reconnect
              </Button>
            ) : null}
            {onRestart ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!item.canRestart || busy}
                onClick={() => onRestart(item.id)}
              >
                Restart
              </Button>
            ) : null}
            {onDisconnect ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!item.canDisconnect || busy}
                onClick={() => onDisconnect(item.id)}
              >
                Disconnect
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-[26px] pt-5">
        {item.specs.length > 0 ? (
          <div
            className="mb-6 grid gap-px overflow-hidden rounded-[10px] border border-border bg-border"
            style={{
              gridTemplateColumns: `repeat(${Math.min(item.specs.length, 4)}, minmax(0, 1fr))`,
            }}
          >
            {item.specs.map((spec) => (
              <div key={spec.key} className="bg-card px-3.5 py-3">
                <div className="text-[10.5px] uppercase tracking-[0.06em] text-muted-foreground">
                  {spec.label}
                </div>
                <div
                  className={cn(
                    "mt-0.5 truncate font-mono text-[15px] font-semibold",
                    spec.uvInk && "text-uv",
                  )}
                  title={spec.value}
                >
                  {spec.value}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {item.kernels !== null ? (
          <>
            <div className="mb-2.5 flex items-baseline justify-between">
              <h4 className="text-[13px] font-semibold">Hosted kernels</h4>
              {item.detailKernelCountLabel ? (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {item.detailKernelCountLabel}
                </span>
              ) : null}
            </div>
            {item.kernels.length > 0 ? (
              <div className="divide-y divide-border overflow-hidden rounded-[10px] border border-border">
                {item.kernels.map((kernel) => (
                  <button
                    key={kernel.id}
                    type="button"
                    className="flex w-full items-center gap-3 px-3.5 py-3 text-left hover:bg-muted"
                    onClick={() => onOpenKernel?.(item.id, kernel.id)}
                    data-testid="workstations-page-kernel"
                  >
                    <LanguageMark language={kernel.languageLabel} size={16} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[13.5px] font-medium">
                        {kernel.notebookLabel}
                      </span>
                      <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
                        {kernel.languageLabel}
                      </span>
                    </span>
                    <RuntimeStatusDot status={kernel.status} showLabel />
                    {onOpenKernel ? (
                      <span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
                        Open
                        <ArrowUpRight className="size-3.5" aria-hidden="true" />
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : (
              <div className="rounded-[10px] border border-dashed border-border px-5 py-5 text-center text-[13px] text-muted-foreground">
                {item.kernelsEmptyLabel}
              </div>
            )}
          </>
        ) : null}

        <p className="mt-2.5 text-xs leading-5 text-muted-foreground">
          Compute sessions attach from a notebook &mdash; open a notebook and pick this workstation
          to start a kernel here.
        </p>

        {item.idlePolicy ? (
          <div className="mt-6 rounded-[10px] border border-border px-4 pb-[18px] pt-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h4 className="text-[13px] font-semibold">Idle auto-shutdown</h4>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  {item.idlePolicy.enabled
                    ? `Sleeps after ${item.idlePolicy.minutes} min idle. Running kernels keep it awake.`
                    : "Stays awake until you disconnect it manually."}
                </p>
              </div>
              <Switch
                checked={item.idlePolicy.enabled}
                onCheckedChange={(checked) => onSetIdlePolicyEnabled?.(item.id, checked)}
                aria-label="Idle auto-shutdown"
                className="shrink-0"
              />
            </div>
            <div className={cn("mt-3.5 flex gap-1.5", !item.idlePolicy.enabled && "opacity-45")}>
              {item.idlePolicy.minuteOptions.map((minutes) => {
                const active = minutes === item.idlePolicy?.minutes;
                return (
                  <button
                    key={minutes}
                    type="button"
                    disabled={!item.idlePolicy?.enabled}
                    className={cn(
                      "rounded-lg border px-3 py-[5px] text-xs font-medium",
                      active
                        ? "border-foreground bg-foreground text-background"
                        : "border-border bg-card text-foreground enabled:hover:bg-muted",
                    )}
                    onClick={() => onSetIdleMinutes?.(item.id, minutes)}
                  >
                    {minutes}m
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function WorkstationPairingDialog({
  pairing,
  onCancel,
  onRestartPairing,
}: {
  pairing: NotebookWorkstationPairingView | null;
  onCancel?: () => void;
  onRestartPairing?: () => void;
}) {
  const commands =
    pairing && pairing.commands && pairing.commands.length > 0
      ? pairing.commands
      : pairing
        ? [{ id: "connect", label: "Pair this workstation", command: pairing.connectCommand }]
        : [];

  return (
    <Dialog
      open={pairing !== null}
      onOpenChange={(open) => {
        if (!open) onCancel?.();
      }}
    >
      {pairing ? (
        <DialogContent className="sm:max-w-[480px]" data-testid="workstations-page-pairing-dialog">
          <DialogHeader>
            <DialogTitle className="text-[17px]">Add a workstation</DialogTitle>
            <DialogDescription className="text-[13px] leading-[1.55]">
              Install the nteract agent on the machine you want to pair, then enter this code. We
              never provision hardware &mdash; you bring your own compute.
            </DialogDescription>
          </DialogHeader>

          {pairing.status === "registered" ? (
            <div className="flex min-w-0 items-center gap-2 text-sm text-foreground">
              <CircleCheck className="size-4 shrink-0 text-emerald-500" aria-hidden="true" />
              <span aria-live="polite">
                {pairing.workstationName ?? "Workstation"} is connected.
              </span>
            </div>
          ) : pairing.status === "expired" ? (
            <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
              <CircleAlert className="size-4 shrink-0 text-amber-500" aria-hidden="true" />
              <span aria-live="polite">
                {pairing.error ?? "The pairing code expired before a machine connected."}
              </span>
            </div>
          ) : (
            <>
              {pairing.code ? (
                <div className="flex flex-col items-center gap-2.5 rounded-xl border border-border bg-muted px-5 py-5">
                  <div className="text-[11px] uppercase tracking-[0.09em] text-muted-foreground">
                    Pairing code
                  </div>
                  <div className="font-mono text-3xl font-bold tracking-[0.1em]">
                    {pairing.code}
                  </div>
                </div>
              ) : null}
              <PairingCommandList commands={commands} />
              <p className="text-xs leading-5 text-muted-foreground" aria-live="polite">
                {pairing.status === "redeemed" ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    Machine connected; registering&hellip;
                  </span>
                ) : (
                  <span>
                    Waiting for this machine to connect.
                    <PairingCountdown expiresAt={pairing.expiresAt} />
                  </span>
                )}
              </p>
            </>
          )}

          <DialogFooter>
            {pairing.status === "expired" && onRestartPairing ? (
              <Button type="button" variant="outline" size="sm" onClick={onRestartPairing}>
                Generate a new code
              </Button>
            ) : null}
            <Button
              type="button"
              variant={pairing.status === "registered" ? "default" : "outline"}
              size="sm"
              onClick={onCancel}
            >
              {pairing.status === "registered" ? "Done" : "Cancel"}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
