import { renderHook } from "@testing-library/react";
import type { BokehSessionState } from "runtimed";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { JupyterOutput } from "@/components/cell/jupyter-output";
import { NTERACT_BOKEH_SESSION_MIME_TYPE } from "@/components/outputs/bokeh-mime";
import {
  getOutputSessionHostMethods,
  getOutputSessionPluginForMethod,
} from "@/components/outputs/output-session-plugins";
import {
  BOKEH_SESSION_PLUGIN_ID,
  bokehSessionPlugin,
  installBokehSessionPlugin,
  useBokehSessionPlugin,
  type BokehSessionRuntime,
  type BokehSessionTransport,
} from "../bokeh-session-plugin";
import {
  NTERACT_BOKEH_APPLY_PATCH,
  NTERACT_BOKEH_SESSION_OPEN,
  NTERACT_BOKEH_SESSION_STATE,
} from "../bokeh-session-rpc";
import type { IsolatedFrameHandle } from "../isolated-frame";

const payload = {
  schema_version: 1 as const,
  session_id: "session-1",
  revision: 0,
  producer: { name: "panel", version: "1.9.3" },
  bokeh_version: "3.9.1",
  document: { roots: [] },
  root_ids: ["root-1"],
  resources: { javascript: [], stylesheets: [], javascript_modules: [], module_exports: {} },
  buffers: [],
};

function session(headRevision: number): BokehSessionState {
  return {
    output_id: "output-1",
    cell_id: "cell-1",
    execution_id: "execution-1",
    kernel_id: "kernel-1",
    status: "connected",
    head_revision: headRevision,
    producer_name: "panel",
    producer_version: "1.9.3",
    bokeh_version: "3.9.1",
    root_ids: ["root-1"],
    checkpoint: {
      revision: 0,
      content_ref: { blob: "checkpoint", size: 1, media_type: "application/json" },
    },
    patch_tail: [],
  };
}

function transport(): BokehSessionTransport & { unsubscribe: ReturnType<typeof vi.fn> } {
  const unsubscribe = vi.fn();
  return {
    fetchBlob: vi.fn(),
    applyPatch: vi.fn(async (options) => ({
      status: "accepted" as const,
      session_id: options.sessionId,
      transaction_id: options.transactionId,
      revision: options.baseRevision + 1,
    })),
    subscribePatches: vi.fn(() => unsubscribe),
    unsubscribe,
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
      NTERACT_BOKEH_APPLY_PATCH,
    ]);
    expect(getOutputSessionPluginForMethod(NTERACT_BOKEH_APPLY_PATCH)?.id).toBe(
      BOKEH_SESSION_PLUGIN_ID,
    );
  });

  it("replaces its bridge manager only when the transport changes", async () => {
    const frame = { notifyExtension: vi.fn() } as unknown as IsolatedFrameHandle;
    const bindings = [{ outputId: "output-1", payload }];
    const first = transport();
    const second = transport();
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
    expect(first.subscribePatches).toHaveBeenCalledOnce();
    expect(frame.notifyExtension).toHaveBeenLastCalledWith(NTERACT_BOKEH_SESSION_STATE, {
      sessionId: "session-1",
      outputId: "output-1",
      status: "connected",
      headRevision: 2,
    });

    await expect(
      bridge.handleRequest(NTERACT_BOKEH_APPLY_PATCH, {
        sessionId: "session-1",
        outputId: "output-1",
        transactionId: "tx-1",
        baseRevision: 2,
        patch: { events: [] },
        buffers: [],
      }),
    ).resolves.toEqual({
      status: "accepted",
      sessionId: "session-1",
      transactionId: "tx-1",
      revision: 3,
    });
    await expect(bridge.handleRequest("nteract/unknown", {})).rejects.toThrow(
      "Unsupported Bokeh session method nteract/unknown",
    );

    vi.mocked(frame.notifyExtension).mockClear();
    bridge.updateRuntime({ sessions: { "session-1": session(2) }, transport: second });
    expect(first.unsubscribe).toHaveBeenCalledOnce();
    expect(second.subscribePatches).toHaveBeenCalledOnce();
    // The new manager re-announces the mounted session; this replaces main's
    // render-batch re-send on a transport change.
    expect(frame.notifyExtension).toHaveBeenCalledWith(NTERACT_BOKEH_SESSION_STATE, {
      sessionId: "session-1",
      outputId: "output-1",
      status: "connected",
      headRevision: 2,
    });

    bridge.dispose();
    expect(second.unsubscribe).toHaveBeenCalledOnce();
  });
});

describe("useBokehSessionPlugin", () => {
  it("keeps the runtime map stable across unrelated renders without registering the plugin", () => {
    const sessions = { "session-1": session(1) };
    const blobResolver = { fetch: vi.fn() };
    const client = { applyBokehSessionPatch: vi.fn() };
    const { result, rerender } = renderHook(
      (props: { sessions: Record<string, BokehSessionState> }) =>
        useBokehSessionPlugin({ sessions: props.sessions, blobResolver, patches: null, client }),
      { initialProps: { sessions } },
    );

    const runtime = result.current[BOKEH_SESSION_PLUGIN_ID] as BokehSessionRuntime;
    // Registration is a startup step (App.tsx module scope), not a render effect.
    expect(getOutputSessionPluginForMethod(NTERACT_BOKEH_SESSION_OPEN)).toBeNull();
    expect(runtime.sessions).toBe(sessions);
    expect(runtime.transport?.subscribePatches(() => {})).toBeTypeOf("function");

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
    const { result } = renderHook(() =>
      useBokehSessionPlugin({
        sessions: {},
        blobResolver: null,
        patches: null,
        client: { applyBokehSessionPatch: vi.fn() },
      }),
    );

    expect((result.current[BOKEH_SESSION_PLUGIN_ID] as BokehSessionRuntime).transport).toBeNull();
  });
});
