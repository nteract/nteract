import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  NTERACT_BOKEH_APPLY_PATCH,
  NTERACT_BOKEH_SESSION_DATA,
  NTERACT_BOKEH_SESSION_DOC,
  NTERACT_BOKEH_SESSION_EVENTS,
  NTERACT_BOKEH_SESSION_OPEN,
  NTERACT_BOKEH_SESSION_STATE,
  NTERACT_BOKEH_SET_PROPS,
  type NteractBokehDocUpdate,
  type NteractBokehResolvedEvents,
  type NteractBokehSessionDataParams,
  type NteractBokehSessionDataResult,
  type NteractBokehSessionOpenResult,
} from "@/components/isolated/bokeh-session-rpc";
import {
  BokehSessionController,
  deferExistingModelUpdates,
  extractBokehPatchBuffers,
  materializeDocJson,
  ModelExpander,
  type BokehRuntime,
} from "../bokeh-session-controller";

class FakeBuffer {
  constructor(readonly buffer: ArrayBuffer) {}
}

interface FakeProp {
  syncable?: boolean;
  may_have_refs?: boolean;
}

class FakeBokehModel {
  data: unknown = undefined;
  setv = vi.fn((attrs: Record<string, unknown>) => {
    Object.assign(this, attrs);
  });

  constructor(
    readonly id: string,
    readonly type: string,
    readonly properties: Record<string, FakeProp> = {},
    readonly stream_to?: () => void,
  ) {}
}

class FakeDocument {
  all_roots: Array<{ id: string }>;
  models = new Map<string, FakeBokehModel>();
  listeners = new Set<(event: Record<string, unknown>) => void>();
  applied: Array<{ patch: Record<string, unknown>; buffers?: Map<string, ArrayBuffer> }> = [];
  cleared = false;

  constructor(readonly json: Record<string, unknown>) {
    const roots = (json.roots ?? []) as Array<{ id: string }>;
    this.all_roots = roots.map((root) => ({ id: root.id }));
    this.add(new FakeBokehModel("root-1", "Column"));
    this.add(new FakeBokehModel("slider", "Slider"));
    this.add(
      new FakeBokehModel("source", "ColumnDataSource", { data: { syncable: true } }, () => {}),
    );
  }

  add(model: FakeBokehModel) {
    this.models.set(model.id, model);
  }

  get_model_by_id(id: string) {
    return this.models.get(id) ?? null;
  }

  on_change(listener: (event: Record<string, unknown>) => void) {
    this.listeners.add(listener);
  }

  remove_on_change(listener: (event: Record<string, unknown>) => void) {
    this.listeners.delete(listener);
  }

  create_json_patch(events: Record<string, unknown>[]) {
    return {
      events: events.map((event) => ({
        kind: event.kind,
        msg_type: event.msg_type,
        model: event.model ? { id: (event.model as { id: string }).id } : undefined,
        payload: new FakeBuffer(new Uint8Array([4, 5, 6]).buffer),
      })),
    };
  }

  apply_json_patch(patch: Record<string, unknown>, buffers?: Map<string, ArrayBuffer>) {
    this.applied.push({ patch: structuredClone(patch), buffers });
  }

  clear() {
    this.cleared = true;
  }

  emit(event: Record<string, unknown>) {
    for (const listener of this.listeners) listener(event);
  }

  appliedEvents(): Array<Record<string, unknown>> {
    return this.applied.flatMap(
      (entry) => (entry.patch.events ?? []) as Array<Record<string, unknown>>,
    );
  }
}

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1 as const,
    session_id: "session-1",
    producer: { name: "panel", version: "1.9.4" },
    bokeh_version: "3.9.2",
    document: { roots: [{ id: "root-1" }] },
    root_ids: ["root-1"],
    resources: {
      javascript: [],
      stylesheets: [],
      javascript_modules: [],
      module_exports: {},
    },
    buffers: [] as Array<{ id: string; hash: string; size: number }>,
    ...overrides,
  };
}

function fullUpdate(overrides: Partial<NteractBokehDocUpdate> = {}): NteractBokehDocUpdate {
  return {
    sessionId: "session-1",
    epoch: 3,
    kind: "full",
    canSwitch: false,
    meta: { rootIds: ["root-1"], title: "Page", bokehVersion: "3.9.2", docExtras: null },
    models: {
      "root-1": { type: "Column", refProps: ["children"], props: { children: [{ id: "slider" }] } },
      slider: { type: "Slider", refProps: [], props: { value: 0.5 } },
      source: { type: "ColumnDataSource", refProps: [], props: {} },
    },
    props: {},
    removed: [],
    columns: { source: { x: { version: 2, size: 10 } } },
    ...overrides,
  };
}

function deltaUpdate(overrides: Partial<NteractBokehDocUpdate> = {}): NteractBokehDocUpdate {
  return {
    sessionId: "session-1",
    epoch: 3,
    kind: "delta",
    canSwitch: false,
    meta: null,
    models: {},
    props: {},
    removed: [],
    columns: {},
    ...overrides,
  };
}

function eventsFor(
  overrides: Partial<NteractBokehResolvedEvents> = {},
): NteractBokehResolvedEvents {
  return {
    sessionId: "session-1",
    epoch: 3,
    transactionId: "kernel-tx",
    dataEvents: [],
    messages: [],
    buffers: [],
    ...overrides,
  };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

function harness(
  options: {
    open?: Partial<NteractBokehSessionOpenResult> | Error;
    payload?: Record<string, unknown>;
    data?: (params: NteractBokehSessionDataParams) => NteractBokehSessionDataResult;
    setProps?: () => unknown;
  } = {},
) {
  const documents: FakeDocument[] = [];
  const runtime: BokehRuntime = {
    Document: {
      from_json: (json) => {
        const document = new FakeDocument(json);
        documents.push(document);
        return document as unknown as ReturnType<BokehRuntime["Document"]["from_json"]>;
      },
    },
    Buffer: FakeBuffer,
    addDocumentStandalone: async (_document, element) => {
      element.appendChild(document.createElement("div"));
      return { clear: vi.fn() };
    },
  };
  const notifications = new Map<string, Set<(params: unknown) => void>>();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const data =
    options.data ??
    ((params: NteractBokehSessionDataParams): NteractBokehSessionDataResult => ({
      epoch: 3,
      columns: Object.fromEntries(
        Object.keys(params.sources).map((sourceId) => [
          sourceId,
          { x: { version: 2, data: { type: "ndarray", array: [1, 2] } } },
        ]),
      ),
      events: [],
      foldRequested: [],
    }));
  const requestHost = vi.fn(async (method: string, params?: unknown) => {
    calls.push({ method, params: params as Record<string, unknown> });
    if (method === NTERACT_BOKEH_SESSION_OPEN) {
      if (options.open instanceof Error) throw options.open;
      return {
        sessionId: "session-1",
        outputId: "output-1",
        status: "connected",
        epoch: 3,
        live: true,
        ...options.open,
      };
    }
    if (method === NTERACT_BOKEH_SESSION_DATA) {
      return data(params as NteractBokehSessionDataParams);
    }
    if (method === NTERACT_BOKEH_SET_PROPS) return options.setProps?.() ?? { status: "written" };
    if (method === NTERACT_BOKEH_APPLY_PATCH) {
      const request = params as { transactionId: string };
      return { status: "accepted", sessionId: "session-1", transactionId: request.transactionId };
    }
    throw new Error(`Unexpected method ${method}`);
  });
  const subscribeHostNotification = (method: string, listener: (params: unknown) => void) => {
    const listeners = notifications.get(method) ?? new Set();
    listeners.add(listener);
    notifications.set(method, listeners);
    return () => listeners.delete(listener);
  };
  const notify = (method: string, params: unknown) => {
    for (const listener of notifications.get(method) ?? []) listener(params);
  };
  const sendDoc = async (update: NteractBokehDocUpdate) => {
    notify(NTERACT_BOKEH_SESSION_DOC, { outputId: "output-1", update });
    await settle();
  };
  const sendEvents = async (events: NteractBokehResolvedEvents) => {
    notify(NTERACT_BOKEH_SESSION_EVENTS, { outputId: "output-1", events });
    await settle();
  };
  const container = document.createElement("div");
  const onStatus = vi.fn();
  const onReadOnly = vi.fn();
  const controller = new BokehSessionController({
    outputId: "output-1",
    payload: makePayload(options.payload),
    container,
    runtime,
    requestHost,
    subscribeHostNotification,
    onStatus,
    onReadOnly,
    onLayout: vi.fn(),
  });
  const callsTo = (method: string) => calls.filter((call) => call.method === method);
  return {
    calls,
    callsTo,
    container,
    controller,
    documents,
    notify,
    onReadOnly,
    onStatus,
    requestHost,
    sendDoc,
    sendEvents,
  };
}

/** A live controller that applied its first full update at epoch 3. */
async function synced(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  await h.controller.start();
  await h.sendDoc(fullUpdate());
  const document = h.documents[0];
  document.applied.length = 0;
  h.calls.length = 0;
  return { ...h, document };
}

describe("BokehSessionController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("copies Bokeh buffers before replacing them with transport ids", () => {
    const source = new Uint8Array([1, 2, 3]).buffer;
    const patch = { data: new FakeBuffer(source) };

    const buffers = extractBokehPatchBuffers(patch, FakeBuffer, "transaction-1");

    expect(patch.data).toEqual({ id: "transaction-1:0" });
    expect(buffers[0].data).not.toBe(source);
    expect(new Uint8Array(buffers[0].data)).toEqual(new Uint8Array([1, 2, 3]));
  });

  describe("read-only outputs", () => {
    it("renders a frozen output from the payload's document and sends nothing", async () => {
      const { controller, documents, onStatus, callsTo } = harness({
        open: { status: "disconnected", live: false },
      });
      await controller.start();

      expect(documents).toHaveLength(1);
      expect(documents[0].json).toEqual({ roots: [{ id: "root-1" }] });
      expect(onStatus).toHaveBeenLastCalledWith("disconnected", undefined);

      documents[0].emit({
        kind: "ModelChanged",
        attr: "value",
        value: 1,
        model: documents[0].get_model_by_id("slider"),
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(callsTo(NTERACT_BOKEH_SET_PROPS)).toHaveLength(0);
      controller.dispose();
    });

    it("renders the state saved on save over the display-time document", async () => {
      const saved = { roots: [{ id: "root-1" }], title: "saved" };
      const { controller, documents } = harness({
        open: { status: "connected", live: false },
        // Out-of-band buffers belong to the display-time document only.
        payload: {
          snapshot: { document: saved, buffers: [] },
          buffers: [{ id: "b0", hash: "h", size: 3 }],
        },
      });
      await controller.start();

      expect(documents).toHaveLength(1);
      expect(documents[0].json).toEqual(saved);
      controller.dispose();
    });

    it("mounts a live session from the document, not the saved state", async () => {
      const { controller, documents } = harness({
        payload: { snapshot: { document: { roots: [{ id: "stale" }] }, buffers: [] } },
      });
      await controller.start();

      expect(documents[0].json).toEqual({ roots: [{ id: "root-1" }] });
      controller.dispose();
    });

    it("renders the payload when the host has no session support", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { controller, documents, onStatus } = harness({ open: new Error("unavailable") });
      await controller.start();

      expect(documents).toHaveLength(1);
      expect(onStatus).toHaveBeenLastCalledWith("disconnected", undefined);
      controller.dispose();
    });

    it("stops writing and keeps the document once the session disconnects", async () => {
      const { controller, document, notify, callsTo, onStatus } = await synced();
      const slider = document.get_model_by_id("slider")!;
      slider.properties.value = { syncable: true };

      document.emit({ kind: "ModelChanged", attr: "value", value: 0.7, model: slider });
      notify(NTERACT_BOKEH_SESSION_STATE, {
        sessionId: "session-1",
        outputId: "output-1",
        status: "disconnected",
        epoch: 3,
      });
      document.emit({ kind: "ModelChanged", attr: "value", value: 0.8, model: slider });
      await vi.advanceTimersByTimeAsync(100);

      expect(onStatus).toHaveBeenLastCalledWith("disconnected", undefined);
      expect(callsTo(NTERACT_BOKEH_SET_PROPS)).toHaveLength(0);
      expect(document.cleared).toBe(false);
      controller.dispose();
    });
  });

  describe("host changes", () => {
    const state = (overrides: Record<string, unknown> = {}) => ({
      sessionId: "session-1",
      outputId: "output-1",
      status: "connected",
      epoch: 3,
      live: true,
      writable: true,
      ...overrides,
    });

    it("re-opens when a new host does not follow its live session yet", async () => {
      const { controller, document, documents, notify, sendDoc, callsTo } = await synced();
      const slider = document.get_model_by_id("slider")!;
      slider.properties.value = { syncable: true };

      notify(NTERACT_BOKEH_SESSION_STATE, state());
      await settle();
      expect(callsTo(NTERACT_BOKEH_SESSION_OPEN)).toHaveLength(0);

      // A transport reconnect replaced the host's bridge, which has no
      // subscription for this frame while the session stays connected.
      notify(NTERACT_BOKEH_SESSION_STATE, state({ live: false }));
      await settle();
      expect(callsTo(NTERACT_BOKEH_SESSION_OPEN)).toHaveLength(1);

      await sendDoc(fullUpdate());
      expect(documents).toHaveLength(1);
      document.emit({ kind: "ModelChanged", attr: "value", value: 0.6, model: slider });
      await vi.advanceTimersByTimeAsync(50);
      expect(callsTo(NTERACT_BOKEH_SET_PROPS).map((call) => call.params.props)).toEqual([
        { slider: { value: "0.6" } },
      ]);
      controller.dispose();
    });

    it("keeps a viewer's edits local and marks the output read-only", async () => {
      const { controller, document, notify, onReadOnly, calls, callsTo } = await synced({
        open: { writable: false },
      });
      const slider = document.get_model_by_id("slider")!;
      slider.properties.value = { syncable: true };
      expect(onReadOnly).toHaveBeenLastCalledWith(true);

      document.emit({ kind: "ModelChanged", attr: "value", value: 0.6, model: slider });
      document.emit({ kind: "MessageSent", msg_type: "bokeh_event", msg_data: {} });
      await vi.advanceTimersByTimeAsync(100);
      expect(calls).toEqual([]);

      notify(NTERACT_BOKEH_SESSION_STATE, state({ writable: true }));
      expect(onReadOnly).toHaveBeenLastCalledWith(false);
      document.emit({ kind: "ModelChanged", attr: "value", value: 0.7, model: slider });
      await vi.advanceTimersByTimeAsync(50);
      expect(callsTo(NTERACT_BOKEH_SET_PROPS).map((call) => call.params.props)).toEqual([
        { slider: { value: "0.7" } },
      ]);
      controller.dispose();
    });
  });

  describe("document updates", () => {
    it("loads every column and the tail on the first full update", async () => {
      const { controller, documents, callsTo, sendDoc } = harness();
      await controller.start();
      await sendDoc(fullUpdate());

      expect(callsTo(NTERACT_BOKEH_SESSION_DATA)[0].params).toEqual({
        sessionId: "session-1",
        outputId: "output-1",
        sources: { source: null },
        tail: true,
      });
      const events = documents[0].appliedEvents();
      expect(events[0]).toMatchObject({
        kind: "RootAdded",
        model: {
          type: "object",
          name: "Column",
          id: "root-1",
          attributes: {
            children: [
              { type: "object", name: "Slider", id: "slider", attributes: { value: 0.5 } },
            ],
          },
        },
      });
      expect(events).toContainEqual({ kind: "TitleChanged", title: "Page" });
      expect(events).toContainEqual({
        kind: "ColumnDataChanged",
        model: { id: "source" },
        attr: "data",
        data: { type: "map", entries: [["x", { type: "ndarray", array: [1, 2] }]] },
      });
      controller.dispose();
    });

    it("mounts a live payload with out-of-band buffers from the first full update", async () => {
      const { controller, documents, sendDoc } = harness({
        payload: { buffers: [{ id: "b0", hash: "abc", size: 3 }] },
      });
      await controller.start();
      expect(documents).toHaveLength(0);

      await sendDoc(fullUpdate());

      expect(documents).toHaveLength(1);
      expect(documents[0].json).toMatchObject({
        version: "3.9.2",
        title: "Page",
        roots: [{ type: "object", name: "Column", id: "root-1" }],
      });
      controller.dispose();
    });

    it("replays the tail before creating views when it mounts from the first full update", async () => {
      const h = harness({
        payload: { buffers: [{ id: "b0", hash: "abc", size: 3 }] },
        data: () => ({
          epoch: 3,
          columns: { source: { x: { version: 2, data: [1, 2] } } },
          events: [
            eventsFor({
              dataEvents: [
                {
                  kind: "ColumnsPatched",
                  source_id: "source",
                  base_version: 2,
                  new_version: 3,
                  patches: { type: "map", entries: [["x", [[0, 9]]]] },
                },
              ],
            }),
          ],
          foldRequested: [],
        }),
      });
      const appliedBeforeViews: number[] = [];
      const addDocumentStandalone = h.controller["options"].runtime.addDocumentStandalone;
      h.controller["options"].runtime.addDocumentStandalone = async (document, element) => {
        appliedBeforeViews.push(h.documents[0].appliedEvents().length);
        return addDocumentStandalone(document, element);
      };
      await h.controller.start();
      await h.sendDoc(fullUpdate());

      expect(h.documents[0].appliedEvents()).toEqual([
        expect.objectContaining({ kind: "ColumnsPatched", model: { id: "source" } }),
      ]);
      expect(appliedBeforeViews).toEqual([1]);
      h.controller.dispose();
    });

    it("turns changed properties into ModelChanged events with new models inlined once", async () => {
      const { controller, document, sendDoc } = await synced();

      await sendDoc(
        deltaUpdate({
          models: {
            glyph: { type: "Line", refProps: ["source"], props: { source: { id: "source" } } },
            renderer: {
              type: "GlyphRenderer",
              refProps: ["glyph"],
              props: { glyph: { id: "glyph" } },
            },
          },
          props: {
            "root-1": { children: [{ id: "slider" }, { id: "renderer" }] },
            slider: { value: 0.9, tags: [{ id: "renderer" }] },
            unknown: { value: 1 },
          },
        }),
      );

      expect(document.appliedEvents()).toEqual([
        {
          kind: "ModelChanged",
          model: { id: "root-1" },
          attr: "children",
          new: [
            { id: "slider" },
            {
              type: "object",
              name: "GlyphRenderer",
              id: "renderer",
              attributes: {
                glyph: {
                  type: "object",
                  name: "Line",
                  id: "glyph",
                  attributes: { source: { id: "source" } },
                },
              },
            },
          ],
        },
        { kind: "ModelChanged", model: { id: "slider" }, attr: "value", new: 0.9 },
        { kind: "ModelChanged", model: { id: "slider" }, attr: "tags", new: [{ id: "renderer" }] },
      ]);
      controller.dispose();
    });

    it("adds and removes roots when the meta changes", async () => {
      const { controller, document, sendDoc } = await synced();

      await sendDoc(
        deltaUpdate({
          meta: { rootIds: ["new-root"], title: null, bokehVersion: "3.9.2", docExtras: null },
          models: { "new-root": { type: "Div", refProps: [], props: { text: "hi" } } },
        }),
      );

      expect(document.appliedEvents()).toEqual([
        {
          kind: "RootAdded",
          model: { type: "object", name: "Div", id: "new-root", attributes: { text: "hi" } },
        },
        { kind: "RootRemoved", model: { id: "root-1" } },
      ]);
      controller.dispose();
    });

    it("loads only columns newer than the frame's version from document changes", async () => {
      const { controller, document, sendDoc, callsTo } = await synced();

      // A fold moves refs at the version the frame already has.
      await sendDoc(deltaUpdate({ columns: { source: { x: { version: 2, size: 8 } } } }));
      expect(callsTo(NTERACT_BOKEH_SESSION_DATA)).toHaveLength(0);

      await sendDoc(
        deltaUpdate({
          columns: { source: { x: { version: 2, size: 8 }, y: { version: 5, size: 8 }, z: null } },
        }),
      );
      expect(callsTo(NTERACT_BOKEH_SESSION_DATA)[0].params).toMatchObject({
        sources: { source: ["y"] },
        tail: false,
      });
      expect(document.appliedEvents()[0]).toMatchObject({
        kind: "ColumnDataChanged",
        model: { id: "source" },
        cols: ["x"],
      });
      controller.dispose();
    });

    it("switches epochs without touching BokehJS when it showed the replaced document", async () => {
      const { controller, document, sendDoc, callsTo } = await synced();

      await sendDoc(fullUpdate({ epoch: 4, canSwitch: true }));
      expect(document.applied).toHaveLength(0);
      expect(callsTo(NTERACT_BOKEH_SESSION_DATA)).toHaveLength(0);

      await sendDoc(deltaUpdate({ epoch: 4, props: { slider: { value: 0.1 } } }));
      expect(document.appliedEvents()).toEqual([
        { kind: "ModelChanged", model: { id: "slider" }, attr: "value", new: 0.1 },
      ]);
      // Deltas of the replaced epoch are stale.
      document.applied.length = 0;
      await sendDoc(deltaUpdate({ epoch: 3, props: { slider: { value: 0.2 } } }));
      expect(document.applied).toHaveLength(0);
      controller.dispose();
    });

    it("reconciles a new epoch in place with full-state defaults otherwise", async () => {
      const { controller, document, sendDoc, callsTo } = await synced();

      await sendDoc(fullUpdate({ epoch: 4, columns: { source: { x: { version: 2, size: 10 } } } }));

      // Versions are unchanged, so no column is reloaded.
      expect(callsTo(NTERACT_BOKEH_SESSION_DATA)).toHaveLength(0);
      expect(document.appliedEvents().map((event) => event.kind)).toEqual([
        "RootAdded",
        "TitleChanged",
      ]);
      controller.dispose();
    });
  });

  describe("local property writes", () => {
    it("writes debounced values and suppresses their echo during the grace window", async () => {
      const { controller, document, sendDoc, callsTo } = await synced();
      const slider = document.get_model_by_id("slider")!;
      slider.properties.value = { syncable: true };

      document.emit({ kind: "ModelChanged", attr: "value", value: 0.6, model: slider });
      document.emit({ kind: "ModelChanged", attr: "value", value: 0.7, model: slider });
      await vi.advanceTimersByTimeAsync(50);

      expect(callsTo(NTERACT_BOKEH_SET_PROPS).map((call) => call.params)).toEqual([
        { sessionId: "session-1", outputId: "output-1", props: { slider: { value: "0.7" } } },
      ]);

      // A remote change this host's value won re-delivers a written value.
      await sendDoc(
        deltaUpdate({
          props: { slider: { value: 0.6 } },
          propOrigins: { slider: { value: "local" } },
        }),
      );
      expect(document.applied).toHaveLength(0);
      await sendDoc(deltaUpdate({ props: { slider: { value: 0.3 } } }));
      expect(document.appliedEvents()).toEqual([
        { kind: "ModelChanged", model: { id: "slider" }, attr: "value", new: 0.3 },
      ]);

      await vi.advanceTimersByTimeAsync(500);
      document.applied.length = 0;
      await sendDoc(deltaUpdate({ props: { slider: { value: 0.6 } } }));
      expect(document.applied).toHaveLength(1);
      controller.dispose();
    });

    it("applies a kernel correction to an intermediate value it wrote", async () => {
      const { controller, document, sendDoc, callsTo } = await synced();
      const range = new FakeBokehModel("range", "Range1d", { start: { syncable: true } });
      document.add(range);
      await sendDoc(
        deltaUpdate({ models: { range: { type: "Range1d", refProps: [], props: { start: 0 } } } }),
      );
      document.applied.length = 0;

      document.emit({ kind: "ModelChanged", attr: "start", value: 1, model: range });
      document.emit({ kind: "ModelChanged", attr: "start", value: 2, model: range });
      await vi.advanceTimersByTimeAsync(50);
      expect(callsTo(NTERACT_BOKEH_SET_PROPS).map((call) => call.params.props)).toEqual([
        { range: { start: "2" } },
      ]);

      // A Python callback clamps `2` back to `1`.
      await sendDoc(
        deltaUpdate({
          props: { range: { start: 1 } },
          propOrigins: { range: { start: "kernel" } },
        }),
      );
      expect(document.appliedEvents()).toEqual([
        { kind: "ModelChanged", model: { id: "range" }, attr: "start", new: 1 },
      ]);

      // Another peer's value is applied too, even if this frame wrote it.
      document.applied.length = 0;
      await sendDoc(
        deltaUpdate({ props: { range: { start: 2 } }, propOrigins: { range: { start: "peer" } } }),
      );
      expect(document.appliedEvents()).toEqual([
        { kind: "ModelChanged", model: { id: "range" }, attr: "start", new: 2 },
      ]);
      controller.dispose();
    });

    it("keeps an unflushed local edit over any remote value", async () => {
      const { controller, document, sendDoc, callsTo } = await synced();
      const slider = document.get_model_by_id("slider")!;
      slider.properties.value = { syncable: true };

      document.emit({ kind: "ModelChanged", attr: "value", value: 0.6, model: slider });
      await sendDoc(
        deltaUpdate({
          props: { slider: { value: 0.1 } },
          propOrigins: { slider: { value: "kernel" } },
        }),
      );
      expect(document.applied).toHaveLength(0);

      // The edit is written after the remote value and wins in the document.
      await vi.advanceTimersByTimeAsync(50);
      expect(callsTo(NTERACT_BOKEH_SET_PROPS).map((call) => call.params.props)).toEqual([
        { slider: { value: "0.6" } },
      ]);
      controller.dispose();
    });

    it("never writes reference, unsyncable or columnar data properties", async () => {
      const { controller, document, callsTo } = await synced();
      const root = document.get_model_by_id("root-1")!;
      root.properties.children = { syncable: true, may_have_refs: true };
      const slider = document.get_model_by_id("slider")!;
      slider.properties.hidden = { syncable: false };
      const local = new FakeBokehModel("frame-only", "Div", { text: { syncable: true } });
      document.add(local);

      document.emit({ kind: "ModelChanged", attr: "children", value: [], model: root });
      document.emit({ kind: "ModelChanged", attr: "text", value: "x", model: local });
      document.emit({ kind: "ModelChanged", attr: "hidden", value: 1, model: slider });
      document.emit({
        kind: "ModelChanged",
        attr: "data",
        value: { x: [1] },
        model: document.get_model_by_id("source"),
      });
      document.emit({ kind: "ModelChanged", attr: "value", sync: false, value: 1, model: slider });
      await vi.advanceTimersByTimeAsync(100);

      expect(callsTo(NTERACT_BOKEH_SET_PROPS)).toHaveLength(0);
      controller.dispose();
    });

    it("writes values whose BokehJS type may hold refs when Python says it cannot", async () => {
      // panel-material-ui declares widget values generically, so BokehJS sets
      // may_have_refs on a slider value the session document lists as a value.
      const { controller, document, callsTo } = await synced();
      const slider = document.get_model_by_id("slider")!;
      slider.properties.value_throttled = { syncable: true, may_have_refs: true };

      document.emit({ kind: "ModelChanged", attr: "value_throttled", value: 2.2, model: slider });
      await vi.advanceTimersByTimeAsync(60);

      expect(callsTo(NTERACT_BOKEH_SET_PROPS).map((call) => call.params)).toEqual([
        {
          sessionId: "session-1",
          outputId: "output-1",
          props: { slider: { value_throttled: "2.2" } },
        },
      ]);
      controller.dispose();
    });

    it("asks for the document again when the host rejects a write", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { controller, document, callsTo } = await synced({
        setProps: () => ({ status: "rejected", error: "refused" }),
      });
      const slider = document.get_model_by_id("slider")!;
      slider.properties.value = { syncable: true };

      document.emit({ kind: "ModelChanged", attr: "value", value: 0.6, model: slider });
      await vi.advanceTimersByTimeAsync(60);

      expect(callsTo(NTERACT_BOKEH_SESSION_OPEN)).toHaveLength(1);
      controller.dispose();
    });

    it("sends one-off events after the property writes made before them", async () => {
      const { controller, document, calls } = await synced();
      const slider = document.get_model_by_id("slider")!;
      slider.properties.value = { syncable: true };

      document.emit({ kind: "ModelChanged", attr: "value", value: 0.6, model: slider });
      document.emit({ kind: "MessageSent", msg_type: "bokeh_event", msg_data: {} });
      document.emit({
        kind: "MessageSent",
        msg_type: "bokeh_event",
        msg_data: { event_name: "document_ready" },
      });
      await settle();

      expect(calls.map((call) => call.method)).toEqual([
        NTERACT_BOKEH_SET_PROPS,
        NTERACT_BOKEH_APPLY_PATCH,
      ]);
      const request = calls[1].params as { transactionId: string; buffers: unknown[] };
      expect(request.buffers).toHaveLength(1);
      controller.dispose();
    });
  });

  describe("data events", () => {
    it("applies contiguous data events with Bokeh's stream and patch", async () => {
      const { controller, document, sendEvents } = await synced();
      const buffer = new Uint8Array([1]).buffer;

      await sendEvents(
        eventsFor({
          dataEvents: [
            {
              kind: "ColumnsStreamed",
              source_id: "source",
              base_version: 2,
              new_version: 3,
              data: { type: "map", entries: [["x", { type: "bytes", data: { id: "b0" } }]] },
              rollover: 100,
            },
            {
              kind: "ColumnsPatched",
              source_id: "source",
              base_version: 3,
              new_version: 4,
              patches: { type: "map", entries: [["x", [[0, 9]]]] },
            },
            // Already applied.
            {
              kind: "ColumnsPatched",
              source_id: "source",
              base_version: 1,
              new_version: 2,
              patches: {},
            },
          ],
          messages: [{ msg_type: "custom", msg_data: { a: 1 } }],
          buffers: [{ id: "b0", data: buffer }],
        }),
      );

      expect(document.applied).toHaveLength(1);
      expect(document.applied[0].buffers?.get("b0")).toBe(buffer);
      expect(document.appliedEvents()).toEqual([
        {
          kind: "ColumnsStreamed",
          model: { id: "source" },
          attr: "data",
          data: { type: "map", entries: [["x", { type: "bytes", data: { id: "b0" } }]] },
          rollover: 100,
        },
        {
          kind: "ColumnsPatched",
          model: { id: "source" },
          attr: "data",
          patches: { type: "map", entries: [["x", [[0, 9]]]] },
        },
        { kind: "MessageSent", msg_type: "custom", msg_data: { a: 1 } },
      ]);
      controller.dispose();
    });

    it("adopts the version of its own stream or patch without applying it again", async () => {
      const { controller, document, sendEvents, calls } = await synced();
      document.emit({ kind: "ColumnsPatched", model: document.get_model_by_id("source") });
      await settle();
      const transactionId = (calls[0].params as { transactionId: string }).transactionId;

      await sendEvents(
        eventsFor({
          transactionId,
          dataEvents: [
            {
              kind: "ColumnsPatched",
              source_id: "source",
              base_version: 2,
              new_version: 3,
              patches: {},
              echo_of: 0,
            },
          ],
        }),
      );
      expect(document.applied).toHaveLength(0);

      await sendEvents(
        eventsFor({
          dataEvents: [
            {
              kind: "ColumnsPatched",
              source_id: "source",
              base_version: 3,
              new_version: 4,
              patches: {},
            },
          ],
        }),
      );
      expect(document.appliedEvents()).toHaveLength(1);
      controller.dispose();
    });

    it("applies data events callbacks derived from its own edit", async () => {
      const h = harness();
      await h.controller.start();
      const document = h.documents[0];
      document.add(
        new FakeBokehModel("source-b", "ColumnDataSource", { data: { syncable: true } }, () => {}),
      );
      await h.sendDoc(
        fullUpdate({
          models: {
            ...fullUpdate().models,
            "source-b": { type: "ColumnDataSource", refProps: [], props: {} },
          },
          columns: {
            source: { x: { version: 2, size: 10 } },
            "source-b": { x: { version: 2, size: 10 } },
          },
        }),
      );
      document.applied.length = 0;
      h.calls.length = 0;

      // A browser stream on source A; a Python callback streams source B and
      // then source A again, all under the request's transaction.
      document.emit({ kind: "ColumnsStreamed", model: document.get_model_by_id("source") });
      await settle();
      const transactionId = (h.calls[0].params as { transactionId: string }).transactionId;
      const stream = (sourceId: string, base: number, echoOf?: number) => ({
        kind: "ColumnsStreamed" as const,
        source_id: sourceId,
        base_version: base,
        new_version: base + 1,
        data: { type: "map", entries: [["x", [base]]] },
        ...(echoOf !== undefined ? { echo_of: echoOf } : {}),
      });
      await h.sendEvents(
        eventsFor({
          transactionId,
          dataEvents: [stream("source", 2, 0), stream("source-b", 2), stream("source", 3)],
        }),
      );

      expect(document.appliedEvents()).toEqual([
        {
          kind: "ColumnsStreamed",
          model: { id: "source-b" },
          attr: "data",
          data: { type: "map", entries: [["x", [2]]] },
        },
        {
          kind: "ColumnsStreamed",
          model: { id: "source" },
          attr: "data",
          data: { type: "map", entries: [["x", [3]]] },
        },
      ]);

      // Both sources continue from the versions they reached.
      document.applied.length = 0;
      await h.sendEvents(eventsFor({ dataEvents: [stream("source", 4), stream("source-b", 3)] }));
      expect(document.appliedEvents().map((event) => event.model)).toEqual([
        { id: "source" },
        { id: "source-b" },
      ]);
      expect(h.callsTo(NTERACT_BOKEH_SESSION_DATA)).toHaveLength(0);
      h.controller.dispose();
    });

    it("applies an echo marker only for its own edit's source, index and transaction", async () => {
      const patch = (base: number, echoOf: number) => ({
        kind: "ColumnsPatched" as const,
        source_id: "source",
        base_version: base,
        new_version: base + 1,
        patches: {},
        echo_of: echoOf,
      });
      const ownPatch = async () => {
        const h = await synced();
        h.document.emit({ kind: "ColumnsPatched", model: h.document.get_model_by_id("source") });
        await settle();
        const transactionId = (h.calls[0].params as { transactionId: string }).transactionId;
        return { ...h, transactionId };
      };

      // Another frame's transaction, or another edit index, is not the echo.
      for (const [transaction, index] of [
        ["other", 0],
        ["own", 1],
      ] as const) {
        const h = await ownPatch();
        const transactionId = transaction === "own" ? h.transactionId : "other";
        await h.sendEvents(eventsFor({ transactionId, dataEvents: [patch(2, index)] }));
        expect(h.document.appliedEvents()).toHaveLength(1);
        h.controller.dispose();
      }

      // The echo is matched once; a repeat marker is applied.
      const h = await ownPatch();
      await h.sendEvents(
        eventsFor({ transactionId: h.transactionId, dataEvents: [patch(2, 0), patch(3, 0)] }),
      );
      expect(h.document.appliedEvents()).toHaveLength(1);
      expect(h.callsTo(NTERACT_BOKEH_SESSION_DATA)).toHaveLength(0);
      h.controller.dispose();
    });

    it.each([
      {
        label: "patch",
        local: "ColumnsPatched" as const,
        echo: { kind: "ColumnsPatched" as const, patches: { x: [[0, 9]] } },
      },
      {
        label: "rollover stream",
        local: "ColumnsStreamed" as const,
        echo: {
          kind: "ColumnsStreamed" as const,
          data: { type: "map", entries: [["x", [9]]] },
          rollover: 2,
        },
      },
    ])(
      "reloads the source when a callback event lands before the echo of its own $label",
      async ({ local, echo }) => {
        let reload = false;
        const { controller, document, sendEvents, calls, callsTo } = await synced({
          data: (): NteractBokehSessionDataResult => ({
            epoch: 3,
            columns: { source: { x: { version: reload ? 4 : 2, data: reload ? [7, 9] : [0] } } },
            events: [],
            foldRequested: [],
          }),
        });
        document.emit({ kind: local, model: document.get_model_by_id("source") });
        await settle();
        const transactionId = (calls[0].params as { transactionId: string }).transactionId;
        reload = true;

        // A Python callback's event for the source, versioned before the edit.
        await sendEvents(
          eventsFor({
            transactionId: "callback-tx",
            dataEvents: [
              {
                kind: "ColumnsPatched",
                source_id: "source",
                base_version: 2,
                new_version: 3,
                patches: { x: [[0, 7]] },
              },
            ],
          }),
        );
        expect(callsTo(NTERACT_BOKEH_SESSION_DATA)).toHaveLength(0);

        // The echo now sits on version 3, not on the 2 the edit was applied on.
        await sendEvents(
          eventsFor({
            transactionId,
            dataEvents: [
              { ...echo, source_id: "source", base_version: 3, new_version: 4, echo_of: 0 },
            ],
          }),
        );

        expect(callsTo(NTERACT_BOKEH_SESSION_DATA)).toHaveLength(1);
        expect(document.appliedEvents().at(-1)).toEqual({
          kind: "ColumnDataChanged",
          model: { id: "source" },
          attr: "data",
          data: { type: "map", entries: [["x", [7, 9]]] },
        });

        // The source continues from the reloaded version.
        document.applied.length = 0;
        await sendEvents(
          eventsFor({
            dataEvents: [
              {
                kind: "ColumnsPatched",
                source_id: "source",
                base_version: 4,
                new_version: 5,
                patches: {},
              },
            ],
          }),
        );
        expect(document.appliedEvents()).toHaveLength(1);
        expect(callsTo(NTERACT_BOKEH_SESSION_DATA)).toHaveLength(1);
        controller.dispose();
      },
    );

    it("drops its own edit when a callback replaces the source in the same transaction", async () => {
      const { controller, document, sendEvents, calls, callsTo } = await synced();
      document.emit({ kind: "ColumnsStreamed", model: document.get_model_by_id("source") });
      await settle();
      const transactionId = (calls[0].params as { transactionId: string }).transactionId;

      // The launcher folds the stream into one replacement from Python's
      // values, versioned from the base the edit was applied on, without
      // `echo_of`.
      await sendEvents(
        eventsFor({
          transactionId,
          dataEvents: [
            {
              kind: "ColumnDataChanged",
              source_id: "source",
              base_version: 2,
              new_version: 3,
              columns: { x: { version: 3, data: [9] } },
              columns_removed: [],
            },
          ],
        }),
      );
      expect(document.appliedEvents()).toEqual([
        {
          kind: "ColumnDataChanged",
          model: { id: "source" },
          attr: "data",
          data: { type: "map", entries: [["x", [9]]] },
          cols: ["x"],
        },
      ]);

      // The edit is settled: a later marker in this transaction is not its echo.
      await sendEvents(
        eventsFor({
          transactionId,
          dataEvents: [
            {
              kind: "ColumnsStreamed",
              source_id: "source",
              base_version: 3,
              new_version: 4,
              data: { type: "map", entries: [["x", [10]]] },
              echo_of: 0,
            },
          ],
        }),
      );
      expect(document.appliedEvents()).toHaveLength(2);
      expect(callsTo(NTERACT_BOKEH_SESSION_DATA)).toHaveLength(0);
      controller.dispose();
    });

    it("reloads a source from its blobs and tail after a version gap", async () => {
      const tailBuffer = new Uint8Array([2]).buffer;
      let reload = false;
      const { controller, document, sendEvents, callsTo } = await synced({
        data: (): NteractBokehSessionDataResult => ({
          epoch: 3,
          columns: {
            source: reload
              ? {
                  x: { version: 6, data: [1, 2, 3] },
                  y: {
                    version: 4,
                    data: { type: "ndarray", array: { type: "bytes", data: "AQI=" } },
                  },
                }
              : { x: { version: 2, data: [0] } },
          },
          events: reload
            ? [
                eventsFor({
                  transactionId: "tail-1",
                  dataEvents: [
                    {
                      kind: "ColumnsStreamed",
                      source_id: "source",
                      base_version: 6,
                      new_version: 7,
                      data: {},
                    },
                    {
                      kind: "ColumnsStreamed",
                      source_id: "source",
                      base_version: 9,
                      new_version: 10,
                      data: {},
                    },
                  ],
                  buffers: [{ id: "t0", data: tailBuffer }],
                }),
              ]
            : [],
          foldRequested: [],
        }),
      });
      reload = true;

      await sendEvents(
        eventsFor({
          dataEvents: [
            {
              kind: "ColumnsStreamed",
              source_id: "source",
              base_version: 5,
              new_version: 6,
              data: {},
            },
          ],
        }),
      );

      expect(callsTo(NTERACT_BOKEH_SESSION_DATA)[0].params).toMatchObject({
        sources: { source: null },
        tail: true,
      });
      expect(document.appliedEvents()).toEqual([
        {
          kind: "ColumnDataChanged",
          model: { id: "source" },
          attr: "data",
          data: {
            type: "map",
            entries: [
              ["x", [1, 2, 3]],
              ["y", { type: "ndarray", array: { type: "bytes", data: "AQI=" } }],
            ],
          },
        },
        { kind: "ColumnsStreamed", model: { id: "source" }, attr: "data", data: {} },
      ]);
      expect(document.applied.at(-1)?.buffers?.get("t0")).toBe(tailBuffer);
      controller.dispose();
    });

    it("replaces columns from loaded blobs and drops removed ones", async () => {
      const { controller, document, sendEvents } = await synced();
      const source = document.get_model_by_id("source")!;
      source.data = { x: [1], y: [2], z: [3] };

      await sendEvents(
        eventsFor({
          dataEvents: [
            {
              kind: "ColumnDataChanged",
              source_id: "source",
              base_version: 2,
              new_version: 3,
              columns: { x: { version: 3, data: { type: "map", entries: [["a", 1]] } } },
              columns_removed: ["z"],
            },
          ],
        }),
      );

      expect(document.appliedEvents()).toEqual([
        {
          kind: "ColumnDataChanged",
          model: { id: "source" },
          attr: "data",
          data: { type: "map", entries: [["x", { type: "map", entries: [["a", 1]] }]] },
          cols: ["x"],
        },
      ]);
      expect(source.setv).toHaveBeenCalledWith({ data: { x: [1], y: [2] } }, { sync: false });
      controller.dispose();
    });

    it("ignores data events until the first full update loaded the columns", async () => {
      const { controller, documents, sendEvents } = harness();
      await controller.start();

      await sendEvents(
        eventsFor({
          dataEvents: [
            {
              kind: "ColumnsStreamed",
              source_id: "source",
              base_version: 0,
              new_version: 1,
              data: {},
            },
          ],
        }),
      );

      expect(documents[0].applied).toHaveLength(0);
      controller.dispose();
    });
  });
});

describe("ModelExpander", () => {
  it("defines each listed model at its first reference only", () => {
    const expander = new ModelExpander({
      a: { type: "A", refProps: ["b"], props: { b: { id: "b" }, other: { id: "existing" } } },
      b: { type: "B", refProps: [], props: { n: 1 } },
    });

    expect(expander.value([{ id: "a" }, { id: "b" }, { id: "a" }, { id: "x", k: 1 }])).toEqual([
      {
        type: "object",
        name: "A",
        id: "a",
        attributes: {
          b: { type: "object", name: "B", id: "b", attributes: { n: 1 } },
          other: { id: "existing" },
        },
      },
      { id: "b" },
      { id: "a" },
      { id: "x", k: 1 },
    ]);
  });

  it("materializes DocJson with columns as Bokeh map encodings", () => {
    const json = materializeDocJson(
      fullUpdate({
        meta: {
          rootIds: ["root-1"],
          title: null,
          bokehVersion: "3.9.2",
          docExtras: { defs: [{ name: "Custom" }] },
        },
        models: {
          "root-1": { type: "Plot", refProps: ["source"], props: { source: { id: "source" } } },
          source: { type: "ColumnDataSource", refProps: [], props: { name: "s" } },
        },
      }),
      { source: { x: { version: 1, data: [1, 2] } } },
    );

    expect(json).toEqual({
      defs: [{ name: "Custom" }],
      version: "3.9.2",
      roots: [
        {
          type: "object",
          name: "Plot",
          id: "root-1",
          attributes: {
            source: {
              type: "object",
              name: "ColumnDataSource",
              id: "source",
              attributes: { name: "s", data: { type: "map", entries: [["x", [1, 2]]] } },
            },
          },
        },
      ],
    });
  });
});

/** Mirrors BokehJS: existing ids are updated mid-decode, new models finalize last. */
class FakeDeserializer {
  references = new Map<string, FakeModel>();
  _decoding = false;
  log: string[] = [];
  private finalizable: FakeModel[] = [];

  decode(value: unknown) {
    if (this._decoding) return this._decode(value);
    this._decoding = true;
    try {
      const decoded = this._decode(value);
      for (const model of this.finalizable.splice(0)) this.log.push(`finalize ${model.id}`);
      return decoded;
    } finally {
      this._decoding = false;
    }
  }

  _decode(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this._decode(item));
    if (value && typeof value === "object") {
      const obj = value as { type?: string; id?: string; name?: string; attributes?: unknown };
      if (obj.type === "object" && obj.id && obj.name) {
        return this._decode_object_ref(obj as { id: string; name: string; attributes?: unknown });
      }
      if (obj.type === "ref" && obj.id) {
        const model = this.references.get(obj.id);
        if (!model) throw new Error(`reference ${obj.id} isn't known`);
        return model;
      }
      return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, this._decode(v)]));
    }
    return value;
  }

  _decode_object_ref(obj: { id: string; name: string; attributes?: unknown }) {
    const existing = this.references.get(obj.id);
    if (existing) {
      existing.setv(this._decode(obj.attributes ?? {}) as Record<string, unknown>, {
        sync: false,
      });
      return existing;
    }
    const model = new FakeModel(obj.id, obj.name, this.log);
    this.references.set(obj.id, model);
    this._decode(obj.attributes ?? {});
    this.finalizable.push(model);
    return model;
  }
}

interface FakeProperty {
  syncable: boolean;
  readonly: boolean;
  may_have_refs: boolean;
  default_value(obj: unknown): unknown;
}

function fakeProperty(defaultValue: unknown, options: Partial<FakeProperty> = {}): FakeProperty {
  return {
    syncable: true,
    readonly: false,
    may_have_refs: false,
    default_value: () => defaultValue,
    ...options,
  };
}

class FakeModel {
  properties: Record<string, FakeProperty> = {};
  values: Record<string, unknown> = {};
  stream_to?: () => void;
  /** Attributes each `setv` actually changed, as BokehJS skips equal values. */
  changes: Array<Record<string, unknown>> = [];

  constructor(
    readonly id: string,
    readonly type: string,
    private readonly log: string[],
  ) {}

  setv(attrs: Record<string, unknown>, _options: { sync: boolean }) {
    this.log.push(`setv ${this.id}`);
    const changed = Object.fromEntries(
      Object.entries(attrs).filter(([attr, value]) => !Object.is(this.values[attr], value)),
    );
    Object.assign(this.values, changed);
    if (Object.keys(changed).length > 0) this.changes.push(changed);
  }
}

function fakeRuntime(): BokehRuntime {
  return {
    Deserializer: FakeDeserializer as unknown as BokehRuntime["Deserializer"],
  } as BokehRuntime;
}

describe("deferExistingModelUpdates", () => {
  it("updates existing models only after the patch's new models are finalized", () => {
    const deserializer = new FakeDeserializer();
    deserializer.references.set("row", new FakeModel("row", "Row", deserializer.log));
    const original = FakeDeserializer.prototype._decode_object_ref;
    const patch = [
      {
        type: "object",
        name: "Row",
        id: "row",
        attributes: { children: [{ type: "object", name: "Div", id: "div", attributes: {} }] },
      },
    ];

    deferExistingModelUpdates(fakeRuntime(), () => deserializer.decode(patch));

    expect(deserializer.log).toEqual(["finalize div", "setv row"]);
    expect(FakeDeserializer.prototype._decode_object_ref).toBe(original);
  });

  it("removes models a failed decode registered", () => {
    const deserializer = new FakeDeserializer();

    expect(() =>
      deferExistingModelUpdates(fakeRuntime(), () =>
        deserializer.decode([
          {
            type: "object",
            name: "Div",
            id: "div",
            attributes: { child: { type: "ref", id: "missing" } },
          },
        ]),
      ),
    ).toThrow("isn't known");

    expect(deserializer.references.has("div")).toBe(false);
  });

  it("keeps finalized models when applying the patch's events fails", () => {
    const deserializer = new FakeDeserializer();

    expect(() =>
      deferExistingModelUpdates(fakeRuntime(), () => {
        deserializer.decode([{ type: "object", name: "Div", id: "div", attributes: {} }]);
        throw new Error("event failed");
      }),
    ).toThrow("event failed");

    expect(deserializer.references.has("div")).toBe(true);
  });

  it("resets properties a full-state definition omits to their defaults", () => {
    const deserializer = new FakeDeserializer();
    const slider = new FakeModel("slider", "Slider", deserializer.log);
    deserializer.references.set("slider", slider);
    slider.properties = {
      value: fakeProperty(0),
      start: fakeProperty(0),
      end: fakeProperty(1),
      title: fakeProperty("", { readonly: true }),
      css_classes: fakeProperty("", { syncable: false }),
      child: fakeProperty(null, { may_have_refs: true }),
      required: { ...fakeProperty(null), default_value: () => Symbol("unset") },
    };
    slider.values = {
      value: 3,
      start: 10,
      end: 1,
      title: "local",
      css_classes: "local",
      child: "local",
      required: "local",
    };
    const definition = [{ type: "object", name: "Slider", id: "slider", attributes: { value: 5 } }];

    deferExistingModelUpdates(fakeRuntime(), () => deserializer.decode(definition), {
      fullState: true,
    });

    expect(slider.changes).toEqual([{ value: 5, start: 0 }]);
    expect(slider.values).toMatchObject({ title: "local", css_classes: "local", child: "local" });
    expect(slider.values.required).toBe("local");
  });

  it("keeps columnar data, which reconciles from columns/, out of the reset", () => {
    const deserializer = new FakeDeserializer();
    const source = new FakeModel("source", "ColumnDataSource", deserializer.log);
    source.stream_to = () => {};
    source.properties = { data: fakeProperty({}), name: fakeProperty(null) };
    source.values = { data: { x: [1] }, name: "local" };
    deserializer.references.set("source", source);

    deferExistingModelUpdates(
      fakeRuntime(),
      () =>
        deserializer.decode([
          { type: "object", name: "ColumnDataSource", id: "source", attributes: {} },
        ]),
      { fullState: true },
    );

    expect(source.changes).toEqual([{ name: null }]);
    expect(source.values.data).toEqual({ x: [1] });
  });

  it("leaves omitted properties alone for incremental patches", () => {
    const deserializer = new FakeDeserializer();
    const slider = new FakeModel("slider", "Slider", deserializer.log);
    deserializer.references.set("slider", slider);
    slider.properties = { value: fakeProperty(0), start: fakeProperty(0) };
    slider.values = { value: 3, start: 10 };

    deferExistingModelUpdates(fakeRuntime(), () =>
      deserializer.decode([
        { type: "object", name: "Slider", id: "slider", attributes: { value: 5 } },
      ]),
    );

    expect(slider.changes).toEqual([{ value: 5 }]);
  });

  it("keeps BokehJS's immediate update outside a patch application", () => {
    const deserializer = new FakeDeserializer();
    deserializer.references.set("row", new FakeModel("row", "Row", deserializer.log));

    deserializer.decode([
      {
        type: "object",
        name: "Row",
        id: "row",
        attributes: { children: [{ type: "object", name: "Div", id: "div", attributes: {} }] },
      },
    ]);

    expect(deserializer.log).toEqual(["setv row", "finalize div"]);
  });
});
