/**
 * Bokeh document sessions as an output-session plugin.
 *
 * The plugin binds `application/vnd.nteract.bokeh-session.v1+json` outputs to
 * the RuntimeStateDoc session records and serves the iframe's Bokeh requests
 * through `BokehSessionBridgeManager`.
 */

import { useMemo } from "react";
import type {
  ApplyBokehSessionPatchOptions,
  BlobRef,
  BlobResolver,
  BokehSessionPatchBroadcast,
  BokehSessionPatchReply,
  BokehSessionState,
} from "runtimed";
import type { JupyterOutput } from "@/components/cell/jupyter-output";
import {
  isBokehSessionMimePayload,
  NTERACT_BOKEH_SESSION_MIME_TYPE,
} from "@/components/outputs/bokeh-mime";
import {
  registerOutputSessionPlugin,
  type OutputSessionBridge,
  type OutputSessionPlugin,
} from "@/components/outputs/output-session-plugins";
import {
  BokehSessionBridgeManager,
  type BokehSessionOutputBinding,
} from "./bokeh-session-bridge-manager";
import {
  NTERACT_BOKEH_APPLY_PATCH,
  NTERACT_BOKEH_SESSION_HOST_METHODS,
  NTERACT_BOKEH_SESSION_OPEN,
  type NteractBokehApplyPatchParams,
  type NteractBokehSessionOpenParams,
} from "./bokeh-session-rpc";
import type { IsolatedFrameHandle } from "./isolated-frame";

export interface BokehSessionTransport {
  fetchBlob(ref: BlobRef): Promise<Response>;
  applyPatch(options: ApplyBokehSessionPatchOptions): Promise<BokehSessionPatchReply>;
  subscribePatches(listener: (broadcast: BokehSessionPatchBroadcast) => void): () => void;
}

export interface BokehSessionRuntime {
  sessions: Record<string, BokehSessionState>;
  transport: BokehSessionTransport | null;
}

export const BOKEH_SESSION_PLUGIN_ID = "bokeh-session";

function bokehSessionBindings(outputs: readonly JupyterOutput[]): BokehSessionOutputBinding[] {
  return outputs.flatMap((output) => {
    if (output.output_type !== "execute_result" && output.output_type !== "display_data") {
      return [];
    }
    const payload = output.data[NTERACT_BOKEH_SESSION_MIME_TYPE];
    if (!output.output_id || !isBokehSessionMimePayload(payload)) return [];
    return [{ outputId: output.output_id, payload }];
  });
}

/**
 * Owns at most one `BokehSessionBridgeManager` per frame, replaced when the
 * transport changes; session records alone only update the manager.
 */
class BokehSessionPluginBridge implements OutputSessionBridge {
  private manager: BokehSessionBridgeManager | null = null;
  private transport: BokehSessionTransport | null = null;

  constructor(
    private readonly frame: IsolatedFrameHandle,
    private bindings: BokehSessionOutputBinding[],
  ) {}

  setBindings(bindings: unknown[]): void {
    this.bindings = bindings as BokehSessionOutputBinding[];
    this.manager?.setBindings(this.bindings);
  }

  updateRuntime(runtime: unknown): void {
    const { sessions, transport } = runtime as BokehSessionRuntime;
    if (transport !== this.transport) {
      this.manager?.dispose();
      this.manager = transport
        ? new BokehSessionBridgeManager({ frame: this.frame, transport, bindings: this.bindings })
        : null;
      this.transport = transport;
    }
    this.manager?.updateRuntimeSessions(sessions);
  }

  handleRequest(method: string, params: unknown): Promise<unknown> {
    const manager = this.manager;
    if (!manager) {
      return Promise.reject(new Error("Bokeh document session transport is unavailable"));
    }
    switch (method) {
      case NTERACT_BOKEH_SESSION_OPEN:
        return manager.openSession(params as NteractBokehSessionOpenParams);
      case NTERACT_BOKEH_APPLY_PATCH:
        return manager.applyPatch(params as NteractBokehApplyPatchParams);
      default:
        return Promise.reject(new Error(`Unsupported Bokeh session method ${method}`));
    }
  }

  notifyCurrentState(): void {
    this.manager?.notifyCurrentState();
  }

  dispose(): void {
    this.manager?.dispose();
    this.manager = null;
    this.transport = null;
  }
}

export const bokehSessionPlugin: OutputSessionPlugin<
  BokehSessionOutputBinding,
  BokehSessionRuntime
> = {
  id: BOKEH_SESSION_PLUGIN_ID,
  mimeTypes: [NTERACT_BOKEH_SESSION_MIME_TYPE],
  hostMethods: NTERACT_BOKEH_SESSION_HOST_METHODS,
  bindings: bokehSessionBindings,
  createBridge: ({ frame, bindings }) => new BokehSessionPluginBridge(frame, bindings),
};

export function installBokehSessionPlugin(): () => void {
  return registerOutputSessionPlugin(bokehSessionPlugin);
}

export interface BokehSessionPluginSources {
  sessions: Record<string, BokehSessionState>;
  blobResolver: Pick<BlobResolver, "fetch"> | null;
  patches: {
    subscribe(listener: (broadcast: BokehSessionPatchBroadcast) => void): {
      unsubscribe(): void;
    };
  } | null;
  client: {
    applyBokehSessionPatch(options: ApplyBokehSessionPatchOptions): Promise<BokehSessionPatchReply>;
  };
}

/**
 * The Bokeh entry of the output-session runtime map for
 * `OutputSessionRuntimeContext`. The plugin itself is registered once at
 * startup with `installBokehSessionPlugin()`.
 */
export function useBokehSessionPlugin({
  sessions,
  blobResolver,
  patches,
  client,
}: BokehSessionPluginSources): Readonly<Record<string, unknown>> {
  const transport = useMemo<BokehSessionTransport | null>(() => {
    if (!blobResolver) return null;
    return {
      fetchBlob: (ref) => blobResolver.fetch(ref),
      applyPatch: (options) => client.applyBokehSessionPatch(options),
      subscribePatches: (listener) => {
        if (!patches) return () => {};
        const subscription = patches.subscribe(listener);
        return () => subscription.unsubscribe();
      },
    };
  }, [blobResolver, client, patches]);
  return useMemo(
    () => ({ [BOKEH_SESSION_PLUGIN_ID]: { sessions, transport } satisfies BokehSessionRuntime }),
    [sessions, transport],
  );
}
