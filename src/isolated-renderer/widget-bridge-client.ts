/**
 * Widget Bridge Client - Iframe Side
 *
 * This module runs inside the isolated iframe and manages widget communication
 * with the parent window via JSON-RPC 2.0 notifications through a shared
 * JsonRpcTransport instance.
 *
 * It:
 * - Creates a local WidgetStore for widget state management
 * - Registers notification handlers on the transport for comm messages from parent
 * - Provides methods to send state updates and custom messages back to parent
 * - Sends `nteract/widgetReady` when initialized
 *
 * Security: This code runs in a sandboxed iframe with an opaque origin.
 * It cannot access Tauri APIs, the parent DOM, or localStorage.
 */

import type { JsonRpcTransport } from "@/components/isolated/jsonrpc-transport";
import {
  NTERACT_BRIDGE_READY,
  NTERACT_COMM_CLOSE,
  NTERACT_COMM_MSG,
  NTERACT_COMM_OPEN,
  NTERACT_RAW_COMM_CLOSE,
  NTERACT_RAW_COMM_MSG,
  NTERACT_RAW_COMM_OPEN,
  NTERACT_WIDGET_SNAPSHOT,
  NTERACT_WIDGET_COMM_CLOSE,
  NTERACT_WIDGET_COMM_MSG,
  NTERACT_WIDGET_READY,
} from "@/components/isolated/rpc-methods";
import { createWidgetStore, type WidgetStore } from "@/components/widgets/widget-store";

type RawCommBuffer = ArrayBuffer | ArrayBufferView;

interface RawCommMessage {
  content: {
    comm_id: string;
    data: unknown;
  };
  metadata: Record<string, unknown>;
  buffers: DataView[];
}

type RawCommHandler = (msg: RawCommMessage) => void;

interface PyVizCommProxy {
  comm_id: string;
  target_name: string;
  connected: boolean;
  active: boolean;
  onMsg?: RawCommHandler;
  on_msg: (callback: RawCommHandler) => void;
  open: (data?: unknown, metadata?: Record<string, unknown>, buffers?: RawCommBuffer[]) => void;
  send: (
    data?: unknown,
    metadata?: Record<string, unknown>,
    buffers?: RawCommBuffer[],
    disposeOnDone?: boolean,
  ) => void;
  close: (data?: unknown, metadata?: Record<string, unknown>, buffers?: RawCommBuffer[]) => void;
}

type InternalPyVizCommProxy = PyVizCommProxy & {
  _deliver: (data: unknown, metadata?: Record<string, unknown>, buffers?: ArrayBuffer[]) => void;
  _close: () => void;
};

type PyVizCommOpenCallback = (comm: PyVizCommProxy, msg: RawCommMessage) => void;

interface PyVizKernelProxy {
  registerCommTarget: (targetName: string, callback: PyVizCommOpenCallback) => void;
  connectToComm: (targetName: string, commId?: string) => PyVizCommProxy;
}

interface PyVizCommManagerProxy {
  register_target: (plotId: string, commId: string, msgHandler: RawCommHandler) => void;
  get_client_comm: (
    plotIdOrCommId: string,
    commIdOrHandler?: string | RawCommHandler,
    msgHandler?: RawCommHandler,
  ) => PyVizCommProxy;
}

interface PyVizGlobal {
  comms?: Record<string, PyVizCommProxy>;
  comm_status?: Record<string, unknown>;
  kernels?: Record<string, PyVizKernelProxy>;
  comm_manager?: PyVizCommManagerProxy;
  receivers?: Record<string, unknown>;
  plot_index?: Record<string, unknown>;
}

type WidgetBridgeWindow = Window &
  typeof globalThis & {
    PyViz?: PyVizGlobal | HTMLElement;
    __nteractRegisterPyVizKernel?: (plotId: string) => () => void;
    __nteractEnsurePyVizCommManager?: () => void;
    __nteractWidgetBridgeClient?: WidgetBridgeClient;
    __nteractPendingPyVizKernelRegistrations?: Map<
      symbol,
      { plotId: string; unregister?: () => void }
    >;
  };

function isLocalDaemonBlobUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname === "127.0.0.1" &&
      url.port.length > 0 &&
      url.search === "" &&
      url.hash === "" &&
      /^\/blob\/[a-f0-9]+$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * Fetch the blob URL at each `bufferPaths` position in `state` and replace
 * it in place with a `DataView` — the shape ipywidgets and anywidget
 * consumers expect for binary traitlets. Mutates `state`.
 *
 * `_esm` / `_css` are *not* listed in `bufferPaths` (the daemon's WASM
 * resolver keeps them URL-preferring), so they stay as strings for
 * `loadESM` / `<link rel=stylesheet>` to load natively.
 */
async function resolveBlobUrlsInPlace(
  state: Record<string, unknown>,
  bufferPaths: string[][] | undefined,
): Promise<void> {
  if (!bufferPaths || bufferPaths.length === 0) return;
  await Promise.all(
    bufferPaths.map(async (path) => {
      if (path.length === 0) return;
      let current: unknown = state;
      for (const segment of path) {
        if (typeof current !== "object" || current === null) return;
        current = (current as Record<string, unknown>)[segment];
      }
      if (typeof current !== "string" || !isLocalDaemonBlobUrl(current)) return;
      try {
        const resp = await fetch(current);
        if (!resp.ok) return;
        const buffer = await resp.arrayBuffer();
        let parent: Record<string, unknown> = state;
        for (let i = 0; i < path.length - 1; i++) {
          parent = parent[path[i]] as Record<string, unknown>;
        }
        parent[path[path.length - 1]] = new DataView(buffer);
      } catch {
        // Leave URL in place — widget will see the URL string and render
        // broken, but that's better than dropping the whole update.
      }
    }),
  );
}

/**
 * Interface for the widget bridge client.
 * Provides access to the local store and methods to communicate with parent.
 */
export interface WidgetBridgeClient {
  /** The local widget store for this iframe */
  store: WidgetStore;

  /**
   * Send a state update to the parent (to be forwarded to kernel).
   * Called when a widget's state changes due to user interaction.
   */
  sendUpdate: (commId: string, state: Record<string, unknown>) => void;

  /**
   * Send a custom message to the parent (to be forwarded to kernel).
   * Used for widget-specific protocols (e.g., ipycanvas draw commands).
   */
  sendCustom: (commId: string, content: Record<string, unknown>, buffers?: ArrayBuffer[]) => void;

  /**
   * Request to close a comm (to be forwarded to kernel).
   */
  closeComm: (commId: string) => void;

  /**
   * Register a PyViz/JupyterLab-compatible kernel proxy for a Panel plot id.
   */
  registerPyVizKernel: (plotId: string) => () => void;

  /**
   * Clean up the bridge.
   */
  dispose: () => void;
}

let currentWidgetBridgeClient: WidgetBridgeClient | null = null;

export function getCurrentWidgetBridgeClient(): WidgetBridgeClient | null {
  return (
    currentWidgetBridgeClient ?? (window as WidgetBridgeWindow).__nteractWidgetBridgeClient ?? null
  );
}

function pendingPyVizKernelRegistrations(): Map<
  symbol,
  { plotId: string; unregister?: () => void }
> {
  const target = window as WidgetBridgeWindow;
  target.__nteractPendingPyVizKernelRegistrations ??= new Map();
  return target.__nteractPendingPyVizKernelRegistrations;
}

function pyVizKernelRegistrar(): ((plotId: string) => () => void) | undefined {
  const target = window as WidgetBridgeWindow;
  return target.__nteractRegisterPyVizKernel ?? currentWidgetBridgeClient?.registerPyVizKernel;
}

function flushPendingPyVizKernelRegistrations(client: WidgetBridgeClient): void {
  for (const registration of pendingPyVizKernelRegistrations().values()) {
    if (!registration.unregister) {
      registration.unregister = client.registerPyVizKernel(registration.plotId);
    }
  }
}

export function registerPyVizKernelProxy(plotId: string): () => void {
  const token = Symbol(plotId);
  const registration = { plotId, unregister: undefined as (() => void) | undefined };
  pendingPyVizKernelRegistrations().set(token, registration);

  registration.unregister = pyVizKernelRegistrar()?.(plotId);

  return () => {
    registration.unregister?.();
    pendingPyVizKernelRegistrations().delete(token);
  };
}

export function ensurePyVizCommManagerProxy(): void {
  const target = window as WidgetBridgeWindow;
  target.__nteractEnsurePyVizCommManager?.();
}

/**
 * Create a widget bridge client for the iframe.
 * This sets up:
 * - A local WidgetStore instance
 * - Notification handlers on the transport for parent → iframe comm messages
 * - Methods to send iframe → parent messages via the transport
 *
 * @param transport - The shared JsonRpcTransport (created in index.tsx init())
 */
export function createWidgetBridgeClient(transport: JsonRpcTransport): WidgetBridgeClient {
  const store = createWidgetStore();
  const rawComms = new Map<string, InternalPyVizCommProxy>();
  const rawTargets = new Map<string, PyVizCommOpenCallback>();
  const pendingRawOpens = new Map<
    string,
    Array<{
      commId: string;
      targetName: string;
      data: unknown;
      metadata?: Record<string, unknown>;
      buffers?: ArrayBuffer[];
    }>
  >();

  function sendWidgetReady() {
    transport.notify(NTERACT_WIDGET_READY);
  }

  function ensurePyViz(): PyVizGlobal {
    const target = window as WidgetBridgeWindow;
    if (!target.PyViz || target.PyViz instanceof HTMLElement) {
      target.PyViz = {};
    }
    const pyviz = target.PyViz as PyVizGlobal;
    pyviz.comms ??= {};
    pyviz.comm_status ??= {};
    pyviz.kernels ??= {};
    pyviz.receivers ??= {};
    pyviz.plot_index ??= {};
    pyviz.comm_manager ??= createPyVizCommManager(pyviz);
    return pyviz;
  }

  function normalizeOutgoingBuffers(buffers?: RawCommBuffer[]): ArrayBuffer[] | undefined {
    if (!buffers || buffers.length === 0) return undefined;
    return buffers.map((buffer) => {
      if (buffer instanceof ArrayBuffer) return buffer;
      const view = buffer as ArrayBufferView;
      if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
        return view.buffer as ArrayBuffer;
      }
      return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
    });
  }

  function incomingBufferViews(buffers?: ArrayBuffer[]): DataView[] {
    return (buffers ?? []).map((buffer) => new DataView(buffer));
  }

  function rawCommMessage(
    commId: string,
    data: unknown,
    metadata?: Record<string, unknown>,
    buffers?: ArrayBuffer[],
  ): RawCommMessage {
    return {
      content: {
        comm_id: commId,
        data,
      },
      metadata: metadata ?? {},
      buffers: incomingBufferViews(buffers),
    };
  }

  function createRawComm(commId: string, targetName: string, connected: boolean) {
    let onMsg: RawCommHandler | undefined;
    const comm: InternalPyVizCommProxy = {
      comm_id: commId,
      target_name: targetName,
      connected,
      active: true,
      get onMsg() {
        return onMsg;
      },
      set onMsg(callback) {
        onMsg = callback;
      },
      on_msg(callback) {
        onMsg = callback;
      },
      open(data = {}, metadata = {}, buffers) {
        comm.connected = true;
        transport.notify(NTERACT_RAW_COMM_OPEN, {
          commId,
          targetName,
          data,
          metadata,
          buffers: normalizeOutgoingBuffers(buffers),
        });
      },
      send(data = {}, metadata = {}, buffers) {
        transport.notify(NTERACT_RAW_COMM_MSG, {
          commId,
          data,
          metadata,
          buffers: normalizeOutgoingBuffers(buffers),
        });
      },
      close(data = {}, metadata = {}, buffers) {
        comm.connected = false;
        comm.active = false;
        transport.notify(NTERACT_RAW_COMM_CLOSE, {
          commId,
          data,
          metadata,
          buffers: normalizeOutgoingBuffers(buffers),
        });
      },
      _deliver(data, metadata, buffers) {
        onMsg?.(rawCommMessage(commId, data, metadata, buffers));
      },
      _close() {
        comm.connected = false;
        comm.active = false;
      },
    };

    rawComms.set(commId, comm);
    ensurePyViz().comms![commId] = comm;
    return comm;
  }

  function connectRawComm(targetName: string, commId = targetName): PyVizCommProxy {
    return rawComms.get(commId) ?? createRawComm(commId, targetName, false);
  }

  function createPyVizCommManager(pyviz: PyVizGlobal): PyVizCommManagerProxy {
    return {
      register_target(plotId, commId, msgHandler) {
        const kernel = pyviz.kernels?.[plotId];
        if (kernel) {
          kernel.registerCommTarget(commId, (comm) => {
            comm.onMsg = msgHandler;
          });
          return;
        }

        registerRawTarget(commId, (comm) => {
          comm.onMsg = msgHandler;
        });
      },

      get_client_comm(plotIdOrCommId, commIdOrHandler, msgHandler) {
        const hasExplicitPlotId = typeof commIdOrHandler === "string";
        const plotId = hasExplicitPlotId ? plotIdOrCommId : undefined;
        const commId = hasExplicitPlotId ? commIdOrHandler : plotIdOrCommId;
        const handler = typeof commIdOrHandler === "function" ? commIdOrHandler : msgHandler;
        const existing = pyviz.comms?.[commId];
        const comm =
          existing ??
          (plotId && pyviz.kernels?.[plotId]
            ? pyviz.kernels[plotId].connectToComm(commId)
            : connectRawComm(commId));

        if (handler) {
          comm.onMsg = handler;
        }
        if (!existing && (comm.active || comm.active === undefined)) {
          comm.open();
        }
        return comm;
      },
    };
  }

  function deliverRawOpen(
    commId: string,
    targetName: string,
    data: unknown,
    metadata?: Record<string, unknown>,
    buffers?: ArrayBuffer[],
  ): void {
    const callback = rawTargets.get(targetName);
    if (!callback) {
      const pending = pendingRawOpens.get(targetName) ?? [];
      pending.push({ commId, targetName, data, metadata, buffers });
      pendingRawOpens.set(targetName, pending);
      return;
    }

    const comm = rawComms.get(commId) ?? createRawComm(commId, targetName, true);
    comm.connected = true;
    comm.active = true;
    callback(comm, rawCommMessage(commId, data, metadata, buffers));
  }

  function registerRawTarget(targetName: string, callback: PyVizCommOpenCallback): void {
    rawTargets.set(targetName, callback);
    const pending = pendingRawOpens.get(targetName);
    if (!pending) return;
    pendingRawOpens.delete(targetName);
    for (const message of pending) {
      deliverRawOpen(
        message.commId,
        message.targetName,
        message.data,
        message.metadata,
        message.buffers,
      );
    }
  }

  function deliverRawMessage(
    commId: string,
    data: unknown,
    metadata?: Record<string, unknown>,
    buffers?: ArrayBuffer[],
  ): boolean {
    const comm = rawComms.get(commId);
    if (!comm) return false;
    comm._deliver(data, metadata, buffers);
    return true;
  }

  function closeRawMessage(commId: string): boolean {
    const comm = rawComms.get(commId);
    if (!comm) return false;
    comm._close();
    rawComms.delete(commId);
    delete ensurePyViz().comms?.[commId];
    return true;
  }

  // Register handlers for parent → iframe comm messages
  transport.onNotification(NTERACT_BRIDGE_READY, () => {
    sendWidgetReady();
  });

  transport.onNotification(NTERACT_COMM_OPEN, async (params) => {
    const { commId, targetName, state, bufferPaths } = params as {
      commId: string;
      targetName?: string;
      state: Record<string, unknown>;
      bufferPaths?: string[][];
    };
    if (targetName && targetName !== "jupyter.widget") {
      deliverRawOpen(commId, targetName, state);
      return;
    }
    await resolveBlobUrlsInPlace(state, bufferPaths);
    store.createModel(commId, state, bufferPaths, targetName);
  });

  transport.onNotification(NTERACT_COMM_MSG, async (params) => {
    const { commId, method, data, metadata, buffers, bufferPaths } = params as {
      commId: string;
      method: "update" | "custom" | "raw";
      data: unknown;
      metadata?: Record<string, unknown>;
      buffers?: ArrayBuffer[];
      bufferPaths?: string[][];
    };
    if (method === "raw") {
      deliverRawMessage(commId, data, metadata, buffers);
      return;
    }
    if (rawComms.has(commId)) {
      deliverRawMessage(commId, data, metadata, buffers);
      return;
    }
    if (method === "update") {
      const update =
        data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
      await resolveBlobUrlsInPlace(update, bufferPaths);
      store.updateModel(commId, update, bufferPaths);
    } else if (method === "custom") {
      const content =
        data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
      store.emitCustomMessage(commId, content, buffers);
    }
  });

  transport.onNotification(NTERACT_COMM_CLOSE, (params) => {
    const { commId } = params as { commId: string };
    if (closeRawMessage(commId)) return;
    store.deleteModel(commId);
  });

  transport.onNotification(NTERACT_WIDGET_SNAPSHOT, async (params) => {
    const { models } = params as {
      models: Array<{
        commId: string;
        targetName?: string;
        state: Record<string, unknown>;
        bufferPaths?: string[][];
      }>;
    };
    await Promise.all(
      models.map(async (model) => {
        if (model.targetName && model.targetName !== "jupyter.widget") {
          deliverRawOpen(model.commId, model.targetName, model.state);
          return;
        }
        await resolveBlobUrlsInPlace(model.state, model.bufferPaths);
        store.createModel(model.commId, model.state, model.bufferPaths, model.targetName);
      }),
    );
  });

  // Send initial widget_ready
  // (Parent may not be listening yet; it will send bridgeReady when ready,
  // and we'll re-send via the handler above)
  sendWidgetReady();

  function registerPyVizKernel(plotId: string) {
    return client.registerPyVizKernel(plotId);
  }

  function ensurePyVizCommManager() {
    const pyviz = ensurePyViz();
    pyviz.comm_manager = createPyVizCommManager(pyviz);
  }

  const client: WidgetBridgeClient = {
    store,

    sendUpdate(commId: string, state: Record<string, unknown>) {
      // Update local store immediately for responsive UI (optimistic update).
      store.updateModel(commId, state);
      transport.notify(NTERACT_WIDGET_COMM_MSG, {
        commId,
        method: "update",
        data: state,
      });
    },

    sendCustom(commId: string, content: Record<string, unknown>, buffers?: ArrayBuffer[]) {
      transport.notify(NTERACT_WIDGET_COMM_MSG, {
        commId,
        method: "custom",
        data: content,
        buffers,
      });
    },

    closeComm(commId: string) {
      transport.notify(NTERACT_WIDGET_COMM_CLOSE, { commId });
    },

    registerPyVizKernel(plotId: string) {
      const pyviz = ensurePyViz();
      const kernelProxy: PyVizKernelProxy = {
        registerCommTarget(targetName, callback) {
          registerRawTarget(targetName, callback);
        },
        connectToComm(targetName, commId = targetName) {
          return connectRawComm(targetName, commId);
        },
      };
      pyviz.kernels![plotId] = kernelProxy;
      return () => {
        if (pyviz.kernels?.[plotId] === kernelProxy) {
          delete pyviz.kernels[plotId];
        }
      };
    },

    dispose() {
      // Transport lifecycle is managed by index.tsx
      rawComms.clear();
      rawTargets.clear();
      pendingRawOpens.clear();
      if (currentWidgetBridgeClient === client) {
        for (const registration of pendingPyVizKernelRegistrations().values()) {
          registration.unregister?.();
          registration.unregister = undefined;
        }
        currentWidgetBridgeClient = null;
      }
      const target = window as WidgetBridgeWindow;
      if (target.__nteractWidgetBridgeClient === client) {
        delete target.__nteractWidgetBridgeClient;
      }
      if (target.__nteractRegisterPyVizKernel === registerPyVizKernel) {
        delete target.__nteractRegisterPyVizKernel;
      }
      if (target.__nteractEnsurePyVizCommManager === ensurePyVizCommManager) {
        delete target.__nteractEnsurePyVizCommManager;
      }
    },
  };
  const target = window as WidgetBridgeWindow;
  currentWidgetBridgeClient = client;
  target.__nteractWidgetBridgeClient = client;
  target.__nteractRegisterPyVizKernel = registerPyVizKernel;
  target.__nteractEnsurePyVizCommManager = ensurePyVizCommManager;
  flushPendingPyVizKernelRegistrations(client);
  return client;
}
