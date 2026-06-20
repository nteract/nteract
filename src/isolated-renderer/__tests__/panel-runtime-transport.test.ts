import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  NTERACT_PANEL_ACK,
  NTERACT_PANEL_CHANNEL_CLOSE,
  NTERACT_PANEL_CHANNEL_OPEN,
  NTERACT_PANEL_CLIENT_PATCH,
  NTERACT_PANEL_DISCONNECTED,
  NTERACT_PANEL_SERVER_PATCH,
} from "@/components/isolated/rpc-methods";
import {
  ensureNteractPanelCommManager,
  installPanelRuntimeTransport,
  registerPanelRuntimeTransportHandlers,
} from "../panel-runtime-transport";

type NotificationHandler = (params: unknown) => void;

function createTransport() {
  const handlers = new Map<string, NotificationHandler>();
  return {
    handlers,
    notify: vi.fn(),
    onNotification: vi.fn((method: string, handler: NotificationHandler) => {
      handlers.set(method, handler);
    }),
  };
}

describe("Panel runtime transport", () => {
  afterEach(() => {
    delete window.__nteractPanelRuntime;
    delete window.PyViz;
    vi.restoreAllMocks();
  });

  it("publishes typed Panel channel notifications to the host", () => {
    const transport = createTransport();
    const runtime = installPanelRuntimeTransport(() => transport);

    runtime.registerTarget({ plotId: "plot-1", commId: "comm-1" });
    runtime.sendClientPatch({
      plotId: "plot-1",
      commId: "comm-1",
      data: { events: [] },
      metadata: { kind: "patch" },
    });
    runtime.closeChannel({ plotId: "plot-1", commId: "comm-1" });

    expect(transport.notify).toHaveBeenNthCalledWith(1, NTERACT_PANEL_CHANNEL_OPEN, {
      plotId: "plot-1",
      commId: "comm-1",
    });
    expect(transport.notify).toHaveBeenNthCalledWith(2, NTERACT_PANEL_CLIENT_PATCH, {
      plotId: "plot-1",
      commId: "comm-1",
      data: { events: [] },
      metadata: { kind: "patch" },
    });
    expect(transport.notify).toHaveBeenNthCalledWith(3, NTERACT_PANEL_CHANNEL_CLOSE, {
      plotId: "plot-1",
      commId: "comm-1",
    });
  });

  it("installs the PyViz comm manager from TypeScript", () => {
    const transport = createTransport();
    installPanelRuntimeTransport(() => transport);

    const manager = ensureNteractPanelCommManager() as {
      __nteractPanelCommManager: true;
      register_target: (plotId: string, commId: string, handler: NotificationHandler) => void;
      get_client_comm: (
        plotId: string,
        commId: string,
        handler?: NotificationHandler,
      ) => {
        active: boolean;
        connected: boolean;
        send: (data?: unknown, metadata?: Record<string, unknown>, buffers?: unknown[]) => void;
        close: () => void;
      };
      receiveServerPatch: (payload: unknown) => void;
      receiveAck: (payload: unknown) => void;
      setDisconnected: (payload: { commId: string }) => void;
    };
    const serverHandler = vi.fn();
    const ackHandler = vi.fn();

    expect(window.PyViz?.comm_manager).toBe(manager);
    expect(manager.__nteractPanelCommManager).toBe(true);

    manager.register_target("plot-1", "server-comm", serverHandler);
    const comm = manager.get_client_comm("plot-1", "client-comm", ackHandler);
    comm.send({ events: [] }, { kind: "patch" }, ["buffer"]);
    comm.close();

    expect(transport.notify).toHaveBeenNthCalledWith(1, NTERACT_PANEL_CHANNEL_OPEN, {
      plotId: "plot-1",
      commId: "server-comm",
    });
    expect(transport.notify).toHaveBeenNthCalledWith(2, NTERACT_PANEL_CLIENT_PATCH, {
      plotId: "plot-1",
      commId: "client-comm",
      data: { events: [] },
      metadata: { kind: "patch" },
      buffers: ["buffer"],
    });
    expect(transport.notify).toHaveBeenNthCalledWith(3, NTERACT_PANEL_CHANNEL_CLOSE, {
      plotId: "plot-1",
      commId: "client-comm",
    });

    manager.receiveServerPatch({
      commId: "server-comm",
      data: { events: [{ kind: "ModelChanged" }] },
      metadata: { msgid: "server-patch" },
      buffers: [],
    });
    expect(serverHandler).toHaveBeenCalledWith({
      metadata: { msgid: "server-patch" },
      content: { data: { events: [{ kind: "ModelChanged" }] } },
      buffers: [],
    });

    manager.receiveAck({
      commId: "client-comm",
      metadata: { msg_type: "Ready" },
    });
    expect(ackHandler).toHaveBeenCalledWith({
      metadata: { msg_type: "Ready" },
      content: { data: undefined },
      buffers: [],
    });

    expect(comm.active).toBe(false);
    expect(comm.connected).toBe(false);
    manager.setDisconnected({ commId: "client-comm" });
    expect(comm.active).toBe(false);
    expect(comm.connected).toBe(false);
  });

  it("routes host Panel notifications to the attached manager", () => {
    const transport = createTransport();
    const manager = {
      receiveServerPatch: vi.fn(),
      receiveAck: vi.fn(),
      setDisconnected: vi.fn(),
    };

    const runtime = installPanelRuntimeTransport(() => transport);
    runtime.attachCommManager(manager);
    registerPanelRuntimeTransportHandlers(transport);

    const serverPatch = {
      plotId: "plot-1",
      commId: "comm-1",
      data: { events: [{ kind: "ModelChanged" }] },
    };
    const ack = {
      plotId: "plot-1",
      commId: "comm-1",
      metadata: { msg_type: "Ready" as const, comm_id: "comm-1" },
    };
    const disconnected = {
      plotId: "plot-1",
      commId: "comm-1",
      reason: "kernel restarted",
    };

    transport.handlers.get(NTERACT_PANEL_SERVER_PATCH)?.(serverPatch);
    transport.handlers.get(NTERACT_PANEL_ACK)?.(ack);
    transport.handlers.get(NTERACT_PANEL_DISCONNECTED)?.(disconnected);

    expect(manager.receiveServerPatch).toHaveBeenCalledWith(serverPatch);
    expect(manager.receiveAck).toHaveBeenCalledWith(ack);
    expect(manager.setDisconnected).toHaveBeenCalledWith(disconnected);
  });

  it("reuses the installed runtime while rebinding outbound transport and handlers", () => {
    const firstTransport = createTransport();
    const secondTransport = createTransport();
    const runtime = installPanelRuntimeTransport(() => firstTransport);

    installPanelRuntimeTransport(() => secondTransport);
    registerPanelRuntimeTransportHandlers(secondTransport);

    expect(window.__nteractPanelRuntime).toBe(runtime);
    expect(secondTransport.onNotification).toHaveBeenCalledWith(
      NTERACT_PANEL_SERVER_PATCH,
      expect.any(Function),
    );
    runtime.registerTarget({ commId: "comm-1" });
    expect(firstTransport.notify).not.toHaveBeenCalled();
    expect(secondTransport.notify).toHaveBeenCalledWith(NTERACT_PANEL_CHANNEL_OPEN, {
      commId: "comm-1",
    });
  });

  it("does not replace outbound transport while registering notification handlers", () => {
    const firstTransport = createTransport();
    const secondTransport = createTransport();
    const runtime = installPanelRuntimeTransport(() => firstTransport);

    registerPanelRuntimeTransportHandlers(secondTransport);

    runtime.registerTarget({ commId: "comm-1" });
    expect(firstTransport.notify).toHaveBeenCalledWith(NTERACT_PANEL_CHANNEL_OPEN, {
      commId: "comm-1",
    });
    expect(secondTransport.notify).not.toHaveBeenCalled();
    expect(secondTransport.onNotification).toHaveBeenCalledWith(
      NTERACT_PANEL_SERVER_PATCH,
      expect.any(Function),
    );
  });
});
