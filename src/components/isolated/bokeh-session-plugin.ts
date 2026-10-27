/**
 * Bokeh document sessions as an output-session plugin.
 *
 * The plugin binds `application/vnd.nteract.bokeh-session.v1+json` outputs to
 * the RuntimeStateDoc session records and serves the iframe's Bokeh requests
 * through `BokehSessionBridgeManager`. Session documents are followed only
 * when the daemon routes the `bokeh_session` keyed document kind to this
 * connection; otherwise outputs render their saved state read-only.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ApplyBokehSessionPatchOptions,
  BlobRef,
  BlobResolver,
  BokehSessionDataTail,
  BokehSessionEvents,
  BokehSessionPatchReply,
  BokehSessionState,
  SyncEngine,
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
  BOKEH_SESSION_DOC_KIND,
  BokehSessionDocStore,
  type BokehSessionDocReplica,
  type BokehSessionDocStoreOptions,
} from "./bokeh-session-doc-store";
import {
  NTERACT_BOKEH_SESSION_HOST_METHODS,
  type NteractBokehSessionHostMethod,
} from "./bokeh-session-rpc";
import type { IsolatedFrameHandle } from "./isolated-frame";

export interface BokehSessionTransport {
  /**
   * Host replicas of the session documents, shared by every output frame;
   * `null` when the connection does not sync them.
   */
  docs: BokehSessionDocStore | null;
  fetchBlob(ref: BlobRef): Promise<Response>;
  /** One-off events (`MessageSent`, `ColumnsStreamed`, `ColumnsPatched`). */
  applyPatch(options: ApplyBokehSessionPatchOptions): Promise<BokehSessionPatchReply>;
  getData(sessionId: string, sourceIds?: string[]): Promise<BokehSessionDataTail>;
  subscribeEvents(listener: (events: BokehSessionEvents) => void): () => void;
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
    return manager.handleRequest(method as NteractBokehSessionHostMethod, params);
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

/** The sync engine streams the session documents travel on. */
export type BokehSessionEngine = Pick<
  SyncEngine,
  | "keyedDocFrames$"
  | "keyedDocResyncs$"
  | "keyedDocsReset$"
  | "negotiatedCapabilities$"
  | "sendKeyedDocFrame"
  | "bokehSessionEventsBroadcasts$"
>;

export type BokehSessionDocsOptions = Omit<BokehSessionDocStoreOptions, "sendFrame">;

/**
 * Keep a `BokehSessionDocStore` on `engine` while the negotiated
 * capabilities include `bokeh_session`, and none otherwise. `onDocs` sees
 * every change. Returns a function that stops following and disposes the
 * store.
 */
export function followBokehSessionDocs(
  engine: BokehSessionEngine,
  options: BokehSessionDocsOptions,
  onDocs: (docs: BokehSessionDocStore | null) => void,
): () => void {
  let docs: BokehSessionDocStore | null = null;
  let streams: Array<{ unsubscribe(): void }> = [];
  const stop = () => {
    for (const stream of streams) stream.unsubscribe();
    streams = [];
    docs?.dispose();
    docs = null;
  };
  const capabilities = engine.negotiatedCapabilities$.subscribe(({ keyedDocKinds }) => {
    const supported = keyedDocKinds.has(BOKEH_SESSION_DOC_KIND);
    if (supported === (docs !== null)) return;
    stop();
    if (supported) {
      const store = new BokehSessionDocStore({
        ...options,
        sendFrame: (payload) => engine.sendKeyedDocFrame(BOKEH_SESSION_DOC_KIND, payload),
      });
      streams = [
        engine.keyedDocFrames$.subscribe((frame) => store.receiveFrame(frame)),
        engine.keyedDocResyncs$.subscribe((resync) => store.handleResync(resync)),
        engine.keyedDocsReset$.subscribe(() => store.resubscribeAll()),
      ];
      docs = store;
    }
    onDocs(docs);
  });
  return () => {
    capabilities.unsubscribe();
    if (docs) {
      stop();
      onDocs(null);
    }
  };
}

export interface BokehSessionPluginSources {
  sessions: Record<string, BokehSessionState>;
  engine: BokehSessionEngine | null;
  blobResolver: Pick<BlobResolver, "fetch"> | null;
  client: {
    applyBokehSessionPatch(options: ApplyBokehSessionPatchOptions): Promise<BokehSessionPatchReply>;
    getBokehSessionData(sessionId: string, sourceIds?: string[]): Promise<BokehSessionDataTail>;
  };
  /** WASM `BokehSessionDocHandle` factory. */
  createReplica(sessionId: string, epoch: number): BokehSessionDocReplica;
  logger?: BokehSessionDocStoreOptions["logger"];
}

/**
 * The Bokeh entry of the output-session runtime map for
 * `OutputSessionRuntimeContext`. The plugin itself is registered once at
 * startup with `installBokehSessionPlugin()`.
 */
export function useBokehSessionPlugin({
  sessions,
  engine,
  blobResolver,
  client,
  createReplica,
  logger,
}: BokehSessionPluginSources): Readonly<Record<string, unknown>> {
  const [docs, setDocs] = useState<BokehSessionDocStore | null>(null);
  // Read through a ref so a new resolver or factory reaches the existing
  // store instead of rebuilding it, which would drop every replica.
  const sources = useRef({ blobResolver, createReplica, logger });
  useEffect(() => {
    sources.current = { blobResolver, createReplica, logger };
  });
  const hasBlobResolver = blobResolver !== null;
  useEffect(() => {
    if (!engine || !hasBlobResolver) return;
    return followBokehSessionDocs(
      engine,
      {
        createReplica: (sessionId, epoch) => sources.current.createReplica(sessionId, epoch),
        fetchBlob: (ref) => {
          const resolver = sources.current.blobResolver;
          return resolver
            ? resolver.fetch(ref)
            : Promise.reject(new Error("Blob resolver is unavailable"));
        },
        logger: { warn: (message, ...args) => sources.current.logger?.warn(message, ...args) },
      },
      setDocs,
    );
  }, [engine, hasBlobResolver]);
  useEffect(() => {
    docs?.updateSessions(sessions);
  }, [docs, sessions]);
  const transport = useMemo<BokehSessionTransport | null>(() => {
    if (!blobResolver) return null;
    return {
      docs,
      fetchBlob: (ref) => blobResolver.fetch(ref),
      applyPatch: (options) => client.applyBokehSessionPatch(options),
      getData: (sessionId, sourceIds) => client.getBokehSessionData(sessionId, sourceIds),
      subscribeEvents: (listener) => {
        if (!engine) return () => {};
        const subscription = engine.bokehSessionEventsBroadcasts$.subscribe((broadcast) =>
          listener(broadcast.events),
        );
        return () => subscription.unsubscribe();
      },
    };
  }, [blobResolver, client, docs, engine]);
  return useMemo(
    () => ({ [BOKEH_SESSION_PLUGIN_ID]: { sessions, transport } satisfies BokehSessionRuntime }),
    [sessions, transport],
  );
}
