import { useEffect, useState } from "react";
import type { ConnectionStatus } from "runtimed";
import { cn } from "@/lib/utils";
import { NotebookActorAvatar } from "./NotebookIdentity";
import { notebookToolbarActors } from "./NotebookToolbarIdentity";
import type { NotebookShellCapabilities } from "./capabilities";

/**
 * Structural subset of an RxJS `Observable<ConnectionStatus>` — keeps the
 * shared component free of a direct rxjs dependency while accepting the
 * transports' `connectionStatus$` and the cloud session's bridge directly.
 */
export interface NotebookConnectionStatusSource {
  subscribe(next: (status: ConnectionStatus) => void): { unsubscribe(): void };
  /**
   * Optional synchronous snapshot for first paint. BehaviorSubject-backed
   * sources (the cloud bridge, the desktop daemon source) implement it so
   * the first committed frame shows the real status instead of a one-frame
   * "connecting" flash.
   */
  getCurrent?(): ConnectionStatus;
}

/**
 * NotebookConnectionIdentity — the connection/identity slot.
 *
 * Self-identity (the flattened avatar treatment) paired with a
 * connectivity dot driven by a connection-status source — its first UI
 * consumer. Runtime-state stores are deliberately not blanked while a
 * transport reconnects, so this dot is what makes frozen kernel/execution
 * chrome interpretable during the offline window — for the link the host
 * actually measures: the cloud room transport on cloud, the daemon link on
 * desktop (daemon↔room health is future work; `connectionLabel` scopes the
 * copy to the measured link so the dot never overclaims).
 *
 * Quiet-chrome rules (distilled from the pulled #3273/#3290/#3337/#3349
 * designs — hard constraints, not preferences):
 * - renders NOTHING for a purely local desktop session
 *   (`isRemoteNotebookContext`); local identity is noise, not chrome;
 * - flat `rounded-md border-border/70 bg-muted/35`, never
 *   rounded-full + shadow;
 * - icon/avatar-first and icon-only at every width: no visible text pill —
 *   the label and status live in `sr-only` copy and the title tooltip;
 * - state expresses as dot color / opacity, never copy; status CHANGES are
 *   announced through a polite sr-only live region (quiet for the eyes is
 *   not silence for screen readers);
 * - errors and reconnect prompts belong to the notices stack, never here;
 * - connection state never masquerades as kernel/runtime status.
 */
export interface NotebookConnectionIdentityProps {
  capabilities: NotebookShellCapabilities;
  /**
   * Connection lifecycle source. Hosts must hand a source that survives
   * transport replacement (cloud: the session's
   * `CloudConnectionStatusBridge`; desktop: the daemon-lifecycle source,
   * stable for the app's lifetime).
   */
  connectionStatus$: NotebookConnectionStatusSource;
  /**
   * Names the link the source measures, e.g. "Daemon connection" on
   * desktop. Scopes the title/sr-only copy and the live-region
   * announcements so the dot never asserts health it does not observe.
   */
  connectionLabel?: string;
  className?: string;
}

export function NotebookConnectionIdentity({
  capabilities,
  connectionStatus$,
  connectionLabel,
  className,
}: NotebookConnectionIdentityProps) {
  const { status, announcedStatus } = useConnectionStatus(connectionStatus$);
  const statusText = formatStatusText(status, connectionLabel);
  const announcement = announcedStatus ? formatStatusText(announcedStatus, connectionLabel) : "";

  // Conditionality is the point (#3290): a purely local desktop session
  // gets no identity chrome at all.
  if (!isRemoteNotebookContext(capabilities)) {
    return null;
  }

  const actor = notebookToolbarActors(capabilities)[0];
  if (!actor) {
    return null;
  }

  const detail = `${actor.label} — ${statusText}`;

  return (
    <div
      className={cn(
        "inline-flex shrink-0 items-center rounded-md border border-border/70 bg-muted/35 px-1.5 py-0.5",
        status !== "online" && "opacity-60",
        className,
      )}
      data-slot="notebook-connection-identity"
      data-state={status}
      data-actor-kind={actor.kind}
      title={detail}
    >
      {/* The visual layer is hidden from the a11y tree (avatar initials
          would otherwise leak ahead of the sr-only copy). */}
      <span aria-hidden="true">
        <NotebookActorAvatar actor={actor} size="sm" statusClassName={connectionDotTone(status)} />
      </span>
      <span className="sr-only">{detail}</span>
      {/* Announces status CHANGES only — empty on initial render so a mount
          never speaks, and sources dedup repeated values so flaps don't
          spam. */}
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}

/**
 * Remote-context predicate: cloud is always remote; a desktop session is
 * remote only when its access is server-assigned or a runtime peer is the
 * compute target.
 */
export function isRemoteNotebookContext(capabilities: NotebookShellCapabilities): boolean {
  return (
    capabilities.access.source !== "local" || capabilities.runtime.target?.kind === "runtime_peer"
  );
}

function useConnectionStatus(status$: NotebookConnectionStatusSource): {
  status: ConnectionStatus;
  /** Set only on a CHANGE the source delivered after its initial value. */
  announcedStatus: ConnectionStatus | null;
} {
  const [status, setStatus] = useState<ConnectionStatus>(
    () => status$.getCurrent?.() ?? "connecting",
  );
  const [announcedStatus, setAnnouncedStatus] = useState<ConnectionStatus | null>(null);
  useEffect(() => {
    // The first delivery (BehaviorSubject replay) is the baseline, never an
    // announcement — only subsequent transitions speak.
    let baseline: ConnectionStatus | null = null;
    let delivered = false;
    const subscription = status$.subscribe((next) => {
      setStatus(next);
      if (!delivered) {
        delivered = true;
        baseline = next;
        return;
      }
      if (next !== baseline) {
        baseline = next;
        setAnnouncedStatus(next);
      }
    });
    return () => subscription.unsubscribe();
  }, [status$]);
  return { status, announcedStatus };
}

function formatStatusText(status: ConnectionStatus, connectionLabel?: string): string {
  const label = connectionStatusLabel(status);
  return connectionLabel ? `${connectionLabel}: ${label}` : label;
}

/** Existing statusTone vocabulary: emerald active, amber attention, muted offline. */
function connectionDotTone(status: ConnectionStatus): string {
  switch (status) {
    case "online":
      return "bg-emerald-500";
    case "connecting":
    case "reconnecting":
      return "animate-pulse bg-amber-500";
    case "offline":
      return "bg-muted";
  }
}

function connectionStatusLabel(status: ConnectionStatus): string {
  switch (status) {
    case "online":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "offline":
      return "Offline";
  }
}
