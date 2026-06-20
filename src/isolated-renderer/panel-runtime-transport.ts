import type { JsonRpcTransport } from "@/components/isolated/jsonrpc-transport";
import {
  NTERACT_PANEL_ACK,
  NTERACT_PANEL_CHANNEL_CLOSE,
  NTERACT_PANEL_CHANNEL_OPEN,
  NTERACT_PANEL_CLIENT_PATCH,
  NTERACT_PANEL_DISCONNECTED,
  NTERACT_PANEL_SERVER_PATCH,
  type NteractPanelAckParams,
  type NteractPanelChannelCloseParams,
  type NteractPanelChannelOpenParams,
  type NteractPanelClientPatchParams,
  type NteractPanelDisconnectedParams,
  type NteractPanelServerPatchParams,
} from "@/components/isolated/rpc-methods";

type PanelRuntimeTransport = Pick<JsonRpcTransport, "notify" | "onNotification">;
type PanelRuntimeTransportGetter = () => PanelRuntimeTransport | null;

interface PanelCommManager {
  receiveServerPatch?: (payload: NteractPanelServerPatchParams) => void;
  receiveAck?: (payload: NteractPanelAckParams) => void;
  setDisconnected?: (payload: NteractPanelDisconnectedParams) => void;
}

export interface NteractPanelRuntime {
  attachCommManager(manager: PanelCommManager): void;
  registerTarget(payload: NteractPanelChannelOpenParams): void;
  sendClientPatch(payload: NteractPanelClientPatchParams): void;
  closeChannel(payload: NteractPanelChannelCloseParams): void;
  receiveServerPatch(payload: NteractPanelServerPatchParams): void;
  receiveAck(payload: NteractPanelAckParams): void;
  setDisconnected(payload: NteractPanelDisconnectedParams): void;
}

let activeTransport: PanelRuntimeTransportGetter = () => null;

declare global {
  interface Window {
    __nteractPanelRuntime?: NteractPanelRuntime;
  }
}

export function installPanelRuntimeTransport(
  getTransport: PanelRuntimeTransportGetter,
): NteractPanelRuntime {
  activeTransport = getTransport;
  const existing = window.__nteractPanelRuntime;
  if (existing) return existing;

  let manager: PanelCommManager | null = null;
  const runtime: NteractPanelRuntime = {
    attachCommManager(nextManager) {
      manager = nextManager;
    },
    registerTarget(payload) {
      activeTransport()?.notify(NTERACT_PANEL_CHANNEL_OPEN, payload);
    },
    sendClientPatch(payload) {
      activeTransport()?.notify(NTERACT_PANEL_CLIENT_PATCH, payload);
    },
    closeChannel(payload) {
      activeTransport()?.notify(NTERACT_PANEL_CHANNEL_CLOSE, payload);
    },
    receiveServerPatch(payload) {
      manager?.receiveServerPatch?.(payload);
    },
    receiveAck(payload) {
      manager?.receiveAck?.(payload);
    },
    setDisconnected(payload) {
      manager?.setDisconnected?.(payload);
    },
  };

  window.__nteractPanelRuntime = runtime;
  return runtime;
}

export function registerPanelRuntimeTransportHandlers(transport: PanelRuntimeTransport): void {
  const runtime = window.__nteractPanelRuntime;
  if (!runtime) return;

  transport.onNotification(NTERACT_PANEL_SERVER_PATCH, (params) => {
    runtime.receiveServerPatch(params as NteractPanelServerPatchParams);
  });
  transport.onNotification(NTERACT_PANEL_ACK, (params) => {
    runtime.receiveAck(params as NteractPanelAckParams);
  });
  transport.onNotification(NTERACT_PANEL_DISCONNECTED, (params) => {
    runtime.setDisconnected(params as NteractPanelDisconnectedParams);
  });
}
