/**
 * Serves one output frame's Bokeh session requests and forwards session
 * state, document updates and one-off events to it. A frame may only reach
 * the sessions bound to its own outputs.
 */

import type { BokehSessionBufferRef, BokehSessionEvents, BokehSessionState } from "runtimed";
import type { BokehSessionMimePayload } from "@/components/outputs/bokeh-mime";
import type { BokehDocColumnRef } from "./bokeh-session-doc-store";
import type { BokehSessionTransport } from "./bokeh-session-plugin";
import type { IsolatedFrameHandle } from "./isolated-frame";
import {
  NTERACT_BOKEH_APPLY_PATCH,
  NTERACT_BOKEH_SESSION_DATA,
  NTERACT_BOKEH_SESSION_DOC,
  NTERACT_BOKEH_SESSION_EVENTS,
  NTERACT_BOKEH_SESSION_OPEN,
  NTERACT_BOKEH_SESSION_STATE,
  NTERACT_BOKEH_SET_PROPS,
  type NteractBokehApplyPatchParams,
  type NteractBokehApplyPatchResult,
  type NteractBokehColumnData,
  type NteractBokehDataEvent,
  type NteractBokehMessage,
  type NteractBokehResolvedBuffer,
  type NteractBokehResolvedEvents,
  type NteractBokehSessionDataParams,
  type NteractBokehSessionDataResult,
  type NteractBokehSessionDocParams,
  type NteractBokehSessionEventsParams,
  type NteractBokehSessionHostMethod,
  type NteractBokehSessionOpenParams,
  type NteractBokehSessionOpenResult,
  type NteractBokehSessionStateParams,
  type NteractBokehSetPropsParams,
  type NteractBokehSetPropsResult,
} from "./bokeh-session-rpc";

export interface BokehSessionOutputBinding {
  outputId: string;
  payload: BokehSessionMimePayload;
}

/** The daemon accepts only these over the one-off channel. */
const ONE_OFF_EVENT_KINDS = new Set(["MessageSent", "ColumnsStreamed", "ColumnsPatched"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(params: Record<string, unknown>, field: string): string {
  const value = params[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Bokeh session request is missing ${field}`);
  }
  return value;
}

function stringMap(value: unknown): Record<string, Record<string, string>> {
  if (!isRecord(value)) throw new Error("Bokeh property writes must be an object");
  // Frame-supplied model and property names are data, including prototype keys.
  const result: Record<string, Record<string, string>> = Object.create(null);
  for (const [modelId, props] of Object.entries(value)) {
    if (!isRecord(props)) throw new Error("Bokeh property writes must map models to values");
    for (const [name, encoded] of Object.entries(props)) {
      if (typeof encoded !== "string") throw new Error("Bokeh property values must be JSON text");
      (result[modelId] ??= Object.create(null))[name] = encoded;
    }
  }
  return result;
}

function stateSignature(state: NteractBokehSessionStateParams): string {
  return [
    state.status,
    state.epoch,
    state.outputId,
    state.live,
    state.writable,
    state.error ?? "",
  ].join(":");
}

export class BokehSessionBridgeManager {
  private readonly frame: IsolatedFrameHandle;
  private readonly transport: BokehSessionTransport;
  private readonly bindings = new Map<string, BokehSessionOutputBinding>();
  private readonly docSubscriptions = new Map<string, () => void>();
  /** Sessions whose document the host stopped rebuilding, with the reason. */
  private readonly docErrors = new Map<string, string>();
  private readonly eventQueues = new Map<string, Promise<void>>();
  private runtimeSessions: Record<string, BokehSessionState> = {};
  private stateSignatures = new Map<string, string>();
  private readonly unsubscribeEvents: (() => void) | null;
  private disposed = false;

  constructor(options: {
    frame: IsolatedFrameHandle;
    transport: BokehSessionTransport;
    bindings: BokehSessionOutputBinding[];
  }) {
    this.frame = options.frame;
    this.transport = options.transport;
    this.setBindings(options.bindings);
    // Without session documents every output renders statically; events
    // would only reach frames that never asked to follow a session.
    this.unsubscribeEvents = this.transport.docs
      ? this.transport.subscribeEvents((events) => this.enqueueEvents(events))
      : null;
  }

  setBindings(bindings: BokehSessionOutputBinding[]): void {
    this.bindings.clear();
    for (const binding of bindings) {
      this.bindings.set(binding.payload.session_id, binding);
    }
    for (const sessionId of this.docSubscriptions.keys()) {
      if (!this.bindings.has(sessionId)) this.unsubscribeDoc(sessionId);
    }
  }

  updateRuntimeSessions(sessions: Record<string, BokehSessionState>): void {
    this.runtimeSessions = sessions;
    this.notifyCurrentState();
  }

  notifyCurrentState(): void {
    for (const [sessionId, binding] of this.bindings) {
      const state = this.currentState(sessionId, binding);
      const signature = stateSignature(state);
      if (this.stateSignatures.get(sessionId) === signature) continue;
      this.stateSignatures.set(sessionId, signature);
      this.frame.notifyExtension(NTERACT_BOKEH_SESSION_STATE, state);
    }
  }

  private currentState(
    sessionId: string,
    binding: BokehSessionOutputBinding,
  ): NteractBokehSessionStateParams {
    const session = this.ownedSession(binding);
    const error = session?.status === "connected" ? this.docErrors.get(sessionId) : undefined;
    const status = error !== undefined ? "error" : (session?.status ?? "disconnected");
    return {
      sessionId,
      outputId: binding.outputId,
      status,
      epoch: session?.epoch ?? null,
      live: this.docSubscriptions.has(sessionId),
      writable: this.writable(status),
      ...(error !== undefined ? { error } : {}),
    };
  }

  /** Serve a request from the frame; it may only reach its own outputs' sessions. */
  async handleRequest(method: NteractBokehSessionHostMethod, params: unknown): Promise<unknown> {
    if (!isRecord(params)) throw new Error("Bokeh session request is invalid");
    switch (method) {
      case NTERACT_BOKEH_SESSION_OPEN:
        return this.openSession(params as unknown as NteractBokehSessionOpenParams);
      case NTERACT_BOKEH_SET_PROPS:
        return this.setProps(params as unknown as NteractBokehSetPropsParams);
      case NTERACT_BOKEH_APPLY_PATCH:
        return this.applyPatch(params as unknown as NteractBokehApplyPatchParams);
      case NTERACT_BOKEH_SESSION_DATA:
        return this.loadData(params as unknown as NteractBokehSessionDataParams);
      default:
        throw new Error(`Unknown Bokeh session request ${String(method)}`);
    }
  }

  openSession(params: NteractBokehSessionOpenParams): NteractBokehSessionOpenResult {
    const sessionId = requireString(params as unknown as Record<string, unknown>, "sessionId");
    const binding = this.requireBinding(sessionId, params.outputId);
    const session = this.ownedSession(binding);
    const status = session?.status ?? "disconnected";
    const docs = this.transport.docs;
    // A frozen or reloaded session renders its payload, and so does every
    // session when the connection does not sync session documents.
    const live = status === "connected" && docs !== null;
    this.unsubscribeDoc(sessionId);
    if (live) {
      const unsubscribe = docs.subscribe(
        sessionId,
        (update) => {
          if (this.disposed || !this.bindings.has(sessionId)) return;
          this.frame.notifyExtension(NTERACT_BOKEH_SESSION_DOC, {
            outputId: binding.outputId,
            update,
          } satisfies NteractBokehSessionDocParams);
          if (update.kind === "full" && this.docErrors.delete(sessionId)) {
            this.notifyCurrentState();
          }
        },
        (error) => {
          if (this.disposed || !this.bindings.has(sessionId)) return;
          this.docErrors.set(sessionId, error);
          this.notifyCurrentState();
        },
      );
      this.docSubscriptions.set(sessionId, unsubscribe);
    }
    // The result carries this state. Sent as a notification it would reach
    // the frame before the result, while its own state is still pre-open.
    const state = this.currentState(sessionId, binding);
    this.stateSignatures.set(sessionId, stateSignature(state));
    this.notifyCurrentState();
    return {
      sessionId,
      outputId: binding.outputId,
      status: state.status,
      epoch: state.epoch,
      live: state.live,
      writable: state.writable,
    };
  }

  setProps(params: NteractBokehSetPropsParams): NteractBokehSetPropsResult {
    const sessionId = requireString(params as unknown as Record<string, unknown>, "sessionId");
    const binding = this.requireBinding(sessionId, params.outputId);
    const docs = this.transport.docs;
    if (!docs || !this.currentState(sessionId, binding).writable) return { status: "read_only" };
    return docs.writeProps(sessionId, stringMap(params.props));
  }

  async applyPatch(params: NteractBokehApplyPatchParams): Promise<NteractBokehApplyPatchResult> {
    const sessionId = requireString(params as unknown as Record<string, unknown>, "sessionId");
    const transactionId = requireString(
      params as unknown as Record<string, unknown>,
      "transactionId",
    );
    const binding = this.requireBinding(sessionId, params.outputId);
    const session = this.ownedSession(binding);
    if (session?.status !== "connected") {
      return {
        status: "error",
        sessionId,
        transactionId,
        error: `Bokeh session is ${session?.status ?? "disconnected"}`,
      };
    }
    if (!this.transport.writable) {
      return { status: "error", sessionId, transactionId, error: "Bokeh session is read-only" };
    }
    const events = isRecord(params.patch) ? params.patch.events : null;
    if (
      !Array.isArray(events) ||
      !events.every((event) => isRecord(event) && ONE_OFF_EVENT_KINDS.has(String(event.kind)))
    ) {
      throw new Error("Bokeh session patches may only carry one-off events");
    }
    const reply = await this.transport.applyPatch({
      sessionId,
      transactionId,
      patch: params.patch,
      buffers: (params.buffers ?? []).map((buffer) => ({
        id: buffer.id,
        data: new Uint8Array(buffer.data),
      })),
    });
    if (reply.status === "error") {
      return { status: "error", sessionId, transactionId, error: reply.error };
    }
    return { status: "accepted", sessionId, transactionId };
  }

  /** Column blobs at the document's current refs, plus the retained tail. */
  async loadData(params: NteractBokehSessionDataParams): Promise<NteractBokehSessionDataResult> {
    const sessionId = requireString(params as unknown as Record<string, unknown>, "sessionId");
    this.requireBinding(sessionId, params.outputId);
    const docs = this.transport.docs;
    if (!docs) throw new Error("This connection does not sync Bokeh session documents");
    if (!isRecord(params.sources)) throw new Error("Bokeh data request needs sources");
    const sources: Record<string, string[] | null> = {};
    for (const [sourceId, names] of Object.entries(params.sources)) {
      sources[sourceId] = Array.isArray(names) ? names.map(String) : null;
    }
    const sourceIds = Object.keys(sources);
    const tail = params.tail
      ? await this.transport.getData(sessionId, sourceIds)
      : { session_id: sessionId, epoch: 0, events: [], fold_requested: [] };
    // Read refs after the tail so a fold in between is never older than it.
    const refs = docs.columnRefs(sessionId, sources);
    if (!refs) throw new Error(`Bokeh session ${sessionId} has not synced`);
    const columns: Record<string, Record<string, NteractBokehColumnData>> = {};
    await Promise.all(
      Object.entries(refs.columns).map(async ([sourceId, sourceRefs]) => {
        columns[sourceId] = await this.loadColumns(sourceRefs);
      }),
    );
    const events = await Promise.all(
      tail.events
        .filter((events) => events.session_id === sessionId)
        .map((events) => this.resolveEvents(events)),
    );
    return { epoch: refs.epoch, columns, events, foldRequested: tail.fold_requested ?? [] };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeEvents?.();
    for (const sessionId of this.docSubscriptions.keys()) this.unsubscribeDoc(sessionId);
    this.bindings.clear();
    this.eventQueues.clear();
  }

  private unsubscribeDoc(sessionId: string): void {
    this.docSubscriptions.get(sessionId)?.();
    this.docSubscriptions.delete(sessionId);
    this.docErrors.delete(sessionId);
  }

  private writable(status: string | undefined): boolean {
    return status === "connected" && this.transport.docs !== null && this.transport.writable;
  }

  private ownedSession(binding: BokehSessionOutputBinding): BokehSessionState | undefined {
    const session = this.runtimeSessions[binding.payload.session_id];
    return session?.output_id === binding.outputId ? session : undefined;
  }

  private requireBinding(sessionId: string, outputId: unknown): BokehSessionOutputBinding {
    const binding = this.bindings.get(sessionId);
    if (!binding || binding.outputId !== outputId) {
      throw new Error(`Bokeh session ${sessionId} is not owned by output ${String(outputId)}`);
    }
    return binding;
  }

  private async loadColumns(
    refs: Record<string, BokehDocColumnRef>,
  ): Promise<Record<string, NteractBokehColumnData>> {
    const docs = this.transport.docs;
    if (!docs) throw new Error("This connection does not sync Bokeh session documents");
    const entries = await Promise.all(
      Object.entries(refs).map(async ([name, ref]) => {
        const data = await docs.loadJson({
          blob: ref.blob,
          size: ref.size,
          media_type: "application/vnd.nteract.bokeh-column.v1+json",
        });
        return [name, { version: ref.version, data }] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  private async resolveBuffers(
    refs: BokehSessionBufferRef[] | undefined,
  ): Promise<NteractBokehResolvedBuffer[]> {
    return Promise.all(
      (refs ?? []).map(async (ref) => {
        const response = await this.transport.fetchBlob(ref);
        if (!response.ok) {
          throw new Error(`Failed to fetch Bokeh buffer ${ref.blob}: ${response.status}`);
        }
        const data = await response.arrayBuffer();
        if (data.byteLength !== ref.size) {
          throw new Error(
            `Bokeh buffer ${ref.id} has size ${data.byteLength}; expected ${ref.size}`,
          );
        }
        return { id: ref.id, data };
      }),
    );
  }

  /** Load buffers, and the blobs of full-column replacements, for the frame. */
  private async resolveEvents(events: BokehSessionEvents): Promise<NteractBokehResolvedEvents> {
    const dataEvents = await Promise.all(
      (events.data_events ?? []).map(async (event): Promise<NteractBokehDataEvent | null> => {
        if (event.kind !== "ColumnDataChanged") return event as unknown as NteractBokehDataEvent;
        const columns = isRecord(event.columns) ? event.columns : {};
        const refs: Record<string, BokehDocColumnRef> = {};
        for (const [name, ref] of Object.entries(columns)) {
          if (isRecord(ref) && typeof ref.blob === "string") {
            refs[name] = {
              blob: ref.blob,
              size: Number(ref.size ?? 0),
              version: Number(ref.version ?? event.new_version ?? 0),
            };
          }
        }
        return {
          kind: "ColumnDataChanged",
          source_id: String(event.source_id),
          base_version: Number(event.base_version),
          new_version: Number(event.new_version),
          columns: await this.loadColumns(refs),
          columns_removed: Array.isArray(event.columns_removed)
            ? event.columns_removed.map(String)
            : [],
        };
      }),
    );
    return {
      sessionId: events.session_id,
      epoch: events.epoch,
      transactionId: events.transaction_id,
      dataEvents: dataEvents.filter((event): event is NteractBokehDataEvent => event !== null),
      messages: (events.messages ?? []) as unknown as NteractBokehMessage[],
      buffers: await this.resolveBuffers(events.buffers),
    };
  }

  private enqueueEvents(events: BokehSessionEvents): void {
    const sessionId = events.session_id;
    if (this.disposed || !this.bindings.has(sessionId)) return;
    const previous = this.eventQueues.get(sessionId) ?? Promise.resolve();
    // Resolve concurrently, deliver in broadcast order.
    const resolved = this.resolveEvents(events);
    const next = previous
      .then(async () => {
        const payload = await resolved;
        const binding = this.bindings.get(sessionId);
        if (this.disposed || !binding) return;
        this.frame.notifyExtension(NTERACT_BOKEH_SESSION_EVENTS, {
          outputId: binding.outputId,
          events: payload,
        } satisfies NteractBokehSessionEventsParams);
      })
      .catch((error: unknown) => {
        // The frame detects the version gap on the next event and reloads.
        console.error("[bokeh-session] Failed to deliver session events:", error);
      });
    this.eventQueues.set(sessionId, next);
    void next.then(() => {
      if (this.eventQueues.get(sessionId) === next) this.eventQueues.delete(sessionId);
    });
  }
}
