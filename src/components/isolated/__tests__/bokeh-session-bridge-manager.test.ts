import { describe, expect, it, vi } from "vite-plus/test";
import type { BokehSessionEvents, BokehSessionState } from "runtimed";
import { BokehSessionBridgeManager } from "../bokeh-session-bridge-manager";
import type { BokehSessionDocListener, BokehSessionDocStore } from "../bokeh-session-doc-store";
import type { BokehSessionTransport } from "../bokeh-session-plugin";
import {
  NTERACT_BOKEH_APPLY_PATCH,
  NTERACT_BOKEH_SESSION_DATA,
  NTERACT_BOKEH_SESSION_DOC,
  NTERACT_BOKEH_SESSION_EVENTS,
  NTERACT_BOKEH_SESSION_OPEN,
  NTERACT_BOKEH_SESSION_STATE,
  NTERACT_BOKEH_SET_PROPS,
  type NteractBokehDocUpdate,
} from "../bokeh-session-rpc";
import type { IsolatedFrameHandle } from "../isolated-frame";

const payload = {
  schema_version: 1 as const,
  session_id: "session-1",
  producer: { name: "panel", version: "1.9.4" },
  bokeh_version: "3.9.2",
  document: { roots: [] },
  root_ids: ["root-1"],
  resources: {
    javascript: [],
    stylesheets: [],
    javascript_modules: [],
    module_exports: {},
  },
  buffers: [],
};

function runtimeSession(overrides: Partial<BokehSessionState> = {}): BokehSessionState {
  return {
    output_id: "output-1",
    cell_id: "cell-1",
    execution_id: "execution-1",
    kernel_id: "kernel-1",
    status: "connected",
    producer_name: "panel",
    producer_version: "1.9.4",
    bokeh_version: "3.9.2",
    root_ids: ["root-1"],
    epoch: 3,
    doc_heads: ["head"],
    ...overrides,
  };
}

const update: NteractBokehDocUpdate = {
  sessionId: "session-1",
  epoch: 3,
  kind: "full",
  canSwitch: false,
  meta: { rootIds: ["root-1"], title: null, bokehVersion: "3.9.2", docExtras: null },
  models: {},
  props: {},
  removed: [],
  columns: {},
};

function makeHarness(options: { docs?: boolean; writable?: boolean } = {}) {
  let eventsListener: ((events: BokehSessionEvents) => void) | null = null;
  const docListeners = new Set<BokehSessionDocListener>();
  const blobs = new Map<string, () => Response>([
    ["col-x", () => new Response('{"type":"ndarray","array":[1,2]}')],
    ["col-y", () => new Response("[3,4]")],
    ["buffer-0", () => new Response(new Uint8Array([1, 2, 3]))],
  ]);
  const fetchBlob = vi.fn(async (ref: { blob: string }) => {
    const response = blobs.get(ref.blob)?.();
    return response ?? new Response(null, { status: 404 });
  });
  const docs = {
    subscribe: vi.fn((_sessionId: string, listener: BokehSessionDocListener) => {
      docListeners.add(listener);
      return () => docListeners.delete(listener);
    }),
    writeProps: vi.fn(() => ({ status: "written" as const })),
    columnRefs: vi.fn(() => ({
      epoch: 3,
      columns: {
        source: {
          x: { blob: "col-x", size: 30, version: 4 },
          y: { blob: "col-y", size: 5, version: 2 },
        },
      },
    })),
    loadJson: vi.fn(async (ref: { blob: string }) =>
      JSON.parse(await (await fetchBlob(ref)).text()),
    ),
  };
  const transport: BokehSessionTransport = {
    docs: options.docs === false ? null : (docs as unknown as BokehSessionDocStore),
    writable: options.writable ?? true,
    fetchBlob,
    applyPatch: vi.fn(async (options) => ({
      status: "accepted" as const,
      session_id: options.sessionId,
      transaction_id: options.transactionId,
    })),
    getData: vi.fn(async (sessionId: string) => ({
      session_id: sessionId,
      epoch: 3,
      events: [
        {
          session_id: sessionId,
          epoch: 3,
          transaction_id: "tx-tail",
          data_events: [
            {
              kind: "ColumnsStreamed",
              source_id: "source",
              base_version: 4,
              new_version: 5,
              data: { type: "map", entries: [] },
            },
          ],
          buffers: [
            { id: "b0", blob: "buffer-0", size: 3, media_type: "application/octet-stream" },
          ],
        },
      ],
      fold_requested: ["other"],
    })),
    subscribeEvents: vi.fn((listener: (events: BokehSessionEvents) => void) => {
      eventsListener = listener;
      return () => {
        eventsListener = null;
      };
    }),
  };
  const frame = { notifyExtension: vi.fn() } as unknown as IsolatedFrameHandle;
  const manager = new BokehSessionBridgeManager({
    frame,
    transport,
    bindings: [{ outputId: "output-1", payload }],
  });
  manager.updateRuntimeSessions({ "session-1": runtimeSession() });
  return {
    blobs,
    docs,
    docListeners,
    emitEvents: (events: BokehSessionEvents) => eventsListener?.(events),
    frame,
    manager,
    transport,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("BokehSessionBridgeManager", () => {
  it("projects status and epoch from RuntimeStateDoc once per change", () => {
    const { frame, manager } = makeHarness();
    expect(frame.notifyExtension).toHaveBeenCalledWith(NTERACT_BOKEH_SESSION_STATE, {
      sessionId: "session-1",
      outputId: "output-1",
      status: "connected",
      epoch: 3,
      live: false,
      writable: true,
    });
    vi.mocked(frame.notifyExtension).mockClear();

    manager.updateRuntimeSessions({ "session-1": runtimeSession() });
    expect(frame.notifyExtension).not.toHaveBeenCalled();

    manager.updateRuntimeSessions({ "session-1": runtimeSession({ status: "disconnected" }) });
    expect(frame.notifyExtension).toHaveBeenCalledWith(NTERACT_BOKEH_SESSION_STATE, {
      sessionId: "session-1",
      outputId: "output-1",
      status: "disconnected",
      epoch: 3,
      live: false,
      writable: false,
    });
  });

  it("follows the session document of a live output and forwards its updates", async () => {
    const { docs, docListeners, frame, manager } = makeHarness();

    await expect(
      manager.handleRequest(NTERACT_BOKEH_SESSION_OPEN, {
        sessionId: "session-1",
        outputId: "output-1",
      }),
    ).resolves.toEqual({
      sessionId: "session-1",
      outputId: "output-1",
      status: "connected",
      epoch: 3,
      live: true,
      writable: true,
    });
    expect(docs.subscribe).toHaveBeenCalledWith(
      "session-1",
      expect.any(Function),
      expect.any(Function),
    );
    // The open result tells the frame it is followed; the same state sent
    // while its open is pending would read as a stale `live: false`.
    expect(frame.notifyExtension).not.toHaveBeenCalledWith(
      NTERACT_BOKEH_SESSION_STATE,
      expect.objectContaining({ live: true }),
    );
    manager.updateRuntimeSessions({ "session-1": runtimeSession() });
    expect(frame.notifyExtension).not.toHaveBeenCalledWith(
      NTERACT_BOKEH_SESSION_STATE,
      expect.objectContaining({ live: true }),
    );

    for (const listener of docListeners) listener(update);
    expect(frame.notifyExtension).toHaveBeenCalledWith(NTERACT_BOKEH_SESSION_DOC, {
      outputId: "output-1",
      update,
    });

    // Re-opening replaces the subscription instead of adding a second one.
    await manager.handleRequest(NTERACT_BOKEH_SESSION_OPEN, {
      sessionId: "session-1",
      outputId: "output-1",
    });
    expect(docListeners.size).toBe(1);

    manager.setBindings([]);
    expect(docListeners.size).toBe(0);
  });

  it("reports an error state while the host cannot build the session document", async () => {
    const { docs, frame, manager } = makeHarness();
    await manager.handleRequest(NTERACT_BOKEH_SESSION_OPEN, {
      sessionId: "session-1",
      outputId: "output-1",
    });
    const [, listener, onError] = docs.subscribe.mock.calls[0] as unknown as [
      string,
      BokehSessionDocListener,
      (error: string) => void,
    ];
    vi.mocked(frame.notifyExtension).mockClear();

    onError("Failed to fetch Bokeh blob late-blob: 404");
    expect(frame.notifyExtension).toHaveBeenCalledWith(NTERACT_BOKEH_SESSION_STATE, {
      sessionId: "session-1",
      outputId: "output-1",
      status: "error",
      epoch: 3,
      live: true,
      writable: false,
      error: "Failed to fetch Bokeh blob late-blob: 404",
    });
    await expect(
      manager.handleRequest(NTERACT_BOKEH_SET_PROPS, {
        sessionId: "session-1",
        outputId: "output-1",
        props: { slider: { value: "0.5" } },
      }),
    ).resolves.toEqual({ status: "read_only" });

    // A later full update (a resync or a new epoch) recovers the session.
    listener(update);
    expect(frame.notifyExtension).toHaveBeenLastCalledWith(NTERACT_BOKEH_SESSION_STATE, {
      sessionId: "session-1",
      outputId: "output-1",
      status: "connected",
      epoch: 3,
      live: true,
      writable: true,
    });
  });

  it("renders frozen and unknown sessions from the payload without subscribing", async () => {
    const { docs, manager } = makeHarness();
    manager.updateRuntimeSessions({ "session-1": runtimeSession({ status: "disconnected" }) });

    await expect(
      manager.handleRequest(NTERACT_BOKEH_SESSION_OPEN, {
        sessionId: "session-1",
        outputId: "output-1",
      }),
    ).resolves.toMatchObject({ status: "disconnected", live: false });

    manager.updateRuntimeSessions({});
    await expect(
      manager.handleRequest(NTERACT_BOKEH_SESSION_OPEN, {
        sessionId: "session-1",
        outputId: "output-1",
      }),
    ).resolves.toMatchObject({ status: "disconnected", epoch: null, live: false });
    expect(docs.subscribe).not.toHaveBeenCalled();
  });

  it("keeps a frame to its own outputs' sessions", async () => {
    const { manager, transport, docs } = makeHarness();

    await expect(
      manager.handleRequest(NTERACT_BOKEH_SESSION_OPEN, {
        sessionId: "session-1",
        outputId: "another-output",
      }),
    ).rejects.toThrow("not owned");
    await expect(
      manager.handleRequest(NTERACT_BOKEH_SET_PROPS, {
        sessionId: "session-2",
        outputId: "output-1",
        props: {},
      }),
    ).rejects.toThrow("not owned");
    await expect(
      manager.handleRequest(NTERACT_BOKEH_SESSION_DATA, {
        sessionId: "session-1",
        outputId: "another-output",
        sources: { source: null },
        tail: false,
      }),
    ).rejects.toThrow("not owned");
    expect(transport.applyPatch).not.toHaveBeenCalled();
    expect(docs.writeProps).not.toHaveBeenCalled();
  });

  it("writes property values through the host replica only while connected", async () => {
    const { docs, manager } = makeHarness();
    const params = {
      sessionId: "session-1",
      outputId: "output-1",
      props: { slider: { value: "0.5" } },
    };

    await expect(manager.handleRequest(NTERACT_BOKEH_SET_PROPS, params)).resolves.toEqual({
      status: "written",
    });
    expect(docs.writeProps).toHaveBeenCalledWith("session-1", { slider: { value: "0.5" } });

    await expect(
      manager.handleRequest(NTERACT_BOKEH_SET_PROPS, {
        ...params,
        props: { slider: { value: 1 } },
      }),
    ).rejects.toThrow("JSON text");

    manager.updateRuntimeSessions({ "session-1": runtimeSession({ status: "closed" }) });
    await expect(manager.handleRequest(NTERACT_BOKEH_SET_PROPS, params)).resolves.toEqual({
      status: "read_only",
    });
    expect(docs.writeProps).toHaveBeenCalledOnce();
  });

  it("follows a viewer connection's sessions read-only", async () => {
    const { docs, frame, manager, transport } = makeHarness({ writable: false });
    expect(frame.notifyExtension).toHaveBeenCalledWith(
      NTERACT_BOKEH_SESSION_STATE,
      expect.objectContaining({ status: "connected", writable: false }),
    );

    await expect(
      manager.handleRequest(NTERACT_BOKEH_SESSION_OPEN, {
        sessionId: "session-1",
        outputId: "output-1",
      }),
    ).resolves.toMatchObject({ live: true, writable: false });
    expect(docs.subscribe).toHaveBeenCalledOnce();
    await expect(
      manager.handleRequest(NTERACT_BOKEH_SET_PROPS, {
        sessionId: "session-1",
        outputId: "output-1",
        props: { slider: { value: "0.5" } },
      }),
    ).resolves.toEqual({ status: "read_only" });
    expect(docs.writeProps).not.toHaveBeenCalled();
    await expect(
      manager.handleRequest(NTERACT_BOKEH_APPLY_PATCH, {
        sessionId: "session-1",
        outputId: "output-1",
        transactionId: "tx-1",
        patch: { events: [{ kind: "MessageSent" }] },
        buffers: [],
      }),
    ).resolves.toMatchObject({ status: "error", error: "Bokeh session is read-only" });
    expect(transport.applyPatch).not.toHaveBeenCalled();
  });

  it("sends only one-off events through apply_bokeh_session_patch", async () => {
    const { manager, transport } = makeHarness();
    const request = {
      sessionId: "session-1",
      outputId: "output-1",
      transactionId: "tx-1",
      patch: { events: [{ kind: "MessageSent", msg_type: "bokeh_event", msg_data: {} }] },
      buffers: [{ id: "tx-1:0", data: new Uint8Array([7]).buffer }],
    };

    await expect(manager.handleRequest(NTERACT_BOKEH_APPLY_PATCH, request)).resolves.toEqual({
      status: "accepted",
      sessionId: "session-1",
      transactionId: "tx-1",
    });
    expect(transport.applyPatch).toHaveBeenCalledWith({
      sessionId: "session-1",
      transactionId: "tx-1",
      patch: request.patch,
      buffers: [{ id: "tx-1:0", data: new Uint8Array([7]) }],
    });

    await expect(
      manager.handleRequest(NTERACT_BOKEH_APPLY_PATCH, {
        ...request,
        patch: { events: [{ kind: "ModelChanged", attr: "value" }] },
      }),
    ).rejects.toThrow("one-off");

    manager.updateRuntimeSessions({ "session-1": runtimeSession({ status: "disconnected" }) });
    await expect(manager.handleRequest(NTERACT_BOKEH_APPLY_PATCH, request)).resolves.toMatchObject({
      status: "error",
      error: "Bokeh session is disconnected",
    });
    expect(transport.applyPatch).toHaveBeenCalledOnce();
  });

  it("loads column blobs and the retained tail for a data reload", async () => {
    const { docs, manager, transport } = makeHarness();

    const result = await manager.handleRequest(NTERACT_BOKEH_SESSION_DATA, {
      sessionId: "session-1",
      outputId: "output-1",
      sources: { source: null },
      tail: true,
    });

    expect(transport.getData).toHaveBeenCalledWith("session-1", ["source"]);
    expect(docs.columnRefs).toHaveBeenCalledWith("session-1", { source: null });
    expect(result).toMatchObject({
      epoch: 3,
      columns: {
        source: {
          x: { version: 4, data: { type: "ndarray", array: [1, 2] } },
          y: { version: 2, data: [3, 4] },
        },
      },
      events: [
        {
          sessionId: "session-1",
          transactionId: "tx-tail",
          dataEvents: [{ kind: "ColumnsStreamed", base_version: 4, new_version: 5 }],
        },
      ],
      foldRequested: ["other"],
    });
    const events = (result as { events: Array<{ buffers: Array<{ data: ArrayBuffer }> }> }).events;
    expect(new Uint8Array(events[0].buffers[0].data)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("resolves broadcast buffers and full-column replacements in order", async () => {
    const { docs, emitEvents, frame } = makeHarness();
    vi.mocked(frame.notifyExtension).mockClear();
    let releaseSlow: (() => void) | undefined;
    const loadJson = docs.loadJson.getMockImplementation()!;
    // The replacement's column loads slower than the next broadcast resolves.
    docs.loadJson.mockImplementationOnce(
      (ref) =>
        new Promise((resolve) => {
          releaseSlow = () => resolve(loadJson(ref));
        }),
    );

    emitEvents({
      session_id: "session-1",
      epoch: 3,
      transaction_id: "tx-replace",
      data_events: [
        {
          kind: "ColumnDataChanged",
          source_id: "source",
          base_version: 4,
          new_version: 5,
          columns: { x: { blob: "col-x", size: 30, version: 5 } },
          columns_removed: ["z"],
        },
      ],
    });
    emitEvents({
      session_id: "session-1",
      epoch: 3,
      transaction_id: "tx-message",
      messages: [{ msg_type: "bokeh_event", msg_data: { event_name: "click" } }],
    });
    emitEvents({ session_id: "session-2", epoch: 1, transaction_id: "tx-other" });
    await settle();
    expect(frame.notifyExtension).not.toHaveBeenCalled();
    releaseSlow?.();
    await settle();

    expect(frame.notifyExtension).toHaveBeenNthCalledWith(1, NTERACT_BOKEH_SESSION_EVENTS, {
      outputId: "output-1",
      events: {
        sessionId: "session-1",
        epoch: 3,
        transactionId: "tx-replace",
        dataEvents: [
          {
            kind: "ColumnDataChanged",
            source_id: "source",
            base_version: 4,
            new_version: 5,
            columns: { x: { version: 5, data: { type: "ndarray", array: [1, 2] } } },
            columns_removed: ["z"],
          },
        ],
        messages: [],
        buffers: [],
      },
    });
    expect(frame.notifyExtension).toHaveBeenNthCalledWith(
      2,
      NTERACT_BOKEH_SESSION_EVENTS,
      expect.objectContaining({
        events: expect.objectContaining({ transactionId: "tx-message" }),
      }),
    );
    expect(frame.notifyExtension).toHaveBeenCalledTimes(2);
  });

  it("does not deliver in-flight events after disposal", async () => {
    const { emitEvents, frame, manager, transport } = makeHarness();
    vi.mocked(frame.notifyExtension).mockClear();
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.mocked(transport.fetchBlob).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    emitEvents({
      session_id: "session-1",
      epoch: 3,
      transaction_id: "tx-delayed",
      buffers: [{ id: "b", blob: "buffer-0", size: 3, media_type: "application/octet-stream" }],
    });
    manager.dispose();
    resolveFetch?.(new Response(new Uint8Array([1, 2, 3])));
    await settle();

    expect(frame.notifyExtension).not.toHaveBeenCalled();
  });

  it("renders every output statically when the connection does not sync session documents", async () => {
    const { frame, manager, transport } = makeHarness({ docs: false });
    expect(transport.subscribeEvents).not.toHaveBeenCalled();
    // State still reaches the frame, so it can show the session's status.
    expect(frame.notifyExtension).toHaveBeenCalledWith(
      NTERACT_BOKEH_SESSION_STATE,
      expect.objectContaining({ status: "connected" }),
    );

    await expect(
      manager.handleRequest(NTERACT_BOKEH_SESSION_OPEN, {
        sessionId: "session-1",
        outputId: "output-1",
      }),
    ).resolves.toMatchObject({ status: "connected", live: false });
    await expect(
      manager.handleRequest(NTERACT_BOKEH_SET_PROPS, {
        sessionId: "session-1",
        outputId: "output-1",
        props: { slider: { value: "0.5" } },
      }),
    ).resolves.toEqual({ status: "read_only" });
    await expect(
      manager.handleRequest(NTERACT_BOKEH_SESSION_DATA, {
        sessionId: "session-1",
        outputId: "output-1",
        sources: { source: null },
        tail: true,
      }),
    ).rejects.toThrow("does not sync");
    expect(transport.getData).not.toHaveBeenCalled();
    manager.dispose();
  });
});
