import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  NTERACT_BOKEH_APPLY_PATCH,
  NTERACT_BOKEH_SESSION_OPEN,
  NTERACT_BOKEH_SESSION_PATCH,
  NTERACT_BOKEH_SESSION_STATE,
  type NteractBokehResolvedPatchEvent,
} from "@/components/isolated/rpc-methods";
import {
  BokehSessionController,
  extractBokehPatchBuffers,
  type BokehRuntime,
} from "../bokeh-session-controller";

class FakeBuffer {
  constructor(readonly buffer: ArrayBuffer) {}
}

class FakeDocument {
  all_roots = [{ id: "root-1" }];
  listeners = new Set<(event: Record<string, unknown>) => void>();
  applied: Array<Record<string, unknown>> = [];
  cleared = false;
  modelIds = new Set(["root-1"]);

  get_model_by_id(id: string) {
    return this.modelIds.has(id) ? { id } : null;
  }

  on_change(listener: (event: Record<string, unknown>) => void) {
    this.listeners.add(listener);
  }

  remove_on_change(listener: (event: Record<string, unknown>) => void) {
    this.listeners.delete(listener);
  }

  create_json_patch(events: Record<string, unknown>[]) {
    return {
      events,
      binary: new FakeBuffer(new Uint8Array([4, 5, 6]).buffer),
    };
  }

  apply_json_patch(patch: Record<string, unknown>) {
    this.applied.push(patch);
  }

  clear() {
    this.cleared = true;
  }

  emit(event: Record<string, unknown>) {
    for (const listener of this.listeners) listener(event);
  }
}

const payload = {
  schema_version: 1 as const,
  session_id: "session-1",
  revision: 0,
  producer: { name: "panel", version: "1.9.3" },
  bokeh_version: "3.9.1",
  document: { roots: [{ id: "root-1" }] },
  root_ids: ["root-1"],
  resources: {
    javascript: [],
    stylesheets: [],
    javascript_modules: [],
    module_exports: {},
  },
  buffers: [],
};

function settle(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve());
}

function harness() {
  const documents: FakeDocument[] = [];
  const runtime: BokehRuntime = {
    Document: {
      from_json: () => {
        const document = new FakeDocument();
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
  const patchRequests: Array<Record<string, unknown>> = [];
  const requestHost = vi.fn(async (method: string, params?: unknown) => {
    if (method === NTERACT_BOKEH_SESSION_OPEN) {
      return {
        schemaVersion: 1,
        sessionId: "session-1",
        outputId: "output-1",
        status: "connected",
        headRevision: 0,
        checkpoint: {
          revision: 0,
          document: { roots: [{ id: "root-1" }] },
          buffers: [],
        },
        patchTail: [] as NteractBokehResolvedPatchEvent[],
      };
    }
    if (method === NTERACT_BOKEH_APPLY_PATCH) {
      patchRequests.push(params as Record<string, unknown>);
      const request = params as { transactionId: string; baseRevision: number };
      return {
        status: "accepted",
        sessionId: "session-1",
        transactionId: request.transactionId,
        revision: request.baseRevision + 1,
      };
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
  const container = document.createElement("div");
  const onStatus = vi.fn();
  const controller = new BokehSessionController({
    outputId: "output-1",
    payload,
    container,
    runtime,
    requestHost,
    subscribeHostNotification,
    onStatus,
    onLayout: vi.fn(),
  });
  return {
    container,
    controller,
    documents,
    notify,
    onStatus,
    patchRequests,
    requestHost,
    runtime,
  };
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
    expect(source.byteLength).toBe(3);
  });

  it("serializes one optimistic transaction until its canonical event arrives", async () => {
    const { controller, documents, notify, patchRequests } = harness();
    await controller.start();
    const document = documents[0];

    document.emit({
      kind: "ModelChanged",
      sync: true,
      attr: "value",
      model: { properties: { value: { syncable: true } } },
    });
    await vi.advanceTimersByTimeAsync(50);
    await settle();

    expect(patchRequests).toHaveLength(1);
    const transactionId = patchRequests[0].transactionId as string;
    expect(patchRequests[0].baseRevision).toBe(0);
    expect(patchRequests[0].buffers as unknown[]).toHaveLength(1);

    document.emit({ kind: "ModelChanged", sync: true, attr: "value" });
    await vi.advanceTimersByTimeAsync(100);
    expect(patchRequests).toHaveLength(1);

    const canonical: NteractBokehResolvedPatchEvent = {
      sessionId: "session-1",
      transactionId,
      baseRevision: 0,
      revision: 1,
      clientPatch: { patch: { events: [{ kind: "ModelChanged", new: 5 }] }, buffers: [] },
      serverPatch: { patch: { events: [{ kind: "ModelChanged", new: 10 }] }, buffers: [] },
    };
    notify(NTERACT_BOKEH_SESSION_PATCH, { outputId: "output-1", event: canonical });
    await vi.advanceTimersByTimeAsync(50);
    await settle();

    expect(document.applied).toEqual([{ events: [{ kind: "ModelChanged", new: 10 }] }]);
    expect(patchRequests).toHaveLength(2);
    expect(patchRequests[1].baseRevision).toBe(1);
    controller.dispose();
  });

  it("re-applies its own patch when the kernel rebased it onto newer events", async () => {
    const { controller, documents, notify, patchRequests, requestHost } = harness();
    await controller.start();
    const document = documents[0];

    document.emit({ kind: "ModelChanged", sync: true, attr: "start" });
    await vi.advanceTimersByTimeAsync(50);
    await settle();
    const transactionId = patchRequests[0].transactionId as string;
    expect(patchRequests[0].baseRevision).toBe(0);

    const serverChange: NteractBokehResolvedPatchEvent = {
      sessionId: "session-1",
      transactionId: "server-change-1",
      baseRevision: 0,
      revision: 1,
      serverPatch: { patch: { events: [{ kind: "ModelChanged", new: 1 }] }, buffers: [] },
    };
    const rebased: NteractBokehResolvedPatchEvent = {
      sessionId: "session-1",
      transactionId,
      baseRevision: 1,
      revision: 2,
      clientPatch: { patch: { events: [{ kind: "ModelChanged", new: 2 }] }, buffers: [] },
    };
    notify(NTERACT_BOKEH_SESSION_PATCH, { outputId: "output-1", event: serverChange });
    notify(NTERACT_BOKEH_SESSION_PATCH, { outputId: "output-1", event: rebased });
    await settle();
    await vi.advanceTimersByTimeAsync(200);

    expect(document.applied).toEqual([
      { events: [{ kind: "ModelChanged", new: 1 }] },
      { events: [{ kind: "ModelChanged", new: 2 }] },
    ]);
    expect(documents).toHaveLength(1);
    expect(requestHost).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("keeps a queued local change when its in-flight patch comes back rebased", async () => {
    const { controller, documents, notify, patchRequests } = harness();
    await controller.start();
    const document = documents[0];
    const setv = vi.fn();
    const page = { properties: { dark_theme: { syncable: true } }, setv };

    document.emit({
      kind: "ModelChanged",
      sync: true,
      attr: "dark_theme",
      value: false,
      model: page,
    });
    await vi.advanceTimersByTimeAsync(50);
    await settle();
    const transactionId = patchRequests[0].transactionId as string;
    document.emit({
      kind: "ModelChanged",
      sync: true,
      attr: "dark_theme",
      value: true,
      model: page,
    });

    notify(NTERACT_BOKEH_SESSION_PATCH, {
      outputId: "output-1",
      event: {
        sessionId: "session-1",
        transactionId: "server-change-1",
        baseRevision: 0,
        revision: 1,
        serverPatch: { patch: { events: [{ kind: "ModelChanged", new: 1 }] }, buffers: [] },
      },
    });
    notify(NTERACT_BOKEH_SESSION_PATCH, {
      outputId: "output-1",
      event: {
        sessionId: "session-1",
        transactionId,
        baseRevision: 1,
        revision: 2,
        clientPatch: {
          patch: { events: [{ kind: "ModelChanged", attr: "dark_theme", new: false }] },
          buffers: [],
        },
      },
    });
    await settle();

    expect(document.applied.at(-1)).toEqual({
      events: [{ kind: "ModelChanged", attr: "dark_theme", new: false }],
    });
    expect(setv).toHaveBeenLastCalledWith({ dark_theme: true }, { sync: false });

    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(patchRequests).toHaveLength(2);
    controller.dispose();
  });

  it("does not publish Bokeh document-ready lifecycle events", async () => {
    const { controller, documents, patchRequests } = harness();
    await controller.start();

    documents[0].emit({
      kind: "MessageSent",
      sync: true,
      msg_type: "bokeh_event",
      msg_data: { event_name: "document_ready" },
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(patchRequests).toHaveLength(0);
    controller.dispose();
  });

  it("cancels state-triggered resync when the canonical event catches up", async () => {
    const { controller, documents, notify, requestHost } = harness();
    await controller.start();

    notify(NTERACT_BOKEH_SESSION_STATE, {
      sessionId: "session-1",
      outputId: "output-1",
      status: "connected",
      headRevision: 1,
    });
    notify(NTERACT_BOKEH_SESSION_PATCH, {
      outputId: "output-1",
      event: {
        sessionId: "session-1",
        transactionId: "server-change-1",
        baseRevision: 0,
        revision: 1,
        serverPatch: { patch: { events: [{ kind: "ModelChanged", new: 3 }] }, buffers: [] },
      },
    });
    await settle();
    await vi.advanceTimersByTimeAsync(200);

    expect(requestHost).toHaveBeenCalledTimes(1);
    expect(documents).toHaveLength(1);
    controller.dispose();
  });

  it("reconciles checkpoint events into the mounted document", async () => {
    const { container, controller, documents, notify, requestHost } = harness();
    await controller.start();
    const mounted = container.firstElementChild;

    notify(NTERACT_BOKEH_SESSION_PATCH, {
      outputId: "output-1",
      event: {
        sessionId: "session-1",
        transactionId: "checkpoint-1",
        baseRevision: 0,
        revision: 1,
        checkpoint: {
          revision: 1,
          document: { title: "Panel", roots: [{ id: "root-1" }] },
          buffers: [],
        },
      },
    });
    notify(NTERACT_BOKEH_SESSION_PATCH, {
      outputId: "output-1",
      event: {
        sessionId: "session-1",
        transactionId: "server-change-2",
        baseRevision: 1,
        revision: 2,
        serverPatch: { patch: { events: [{ kind: "ModelChanged", new: 7 }] }, buffers: [] },
      },
    });
    await vi.advanceTimersByTimeAsync(200);
    await settle();

    expect(requestHost).toHaveBeenCalledTimes(1);
    expect(documents).toHaveLength(1);
    expect(documents[0].cleared).toBe(false);
    expect(container.firstElementChild).toBe(mounted);
    expect(documents[0].applied).toEqual([
      {
        events: [
          { kind: "RootAdded", model: { id: "root-1" } },
          { kind: "TitleChanged", title: "Panel" },
        ],
      },
      { events: [{ kind: "ModelChanged", new: 7 }] },
    ]);
    controller.dispose();
  });

  it("catches up from the snapshot tail without remounting the document", async () => {
    const { controller, documents, notify, requestHost } = harness();
    await controller.start();
    const tailEvent = (revision: number): NteractBokehResolvedPatchEvent => ({
      sessionId: "session-1",
      transactionId: `server-${revision}`,
      baseRevision: revision - 1,
      revision,
      serverPatch: { patch: { events: [{ kind: "ModelChanged", new: revision }] }, buffers: [] },
    });
    requestHost.mockResolvedValueOnce({
      schemaVersion: 1,
      sessionId: "session-1",
      outputId: "output-1",
      status: "connected",
      headRevision: 2,
      checkpoint: { revision: 0, document: { roots: [{ id: "root-1" }] }, buffers: [] },
      patchTail: [tailEvent(1), tailEvent(2)],
    });

    notify(NTERACT_BOKEH_SESSION_STATE, {
      sessionId: "session-1",
      outputId: "output-1",
      status: "connected",
      headRevision: 2,
    });
    await vi.advanceTimersByTimeAsync(200);
    await settle();

    expect(requestHost).toHaveBeenCalledTimes(2);
    expect(documents).toHaveLength(1);
    expect(documents[0].applied).toEqual([
      { events: [{ kind: "ModelChanged", new: 1 }] },
      { events: [{ kind: "ModelChanged", new: 2 }] },
    ]);
    controller.dispose();
  });

  it("reconciles existing models through ModelChanged events", async () => {
    const { controller, documents, notify } = harness();
    await controller.start();
    const newChild = { type: "object", name: "Div", id: "div-2", attributes: { text: "new" } };

    notify(NTERACT_BOKEH_SESSION_PATCH, {
      outputId: "output-1",
      event: {
        sessionId: "session-1",
        transactionId: "checkpoint-1",
        baseRevision: 0,
        revision: 1,
        checkpoint: {
          revision: 1,
          document: {
            roots: [
              {
                type: "object",
                name: "Row",
                id: "root-1",
                attributes: { children: [newChild], dark_theme: true },
              },
            ],
          },
          buffers: [],
        },
      },
    });
    await vi.advanceTimersByTimeAsync(200);
    await settle();

    expect(documents).toHaveLength(1);
    expect(documents[0].applied).toEqual([
      {
        events: [
          { kind: "ModelChanged", model: { id: "root-1" }, attr: "children", new: [newChild] },
          { kind: "ModelChanged", model: { id: "root-1" }, attr: "dark_theme", new: true },
          { kind: "RootAdded", model: { id: "root-1" } },
        ],
      },
    ]);
    controller.dispose();
  });

  it("applies redefinitions of existing models in patches as ModelChanged events", async () => {
    const { controller, documents, notify } = harness();
    await controller.start();
    const existing = {
      type: "object",
      name: "Row",
      id: "root-1",
      attributes: { dark_theme: true },
    };
    const added = { type: "object", name: "Div", id: "div-2", attributes: { text: "new" } };

    notify(NTERACT_BOKEH_SESSION_PATCH, {
      outputId: "output-1",
      event: {
        sessionId: "session-1",
        transactionId: "server-change-1",
        baseRevision: 0,
        revision: 1,
        serverPatch: {
          patch: {
            events: [
              {
                kind: "ModelChanged",
                model: { id: "page-1" },
                attr: "main",
                new: [existing, added],
              },
            ],
          },
          buffers: [],
        },
      },
    });
    await settle();

    expect(documents[0].applied).toEqual([
      {
        events: [
          { kind: "ModelChanged", model: { id: "root-1" }, attr: "dark_theme", new: true },
          {
            kind: "ModelChanged",
            model: { id: "page-1" },
            attr: "main",
            new: [{ id: "root-1" }, added],
          },
        ],
      },
    ]);
    controller.dispose();
  });

  it("reconciles instead of remounting after the kernel rejected a local patch", async () => {
    const { controller, documents, requestHost } = harness();
    await controller.start();
    requestHost.mockImplementationOnce(async (_method, params) => ({
      status: "error",
      sessionId: "session-1",
      transactionId: (params as { transactionId: string }).transactionId,
      revision: 0,
    }));

    documents[0].emit({ kind: "ModelChanged", sync: true, attr: "value" });
    await vi.advanceTimersByTimeAsync(50);
    await settle();
    await vi.advanceTimersByTimeAsync(200);
    await settle();

    expect(requestHost.mock.calls.map(([method]) => method)).toEqual([
      NTERACT_BOKEH_SESSION_OPEN,
      NTERACT_BOKEH_APPLY_PATCH,
      NTERACT_BOKEH_SESSION_OPEN,
    ]);
    expect(documents).toHaveLength(1);
    expect(documents[0].cleared).toBe(false);
    expect(documents[0].applied).toEqual([
      { events: [{ kind: "RootAdded", model: { id: "root-1" } }] },
    ]);
    controller.dispose();
  });

  it("cleans up and retries when the initial document fails to mount", async () => {
    const { container, controller, documents, onStatus, requestHost, runtime } = harness();
    const mountDocument = runtime.addDocumentStandalone;
    let failNextMount = true;
    runtime.addDocumentStandalone = async (document, element) => {
      if (failNextMount) {
        failNextMount = false;
        element.appendChild(window.document.createElement("div"));
        throw new Error("mount failed");
      }
      return mountDocument(document, element);
    };

    await controller.start();
    await settle();

    expect(documents[0].cleared).toBe(true);
    expect(onStatus).toHaveBeenLastCalledWith("error", "mount failed");
    expect(container.querySelectorAll("div")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_000);
    await settle();

    expect(requestHost).toHaveBeenCalledTimes(2);
    expect(documents).toHaveLength(2);
    expect(documents[1].cleared).toBe(false);
    expect(onStatus).toHaveBeenLastCalledWith("connected", undefined);
    controller.dispose();
  });

  it("freezes the current document when RuntimeState marks the session disconnected", async () => {
    const { controller, documents, notify, onStatus, patchRequests } = harness();
    await controller.start();
    const document = documents[0];

    notify(NTERACT_BOKEH_SESSION_STATE, {
      sessionId: "session-1",
      outputId: "output-1",
      status: "disconnected",
      headRevision: 0,
    });
    document.emit({ kind: "ModelChanged", sync: true, attr: "value" });
    await vi.advanceTimersByTimeAsync(100);

    expect(onStatus).toHaveBeenLastCalledWith("disconnected", undefined);
    expect(patchRequests).toHaveLength(0);
    expect(documents).toHaveLength(1);
    expect(document.cleared).toBe(false);
    controller.dispose();
  });
});
