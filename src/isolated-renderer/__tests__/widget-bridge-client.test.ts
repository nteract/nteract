import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { JsonRpcTransport } from "@/components/isolated/jsonrpc-transport";
import {
  NTERACT_COMM_MSG,
  NTERACT_COMM_OPEN,
  NTERACT_RAW_COMM_MSG,
  NTERACT_RAW_COMM_OPEN,
  NTERACT_WIDGET_READY,
} from "@/components/isolated/rpc-methods";
import {
  createWidgetBridgeClient,
  getCurrentWidgetBridgeClient,
  registerPyVizKernelProxy,
} from "../widget-bridge-client";

function createMockTransport() {
  const handlers = new Map<string, (params?: unknown) => void | Promise<void>>();
  const notify = vi.fn();
  const transport = {
    notify,
    onNotification: vi.fn((method: string, handler: (params?: unknown) => void | Promise<void>) => {
      handlers.set(method, handler);
    }),
  } as unknown as JsonRpcTransport;

  return { transport, handlers, notify };
}

describe("WidgetBridgeClient PyViz comm proxy", () => {
  afterEach(() => {
    getCurrentWidgetBridgeClient()?.dispose();
    delete (window as typeof window & { PyViz?: unknown }).PyViz;
    delete (window as typeof window & { __nteractRegisterPyVizKernel?: unknown })
      .__nteractRegisterPyVizKernel;
    delete (window as typeof window & { __nteractWidgetBridgeClient?: unknown })
      .__nteractWidgetBridgeClient;
    delete (window as typeof window & { __nteractEnsurePyVizCommManager?: unknown })
      .__nteractEnsurePyVizCommManager;
    delete (window as typeof window & { __nteractPendingPyVizKernelRegistrations?: unknown })
      .__nteractPendingPyVizKernelRegistrations;
    vi.restoreAllMocks();
  });

  it("attaches pending PyViz kernel registrations when the bridge client is created", () => {
    const unregister = registerPyVizKernelProxy("plot-1");
    expect(
      (window as typeof window & { PyViz?: { kernels?: Record<string, unknown> } }).PyViz
        ?.kernels?.["plot-1"],
    ).toBeUndefined();

    const { transport } = createMockTransport();
    createWidgetBridgeClient(transport);

    const pyviz = (window as typeof window & { PyViz?: { kernels?: Record<string, unknown> } })
      .PyViz;
    expect(pyviz?.kernels?.["plot-1"]).toEqual(
      expect.objectContaining({
        connectToComm: expect.any(Function),
        registerCommTarget: expect.any(Function),
      }),
    );

    unregister();
    expect(pyviz?.kernels?.["plot-1"]).toBeUndefined();
  });

  it("uses the window-scoped registrar for renderer plugin bundle copies", () => {
    const unregisterBridgeKernel = vi.fn();
    const registerBridgeKernel = vi.fn(() => unregisterBridgeKernel);
    (
      window as typeof window & {
        __nteractRegisterPyVizKernel?: (plotId: string) => () => void;
      }
    ).__nteractRegisterPyVizKernel = registerBridgeKernel;

    const unregister = registerPyVizKernelProxy("panel-plot");

    expect(registerBridgeKernel).toHaveBeenCalledWith("panel-plot");
    unregister();
    expect(unregisterBridgeKernel).toHaveBeenCalledTimes(1);
  });

  it("registers a PyViz kernel proxy and forwards frontend raw comm messages", () => {
    const { transport, notify } = createMockTransport();
    const client = createWidgetBridgeClient(transport);

    const unregister = client.registerPyVizKernel("plot-1");
    const pyviz = (window as typeof window & { PyViz?: { kernels?: Record<string, unknown> } })
      .PyViz;
    const kernel = pyviz?.kernels?.["plot-1"] as {
      connectToComm: (
        targetName: string,
        commId?: string,
      ) => {
        open: (data?: unknown, metadata?: Record<string, unknown>, buffers?: ArrayBuffer[]) => void;
        send: (data?: unknown, metadata?: Record<string, unknown>, buffers?: ArrayBuffer[]) => void;
      };
    };
    const buffer = new ArrayBuffer(4);

    const comm = kernel.connectToComm("panel-target", "panel-comm");
    comm.open("open-data", { opened: true }, [buffer]);
    comm.send("PATCH-DOC", { msg_type: "Ready" }, [buffer]);

    expect(notify).toHaveBeenCalledWith(NTERACT_WIDGET_READY);
    expect(notify).toHaveBeenCalledWith(NTERACT_RAW_COMM_OPEN, {
      commId: "panel-comm",
      targetName: "panel-target",
      data: "open-data",
      metadata: { opened: true },
      buffers: [buffer],
    });
    expect(notify).toHaveBeenCalledWith(NTERACT_RAW_COMM_MSG, {
      commId: "panel-comm",
      data: "PATCH-DOC",
      metadata: { msg_type: "Ready" },
      buffers: [buffer],
    });

    unregister();
    expect(pyviz?.kernels?.["plot-1"]).toBeUndefined();
  });

  it("exposes a pyviz_comms-compatible comm_manager for Panel", async () => {
    const { transport, handlers, notify } = createMockTransport();
    const client = createWidgetBridgeClient(transport);
    client.registerPyVizKernel("panel-plot");
    const pyviz = (
      window as typeof window & {
        PyViz?: {
          comm_manager?: {
            register_target: (
              plotId: string,
              commId: string,
              msgHandler: (message: {
                content: { comm_id: string; data: unknown };
                metadata: Record<string, unknown>;
                buffers: DataView[];
              }) => void,
            ) => void;
            get_client_comm: (
              plotId: string,
              commId: string,
              msgHandler: (message: {
                content: { comm_id: string; data: unknown };
                metadata: Record<string, unknown>;
                buffers: DataView[];
              }) => void,
            ) => {
              comm_id: string;
              connected: boolean;
              onMsg?: (message: {
                content: { comm_id: string; data: unknown };
                metadata: Record<string, unknown>;
                buffers: DataView[];
              }) => void;
            };
          };
          comms?: Record<string, unknown>;
        };
      }
    ).PyViz;
    const serverHandler = vi.fn();
    const ackHandler = vi.fn();

    pyviz?.comm_manager?.register_target("panel-plot", "server-comm", serverHandler);
    const clientComm = pyviz?.comm_manager?.get_client_comm(
      "panel-plot",
      "client-comm",
      ackHandler,
    );

    expect(clientComm).toEqual(
      expect.objectContaining({
        comm_id: "client-comm",
        connected: true,
      }),
    );
    expect(pyviz?.comms?.["client-comm"]).toBe(clientComm);
    expect(notify).toHaveBeenCalledWith(NTERACT_RAW_COMM_OPEN, {
      commId: "client-comm",
      targetName: "client-comm",
      data: {},
      metadata: {},
      buffers: undefined,
    });

    await handlers.get(NTERACT_COMM_OPEN)?.({
      commId: "server-comm",
      targetName: "server-comm",
      state: { initial: true },
    });
    await handlers.get(NTERACT_COMM_MSG)?.({
      commId: "server-comm",
      method: "raw",
      data: "PATCH-DOC",
      metadata: { msg_type: "PATCH-DOC" },
    });
    expect(serverHandler).toHaveBeenCalledWith({
      content: { comm_id: "server-comm", data: "PATCH-DOC" },
      metadata: { msg_type: "PATCH-DOC" },
      buffers: [],
    });

    const buffer = new ArrayBuffer(8);
    await handlers.get(NTERACT_COMM_MSG)?.({
      commId: "client-comm",
      method: "raw",
      data: "",
      metadata: { msg_type: "Ready", comm_id: "client-comm" },
      buffers: [buffer],
    });
    expect(ackHandler).toHaveBeenCalledWith({
      content: { comm_id: "client-comm", data: "" },
      metadata: { msg_type: "Ready", comm_id: "client-comm" },
      buffers: [expect.any(DataView)],
    });
    expect(ackHandler.mock.calls[0][0].buffers[0].buffer).toBe(buffer);
  });

  it("reattaches Panel ACK handlers when a client comm already exists", async () => {
    const { transport, handlers } = createMockTransport();
    const client = createWidgetBridgeClient(transport);
    client.registerPyVizKernel("panel-plot");
    const pyviz = (
      window as typeof window & {
        PyViz?: {
          comm_manager?: {
            get_client_comm: (
              plotId: string,
              commId: string,
              msgHandler: (message: {
                content: { comm_id: string; data: unknown };
                metadata: Record<string, unknown>;
                buffers: DataView[];
              }) => void,
            ) => {
              comm_id: string;
              onMsg?: (message: {
                content: { comm_id: string; data: unknown };
                metadata: Record<string, unknown>;
                buffers: DataView[];
              }) => void;
            };
          };
        };
      }
    ).PyViz;
    const staleAckHandler = vi.fn();
    const currentAckHandler = vi.fn();

    const comm = pyviz?.comm_manager?.get_client_comm("panel-plot", "client-comm", staleAckHandler);
    pyviz?.comm_manager?.get_client_comm("panel-plot", "client-comm", currentAckHandler);

    expect(comm?.onMsg).toBe(currentAckHandler);

    await handlers.get(NTERACT_COMM_MSG)?.({
      commId: "client-comm",
      method: "raw",
      data: {},
      metadata: { msg_type: "Ready" },
    });

    expect(staleAckHandler).not.toHaveBeenCalled();
    expect(currentAckHandler).toHaveBeenCalledWith({
      content: { comm_id: "client-comm", data: {} },
      metadata: { msg_type: "Ready" },
      buffers: [],
    });
  });

  it("delivers incoming raw comm messages to PyViz onMsg handlers", async () => {
    const { transport, handlers } = createMockTransport();
    const client = createWidgetBridgeClient(transport);
    client.registerPyVizKernel("plot-1");
    const pyviz = (window as typeof window & { PyViz?: { kernels?: Record<string, unknown> } })
      .PyViz;
    const kernel = pyviz?.kernels?.["plot-1"] as {
      connectToComm: (
        targetName: string,
        commId?: string,
      ) => {
        onMsg?: (message: {
          content: { comm_id: string; data: unknown };
          metadata: Record<string, unknown>;
          buffers: DataView[];
        }) => void;
      };
    };
    const received = vi.fn();
    const comm = kernel.connectToComm("panel-target", "panel-comm");
    comm.onMsg = received;
    const buffer = new ArrayBuffer(8);

    await handlers.get(NTERACT_COMM_MSG)?.({
      commId: "panel-comm",
      method: "raw",
      data: "PATCH-DOC",
      metadata: { msg_type: "Ready" },
      buffers: [buffer],
    });

    expect(received).toHaveBeenCalledWith({
      content: { comm_id: "panel-comm", data: "PATCH-DOC" },
      metadata: { msg_type: "Ready" },
      buffers: [expect.any(DataView)],
    });
    expect(received.mock.calls[0][0].buffers[0].buffer).toBe(buffer);
  });

  it("queues kernel-opened raw comms until PyViz registers the target", async () => {
    const { transport, handlers } = createMockTransport();
    const client = createWidgetBridgeClient(transport);

    await handlers.get(NTERACT_COMM_OPEN)?.({
      commId: "server-comm",
      targetName: "server-target",
      state: { ready: true },
    });

    client.registerPyVizKernel("plot-1");
    const pyviz = (window as typeof window & { PyViz?: { kernels?: Record<string, unknown> } })
      .PyViz;
    const kernel = pyviz?.kernels?.["plot-1"] as {
      registerCommTarget: (
        targetName: string,
        callback: (comm: unknown, msg: unknown) => void,
      ) => void;
    };
    const callback = vi.fn();

    kernel.registerCommTarget("server-target", callback);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        comm_id: "server-comm",
        target_name: "server-target",
        connected: true,
      }),
      {
        content: { comm_id: "server-comm", data: { ready: true } },
        metadata: {},
        buffers: [],
      },
    );
  });
});
