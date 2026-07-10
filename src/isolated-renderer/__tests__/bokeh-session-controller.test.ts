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
        patchTail: [],
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
  return { container, controller, documents, notify, onStatus, patchRequests, requestHost };
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
