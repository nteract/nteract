import type { HostDaemonEvents } from "@nteract/notebook-host";
import type { ConnectionStatus } from "runtimed";
import type { NotebookConnectionStatusSource } from "@/components/notebook";

export interface DesktopConnectionStatusSource extends NotebookConnectionStatusSource {
  getCurrent(): ConnectionStatus;
  /** Detach from the daemon events (app teardown). */
  dispose(): void;
}

/**
 * Desktop connection-status source for the connection/identity slot,
 * derived from daemon lifecycle events.
 *
 * The Tauri IPC transport's own `connectionStatus$` is honest about IPC
 * but constant in practice — the app never disconnects it, so a dot fed
 * from it could never transition (it would sit emerald through a daemon
 * restart, exactly the window where kernel/execution chrome freezes). The
 * daemon link is the first hop of any remote context the slot renders
 * for, and `daemon:ready` / `daemon:disconnected` / `daemon:unavailable`
 * are the real lifecycle the desktop can report today. Daemon↔room link
 * health is future work; the slot's copy is scoped to the daemon link via
 * its `connectionLabel`.
 *
 * - `onReady` → "online" (the host facade backfills from its cache, so a
 *   source created after the daemon is already up still reaches "online")
 * - `onDisconnected` → "reconnecting" (the host immediately starts its own
 *   reconnect — "reconnecting" is the truthful state, not "offline")
 * - `onUnavailable` → "offline"
 */
export function createDesktopConnectionStatusSource(
  daemonEvents: Pick<HostDaemonEvents, "onReady" | "onDisconnected" | "onUnavailable">,
): DesktopConnectionStatusSource {
  let current: ConnectionStatus = "connecting";
  const listeners = new Set<(status: ConnectionStatus) => void>();
  const next = (status: ConnectionStatus) => {
    if (status === current) return;
    current = status;
    for (const listener of listeners) {
      listener(status);
    }
  };

  const unlisteners = [
    daemonEvents.onReady(() => next("online")),
    daemonEvents.onDisconnected(() => next("reconnecting")),
    daemonEvents.onUnavailable(() => next("offline")),
  ];

  return {
    getCurrent: () => current,
    subscribe(listener) {
      listener(current);
      listeners.add(listener);
      return { unsubscribe: () => listeners.delete(listener) };
    },
    dispose() {
      for (const unlisten of unlisteners) {
        unlisten();
      }
      listeners.clear();
    },
  };
}
