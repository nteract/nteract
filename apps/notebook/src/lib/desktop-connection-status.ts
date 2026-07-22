import type { HostAutoReconnect, HostDaemonEvents } from "@nteract/notebook-host";
import type { ConnectionStatus, HostedBridgeStatus } from "runtimed";
import type { Observable } from "rxjs";
import type { NotebookConnectionStatusSource } from "@/components/notebook";

export interface DesktopConnectionStatusSource extends NotebookConnectionStatusSource {
  getCurrent(): ConnectionStatus;
  /** Detach from the daemon events (app teardown). */
  dispose(): void;
}

/**
 * Desktop connection-status source for the connection/identity slot,
 * derived from daemon lifecycle events and the host's reconnect governor.
 *
 * The Tauri IPC transport's own `connectionStatus$` is honest about IPC
 * but constant in practice — the app never disconnects it, so a dot fed
 * from it could never transition (it would sit emerald through a daemon
 * restart, exactly the window where kernel/execution chrome freezes). The
 * daemon link is the first hop of any remote context the slot renders.
 * Hosted notebooks additionally project the daemon-owned outbound bridge
 * health through the session-control lane, so an online first hop cannot
 * hide a reconnecting or terminal daemon↔room link.
 *
 * - `onReady` → "online" (the host facade backfills from its cache, so a
 *   source created after the daemon is already up still reaches "online")
 * - `onDisconnected` → "reconnecting" while the governor is armed (the
 *   host redials on its own), but "offline" when the governor is latched
 *   terminal, nothing is redialing, so a reconnecting dot would lie
 * - a governor transition into "latched" demotes a live "reconnecting"
 *   dot to "offline" (covers a latch that lands after the disconnect)
 * - `onUnavailable` → "offline"
 * - hosted bridge connecting/reconnecting → matching transitional state
 * - hosted bridge authentication/terminal failure → "offline"
 */
export function createDesktopConnectionStatusSource(
  daemonEvents: Pick<HostDaemonEvents, "onReady" | "onDisconnected" | "onUnavailable">,
  autoReconnect?: Pick<HostAutoReconnect, "getState" | "state$">,
  hostedBridgeStatus$?: Observable<HostedBridgeStatus>,
): DesktopConnectionStatusSource {
  let current: ConnectionStatus = "connecting";
  let daemonStatus: ConnectionStatus = "connecting";
  let hostedBridgeStatus: HostedBridgeStatus = "not_applicable";
  const listeners = new Set<(status: ConnectionStatus) => void>();
  const next = (status: ConnectionStatus) => {
    if (status === current) return;
    current = status;
    for (const listener of listeners) {
      listener(status);
    }
  };

  const project = () => {
    if (daemonStatus !== "online") return daemonStatus;
    switch (hostedBridgeStatus) {
      case "not_applicable":
      case "connected":
        return "online";
      case "connecting":
        return "connecting";
      case "reconnecting":
        return "reconnecting";
      case "authentication_failed":
      case "terminal_error":
        return "offline";
    }
  };
  const update = () => next(project());

  const unlisteners = [
    daemonEvents.onReady(() => {
      daemonStatus = "online";
      update();
    }),
    daemonEvents.onDisconnected(() => {
      daemonStatus = autoReconnect?.getState().kind === "latched" ? "offline" : "reconnecting";
      update();
    }),
    daemonEvents.onUnavailable(() => {
      daemonStatus = "offline";
      update();
    }),
  ];

  const latchSubscription = autoReconnect?.state$.subscribe((state) => {
    if (state.kind === "latched" && daemonStatus === "reconnecting") {
      daemonStatus = "offline";
      update();
    }
  });

  const hostedBridgeSubscription = hostedBridgeStatus$?.subscribe((status) => {
    hostedBridgeStatus = status;
    update();
  });

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
      latchSubscription?.unsubscribe();
      hostedBridgeSubscription?.unsubscribe();
      listeners.clear();
    },
  };
}
