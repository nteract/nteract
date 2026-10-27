import type { BokehSessionMimePayload } from "@/components/outputs/bokeh-mime";
import {
  NTERACT_BOKEH_APPLY_PATCH,
  NTERACT_BOKEH_SESSION_OPEN,
  NTERACT_BOKEH_SESSION_PATCH,
  NTERACT_BOKEH_SESSION_STATE,
  type NteractBokehApplyPatchResult,
  type NteractBokehResolvedBuffer,
  type NteractBokehResolvedCheckpoint,
  type NteractBokehResolvedPatchEvent,
  type NteractBokehResolvedPatchPayload,
  type NteractBokehSessionSnapshot,
  type NteractBokehSessionStateParams,
  type NteractBokehSessionStatus,
} from "@/components/isolated/bokeh-session-rpc";

interface BokehDocumentEvent {
  sync?: boolean;
  kind?: string;
  attr?: string;
  msg_type?: string;
  msg_data?: {
    event_name?: string;
  };
  value?: unknown;
  model?: {
    properties?: Record<string, { syncable?: boolean }>;
    setv?(attrs: Record<string, unknown>, options?: { sync?: boolean }): void;
  };
}

interface BokehDocument {
  resolver: unknown;
  all_roots: Array<{ id?: string }>;
  on_change(callback: (event: BokehDocumentEvent) => void): void;
  remove_on_change(callback: (event: BokehDocumentEvent) => void): void;
  create_json_patch(events: BokehDocumentEvent[]): Record<string, unknown>;
  apply_json_patch(patch: Record<string, unknown>, buffers?: Map<string, ArrayBuffer>): void;
  clear(options?: { sync?: boolean }): void;
}

interface BokehViewManager {
  clear(): void;
}

interface BokehBufferValue {
  buffer: ArrayBuffer;
}

interface BokehRuntime {
  Document: {
    from_json(
      document: Record<string, unknown>,
      events?: unknown[],
      buffers?: Map<string, ArrayBuffer>,
    ): BokehDocument;
  };
  Buffer: new (buffer: ArrayBuffer) => BokehBufferValue;
  Deserializer?: { new (resolver: unknown): BokehDeserializer; prototype: BokehDeserializer };
  addDocumentStandalone(document: BokehDocument, element: HTMLElement): Promise<BokehViewManager>;
}

interface BokehModel {
  type: string;
  properties: Record<
    string,
    { syncable: boolean; readonly: boolean; is_unset: boolean; get_value(): unknown }
  >;
  initialize_props(attrs: unknown): void;
  setv(attrs: unknown, options: { sync: boolean }): void;
}

interface BokehDeserializer {
  references: Map<string, BokehModel> & Map<string, unknown>;
  _decoding: boolean;
  _decode(value: unknown): unknown;
  _decode_object_ref(obj: { id: string; name: string; attributes?: unknown }): unknown;
  decode(value: unknown, buffers?: unknown): unknown;
}

interface BokehSessionControllerOptions {
  outputId: string;
  payload: BokehSessionMimePayload;
  container: HTMLElement;
  runtime: BokehRuntime;
  requestHost(method: string, params?: unknown): Promise<unknown>;
  subscribeHostNotification(method: string, listener: (params: unknown) => void): () => void;
  onStatus(status: NteractBokehSessionStatus, error?: string): void;
  onLayout(): void;
}

const PATCH_DEBOUNCE_MS = 50;
const RESYNC_GRACE_MS = 150;
const TRANSACTION_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSnapshot(value: unknown): value is NteractBokehSessionSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  return (
    typeof value.sessionId === "string" &&
    typeof value.outputId === "string" &&
    typeof value.headRevision === "number" &&
    isRecord(value.checkpoint) &&
    Array.isArray(value.patchTail)
  );
}

function isPatchEvent(value: unknown): value is NteractBokehResolvedPatchEvent {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    typeof value.transactionId === "string" &&
    typeof value.baseRevision === "number" &&
    typeof value.revision === "number"
  );
}

function isStateParams(value: unknown): value is NteractBokehSessionStateParams {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    typeof value.outputId === "string" &&
    typeof value.status === "string" &&
    typeof value.headRevision === "number"
  );
}

function isPatchReply(value: unknown): value is NteractBokehApplyPatchResult {
  return (
    isRecord(value) &&
    (value.status === "accepted" || value.status === "stale" || value.status === "error") &&
    typeof value.sessionId === "string" &&
    typeof value.transactionId === "string"
  );
}

// Snapshot definitions omit default-valued properties. Bokeh's existing-model
// decoder only sets explicit attributes, so complete them with the same property
// initialization used for a new model. Passing an id defers finalization and
// signal setup; the temporary model never joins a document or mounts a view.
// Python checkpoints include model-valued defaults as explicit references, so
// their existing child identities are retained rather than synthesized here.
function checkpointModelAttributes(model: BokehModel, id: string, attrs: unknown): unknown {
  const Model = model.constructor as new (attrs: { id: string }) => BokehModel;
  const defaults = new Model({ id });
  defaults.initialize_props(attrs);
  return Object.fromEntries(
    Object.entries(defaults.properties)
      .filter(([, prop]) => prop.syncable && !(prop.readonly && prop.is_unset))
      .map(([name, prop]) => [name, prop.get_value()]),
  );
}

/**
 * Run `apply` with BokehJS updating existing models only after a patch's new
 * models are finalized. Decoding a definition of a model the document already
 * has calls `setv` mid-decode, so change listeners would build views for new
 * models that are not initialized yet (UnsetValueError) and the affected
 * output would disappear. The updates still happen before the patch's events
 * are applied, in decoding order, as Bokeh intends.
 */
export function deferExistingModelUpdates<T>(
  runtime: BokehRuntime,
  apply: () => T,
  checkpoint = false,
): T {
  const proto = runtime.Deserializer?.prototype;
  if (!proto?._decode_object_ref || !proto.decode) return apply();
  const decodeObjectRef = proto._decode_object_ref;
  const decode = proto.decode;
  const deferred: Array<[{ setv(attrs: unknown, options: { sync: boolean }): void }, unknown]> = [];
  const created: Array<[Map<string, unknown>, string]> = [];
  proto._decode_object_ref = function (this: BokehDeserializer, obj) {
    const existing = this.references.get(obj.id);
    if (existing == null) {
      // Registered before its attributes are decoded; see the cleanup below.
      created.push([this.references, obj.id]);
      return decodeObjectRef.call(this, obj);
    }
    if (existing.type !== obj.name) return decodeObjectRef.call(this, obj);
    const attributes = this._decode(obj.attributes ?? {});
    deferred.push([
      existing,
      checkpoint ? checkpointModelAttributes(existing, obj.id, attributes) : attributes,
    ]);
    return existing;
  };
  proto.decode = function (this: BokehDeserializer, value, buffers) {
    const outermost = !this._decoding;
    const decoded = decode.call(this, value, buffers);
    if (outermost) {
      // Decode has finalized these models. A later listener failure must not
      // erase their references: checkpoint recovery may need to remove them.
      created.length = 0;
      for (const [model, attributes] of deferred.splice(0)) model.setv(attributes, { sync: false });
    }
    return decoded;
  };
  try {
    return apply();
  } catch (error) {
    // A failed decode leaves its new models in the document uninitialized;
    // a retry would find them by id and build views on unset properties.
    for (const [references, id] of created) references.delete(id);
    throw error;
  } finally {
    proto._decode_object_ref = decodeObjectRef;
    proto.decode = decode;
  }
}

function bufferMap(buffers: NteractBokehResolvedBuffer[]): Map<string, ArrayBuffer> {
  return new Map(buffers.map((buffer) => [buffer.id, buffer.data]));
}

function shouldSyncEvent(event: BokehDocumentEvent): boolean {
  if (event.sync === false) return false;
  if (
    event.kind === "MessageSent" &&
    event.msg_type === "bokeh_event" &&
    event.msg_data?.event_name === "document_ready"
  ) {
    return false;
  }
  if (event.kind !== "ModelChanged" || !event.attr) return true;
  return event.model?.properties?.[event.attr]?.syncable !== false;
}

export function extractBokehPatchBuffers(
  patch: Record<string, unknown>,
  BufferType: BokehRuntime["Buffer"],
  transactionId: string,
): NteractBokehResolvedBuffer[] {
  const buffers: NteractBokehResolvedBuffer[] = [];
  const visited = new WeakSet<object>();

  const replace = (value: unknown): unknown => {
    if (value instanceof BufferType) {
      const id = `${transactionId}:${buffers.length}`;
      buffers.push({ id, data: value.buffer.slice(0) });
      return { id };
    }
    if (typeof value !== "object" || value === null) return value;
    if (visited.has(value)) return value;
    visited.add(value);
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        value[index] = replace(value[index]);
      }
      return value;
    }
    if (value instanceof Map) {
      for (const [key, entry] of value) {
        value.set(key, replace(entry));
      }
      return value;
    }
    for (const [key, entry] of Object.entries(value)) {
      (value as Record<string, unknown>)[key] = replace(entry);
    }
    return value;
  };

  replace(patch);
  return buffers;
}

export class BokehSessionController {
  private readonly options: BokehSessionControllerOptions;
  private document: BokehDocument | null = null;
  private views: BokehViewManager | null = null;
  private revision = -1;
  private announcedHeadRevision = -1;
  private status: NteractBokehSessionStatus = "disconnected";
  private applyingRemote = false;
  private disposed = false;
  private localEvents: BokehDocumentEvent[] = [];
  private localTimer: number | null = null;
  private resyncTimer: number | null = null;
  private transactionTimer: number | null = null;
  private inFlightTransaction: string | null = null;
  private inFlightBaseRevision = 0;
  private inFlightNeedsReplay = false;
  private checkpointRequired = false;
  private canonicalEvents = new Map<number, NteractBokehResolvedPatchEvent>();
  private drainingCanonicalEvents = false;
  private syncPromise: Promise<void> | null = null;
  private syncGeneration = 0;
  private unsubscribePatch: (() => void) | null = null;
  private unsubscribeState: (() => void) | null = null;

  constructor(options: BokehSessionControllerOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    this.unsubscribePatch = this.options.subscribeHostNotification(
      NTERACT_BOKEH_SESSION_PATCH,
      (params) => {
        if (!isRecord(params) || params.outputId !== this.options.outputId) return;
        if (
          !isPatchEvent(params.event) ||
          params.event.sessionId !== this.options.payload.session_id
        ) {
          return;
        }
        this.canonicalEvents.set(params.event.revision, params.event);
        void this.drainCanonicalEvents();
      },
    );
    this.unsubscribeState = this.options.subscribeHostNotification(
      NTERACT_BOKEH_SESSION_STATE,
      (params) => {
        if (
          !isStateParams(params) ||
          params.outputId !== this.options.outputId ||
          params.sessionId !== this.options.payload.session_id
        ) {
          return;
        }
        this.setStatus(params.status);
        this.announcedHeadRevision = params.headRevision;
        if (
          params.status === "connected" &&
          (params.headRevision > this.revision || this.checkpointRequired)
        ) {
          this.scheduleResync();
        }
      },
    );
    await this.resync();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribePatch?.();
    this.unsubscribeState?.();
    this.unsubscribePatch = null;
    this.unsubscribeState = null;
    this.clearTimers();
    this.destroyDocument();
    this.canonicalEvents.clear();
    this.localEvents = [];
  }

  private readonly onDocumentChange = (event: BokehDocumentEvent) => {
    if (this.disposed || this.applyingRemote) return;
    if (!shouldSyncEvent(event)) return;
    if (this.status !== "connected") {
      // Widgets can still change while disconnected or awaiting a retry.
      this.checkpointRequired = true;
      return;
    }
    this.localEvents.push(event);
    this.scheduleLocalPatch();
  };

  private setStatus(status: NteractBokehSessionStatus, error?: string): void {
    this.status = status;
    this.options.onStatus(status, error);
    if (status !== "connected") {
      // Dropping the queue does not undo its optimistic changes in Bokeh.
      // A later patch tail cannot restore attributes it never mentions.
      if (this.localEvents.length > 0) this.checkpointRequired = true;
      this.localEvents = [];
      if (this.localTimer !== null) window.clearTimeout(this.localTimer);
      this.localTimer = null;
    }
  }

  private scheduleLocalPatch(): void {
    if (this.inFlightTransaction || this.localTimer !== null || this.localEvents.length === 0) {
      return;
    }
    this.localTimer = window.setTimeout(() => {
      this.localTimer = null;
      void this.flushLocalPatch();
    }, PATCH_DEBOUNCE_MS);
  }

  private async flushLocalPatch(): Promise<void> {
    if (
      this.disposed ||
      this.status !== "connected" ||
      this.inFlightTransaction ||
      !this.document ||
      this.localEvents.length === 0
    ) {
      return;
    }
    // A stale/error reply resyncs from the kernel-owned document. Do not retry
    // these optimistic events against a newer revision: replaying them would
    // change Bokeh's transaction semantics and can duplicate callbacks.
    const events = this.localEvents;
    this.localEvents = [];
    let patch: Record<string, unknown>;
    try {
      patch = this.document.create_json_patch(events);
    } catch (error) {
      this.checkpointRequired = true;
      this.setStatus("error", error instanceof Error ? error.message : String(error));
      this.scheduleResync(0);
      return;
    }

    const transactionId = crypto.randomUUID();
    const buffers = extractBokehPatchBuffers(patch, this.options.runtime.Buffer, transactionId);
    this.inFlightTransaction = transactionId;
    this.inFlightBaseRevision = this.revision;
    this.inFlightNeedsReplay = false;
    this.armTransactionTimeout();
    try {
      const rawReply = await this.options.requestHost(NTERACT_BOKEH_APPLY_PATCH, {
        sessionId: this.options.payload.session_id,
        outputId: this.options.outputId,
        transactionId,
        baseRevision: this.revision,
        patch,
        buffers,
      });
      if (!isPatchReply(rawReply) || rawReply.transactionId !== transactionId) {
        throw new Error("Bokeh patch request returned an invalid reply");
      }
      if (rawReply.status !== "accepted") {
        this.checkpointRequired = true;
        this.finishTransaction(transactionId);
        this.scheduleResync(0);
      }
    } catch (error) {
      this.checkpointRequired = true;
      this.finishTransaction(transactionId);
      this.setStatus("error", error instanceof Error ? error.message : String(error));
      this.scheduleResync();
    }
  }

  private finishTransaction(transactionId: string): void {
    if (this.inFlightTransaction !== transactionId) return;
    this.inFlightTransaction = null;
    this.inFlightNeedsReplay = false;
    if (this.transactionTimer !== null) window.clearTimeout(this.transactionTimer);
    this.transactionTimer = null;
    this.scheduleLocalPatch();
  }

  private armTransactionTimeout(): void {
    if (this.transactionTimer !== null) window.clearTimeout(this.transactionTimer);
    this.transactionTimer = window.setTimeout(() => {
      const transactionId = this.inFlightTransaction;
      if (transactionId) {
        this.checkpointRequired = true;
        this.finishTransaction(transactionId);
      }
      this.scheduleResync(0);
    }, TRANSACTION_TIMEOUT_MS);
  }

  private scheduleResync(delay = RESYNC_GRACE_MS): void {
    if (this.disposed || this.status === "disconnected" || this.status === "closed") return;
    if (this.resyncTimer !== null) window.clearTimeout(this.resyncTimer);
    this.resyncTimer = window.setTimeout(() => {
      this.resyncTimer = null;
      void this.resync();
    }, delay);
  }

  private resync(): Promise<void> {
    if (this.syncPromise) return this.syncPromise;
    const generation = ++this.syncGeneration;
    this.syncPromise = this.options
      .requestHost(NTERACT_BOKEH_SESSION_OPEN, {
        sessionId: this.options.payload.session_id,
        outputId: this.options.outputId,
      })
      .then(async (value) => {
        if (this.disposed || generation !== this.syncGeneration) return;
        if (!isSnapshot(value)) {
          throw new Error("Bokeh session host returned an invalid snapshot");
        }
        await this.installSnapshot(value);
      })
      .catch((error) => {
        if (this.disposed) return;
        this.setStatus("error", error instanceof Error ? error.message : String(error));
        this.scheduleResync(1_000);
      })
      .finally(() => {
        if (generation === this.syncGeneration) {
          this.syncPromise = null;
          void this.drainCanonicalEvents();
        }
      });
    return this.syncPromise;
  }

  private async installSnapshot(snapshot: NteractBokehSessionSnapshot): Promise<void> {
    if (
      snapshot.sessionId !== this.options.payload.session_id ||
      snapshot.outputId !== this.options.outputId
    ) {
      throw new Error("Bokeh snapshot does not belong to this output");
    }
    const catchUp = this.canCatchUp(snapshot);
    if (!catchUp) await this.installCheckpoint(snapshot.checkpoint);
    for (const event of snapshot.patchTail) {
      if (catchUp && event.revision <= this.revision) continue;
      if (event.baseRevision !== this.revision || event.revision !== this.revision + 1) {
        throw new Error("Bokeh snapshot patch tail is not contiguous");
      }
      await this.applyCanonicalEvent(event, true);
    }
    if (this.revision !== snapshot.headRevision) {
      throw new Error("Bokeh snapshot does not reach its advertised head revision");
    }
    this.setStatus(snapshot.status);
    this.announcedHeadRevision = snapshot.headRevision;
    this.cancelSatisfiedResync();
    for (const revision of this.canonicalEvents.keys()) {
      if (revision <= this.revision) this.canonicalEvents.delete(revision);
    }
    this.options.onLayout();
  }

  /**
   * Whether the mounted document can reach the snapshot head by applying just
   * the patch tail. Otherwise the checkpoint is reconciled first, which also
   * overwrites rejected local values and repairs partially applied mutations.
   */
  private canCatchUp(snapshot: NteractBokehSessionSnapshot): boolean {
    if (!this.document || this.checkpointRequired) return false;
    if (snapshot.checkpoint.revision > this.revision || snapshot.headRevision < this.revision) {
      return false;
    }
    return (
      this.revision === snapshot.checkpoint.revision ||
      snapshot.patchTail.some((event) => event.revision === this.revision)
    );
  }

  private async installCheckpoint(checkpoint: NteractBokehResolvedCheckpoint): Promise<void> {
    if (this.document) {
      this.reconcileCheckpoint(this.document, checkpoint);
    } else {
      await this.mountDocument(checkpoint);
    }
    // Reconciliation replaced optimistic values, including a pending request's.
    // Its eventual acknowledgement must apply the accepted client patch again.
    if (this.inFlightTransaction) this.inFlightNeedsReplay = true;
    this.checkpointRequired = false;
  }

  /**
   * Bring the mounted document to a checkpoint in place, keeping every view
   * mounted.
   */
  private reconcileCheckpoint(
    document: BokehDocument,
    checkpoint: NteractBokehResolvedCheckpoint,
  ): void {
    const roots = Array.isArray(checkpoint.document.roots)
      ? (checkpoint.document.roots as Array<{ id?: string }>)
      : [];
    const rootIds = new Set(roots.map((root) => root.id));
    for (const rootId of this.options.payload.root_ids) {
      if (!rootIds.has(rootId)) throw new Error(`Bokeh document is missing root ${rootId}`);
    }
    const events: Record<string, unknown>[] = [
      ...roots.map((root) => ({ kind: "RootAdded", model: root })),
      ...document.all_roots
        .filter((root) => !rootIds.has(root.id))
        .map((root) => ({ kind: "RootRemoved", model: { id: root.id } })),
    ];
    if (typeof checkpoint.document.title === "string") {
      events.push({ kind: "TitleChanged", title: checkpoint.document.title });
    }
    this.applyingRemote = true;
    try {
      if (checkpoint.document.defs != null) {
        const Deserializer = this.options.runtime.Deserializer;
        if (!Deserializer) throw new Error("Bokeh model definition decoder is unavailable");
        // Match Document.from_json: register classes before decoding their roots.
        new Deserializer(document.resolver).decode(
          checkpoint.document.defs,
          bufferMap(checkpoint.buffers),
        );
      }
      deferExistingModelUpdates(
        this.options.runtime,
        () => document.apply_json_patch({ events }, bufferMap(checkpoint.buffers)),
        true,
      );
      this.reapplyPendingLocalChanges();
      this.revision = checkpoint.revision;
    } catch (error) {
      // Bokeh can mutate models before a decoder or change listener throws.
      // Restore a checkpoint before replaying any more canonical patches.
      this.checkpointRequired = true;
      throw error;
    } finally {
      this.applyingRemote = false;
    }
  }

  private async mountDocument(checkpoint: NteractBokehResolvedCheckpoint): Promise<void> {
    this.options.container.replaceChildren();
    this.applyingRemote = true;
    try {
      const document = this.options.runtime.Document.from_json(
        checkpoint.document,
        [],
        bufferMap(checkpoint.buffers),
      );
      const rootIds = new Set(document.all_roots.map((root) => root.id));
      for (const rootId of this.options.payload.root_ids) {
        if (!rootIds.has(rootId)) {
          throw new Error(`Bokeh document is missing root ${rootId}`);
        }
      }
      this.document = document;
      this.views = await this.options.runtime.addDocumentStandalone(
        document,
        this.options.container,
      );
      document.on_change(this.onDocumentChange);
      this.revision = checkpoint.revision;
    } catch (error) {
      this.destroyDocument();
      this.options.container.replaceChildren();
      throw error;
    } finally {
      this.applyingRemote = false;
    }
  }

  private async drainCanonicalEvents(): Promise<void> {
    if (!this.document || this.syncPromise || this.disposed || this.drainingCanonicalEvents) {
      return;
    }
    this.drainingCanonicalEvents = true;
    try {
      while (this.canonicalEvents.has(this.revision + 1)) {
        const event = this.canonicalEvents.get(this.revision + 1)!;
        this.canonicalEvents.delete(this.revision + 1);
        await this.applyCanonicalEvent(event, false);
      }
      const nextRevision = Math.min(...this.canonicalEvents.keys());
      if (Number.isFinite(nextRevision) && nextRevision > this.revision + 1) {
        this.scheduleResync();
      }
    } catch (error) {
      if (!this.disposed) {
        this.setStatus("error", error instanceof Error ? error.message : String(error));
        this.scheduleResync(0);
      }
    } finally {
      this.drainingCanonicalEvents = false;
    }
  }

  private async applyCanonicalEvent(
    event: NteractBokehResolvedPatchEvent,
    replay: boolean,
  ): Promise<void> {
    if (event.sessionId !== this.options.payload.session_id) return;
    if (event.baseRevision !== this.revision || event.revision !== this.revision + 1) {
      this.scheduleResync(0);
      return;
    }
    if (event.checkpoint) {
      await this.installCheckpoint(event.checkpoint);
    } else {
      const ownTransaction = !replay && event.transactionId === this.inFlightTransaction;
      // The kernel applies a patch made against an older revision on top of
      // the events in between, which may have overwritten the optimistic
      // values here, so they have to be applied again in kernel order.
      const replayClientPatch =
        !ownTransaction ||
        this.inFlightNeedsReplay ||
        event.baseRevision !== this.inFlightBaseRevision;
      this.applyingRemote = true;
      try {
        if (replayClientPatch && event.clientPatch) {
          this.applyPatchPayload(event.clientPatch);
        }
        if (event.serverPatch) this.applyPatchPayload(event.serverPatch);
        this.reapplyPendingLocalChanges();
        this.revision = event.revision;
      } catch (error) {
        // A failed patch may already have streamed data or changed models.
        // Retrying its tail against that partial state would apply it twice.
        this.checkpointRequired = true;
        throw error;
      } finally {
        this.applyingRemote = false;
      }
    }
    this.cancelSatisfiedResync();
    this.finishTransaction(event.transactionId);
    this.options.onLayout();
  }

  /**
   * Kernel events can overwrite values the browser changed but has not sent
   * yet. The kernel applies those changes after the event, so restore them
   * here; otherwise the browser keeps the kernel's older value while the
   * kernel ends up with the browser's.
   */
  private reapplyPendingLocalChanges(): void {
    for (const event of this.localEvents) {
      if (event.kind === "ModelChanged" && event.attr && event.model?.setv) {
        event.model.setv({ [event.attr]: event.value }, { sync: false });
      }
    }
  }

  private applyPatchPayload(payload: NteractBokehResolvedPatchPayload): void {
    if (!this.document) throw new Error("Bokeh document is not mounted");
    const document = this.document;
    deferExistingModelUpdates(this.options.runtime, () =>
      document.apply_json_patch(payload.patch, bufferMap(payload.buffers)),
    );
  }

  private cancelSatisfiedResync(): void {
    if (
      this.checkpointRequired ||
      this.revision < this.announcedHeadRevision ||
      this.resyncTimer === null
    ) {
      return;
    }
    window.clearTimeout(this.resyncTimer);
    this.resyncTimer = null;
  }

  private destroyDocument(): void {
    if (this.document) {
      this.document.remove_on_change(this.onDocumentChange);
    }
    this.views?.clear();
    this.views = null;
    this.document?.clear({ sync: false });
    this.document = null;
  }

  private clearTimers(): void {
    if (this.localTimer !== null) window.clearTimeout(this.localTimer);
    if (this.resyncTimer !== null) window.clearTimeout(this.resyncTimer);
    if (this.transactionTimer !== null) window.clearTimeout(this.transactionTimer);
    this.localTimer = null;
    this.resyncTimer = null;
    this.transactionTimer = null;
  }
}

export type { BokehRuntime, BokehSessionControllerOptions };
