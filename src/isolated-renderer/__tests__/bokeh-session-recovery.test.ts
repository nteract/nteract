import type { Document as BokehDocument } from "@bokeh/bokehjs/build/js/lib/document/document";
import type { ColumnDataSource } from "@bokeh/bokehjs/build/js/lib/models/sources/column_data_source";
import type { Range1d } from "@bokeh/bokehjs/build/js/lib/models/ranges/range1d";
import bokehSource from "@bokeh/bokehjs/build/js/bokeh.min.js?raw";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  NTERACT_BOKEH_APPLY_PATCH,
  NTERACT_BOKEH_SESSION_OPEN,
  NTERACT_BOKEH_SESSION_PATCH,
  NTERACT_BOKEH_SESSION_STATE,
  type NteractBokehResolvedPatchEvent,
  type NteractBokehSessionSnapshot,
  type NteractBokehSessionStatus,
} from "@/components/isolated/bokeh-session-rpc";
import {
  BokehSessionController,
  type BokehRuntime,
  deferExistingModelUpdates,
} from "../bokeh-session-controller";

// Exercise the same bundled BokehJS modules used by the renderer. Only view
// mounting is stubbed: jsdom cannot lay out a Bokeh view or draw on a canvas.
let realRuntime: Pick<BokehRuntime, "Document" | "Buffer" | "Deserializer">;
beforeAll(() => {
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    createLinearGradient: () => ({ addColorStop() {} }),
  } as unknown as CanvasRenderingContext2D);
  try {
    const scope = {} as { Bokeh: { require(name: string): unknown } };
    new Function(bokehSource).call(scope);
    realRuntime = {
      Document: (scope.Bokeh.require("document") as Pick<BokehRuntime, "Document">).Document,
      Buffer: (scope.Bokeh.require("core/serialization") as Pick<BokehRuntime, "Buffer">).Buffer,
      Deserializer: (
        scope.Bokeh.require("core/serialization/deserializer") as Pick<BokehRuntime, "Deserializer">
      ).Deserializer,
    };
  } finally {
    canvas.mockRestore();
  }
});

function snapshot(attributes: Record<string, unknown> = {}): NteractBokehSessionSnapshot {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    outputId: "output-1",
    status: "connected",
    headRevision: 0,
    checkpoint: {
      revision: 0,
      document: {
        version: "3.9.1",
        title: "Recovery",
        roots: [{ type: "object", name: "Range1d", id: "range-1", attributes }],
      },
      buffers: [],
    },
    patchTail: [],
  };
}

function patch(attr: string, value: number): NteractBokehResolvedPatchEvent {
  return {
    sessionId: "session-1",
    transactionId: "kernel-1",
    baseRevision: 0,
    revision: 1,
    serverPatch: {
      patch: { events: [{ kind: "ModelChanged", model: { id: "range-1" }, attr, new: value }] },
      buffers: [],
    },
  };
}

function columnSnapshot(values = [1, 2]): NteractBokehSessionSnapshot {
  const initial = snapshot();
  initial.checkpoint.document.roots = [
    {
      type: "object",
      name: "ColumnDataSource",
      id: "range-1",
      attributes: {
        selected: { type: "object", name: "Selection", id: "selection-1" },
        selection_policy: { type: "object", name: "UnionRenderers", id: "policy-1" },
        data: { type: "map", entries: [["value", values]] },
      },
    },
  ];
  return initial;
}

function streamPatch(values: number[]): NteractBokehResolvedPatchEvent {
  return {
    ...patch("end", 0),
    serverPatch: {
      patch: {
        events: [
          {
            kind: "ColumnsStreamed",
            model: { id: "range-1" },
            attr: "data",
            data: { type: "map", entries: [["value", values]] },
            rollover: null,
          },
        ],
      },
      buffers: [],
    },
  };
}

function harness(initial = snapshot()) {
  const listeners = new Map<string, (params: unknown) => void>();
  const documents: BokehDocument[] = [];
  const view = { clear: vi.fn() };
  const mount = vi.fn(async (doc: Parameters<BokehRuntime["addDocumentStandalone"]>[0]) => {
    documents.push(doc as unknown as BokehDocument);
    return view;
  });
  const runtime: BokehRuntime = { ...realRuntime, addDocumentStandalone: mount };
  let nextSnapshot = initial;
  const open = vi.fn(async (): Promise<unknown> => nextSnapshot);
  const apply = vi.fn(async (params: { transactionId: string; baseRevision: number }) => ({
    status: "accepted",
    sessionId: "session-1",
    transactionId: params.transactionId,
    revision: params.baseRevision + 1,
  }));
  const onStatus = vi.fn();
  const controller = new BokehSessionController({
    outputId: "output-1",
    payload: {
      schema_version: 1,
      session_id: "session-1",
      revision: 0,
      producer: { name: "panel", version: "1.9.3" },
      bokeh_version: "3.9.1",
      document: initial.checkpoint.document,
      root_ids: ["range-1"],
      resources: { javascript: [], stylesheets: [], javascript_modules: [], module_exports: {} },
      buffers: [],
    },
    container: document.createElement("div"),
    runtime,
    requestHost: (method, params) => {
      if (method === NTERACT_BOKEH_SESSION_OPEN) return open();
      if (method === NTERACT_BOKEH_APPLY_PATCH) {
        return apply(params as { transactionId: string; baseRevision: number });
      }
      throw new Error(`Unexpected request ${method}`);
    },
    subscribeHostNotification: (method, listener) => {
      listeners.set(method, listener);
      return () => listeners.delete(method);
    },
    onStatus,
    onLayout: vi.fn(),
  });
  const notify = (method: string, params: unknown) => listeners.get(method)?.(params);
  return {
    controller,
    open,
    apply,
    onStatus,
    mount,
    view,
    documents,
    range: () => documents[0].get_model_by_id("range-1") as Range1d,
    announce: (headRevision: number, status: NteractBokehSessionStatus = "connected") =>
      notify(NTERACT_BOKEH_SESSION_STATE, {
        sessionId: "session-1",
        outputId: "output-1",
        status,
        headRevision,
      }),
    canonical: (event: NteractBokehResolvedPatchEvent) =>
      notify(NTERACT_BOKEH_SESSION_PATCH, { outputId: "output-1", event }),
    setSnapshot: (value: NteractBokehSessionSnapshot) => {
      nextSnapshot = value;
    },
  };
}

const controllers: BokehSessionController[] = [];
async function start(initial?: NteractBokehSessionSnapshot) {
  const h = harness(initial);
  controllers.push(h.controller);
  await h.controller.start();
  expect(h.onStatus).toHaveBeenLastCalledWith("connected", undefined);
  return h;
}

describe("Bokeh session recovery with real documents", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    for (const controller of controllers.splice(0)) controller.dispose();
    vi.useRealTimers();
  });

  it("loads model definitions introduced by a later checkpoint without remounting", async () => {
    const h = await start(snapshot({ start: 0 }));
    const range = h.range();
    // Python DataModel serialization supplies a definition separately from its
    // root. The model need not exist when the output first mounts.
    const updated = snapshot({ start: 2 });
    updated.headRevision = updated.checkpoint.revision = 1;
    updated.checkpoint.document.defs = [
      {
        type: "model",
        name: "LateRecoveryModel",
        properties: [{ name: "answer", kind: "Any", default: 7 }],
      },
    ];
    (updated.checkpoint.document.roots as unknown[]).push({
      type: "object",
      name: "LateRecoveryModel",
      id: "late-model",
    });
    h.setSnapshot(updated);
    h.announce(1);
    await vi.advanceTimersByTimeAsync(151);

    expect(h.documents[0].get_model_by_id("late-model")?.properties.answer.get_value()).toBe(7);
    expect(h.range()).toBe(range);
    expect(range.start).toBe(2);
    expect(h.onStatus).toHaveBeenLastCalledWith("connected", undefined);
    expect(h.mount).toHaveBeenCalledTimes(1);
    expect(h.view.clear).not.toHaveBeenCalled();
  });

  it.each([{}, { start: 0 }])(
    "restores rejected optimistic values from checkpoint attributes %j without remounting",
    async (attributes) => {
      const h = await start(snapshot(attributes));
      const range = h.range();
      expect([range.start, range.end]).toEqual([0, 1]);
      h.apply.mockImplementationOnce(async ({ transactionId }) => ({
        status: "stale",
        sessionId: "session-1",
        transactionId,
        revision: 0,
      }));
      range.start = 10;
      await vi.advanceTimersByTimeAsync(51);

      expect(h.open).toHaveBeenCalledTimes(2);
      expect(h.apply).toHaveBeenCalledTimes(1);
      expect(h.range()).toBe(range);
      expect(range.start).toBe(0);
      expect(h.onStatus).toHaveBeenLastCalledWith("connected", undefined);
      expect(h.mount).toHaveBeenCalledTimes(1);
      expect(h.view.clear).not.toHaveBeenCalled();
    },
  );

  it("repairs discarded unsent edits before catching up after a failed snapshot fetch", async () => {
    // An explicit default keeps this separate from the sparse-checkpoint case.
    const h = await start(snapshot({ start: 0 }));
    let rejectOpen!: (reason: Error) => void;
    h.open.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectOpen = reject;
        }),
    );
    h.announce(1);
    await vi.advanceTimersByTimeAsync(150);
    const range = h.range();
    range.start = 10;
    rejectOpen(new Error("snapshot unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onStatus).toHaveBeenLastCalledWith("error", "snapshot unavailable");
    const recovered = snapshot({ start: 0 });
    recovered.headRevision = 1;
    recovered.patchTail = [patch("end", 2)];
    h.setSnapshot(recovered);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(h.range()).toBe(range);
    expect([range.start, range.end]).toEqual([0, 2]);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.onStatus).toHaveBeenLastCalledWith("connected", undefined);
    expect(h.mount).toHaveBeenCalledTimes(1);
    // The recovered revision is usable for subsequent canonical events.
    h.canonical({ ...patch("end", 3), baseRevision: 1, revision: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(range.end).toBe(3);
  });

  it("preserves queued edits over a checkpoint until they can be submitted", async () => {
    const h = await start();
    const range = h.range();
    range.start = 10;
    const checkpoint = snapshot({ end: 2 }).checkpoint;
    checkpoint.revision = 1;
    h.canonical({ ...patch("end", 2), serverPatch: undefined, checkpoint });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.range()).toBe(range);
    expect([range.start, range.end]).toEqual([10, 2]);
    expect(h.apply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.apply.mock.calls[0][0].baseRevision).toBe(1);
    expect(h.mount).toHaveBeenCalledTimes(1);
  });

  it("repairs edits made while a failed snapshot fetch is being retried", async () => {
    const h = await start(snapshot({ start: 0 }));
    h.open.mockRejectedValueOnce(new Error("snapshot unavailable"));
    h.announce(1);
    await vi.advanceTimersByTimeAsync(150);
    expect(h.onStatus).toHaveBeenLastCalledWith("error", "snapshot unavailable");
    const range = h.range();
    range.start = 10;
    const recovered = snapshot({ start: 0 });
    recovered.headRevision = 1;
    recovered.patchTail = [patch("end", 2)];
    h.setSnapshot(recovered);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(h.range()).toBe(range);
    expect([range.start, range.end]).toEqual([0, 2]);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.onStatus).toHaveBeenLastCalledWith("connected", undefined);
    expect(h.mount).toHaveBeenCalledTimes(1);
  });

  it("repairs discarded edits when reconnecting at the same revision", async () => {
    const h = await start(snapshot({ start: 0 }));
    const range = h.range();
    range.start = 10;
    h.announce(0, "disconnected");
    h.announce(0);
    await vi.advanceTimersByTimeAsync(150);

    expect(h.open).toHaveBeenCalledTimes(2);
    expect(h.range()).toBe(range);
    expect(range.start).toBe(0);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.onStatus).toHaveBeenLastCalledWith("connected", undefined);
    expect(h.mount).toHaveBeenCalledTimes(1);
  });

  it("repairs optimistic edits when patch serialization fails", async () => {
    const h = await start(snapshot({ start: 0 }));
    const range = h.range();
    vi.spyOn(h.documents[0], "create_json_patch").mockImplementationOnce(() => {
      throw new Error("patch unavailable");
    });
    range.start = 10;
    await vi.advanceTimersByTimeAsync(51);

    expect(h.open).toHaveBeenCalledTimes(2);
    expect(h.range()).toBe(range);
    expect(range.start).toBe(0);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.onStatus).toHaveBeenLastCalledWith("connected", undefined);
    expect(h.mount).toHaveBeenCalledTimes(1);
  });

  it("keeps required checkpoint recovery scheduled when a canonical patch catches up", async () => {
    const h = await start(snapshot({ start: 0 }));
    const range = h.range();
    range.start = 10;
    h.announce(0, "disconnected");
    h.announce(0);
    h.canonical(patch("end", 2));
    await vi.advanceTimersByTimeAsync(0);
    expect([range.start, range.end]).toEqual([10, 2]);
    const recovered = snapshot({ start: 0 });
    recovered.headRevision = 1;
    recovered.patchTail = [patch("end", 2)];
    h.setSnapshot(recovered);
    await vi.advanceTimersByTimeAsync(150);

    expect(h.open).toHaveBeenCalledTimes(2);
    expect([range.start, range.end]).toEqual([0, 2]);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.onStatus).toHaveBeenLastCalledWith("connected", undefined);
    expect(h.mount).toHaveBeenCalledTimes(1);
  });

  it("replays an accepted in-flight edit after checkpoint recovery replaced its value", async () => {
    const h = await start(snapshot({ start: 0 }));
    let accept!: (value: Awaited<ReturnType<typeof h.apply>>) => void;
    h.apply.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    const range = h.range();
    range.start = 10;
    await vi.advanceTimersByTimeAsync(50);
    const request = h.apply.mock.calls[0][0];
    range.end = 20;
    h.announce(0, "disconnected");
    h.announce(0);
    await vi.advanceTimersByTimeAsync(150);
    expect([range.start, range.end]).toEqual([0, 1]);
    accept({
      status: "accepted",
      sessionId: "session-1",
      transactionId: request.transactionId,
      revision: 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    h.canonical({
      ...patch("start", 10),
      transactionId: request.transactionId,
      clientPatch: patch("start", 10).serverPatch,
      serverPatch: undefined,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(h.range()).toBe(range);
    expect([range.start, range.end]).toEqual([10, 1]);
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.onStatus).toHaveBeenLastCalledWith("connected", undefined);
    expect(h.mount).toHaveBeenCalledTimes(1);
  });

  it("restores buffered column data without replacing its model", async () => {
    const initial = snapshot();
    initial.checkpoint.document.roots = [
      {
        type: "object",
        name: "ColumnDataSource",
        id: "range-1",
        attributes: {
          // Python checkpoints serialize model-valued defaults explicitly.
          selected: { type: "object", name: "Selection", id: "selection-1" },
          selection_policy: { type: "object", name: "UnionRenderers", id: "policy-1" },
          data: {
            type: "map",
            entries: [
              [
                "value",
                {
                  type: "ndarray",
                  dtype: "float64",
                  order: "little",
                  shape: [2],
                  array: { type: "bytes", data: { id: "values" } },
                },
              ],
            ],
          },
        },
      },
    ];
    initial.checkpoint.buffers = [{ id: "values", data: new Float64Array([1, 2]).buffer }];
    const h = await start(initial);
    const source = h.documents[0].get_model_by_id("range-1") as ColumnDataSource;
    const selected = source.selected;
    const policy = source.selection_policy;
    h.apply.mockImplementationOnce(async ({ transactionId }) => ({
      status: "stale",
      sessionId: "session-1",
      transactionId,
      revision: 0,
    }));
    source.data = { value: new Float64Array([10, 20]) };
    await vi.advanceTimersByTimeAsync(51);
    expect(h.documents[0].get_model_by_id("range-1")).toBe(source);
    expect(source.selected).toBe(selected);
    expect(source.selection_policy).toBe(policy);
    expect(Array.from(source.get_column("value") ?? [])).toEqual([1, 2]);
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.mount).toHaveBeenCalledTimes(1);
    expect(h.onStatus).toHaveBeenLastCalledWith("connected", undefined);
  });

  it.each(["notification", "snapshot tail"])(
    "restores a checkpoint after a partially applied %s stream",
    async (delivery) => {
      const initial = columnSnapshot();
      const h = await start(initial);
      const source = h.documents[0].get_model_by_id("range-1") as ColumnDataSource;
      const onStream = vi.fn().mockImplementationOnce(() => {
        // Bokeh mutates the column before notifying this signal's listeners.
        throw new Error("stream listener failed");
      });
      source.streaming.connect(onStream);
      const recovered = columnSnapshot();
      recovered.headRevision = 1;
      recovered.patchTail = [streamPatch([3])];
      h.setSnapshot(recovered);

      if (delivery === "notification") {
        h.canonical(streamPatch([3]));
        await vi.advanceTimersByTimeAsync(1);
      } else {
        h.announce(1);
        await vi.advanceTimersByTimeAsync(150);
        expect(Array.from(source.get_column("value") ?? [])).toEqual([1, 2, 3]);
        expect(h.onStatus).toHaveBeenLastCalledWith("error", "stream listener failed");
        await vi.advanceTimersByTimeAsync(1_000);
      }

      expect(h.onStatus).toHaveBeenCalledWith("error", "stream listener failed");
      expect(h.documents[0].get_model_by_id("range-1")).toBe(source);
      expect(Array.from(source.get_column("value") ?? [])).toEqual([1, 2, 3]);
      expect(h.onStatus).toHaveBeenLastCalledWith("connected", undefined);
      expect(h.apply).not.toHaveBeenCalled();
      expect(h.mount).toHaveBeenCalledTimes(1);
      expect(h.view.clear).not.toHaveBeenCalled();
      expect(onStream).toHaveBeenCalledTimes(2);
      h.canonical({ ...streamPatch([4]), baseRevision: 1, revision: 2 });
      await vi.advanceTimersByTimeAsync(0);
      expect(Array.from(source.get_column("value") ?? [])).toEqual([1, 2, 3, 4]);
    },
  );

  it("restores a checkpoint after checkpoint reconciliation partially mutates a model", async () => {
    const h = await start(columnSnapshot());
    const source = h.documents[0].get_model_by_id("range-1") as ColumnDataSource;
    source.properties.data.change.connect(
      vi.fn().mockImplementationOnce(() => {
        throw new Error("checkpoint listener failed");
      }),
    );
    const checkpoint = columnSnapshot([1, 2, 3]).checkpoint;
    checkpoint.revision = 1;
    const recovered = columnSnapshot();
    recovered.headRevision = 1;
    recovered.patchTail = [streamPatch([3])];
    h.setSnapshot(recovered);
    h.canonical({ ...streamPatch([3]), serverPatch: undefined, checkpoint });
    await vi.advanceTimersByTimeAsync(1);

    expect(h.onStatus).toHaveBeenCalledWith("error", "checkpoint listener failed");
    expect(h.documents[0].get_model_by_id("range-1")).toBe(source);
    expect(Array.from(source.get_column("value") ?? [])).toEqual([1, 2, 3]);
    expect(h.onStatus).toHaveBeenLastCalledWith("connected", undefined);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.mount).toHaveBeenCalledTimes(1);
    expect(h.view.clear).not.toHaveBeenCalled();
  });

  it("keeps finalized root references when a later document listener fails", async () => {
    const h = await start();
    const original = h.range();
    const doc = h.documents[0];
    let fail = true;
    doc.on_change((event) => {
      if (event.kind === "RootAdded" && fail) {
        fail = false;
        throw new Error("root listener failed");
      }
    });
    const event: NteractBokehResolvedPatchEvent = {
      ...patch("end", 0),
      serverPatch: {
        patch: {
          events: [{ kind: "RootAdded", model: { type: "object", name: "Range1d", id: "added" } }],
        },
        buffers: [],
      },
    };
    const recovered = snapshot();
    recovered.headRevision = 1;
    recovered.patchTail = [event];
    h.setSnapshot(recovered);
    h.canonical(event);
    await vi.advanceTimersByTimeAsync(1);

    expect(h.onStatus).toHaveBeenCalledWith("error", "root listener failed");
    expect(h.onStatus).toHaveBeenLastCalledWith("connected", undefined);
    expect(h.range()).toBe(original);
    const added = doc.get_model_by_id("added");
    expect(added).not.toBeNull();
    expect(doc.all_roots.filter((root) => root.id === "added")).toEqual([added]);
    expect(h.open).toHaveBeenCalledTimes(2);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.mount).toHaveBeenCalledTimes(1);
    expect(h.view.clear).not.toHaveBeenCalled();
  });

  it("discards incomplete model references when decoding itself fails", async () => {
    const h = await start();
    const doc = h.documents[0];
    const rootPatch = (
      start: number | { id: string },
    ): Parameters<BokehDocument["apply_json_patch"]>[0] => ({
      events: [
        {
          kind: "RootAdded",
          model: { type: "object", name: "Range1d", id: "added", attributes: { start } },
        },
      ],
    });
    expect(() =>
      deferExistingModelUpdates(realRuntime as BokehRuntime, () =>
        doc.apply_json_patch(rootPatch({ id: "missing" })),
      ),
    ).toThrow("reference missing isn't known");
    expect(doc.get_model_by_id("added")).toBeNull();
    expect(doc.all_roots.some((root) => root.id === "added")).toBe(false);

    deferExistingModelUpdates(realRuntime as BokehRuntime, () =>
      doc.apply_json_patch(rootPatch(2)),
    );
    const added = doc.get_model_by_id("added") as Range1d;
    expect(added.start).toBe(2);
    expect(doc.all_roots.filter((root) => root.id === "added")).toEqual([added]);
  });

  it("catches up a clean document without replacing it", async () => {
    const h = await start();
    const range = h.range();
    const recovered = snapshot();
    recovered.headRevision = 1;
    recovered.patchTail = [patch("end", 2)];
    h.setSnapshot(recovered);
    h.announce(1);
    await vi.advanceTimersByTimeAsync(150);
    expect(h.range()).toBe(range);
    expect([range.start, range.end]).toEqual([0, 2]);
    expect(h.mount).toHaveBeenCalledTimes(1);
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("keeps accepted optimistic edits when their canonical acknowledgement arrives", async () => {
    const h = await start();
    const range = h.range();
    range.start = 10;
    await vi.advanceTimersByTimeAsync(50);
    const request = h.apply.mock.calls[0][0];
    h.canonical({ ...patch("end", 2), transactionId: request.transactionId });
    await vi.advanceTimersByTimeAsync(0);
    expect([range.start, range.end]).toEqual([10, 2]);
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.open).toHaveBeenCalledTimes(1);
  });
});
