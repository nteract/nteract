import { describe, expect, it, vi } from "vite-plus/test";
import type { BokehSessionPatchBroadcast, BokehSessionState } from "runtimed";
import { BokehSessionBridgeManager } from "../bokeh-session-bridge-manager";
import type { BokehSessionTransport } from "../bokeh-session-context";
import type { IsolatedFrameHandle } from "../isolated-frame";

const payload = {
  schema_version: 1 as const,
  session_id: "session-1",
  revision: 0,
  producer: { name: "panel", version: "1.9.3" },
  bokeh_version: "3.9.1",
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

function runtimeSession(): BokehSessionState {
  return {
    output_id: "output-1",
    cell_id: "cell-1",
    execution_id: "execution-1",
    kernel_id: "kernel-1",
    status: "connected",
    head_revision: 1,
    producer_name: "panel",
    producer_version: "1.9.3",
    bokeh_version: "3.9.1",
    root_ids: ["root-1"],
    checkpoint: {
      revision: 0,
      content_ref: {
        blob: "checkpoint",
        size: 100,
        media_type: "application/vnd.nteract.bokeh-checkpoint.v1+json",
      },
    },
    patch_tail: [
      {
        base_revision: 0,
        revision: 1,
        content_ref: {
          blob: "patch-1",
          size: 100,
          media_type: "application/vnd.nteract.bokeh-patch.v1+json",
        },
      },
    ],
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeHarness() {
  let patchListener: ((broadcast: BokehSessionPatchBroadcast) => void) | null = null;
  const blobs = new Map<string, () => Response>([
    [
      "checkpoint",
      () =>
        jsonResponse({
          schema_version: 1,
          session_id: "session-1",
          revision: 0,
          document: { roots: [{ id: "root-1" }] },
          buffers: [
            { id: "buffer-0", blob: "buffer-0", size: 3, media_type: "application/octet-stream" },
          ],
        }),
    ],
    [
      "patch-1",
      () =>
        jsonResponse({
          session_id: "session-1",
          transaction_id: "transaction-1",
          base_revision: 0,
          revision: 1,
          client_patch: { patch: { events: [{ kind: "ModelChanged" }] }, buffers: [] },
          server_patch: null,
          checkpoint: null,
        }),
    ],
    ["buffer-0", () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })],
  ]);
  const transport: BokehSessionTransport = {
    fetchBlob: vi.fn(async (ref) => {
      const response = blobs.get(ref.blob)?.();
      if (!response) return new Response(null, { status: 404 });
      return response;
    }),
    applyPatch: vi.fn(async (options) => ({
      status: "accepted" as const,
      session_id: options.sessionId,
      transaction_id: options.transactionId,
      revision: options.baseRevision + 1,
    })),
    subscribePatches(listener) {
      patchListener = listener;
      return () => {
        patchListener = null;
      };
    },
  };
  const frame = { send: vi.fn() } as unknown as IsolatedFrameHandle;
  const manager = new BokehSessionBridgeManager({
    frame,
    transport,
    bindings: [{ outputId: "output-1", payload }],
  });
  manager.updateRuntimeSessions({ "session-1": runtimeSession() });
  return { blobs, frame, manager, patchListener: () => patchListener, transport };
}

describe("BokehSessionBridgeManager", () => {
  it("materializes a checkpoint and contiguous patch tail from blob storage", async () => {
    const { manager } = makeHarness();

    const snapshot = await manager.openSession({ sessionId: "session-1", outputId: "output-1" });

    expect(snapshot.status).toBe("connected");
    expect(snapshot.headRevision).toBe(1);
    expect(snapshot.checkpoint.revision).toBe(0);
    expect(new Uint8Array(snapshot.checkpoint.buffers[0].data)).toEqual(new Uint8Array([1, 2, 3]));
    expect(snapshot.patchTail).toHaveLength(1);
    expect(snapshot.patchTail[0].revision).toBe(1);
  });

  it("rejects a replay checkpoint owned by another session", async () => {
    const { blobs, manager } = makeHarness();
    blobs.set("checkpoint", () =>
      jsonResponse({
        schema_version: 1,
        session_id: "another-session",
        revision: 0,
        document: { roots: [{ id: "root-1" }] },
        buffers: [],
      }),
    );

    await expect(
      manager.openSession({ sessionId: "session-1", outputId: "output-1" }),
    ).rejects.toThrow("another session");
  });

  it("validates output ownership before applying a typed patch", async () => {
    const { manager, transport } = makeHarness();

    await expect(
      manager.applyPatch({
        sessionId: "session-1",
        outputId: "another-output",
        transactionId: "transaction-2",
        baseRevision: 1,
        patch: { events: [] },
        buffers: [],
      }),
    ).rejects.toThrow("not owned");

    const reply = await manager.applyPatch({
      sessionId: "session-1",
      outputId: "output-1",
      transactionId: "transaction-2",
      baseRevision: 1,
      patch: { events: [] },
      buffers: [],
    });
    expect(reply).toEqual({
      status: "accepted",
      sessionId: "session-1",
      transactionId: "transaction-2",
      revision: 2,
    });
    expect(transport.applyPatch).toHaveBeenCalledOnce();
  });

  it("delivers canonical broadcasts through the typed frame channel", async () => {
    const { frame, manager, patchListener } = makeHarness();
    vi.mocked(frame.send).mockClear();
    patchListener()?.({
      event: "bokeh_session_patch",
      patch: {
        session_id: "session-1",
        transaction_id: "transaction-2",
        base_revision: 1,
        revision: 2,
        server_patch: { patch: { events: [] }, buffers: [] },
        checkpoint: {
          session_id: "session-1",
          revision: 2,
          document: { roots: [{ id: "root-1" }] },
          buffers: [],
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(frame.send).toHaveBeenCalledWith({
      type: "bokeh_session_patch",
      payload: {
        outputId: "output-1",
        event: expect.objectContaining({
          sessionId: "session-1",
          transactionId: "transaction-2",
          revision: 2,
          checkpoint: expect.objectContaining({ revision: 2 }),
        }),
      },
    });
    manager.dispose();
  });

  it("does not deliver an in-flight broadcast after disposal", async () => {
    const { frame, manager, patchListener, transport } = makeHarness();
    vi.mocked(frame.send).mockClear();
    let markFetchStarted: (() => void) | undefined;
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const delayedResponse = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    vi.mocked(transport.fetchBlob).mockImplementationOnce(async () => {
      markFetchStarted?.();
      return delayedResponse;
    });

    patchListener()?.({
      event: "bokeh_session_patch",
      patch: {
        session_id: "session-1",
        transaction_id: "transaction-delayed",
        base_revision: 1,
        revision: 2,
        server_patch: {
          patch: { events: [] },
          buffers: [
            {
              id: "buffer-delayed",
              blob: "buffer-delayed",
              size: 3,
              media_type: "application/octet-stream",
            },
          ],
        },
      },
    });
    await fetchStarted;
    manager.dispose();
    resolveFetch?.(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(frame.send).not.toHaveBeenCalled();
  });

  it("rejects a live checkpoint whose identity does not match its event", async () => {
    const { frame, manager, patchListener } = makeHarness();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(frame.send).mockClear();

    patchListener()?.({
      event: "bokeh_session_patch",
      patch: {
        session_id: "session-1",
        transaction_id: "transaction-2",
        base_revision: 1,
        revision: 2,
        checkpoint: {
          session_id: "another-session",
          revision: 2,
          document: { roots: [{ id: "root-1" }] },
          buffers: [],
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    patchListener()?.({
      event: "bokeh_session_patch",
      patch: {
        session_id: "session-1",
        transaction_id: "transaction-3",
        base_revision: 1,
        revision: 2,
        checkpoint: {
          session_id: "session-1",
          revision: 3,
          document: { roots: [{ id: "root-1" }] },
          buffers: [],
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(frame.send).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenNthCalledWith(
      1,
      "[bokeh-session] Failed to deliver document patch:",
      expect.objectContaining({ message: expect.stringContaining("another session") }),
    );
    expect(consoleError).toHaveBeenNthCalledWith(
      2,
      "[bokeh-session] Failed to deliver document patch:",
      expect.objectContaining({ message: expect.stringContaining("revision") }),
    );
    manager.dispose();
  });
});
