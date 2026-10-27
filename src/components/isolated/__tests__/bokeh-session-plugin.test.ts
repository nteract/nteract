import { act, renderHook } from "@testing-library/react";
import type {
  BokehSessionEvents,
  BokehSessionState,
  KeyedDocFrame,
  KeyedDocResync,
  NegotiatedCapabilities,
} from "runtimed";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { JupyterOutput } from "@/components/cell/jupyter-output";
import { NTERACT_BOKEH_SESSION_MIME_TYPE } from "@/components/outputs/bokeh-mime";
import {
  getOutputSessionHostMethods,
  getOutputSessionPluginForMethod,
} from "@/components/outputs/output-session-plugins";
import {
  BOKEH_SESSION_DOC_KIND,
  type BokehDocSnapshot,
  type BokehReplicaFrameEvent,
  type BokehSessionDocReplica,
  BokehSessionDocStore,
} from "../bokeh-session-doc-store";
import {
  BOKEH_SESSION_PLUGIN_ID,
  bokehSessionPlugin,
  type BokehSessionEngine,
  type BokehSessionRuntime,
  type BokehSessionTransport,
  followBokehSessionDocs,
  installBokehSessionPlugin,
  useBokehSessionPlugin,
} from "../bokeh-session-plugin";
import {
  NTERACT_BOKEH_APPLY_PATCH,
  NTERACT_BOKEH_SESSION_DATA,
  NTERACT_BOKEH_SESSION_OPEN,
  NTERACT_BOKEH_SESSION_STATE,
  NTERACT_BOKEH_SET_PROPS,
} from "../bokeh-session-rpc";
import type { IsolatedFrameHandle } from "../isolated-frame";

const payload = {
  schema_version: 1 as const,
  session_id: "session-1",
  producer: { name: "panel", version: "1.9.4" },
  bokeh_version: "3.9.2",
  document: { roots: [] },
  root_ids: ["root-1"],
  resources: { javascript: [], stylesheets: [], javascript_modules: [], module_exports: {} },
  buffers: [],
};

function session(epoch: number): BokehSessionState {
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
    epoch,
    doc_heads: ["head"],
  };
}

function transport(
  docs: BokehSessionTransport["docs"] = null,
): BokehSessionTransport & { unsubscribe: ReturnType<typeof vi.fn> } {
  const unsubscribe = vi.fn();
  return {
    docs,
    fetchBlob: vi.fn(),
    applyPatch: vi.fn(async (options) => ({
      status: "accepted" as const,
      session_id: options.sessionId,
      transaction_id: options.transactionId,
    })),
    getData: vi.fn(),
    subscribeEvents: vi.fn(() => unsubscribe),
    unsubscribe,
  };
}

/** Just enough of an RxJS subject for the plugin's subscriptions. */
class Stream<T> {
  private readonly listeners = new Set<(value: T) => void>();
  constructor(private latest?: { value: T }) {}

  subscribe(listener: (value: T) => void) {
    this.listeners.add(listener);
    if (this.latest) listener(this.latest.value);
    return { unsubscribe: () => this.listeners.delete(listener) };
  }

  next(value: T) {
    if (this.latest) this.latest = { value };
    // Snapshot: a listener that resubscribes must not run again in this pass.
    for (const listener of Array.from(this.listeners)) listener(value);
  }

  get observed() {
    return this.listeners.size;
  }
}

function fakeEngine(kinds: string[]) {
  const engine = {
    keyedDocFrames$: new Stream<KeyedDocFrame>(),
    keyedDocResyncs$: new Stream<KeyedDocResync>(),
    keyedDocsReset$: new Stream<void>(),
    negotiatedCapabilities$: new Stream<NegotiatedCapabilities>({
      value: { keyedDocKinds: new Set(kinds) },
    }),
    bokehSessionEventsBroadcasts$: new Stream<{
      event: "bokeh_session_events";
      events: BokehSessionEvents;
    }>(),
    sendKeyedDocFrame: vi.fn(async (_kind: string, _payload: Uint8Array) => {}),
  };
  return { engine, asEngine: engine as unknown as BokehSessionEngine };
}

/** A replica that records the frames it is given; enough to see routing. */
class RecordingReplica implements BokehSessionDocReplica {
  readonly frames: Uint8Array[] = [];
  freed = false;
  constructor(readonly epoch: number) {}
  is_synced() {
    return false;
  }
  set_read_only() {}
  receive_frame(frame: Uint8Array): BokehReplicaFrameEvent {
    this.frames.push(frame);
    return { type: "applied", changed: false, changeset: emptyChangeset() };
  }
  flush_sync() {
    return new Uint8Array([this.epoch]);
  }
  cancel_last_flush() {}
  snapshot(): BokehDocSnapshot | null {
    return null;
  }
  get_model() {
    return null;
  }
  get_prop() {
    return undefined;
  }
  get_prop_origin() {
    return undefined;
  }
  set_props_json() {
    return false;
  }
  get_heads_hex() {
    return [];
  }
  free() {
    this.freed = true;
  }
}

function emptyChangeset() {
  return {
    models_added: [],
    models_removed: [],
    props_changed: {},
    columns_changed: {},
    meta_changed: false,
  };
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("bokehSessionPlugin", () => {
  it("binds session MIME outputs that carry a stable output id", () => {
    const outputs: JupyterOutput[] = [
      {
        output_id: "output-1",
        output_type: "display_data",
        data: { [NTERACT_BOKEH_SESSION_MIME_TYPE]: payload },
      },
      { output_type: "display_data", data: { [NTERACT_BOKEH_SESSION_MIME_TYPE]: payload } },
      {
        output_id: "output-3",
        output_type: "display_data",
        data: { [NTERACT_BOKEH_SESSION_MIME_TYPE]: {} },
      },
      { output_id: "output-4", output_type: "display_data", data: { "text/html": "<b>x</b>" } },
    ];

    expect(bokehSessionPlugin.bindings(outputs)).toEqual([{ outputId: "output-1", payload }]);
    expect(bokehSessionPlugin.mimeTypes).toEqual([NTERACT_BOKEH_SESSION_MIME_TYPE]);
  });

  it("registers the Bokeh host methods", () => {
    cleanups.push(installBokehSessionPlugin());

    expect(getOutputSessionHostMethods()).toEqual([
      NTERACT_BOKEH_SESSION_OPEN,
      NTERACT_BOKEH_SET_PROPS,
      NTERACT_BOKEH_APPLY_PATCH,
      NTERACT_BOKEH_SESSION_DATA,
    ]);
    expect(getOutputSessionPluginForMethod(NTERACT_BOKEH_SET_PROPS)?.id).toBe(
      BOKEH_SESSION_PLUGIN_ID,
    );
  });

  it("replaces its bridge manager only when the transport changes", async () => {
    const frame = { notifyExtension: vi.fn() } as unknown as IsolatedFrameHandle;
    const bindings = [{ outputId: "output-1", payload }];
    const docs = new BokehSessionDocStore({
      createReplica: (_sessionId, epoch) => new RecordingReplica(epoch),
      sendFrame: async () => {},
      fetchBlob: vi.fn(),
    });
    const first = transport(docs);
    const second = transport(docs);
    const bridge = bokehSessionPlugin.createBridge({
      frame,
      runtime: { sessions: {}, transport: null },
      bindings,
    })!;

    bridge.updateRuntime({ sessions: {}, transport: null } satisfies BokehSessionRuntime);
    await expect(bridge.handleRequest(NTERACT_BOKEH_SESSION_OPEN, {})).rejects.toThrow(
      "Bokeh document session transport is unavailable",
    );

    bridge.updateRuntime({ sessions: { "session-1": session(1) }, transport: first });
    bridge.updateRuntime({ sessions: { "session-1": session(2) }, transport: first });
    expect(first.subscribeEvents).toHaveBeenCalledOnce();
    expect(frame.notifyExtension).toHaveBeenLastCalledWith(NTERACT_BOKEH_SESSION_STATE, {
      sessionId: "session-1",
      outputId: "output-1",
      status: "connected",
      epoch: 2,
    });

    await expect(
      bridge.handleRequest(NTERACT_BOKEH_APPLY_PATCH, {
        sessionId: "session-1",
        outputId: "output-1",
        transactionId: "tx-1",
        patch: { events: [] },
        buffers: [],
      }),
    ).resolves.toEqual({ status: "accepted", sessionId: "session-1", transactionId: "tx-1" });
    await expect(bridge.handleRequest("nteract/unknown", {})).rejects.toThrow(
      "Unknown Bokeh session request nteract/unknown",
    );

    vi.mocked(frame.notifyExtension).mockClear();
    bridge.updateRuntime({ sessions: { "session-1": session(2) }, transport: second });
    expect(first.unsubscribe).toHaveBeenCalledOnce();
    expect(second.subscribeEvents).toHaveBeenCalledOnce();
    // The new manager re-announces the mounted session; this replaces main's
    // render-batch re-send on a transport change.
    expect(frame.notifyExtension).toHaveBeenCalledWith(NTERACT_BOKEH_SESSION_STATE, {
      sessionId: "session-1",
      outputId: "output-1",
      status: "connected",
      epoch: 2,
    });

    bridge.dispose();
    expect(second.unsubscribe).toHaveBeenCalledOnce();
    docs.dispose();
  });
});

describe("followBokehSessionDocs", () => {
  const options = () => ({
    createReplica: vi.fn((_sessionId: string, epoch: number) => new RecordingReplica(epoch)),
    fetchBlob: vi.fn(),
  });

  it("keeps no store and sends no 0x0b when the room does not route bokeh_session", () => {
    const { engine, asEngine } = fakeEngine(["test_kv"]);
    const opts = options();
    const onDocs = vi.fn();
    const stop = followBokehSessionDocs(asEngine, opts, onDocs);

    expect(onDocs).not.toHaveBeenCalled();
    expect(engine.keyedDocFrames$.observed).toBe(0);
    engine.keyedDocFrames$.next({
      kind: BOKEH_SESSION_DOC_KIND,
      id: "session-1",
      epoch: 0,
      frame: new Uint8Array([0x0b]),
    });
    expect(opts.createReplica).not.toHaveBeenCalled();
    expect(engine.sendKeyedDocFrame).not.toHaveBeenCalled();
    stop();
  });

  it("follows the negotiated kinds: routes frames while bokeh_session is routed", () => {
    const { engine, asEngine } = fakeEngine([]);
    const opts = options();
    const stores: Array<BokehSessionDocStore | null> = [];
    const stop = followBokehSessionDocs(asEngine, opts, (docs) => stores.push(docs));

    engine.negotiatedCapabilities$.next({ keyedDocKinds: new Set([BOKEH_SESSION_DOC_KIND]) });
    expect(stores).toHaveLength(1);
    const docs = stores[0]!;
    docs.updateSessions({ "session-1": session(4) });
    docs.subscribe("session-1", () => {});
    expect(engine.sendKeyedDocFrame).toHaveBeenCalledWith(
      BOKEH_SESSION_DOC_KIND,
      new Uint8Array([4]),
    );
    const replica = opts.createReplica.mock.results[0].value as RecordingReplica;
    const frame = new Uint8Array([0x0b, 1]);
    engine.keyedDocFrames$.next({ kind: BOKEH_SESSION_DOC_KIND, id: "session-1", epoch: 4, frame });
    engine.keyedDocFrames$.next({ kind: "test_kv", id: "session-1", epoch: 4, frame });
    expect(replica.frames).toEqual([frame]);

    // A reconnect that still routes the kind keeps the store and resubscribes.
    engine.negotiatedCapabilities$.next({ keyedDocKinds: new Set([BOKEH_SESSION_DOC_KIND]) });
    engine.keyedDocsReset$.next();
    expect(stores).toHaveLength(1);
    expect(replica.freed).toBe(true);
    expect(opts.createReplica).toHaveBeenCalledTimes(2);

    // A connection that no longer routes it drops the store.
    engine.negotiatedCapabilities$.next({ keyedDocKinds: new Set() });
    expect(stores).toEqual([docs, null]);
    expect(engine.keyedDocFrames$.observed).toBe(0);
    expect(engine.keyedDocResyncs$.observed).toBe(0);
    expect(engine.keyedDocsReset$.observed).toBe(0);
    stop();
    expect(engine.negotiatedCapabilities$.observed).toBe(0);
  });
});

describe("useBokehSessionPlugin", () => {
  const client = { applyBokehSessionPatch: vi.fn(), getBokehSessionData: vi.fn() };
  const createReplica = (_sessionId: string, epoch: number) => new RecordingReplica(epoch);

  it("keeps the runtime map stable across unrelated renders without registering the plugin", () => {
    const sessions = { "session-1": session(1) };
    const blobResolver = { fetch: vi.fn() };
    const { result, rerender } = renderHook(
      (props: { sessions: Record<string, BokehSessionState> }) =>
        useBokehSessionPlugin({
          sessions: props.sessions,
          engine: null,
          blobResolver,
          client,
          createReplica,
        }),
      { initialProps: { sessions } },
    );

    const runtime = result.current[BOKEH_SESSION_PLUGIN_ID] as BokehSessionRuntime;
    // Registration is a startup step (App.tsx module scope), not a render effect.
    expect(getOutputSessionPluginForMethod(NTERACT_BOKEH_SESSION_OPEN)).toBeNull();
    expect(runtime.sessions).toBe(sessions);
    expect(runtime.transport?.docs).toBeNull();
    expect(runtime.transport?.subscribeEvents(() => {})).toBeTypeOf("function");

    const first = result.current;
    rerender({ sessions });
    expect(result.current).toBe(first);

    const nextSessions = { "session-1": session(2) };
    rerender({ sessions: nextSessions });
    const next = result.current[BOKEH_SESSION_PLUGIN_ID] as BokehSessionRuntime;
    expect(next.sessions).toBe(nextSessions);
    expect(next.transport).toBe(runtime.transport);
  });

  it("provides no transport until a blob resolver is available", () => {
    const engine = fakeEngine([BOKEH_SESSION_DOC_KIND]).asEngine;
    const sessions = {};
    const { result } = renderHook(() =>
      useBokehSessionPlugin({
        sessions,
        engine,
        blobResolver: null,
        client,
        createReplica,
      }),
    );

    expect((result.current[BOKEH_SESSION_PLUGIN_ID] as BokehSessionRuntime).transport).toBeNull();
  });

  it("serves outputs statically without the capability and live once it arrives", async () => {
    const { engine, asEngine } = fakeEngine([]);
    const sessions = { "session-1": session(0) };
    const blobResolver = { fetch: vi.fn() };
    const { result, unmount } = renderHook(() =>
      useBokehSessionPlugin({
        sessions,
        engine: asEngine,
        blobResolver,
        client,
        createReplica,
      }),
    );
    const frame = { notifyExtension: vi.fn() } as unknown as IsolatedFrameHandle;
    const bridge = bokehSessionPlugin.createBridge({
      frame,
      runtime: result.current[BOKEH_SESSION_PLUGIN_ID] as BokehSessionRuntime,
      bindings: [{ outputId: "output-1", payload }],
    })!;
    bridge.updateRuntime(result.current[BOKEH_SESSION_PLUGIN_ID]);
    const open = { sessionId: "session-1", outputId: "output-1" };

    await expect(bridge.handleRequest(NTERACT_BOKEH_SESSION_OPEN, open)).resolves.toMatchObject({
      status: "connected",
      live: false,
    });
    expect(engine.sendKeyedDocFrame).not.toHaveBeenCalled();
    expect(engine.keyedDocFrames$.observed).toBe(0);

    act(() => {
      engine.negotiatedCapabilities$.next({ keyedDocKinds: new Set([BOKEH_SESSION_DOC_KIND]) });
    });
    const live = result.current[BOKEH_SESSION_PLUGIN_ID] as BokehSessionRuntime;
    expect(live.transport?.docs).toBeInstanceOf(BokehSessionDocStore);
    bridge.updateRuntime(live);
    await expect(bridge.handleRequest(NTERACT_BOKEH_SESSION_OPEN, open)).resolves.toMatchObject({
      live: true,
    });
    expect(engine.sendKeyedDocFrame).toHaveBeenCalledWith(
      BOKEH_SESSION_DOC_KIND,
      new Uint8Array([0]),
    );

    bridge.dispose();
    unmount();
    expect(engine.keyedDocFrames$.observed).toBe(0);
    expect(engine.negotiatedCapabilities$.observed).toBe(0);
  });
});
