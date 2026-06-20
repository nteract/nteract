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

type PanelMessageHandler = (message: {
  metadata: Record<string, unknown>;
  content: { data: unknown };
  buffers: NteractPanelServerPatchParams["buffers"];
}) => void;

interface PanelComm {
  active: boolean;
  connected: boolean;
  onMsg?: PanelMessageHandler;
  on_msg(handler: PanelMessageHandler): void;
  send(
    data?: unknown,
    metadata?: Record<string, unknown>,
    buffers?: NteractPanelClientPatchParams["buffers"],
  ): void;
  close(): void;
}

interface PanelCommTarget {
  plotId?: string | null;
  msgHandler: PanelMessageHandler;
}

interface PanelPyVizGlobal {
  comms: Record<string, PanelComm>;
  comm_status: Record<string, unknown>;
  kernels: Record<string, unknown>;
  receivers: Record<string, unknown>;
  plot_index: Record<string, unknown>;
  comm_manager?: PanelCommManager;
  shared_views?: Map<string, unknown[]>;
}

interface PanelCommManager {
  __nteractPanelCommManager?: true;
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
const registeredPanelRuntimeTransports = new WeakSet<PanelRuntimeTransport>();

declare global {
  interface Window {
    __nteractPanelRuntime?: NteractPanelRuntime;
    PyViz?: PanelPyVizGlobal | HTMLElement;
  }
}

function ensurePanelPyViz(): PanelPyVizGlobal {
  if (!window.PyViz || window.PyViz instanceof HTMLElement) {
    window.PyViz = {
      comms: {},
      comm_status: {},
      kernels: {},
      receivers: {},
      plot_index: {},
    };
  }

  const pyviz = window.PyViz;
  pyviz.comms ??= {};
  pyviz.comm_status ??= {};
  pyviz.kernels ??= {};
  pyviz.receivers ??= {};
  pyviz.plot_index ??= {};
  return pyviz;
}

function currentNteractPanelCommManager(): PanelCommManager | null {
  const pyviz = window.PyViz;
  if (!pyviz || pyviz instanceof HTMLElement) return null;
  const manager = pyviz.comm_manager;
  return manager?.__nteractPanelCommManager ? manager : null;
}

class NteractPanelCommManager implements PanelCommManager {
  readonly __nteractPanelCommManager = true;
  readonly targets: Record<string, PanelCommTarget> = {};
  readonly comms: Record<string, PanelComm> = {};

  constructor(private readonly pyviz: PanelPyVizGlobal) {
    window.__nteractPanelRuntime?.attachCommManager(this);
  }

  register_target(
    plotId: string | null | undefined,
    commId: string,
    msgHandler: PanelMessageHandler,
  ) {
    this.targets[commId] = { plotId, msgHandler };
    window.__nteractPanelRuntime?.registerTarget({ plotId, commId });
  }

  get_client_comm(
    plotIdOrCommId: string | null | undefined,
    commIdOrHandler?: string | PanelMessageHandler,
    maybeHandler?: PanelMessageHandler,
  ): PanelComm {
    const commId = typeof commIdOrHandler === "string" ? commIdOrHandler : plotIdOrCommId;
    if (!commId) {
      throw new Error("Panel client comm requested without a comm id");
    }
    const plotId = typeof commIdOrHandler === "string" ? plotIdOrCommId : undefined;
    const msgHandler = typeof commIdOrHandler === "function" ? commIdOrHandler : maybeHandler;

    if (this.comms[commId]) {
      if (msgHandler) this.comms[commId].on_msg(msgHandler);
      return this.comms[commId];
    }

    const comm: PanelComm = {
      active: true,
      connected: true,
      onMsg: msgHandler,
      on_msg(handler) {
        comm.onMsg = handler;
      },
      send(data, metadata, buffers) {
        window.__nteractPanelRuntime?.sendClientPatch({
          plotId,
          commId,
          data,
          metadata: metadata ?? {},
          buffers: buffers ?? [],
        });
      },
      close() {
        comm.active = false;
        comm.connected = false;
        window.__nteractPanelRuntime?.closeChannel({ plotId, commId });
      },
    };

    this.comms[commId] = comm;
    this.pyviz.comms[commId] = comm;
    return comm;
  }

  receiveServerPatch(payload: NteractPanelServerPatchParams): void {
    const target = this.targets[payload.commId];
    if (!target) return;
    target.msgHandler({
      metadata: payload.metadata ?? {},
      content: { data: payload.data },
      buffers: payload.buffers ?? [],
    });
  }

  receiveAck(payload: NteractPanelAckParams): void {
    const comm = this.comms[payload.commId] ?? this.pyviz.comms[payload.commId];
    comm?.onMsg?.({
      metadata: payload.metadata,
      content: { data: undefined },
      buffers: [],
    });
  }

  setDisconnected(payload: NteractPanelDisconnectedParams): void {
    const commId = payload.commId;
    if (commId && this.comms[commId]) {
      this.comms[commId].active = false;
      this.comms[commId].connected = false;
    }
    console.warn("Panel runtime channel disconnected", payload);
  }
}

export function ensureNteractPanelCommManager(): PanelCommManager {
  const existing = currentNteractPanelCommManager();
  if (existing) {
    window.__nteractPanelRuntime?.attachCommManager(existing);
    return existing;
  }

  const pyviz = ensurePanelPyViz();
  const manager = new NteractPanelCommManager(pyviz);
  pyviz.comm_manager = manager;
  return manager;
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
  const currentManager = currentNteractPanelCommManager();
  if (currentManager) runtime.attachCommManager(currentManager);
  return runtime;
}

export function registerPanelRuntimeTransportHandlers(transport: PanelRuntimeTransport): void {
  const runtime = window.__nteractPanelRuntime;
  if (!runtime) return;
  if (registeredPanelRuntimeTransports.has(transport)) return;
  registeredPanelRuntimeTransports.add(transport);

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
