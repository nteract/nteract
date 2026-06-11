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
}

/**
 * NotebookConnectionIdentity — the connection/identity slot.
 *
 * Self-identity (the flattened avatar treatment) paired with a
 * connectivity dot driven by the transport's `connectionStatus$` — its
 * first UI consumer. Runtime-state stores are deliberately not blanked
 * while a transport reconnects, so this dot is what makes frozen
 * kernel/execution chrome interpretable during the offline window.
 *
 * Quiet-chrome rules (distilled from the pulled #3273/#3290/#3337/#3349
 * designs — hard constraints, not preferences):
 * - renders NOTHING for a purely local desktop session
 *   (`isRemoteNotebookContext`); local identity is noise, not chrome;
 * - flat `rounded-md border-border/70 bg-muted/35`, never
 *   rounded-full + shadow;
 * - icon/avatar-first and icon-only at every width: no visible text pill —
 *   the label and status live in `sr-only` copy and the title tooltip;
 * - state expresses as dot color / opacity, never copy;
 * - errors and reconnect prompts belong to the notices stack, never here;
 * - connection state never masquerades as kernel/runtime status.
 */
export interface NotebookConnectionIdentityProps {
  capabilities: NotebookShellCapabilities;
  /**
   * Connection lifecycle from the live transport. Hosts must hand a source
   * that survives transport replacement (cloud: the session's
   * `CloudConnectionStatusBridge`; desktop: the host transport, which is
   * stable for the app's lifetime).
   */
  connectionStatus$: NotebookConnectionStatusSource;
  className?: string;
}

export function NotebookConnectionIdentity({
  capabilities,
  connectionStatus$,
  className,
}: NotebookConnectionIdentityProps) {
  const status = useConnectionStatus(connectionStatus$);

  // Conditionality is the point (#3290): a purely local desktop session
  // gets no identity chrome at all.
  if (!isRemoteNotebookContext(capabilities)) {
    return null;
  }

  const actor = notebookToolbarActors(capabilities)[0];
  if (!actor) {
    return null;
  }

  const statusLabel = connectionStatusLabel(status);
  const detail = `${actor.label} — ${statusLabel}`;

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
      <NotebookActorAvatar actor={actor} size="sm" statusClassName={connectionDotTone(status)} />
      <span className="sr-only">{detail}</span>
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

function useConnectionStatus(status$: NotebookConnectionStatusSource): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  useEffect(() => {
    const subscription = status$.subscribe((next) => setStatus(next));
    return () => subscription.unsubscribe();
  }, [status$]);
  return status;
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
