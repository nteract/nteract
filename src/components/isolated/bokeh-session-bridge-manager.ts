import type {
  BlobRef,
  BokehSessionBufferRef,
  BokehSessionPatchBroadcast,
  BokehSessionPatchEvent,
  BokehSessionPatchPayload,
  BokehSessionPatchReply,
  BokehSessionState,
} from "runtimed";
import type { BokehSessionMimePayload } from "@/components/outputs/bokeh-mime";
import type { IsolatedFrameHandle } from "./isolated-frame";
import type {
  NteractBokehApplyPatchParams,
  NteractBokehApplyPatchResult,
  NteractBokehResolvedBuffer,
  NteractBokehResolvedPatchEvent,
  NteractBokehResolvedPatchPayload,
  NteractBokehSessionOpenParams,
  NteractBokehSessionSnapshot,
} from "./rpc-methods";
import type { BokehSessionTransport } from "./bokeh-session-context";

export interface BokehSessionOutputBinding {
  outputId: string;
  payload: BokehSessionMimePayload;
}

interface CheckpointArtifact {
  revision: number;
  document: Record<string, unknown>;
  buffers: BokehSessionBufferRef[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Bokeh session artifact is missing ${field}`);
  }
  return value;
}

function requiredRevision(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Bokeh session artifact has an invalid ${field}`);
  }
  return value;
}

function bufferRefs(value: unknown): BokehSessionBufferRef[] {
  if (!Array.isArray(value)) {
    throw new Error("Bokeh session artifact buffers must be an array");
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("Bokeh session buffer reference must be an object");
    }
    const size = entry.size;
    const mediaType = entry.media_type;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("Bokeh session buffer reference has an invalid size");
    }
    if (typeof mediaType !== "string" || mediaType.length === 0) {
      throw new Error("Bokeh session buffer reference is missing media_type");
    }
    return {
      id: requiredString(entry, "id"),
      blob: requiredString(entry, "blob"),
      size,
      media_type: mediaType,
    };
  });
}

function patchPayload(value: unknown): BokehSessionPatchPayload | undefined {
  if (value == null) return undefined;
  if (!isRecord(value) || !isRecord(value.patch)) {
    throw new Error("Bokeh session patch payload is invalid");
  }
  return { patch: value.patch, buffers: bufferRefs(value.buffers) };
}

function patchEvent(value: unknown): BokehSessionPatchEvent {
  if (!isRecord(value)) {
    throw new Error("Bokeh session patch event must be an object");
  }
  const checkpointValue = value.checkpoint;
  let checkpoint: BokehSessionPatchEvent["checkpoint"];
  if (checkpointValue != null) {
    if (!isRecord(checkpointValue) || !isRecord(checkpointValue.document)) {
      throw new Error("Bokeh session event checkpoint is invalid");
    }
    checkpoint = {
      document: checkpointValue.document,
      buffers: bufferRefs(checkpointValue.buffers),
    };
  }
  return {
    session_id: requiredString(value, "session_id"),
    transaction_id: requiredString(value, "transaction_id"),
    base_revision: requiredRevision(value, "base_revision"),
    revision: requiredRevision(value, "revision"),
    client_patch: patchPayload(value.client_patch),
    server_patch: patchPayload(value.server_patch),
    checkpoint,
  };
}

function replayKey(session: BokehSessionState): string {
  const checkpoint = session.checkpoint;
  const tail = session.patch_tail;
  return JSON.stringify([
    session.status,
    session.head_revision,
    checkpoint?.revision ?? null,
    checkpoint?.content_ref.blob ?? null,
    tail.map((patch) => [patch.base_revision, patch.revision, patch.content_ref.blob]),
  ]);
}

function patchReply(reply: BokehSessionPatchReply): NteractBokehApplyPatchResult {
  if (reply.status === "error") {
    return {
      status: "error",
      sessionId: reply.session_id,
      transactionId: reply.transaction_id,
      revision: reply.revision,
      error: reply.error,
    };
  }
  return {
    status: reply.status,
    sessionId: reply.session_id,
    transactionId: reply.transaction_id,
    revision: reply.revision,
  };
}

export class BokehSessionBridgeManager {
  private readonly frame: IsolatedFrameHandle;
  private readonly transport: BokehSessionTransport;
  private readonly bindings = new Map<string, BokehSessionOutputBinding>();
  private runtimeSessions: Record<string, BokehSessionState> = {};
  private stateSignatures = new Map<string, string>();
  private patchQueues = new Map<string, Promise<void>>();
  private readonly unsubscribePatches: () => void;
  private disposed = false;

  constructor(options: {
    frame: IsolatedFrameHandle;
    transport: BokehSessionTransport;
    bindings: BokehSessionOutputBinding[];
  }) {
    this.frame = options.frame;
    this.transport = options.transport;
    this.setBindings(options.bindings);
    this.unsubscribePatches = this.transport.subscribePatches((broadcast) => {
      this.enqueueBroadcast(broadcast);
    });
  }

  setBindings(bindings: BokehSessionOutputBinding[]): void {
    this.bindings.clear();
    for (const binding of bindings) {
      this.bindings.set(binding.payload.session_id, binding);
    }
  }

  updateRuntimeSessions(sessions: Record<string, BokehSessionState>): void {
    this.runtimeSessions = sessions;
    this.notifyCurrentState();
  }

  notifyCurrentState(): void {
    for (const [sessionId, binding] of this.bindings) {
      const session = this.runtimeSessions[sessionId];
      const signature = session
        ? `${session.status}:${session.head_revision}:${session.output_id}`
        : `disconnected:${binding.payload.revision}:${binding.outputId}`;
      if (this.stateSignatures.get(sessionId) === signature) continue;
      this.stateSignatures.set(sessionId, signature);
      this.frame.send({
        type: "bokeh_session_state",
        payload: {
          sessionId,
          outputId: binding.outputId,
          status: session?.status ?? "disconnected",
          headRevision: session?.head_revision ?? binding.payload.revision,
        },
      });
    }
  }

  async openSession(params: NteractBokehSessionOpenParams): Promise<NteractBokehSessionSnapshot> {
    const binding = this.requireBinding(params.sessionId, params.outputId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const session = this.requireRuntimeSession(binding);
      const key = replayKey(session);
      const snapshot = await this.materializeSnapshot(params.sessionId, session);
      const current = this.runtimeSessions[params.sessionId];
      if (current && replayKey(current) === key) {
        return snapshot;
      }
    }
    throw new Error(`Bokeh session ${params.sessionId} changed while its replay was loading`);
  }

  async applyPatch(params: NteractBokehApplyPatchParams): Promise<NteractBokehApplyPatchResult> {
    const binding = this.requireBinding(params.sessionId, params.outputId);
    const session = this.requireRuntimeSession(binding);
    if (session.status !== "connected") {
      return {
        status: "error",
        sessionId: params.sessionId,
        transactionId: params.transactionId,
        revision: session.head_revision,
        error: `Bokeh session is ${session.status}`,
      };
    }
    const reply = await this.transport.applyPatch({
      sessionId: params.sessionId,
      transactionId: params.transactionId,
      baseRevision: params.baseRevision,
      patch: params.patch,
      buffers: params.buffers.map((buffer) => ({
        id: buffer.id,
        data: new Uint8Array(buffer.data),
      })),
    });
    return patchReply(reply);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribePatches();
    this.bindings.clear();
    this.patchQueues.clear();
  }

  private requireBinding(sessionId: string, outputId: string): BokehSessionOutputBinding {
    const binding = this.bindings.get(sessionId);
    if (!binding || binding.outputId !== outputId) {
      throw new Error(`Bokeh session ${sessionId} is not owned by output ${outputId}`);
    }
    return binding;
  }

  private requireRuntimeSession(binding: BokehSessionOutputBinding): BokehSessionState {
    const session = this.runtimeSessions[binding.payload.session_id];
    if (!session || session.output_id !== binding.outputId) {
      throw new Error(`Bokeh session ${binding.payload.session_id} is unavailable`);
    }
    if (!session.checkpoint) {
      throw new Error(`Bokeh session ${binding.payload.session_id} has no checkpoint`);
    }
    return session;
  }

  private async fetchJson(ref: BlobRef): Promise<unknown> {
    const response = await this.transport.fetchBlob(ref);
    if (!response.ok) {
      throw new Error(`Failed to fetch Bokeh artifact ${ref.blob}: ${response.status}`);
    }
    return response.json();
  }

  private async resolveBuffers(
    refs: BokehSessionBufferRef[],
  ): Promise<NteractBokehResolvedBuffer[]> {
    return Promise.all(
      refs.map(async (ref) => {
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

  private async resolvePatchPayload(
    payload: BokehSessionPatchPayload | undefined,
  ): Promise<NteractBokehResolvedPatchPayload | undefined> {
    if (!payload) return undefined;
    return {
      patch: payload.patch,
      buffers: await this.resolveBuffers(payload.buffers),
    };
  }

  private async resolvePatchEvent(
    event: BokehSessionPatchEvent,
  ): Promise<NteractBokehResolvedPatchEvent> {
    const checkpoint = event.checkpoint
      ? {
          revision: event.revision,
          document: event.checkpoint.document,
          buffers: await this.resolveBuffers(event.checkpoint.buffers),
        }
      : undefined;
    return {
      sessionId: event.session_id,
      transactionId: event.transaction_id,
      baseRevision: event.base_revision,
      revision: event.revision,
      clientPatch: await this.resolvePatchPayload(event.client_patch),
      serverPatch: await this.resolvePatchPayload(event.server_patch),
      checkpoint,
    };
  }

  private async materializeSnapshot(
    sessionId: string,
    session: BokehSessionState,
  ): Promise<NteractBokehSessionSnapshot> {
    const checkpointRef = session.checkpoint;
    if (!checkpointRef) {
      throw new Error(`Bokeh session ${session.output_id} has no checkpoint`);
    }
    const checkpointValue = await this.fetchJson(checkpointRef.content_ref);
    if (!isRecord(checkpointValue) || !isRecord(checkpointValue.document)) {
      throw new Error("Bokeh checkpoint artifact is invalid");
    }
    const checkpoint: CheckpointArtifact = {
      revision: requiredRevision(checkpointValue, "revision"),
      document: checkpointValue.document,
      buffers: bufferRefs(checkpointValue.buffers),
    };
    if (checkpoint.revision !== checkpointRef.revision) {
      throw new Error("Bokeh checkpoint revision does not match RuntimeStateDoc");
    }

    const tailValues = await Promise.all(
      session.patch_tail.map((entry) => this.fetchJson(entry.content_ref)),
    );
    const events = tailValues.map(patchEvent);
    let revision = checkpoint.revision;
    for (const event of events) {
      if (event.session_id !== sessionId) {
        throw new Error("Bokeh patch tail contains an event for another session");
      }
      if (event.base_revision !== revision || event.revision !== revision + 1) {
        throw new Error("Bokeh patch tail is not contiguous with its checkpoint");
      }
      revision = event.revision;
    }
    if (revision !== session.head_revision) {
      throw new Error("Bokeh replay does not reach the RuntimeStateDoc head revision");
    }

    return {
      schemaVersion: 1,
      sessionId,
      outputId: session.output_id,
      status: session.status,
      headRevision: session.head_revision,
      checkpoint: {
        revision: checkpoint.revision,
        document: checkpoint.document,
        buffers: await this.resolveBuffers(checkpoint.buffers),
      },
      patchTail: await Promise.all(events.map((event) => this.resolvePatchEvent(event))),
    };
  }

  private enqueueBroadcast(broadcast: BokehSessionPatchBroadcast): void {
    const sessionId = broadcast.patch.session_id;
    if (!this.bindings.has(sessionId) || this.disposed) return;
    const previous = this.patchQueues.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        if (this.disposed) return;
        const binding = this.bindings.get(sessionId);
        if (!binding) return;
        const event = await this.resolvePatchEvent(broadcast.patch);
        if (this.disposed || !this.bindings.has(sessionId)) return;
        this.frame.send({
          type: "bokeh_session_patch",
          payload: { outputId: binding.outputId, event },
        });
      })
      .catch((error) => {
        console.error("[bokeh-session] Failed to deliver document patch:", error);
      });
    this.patchQueues.set(sessionId, next);
  }
}
