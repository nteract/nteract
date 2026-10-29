import type { BokehSessionMimePayload } from "@/components/outputs/bokeh-mime";
import {
  NTERACT_BOKEH_APPLY_PATCH,
  NTERACT_BOKEH_SESSION_DATA,
  NTERACT_BOKEH_SESSION_DOC,
  NTERACT_BOKEH_SESSION_EVENTS,
  NTERACT_BOKEH_SESSION_OPEN,
  NTERACT_BOKEH_SESSION_STATE,
  NTERACT_BOKEH_SET_PROPS,
  type NteractBokehApplyPatchResult,
  type NteractBokehColumnData,
  type NteractBokehDocUpdate,
  type NteractBokehModelState,
  type NteractBokehPropOrigin,
  type NteractBokehResolvedBuffer,
  type NteractBokehResolvedEvents,
  type NteractBokehSessionDataParams,
  type NteractBokehSessionDataResult,
  type NteractBokehSessionOpenResult,
  type NteractBokehSessionStatus,
  type NteractBokehSetPropsResult,
} from "@/components/isolated/bokeh-session-rpc";

/** The parts of a BokehJS `Property` the adapter reads. */
interface BokehProperty {
  syncable?: boolean;
  readonly?: boolean;
  may_have_refs?: boolean;
  default_value?(obj: unknown): unknown;
  kind?: { coerce?(value: unknown): unknown };
}

interface BokehModel {
  id: string;
  type: string;
  properties?: Record<string, BokehProperty>;
  data?: unknown;
  stream_to?: unknown;
  setv(attrs: Record<string, unknown>, options: { sync: boolean }): void;
}

interface BokehDocumentEvent {
  sync?: boolean;
  kind?: string;
  attr?: string;
  msg_type?: string;
  msg_data?: {
    event_name?: string;
  };
  value?: unknown;
  model?: BokehModel;
}

interface BokehDocument {
  all_roots: Array<{ id?: string }>;
  readonly all_models?: Iterable<BokehModel & { ref?(): unknown }>;
  get_model_by_id?(id: string): BokehModel | null;
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
  Serializer?: new (options?: { references?: Map<unknown, unknown>; binary?: boolean }) => {
    encode(value: unknown): unknown;
  };
  Deserializer?: { prototype: BokehDeserializer };
  addDocumentStandalone(document: BokehDocument, element: HTMLElement): Promise<BokehViewManager>;
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
  /** A live session this connection may not write (a viewer). */
  onReadOnly?(readOnly: boolean): void;
  onLayout(): void;
}

type JsonPatchEvent = Record<string, unknown>;

/** Batches local property writes, as `widget-update-manager.ts` does. */
const WRITE_DEBOUNCE_MS = 50;
/**
 * How long written values suppress matching document changes after a flush:
 * the round trip through the daemon, the kernel and back.
 */
const ECHO_GRACE_MS = 500;
const OWN_TRANSACTION_LIMIT = 64;

/** The payload's self-contained state from the last save or freeze, if any. */
function savedDocument(payload: BokehSessionMimePayload): Record<string, unknown> | null {
  const snapshot: unknown = payload.snapshot;
  if (!isRecord(snapshot) || !isRecord(snapshot.document)) return null;
  const buffers = snapshot.buffers;
  return Array.isArray(buffers) && buffers.length > 0 ? null : snapshot.document;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function structuralEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => structuralEqual(item, b[index]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao);
  return (
    keys.length === Object.keys(bo).length &&
    keys.every(
      (key) => Object.prototype.hasOwnProperty.call(bo, key) && structuralEqual(ao[key], bo[key]),
    )
  );
}

function isColumnar(model: BokehModel | null | undefined): boolean {
  return typeof model?.stream_to === "function";
}

let warnedMissingDeserializerHooks = false;

/**
 * Add the BokehJS default for every property a full-state definition omits.
 * Python only serializes properties it has set to a non-default value, so an
 * omitted property is canonically at its default. Reference-valued
 * properties are left alone so a reset cannot detach models, and columnar
 * `data` is reconciled separately from `columns/`.
 */
function withOmittedDefaults(model: BokehModel, attributes: unknown): unknown {
  if (!isRecord(attributes)) return attributes;
  for (const [attr, prop] of Object.entries(model.properties ?? {})) {
    if (attr in attributes || !prop.syncable || prop.readonly || prop.may_have_refs) continue;
    if (attr === "data" && isColumnar(model)) continue;
    const value = prop.default_value?.(model);
    // Required properties return BokehJS's `unset` symbol.
    if (value === undefined || typeof value === "symbol") continue;
    attributes[attr] = prop.kind?.coerce ? prop.kind.coerce(value) : value;
  }
  return attributes;
}

/**
 * Run `apply` with BokehJS updating existing models only after a patch's new
 * models are finalized. Decoding a definition of a model the document already
 * has calls `setv` mid-decode, so change listeners would build views for new
 * models that are not initialized yet (UnsetValueError) and the affected
 * output would disappear. The updates still happen before the patch's events
 * are applied, in decoding order, as Bokeh intends.
 *
 * With `fullState`, each existing model's definition is treated as its whole
 * state, so properties it omits are reset to their defaults.
 */
export function deferExistingModelUpdates<T>(
  runtime: BokehRuntime,
  apply: () => T,
  { fullState = false }: { fullState?: boolean } = {},
): T {
  const proto = runtime.Deserializer?.prototype;
  if (!proto?._decode_object_ref || !proto.decode) {
    if (!warnedMissingDeserializerHooks) {
      warnedMissingDeserializerHooks = true;
      console.warn("BokehJS Deserializer hooks are unavailable; applying patches unmodified");
    }
    return apply();
  }
  const decodeObjectRef = proto._decode_object_ref;
  const decode = proto.decode;
  const deferred: Array<[BokehModel, unknown]> = [];
  const created: Array<[Map<string, unknown>, string]> = [];
  proto._decode_object_ref = function (this: BokehDeserializer, obj) {
    const existing = this.references.get(obj.id);
    if (existing == null) {
      // Registered before its attributes are decoded; see the cleanup below.
      created.push([this.references, obj.id]);
      return decodeObjectRef.call(this, obj);
    }
    if (existing.type !== obj.name) return decodeObjectRef.call(this, obj);
    deferred.push([existing, this._decode(obj.attributes ?? {})]);
    return existing;
  };
  proto.decode = function (this: BokehDeserializer, value, buffers) {
    if (this._decoding) return decode.call(this, value, buffers);
    let decoded: unknown;
    try {
      decoded = decode.call(this, value, buffers);
    } catch (error) {
      // A failed decode leaves its new models in the document uninitialized;
      // a retry would find them by id and build views on unset properties.
      for (const [references, id] of created.splice(0)) references.delete(id);
      deferred.length = 0;
      throw error;
    }
    created.length = 0;
    for (const [model, attributes] of deferred.splice(0)) {
      const attrs = fullState ? withOmittedDefaults(model, attributes) : attributes;
      model.setv(attrs as Record<string, unknown>, { sync: false });
    }
    return decoded;
  };
  try {
    return apply();
  } finally {
    proto._decode_object_ref = decodeObjectRef;
    proto.decode = decode;
  }
}

/**
 * Inlines model definitions at their first reference. Values are Bokeh
 * encodings in which references are `{"id": ...}`; only ids in `models` are
 * expanded, every other reference stays a reference.
 */
export class ModelExpander {
  private readonly emitted = new Set<string>();

  constructor(private readonly models: Record<string, NteractBokehModelState>) {}

  has(id: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.models, id);
  }

  model(id: string, omit?: (attr: string) => boolean): Record<string, unknown> {
    if (this.emitted.has(id) || !this.has(id)) return { id };
    this.emitted.add(id);
    const state = this.models[id];
    const attributes: Record<string, unknown> = {};
    for (const [attr, value] of Object.entries(state.props)) {
      if (omit?.(attr)) continue;
      attributes[attr] = this.value(value);
    }
    return { type: "object", name: state.type, id, attributes };
  }

  value(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.value(item));
    if (!isRecord(value)) return value;
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof value.id === "string" && this.has(value.id)) {
      return this.model(value.id);
    }
    return Object.fromEntries(keys.map((key) => [key, this.value(value[key])]));
  }
}

function columnsMap(columns: Record<string, NteractBokehColumnData>): Record<string, unknown> {
  return {
    type: "map",
    entries: Object.entries(columns).map(([name, column]) => [name, column.data]),
  };
}

/** Bokeh DocJson for a full update: roots depth-first, columns inlined. */
export function materializeDocJson(
  update: NteractBokehDocUpdate,
  columns: Record<string, Record<string, NteractBokehColumnData>>,
): Record<string, unknown> {
  const models: Record<string, NteractBokehModelState> = {};
  for (const [id, model] of Object.entries(update.models)) {
    const sourceColumns = columns[id];
    models[id] = sourceColumns
      ? { ...model, props: { ...model.props, data: columnsMap(sourceColumns) } }
      : model;
  }
  const expander = new ModelExpander(models);
  const meta = update.meta;
  return {
    ...meta?.docExtras,
    version: meta?.bokehVersion,
    ...(meta?.title != null ? { title: meta.title } : {}),
    roots: (meta?.rootIds ?? []).filter((id) => expander.has(id)).map((id) => expander.model(id)),
  };
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

interface PendingProp {
  modelId: string;
  attr: string;
  value: unknown;
  encoded: string;
}

/** A local stream/patch, matched to the launcher's `echo_of` by its index in the request patch. */
interface OwnDataEdit {
  sourceId: string;
  index: number;
  /** The source's data version the edit was applied on; undefined if unknown. */
  baseVersion: number | undefined;
}

function propKey(modelId: string, attr: string): string {
  return `${modelId}\u0000${attr}`;
}

function maxVersion(columns: Record<string, { version: number } | null>, floor = -1): number {
  let version = floor;
  for (const column of Object.values(columns)) {
    if (column && column.version > version) version = column.version;
  }
  return version;
}

/**
 * Keeps a mounted Bokeh document in step with its session document.
 *
 * The host follows the session's Automerge document and sends `full` and
 * `delta` updates; this turns them into Bokeh JSON patches. Column data
 * follows versioned one-off events, falling back to the `columns/` blobs and
 * the retained tail on a version gap. Local property changes are written
 * back through the host; other local events go out as one-off messages.
 */
export class BokehSessionController {
  private readonly options: BokehSessionControllerOptions;
  private document: BokehDocument | null = null;
  private views: BokehViewManager | null = null;
  private status: NteractBokehSessionStatus = "disconnected";
  private live = false;
  /** Whether the host lets this frame write; false for viewer connections. */
  private hostWritable = true;
  private readOnlyShown: boolean | null = null;
  /** Epoch of the session state the mounted document shows; null before the first full update. */
  private epoch: number | null = null;
  /** A failed apply left the document out of step; the next full update reconciles. */
  private dirty = false;
  private applyingRemote = false;
  private disposed = false;
  /** Data version per ColumnDataSource; absent while unknown. */
  private readonly versions = new Map<string, number>();
  /** `ref_props` per session document model; absent models are not writable. */
  private readonly refProps = new Map<string, Set<string>>();
  /** Data edits this frame applied optimistically, by transaction, until their echo arrives. */
  private readonly ownTransactions = new Map<string, OwnDataEdit>();
  private readonly pendingProps = new Map<string, PendingProp>();
  /** Values written during the echo grace window, per property. */
  private readonly trail = new Map<string, unknown[]>();
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private inbound: Promise<void> = Promise.resolve();
  private outbound: Promise<void> = Promise.resolve();
  private reopening = false;
  private opened = false;
  private readonly unsubscribers: Array<() => void> = [];

  constructor(options: BokehSessionControllerOptions) {
    this.options = options;
  }

  private get sessionId(): string {
    return this.options.payload.session_id;
  }

  async start(): Promise<void> {
    const subscribe = (method: string, listener: (params: Record<string, unknown>) => void) => {
      this.unsubscribers.push(
        this.options.subscribeHostNotification(method, (params) => {
          if (!isRecord(params) || params.outputId !== this.options.outputId) return;
          listener(params);
        }),
      );
    };
    subscribe(NTERACT_BOKEH_SESSION_STATE, (params) => {
      if (params.sessionId !== this.sessionId || typeof params.status !== "string") return;
      if (typeof params.writable === "boolean") this.hostWritable = params.writable;
      this.setStatus(params.status as NteractBokehSessionStatus);
      // The record can arrive after the frame opened, and a new host bridge
      // (after a transport reconnect) does not follow the session until the
      // frame opens it again.
      if (params.status === "connected" && this.opened && (!this.live || params.live === false)) {
        this.reopen();
      }
    });
    subscribe(NTERACT_BOKEH_SESSION_DOC, (params) => {
      const update = params.update as NteractBokehDocUpdate | undefined;
      if (!isRecord(update) || update.sessionId !== this.sessionId) return;
      this.enqueue(() => this.applyDocUpdate(update), update.kind === "full");
    });
    subscribe(NTERACT_BOKEH_SESSION_EVENTS, (params) => {
      const events = params.events as NteractBokehResolvedEvents | undefined;
      if (!isRecord(events) || events.sessionId !== this.sessionId) return;
      this.enqueue(() => this.applyEvents(events), false);
    });
    this.enqueue(() => this.open(), true);
    await this.inbound;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.clearLocalState();
    this.destroyDocument();
  }

  // ── Inbound ─────────────────────────────────────────────────────────

  /**
   * Run inbound work in arrival order. A failed incremental step marks the
   * document out of step and asks the host for a full update.
   */
  private enqueue(task: () => Promise<void> | void, full: boolean): void {
    this.inbound = this.inbound.then(async () => {
      if (this.disposed) return;
      try {
        await task();
      } catch (error) {
        if (this.disposed) return;
        console.error("[bokeh-session] Failed to apply a session update:", error);
        this.dirty = true;
        if (full || !this.document) {
          this.setStatus("error", errorMessage(error));
        } else {
          this.reopen();
        }
      }
    });
  }

  private async open(): Promise<void> {
    let result: NteractBokehSessionOpenResult | null = null;
    try {
      result = (await this.options.requestHost(NTERACT_BOKEH_SESSION_OPEN, {
        sessionId: this.sessionId,
        outputId: this.options.outputId,
      })) as NteractBokehSessionOpenResult;
    } catch (error) {
      // Hosts without session support still render the payload read-only.
      console.warn("[bokeh-session] Session is not available:", errorMessage(error));
    }
    this.opened = true;
    this.live = result?.live === true;
    this.hostWritable = result?.writable !== false;
    this.setStatus(result?.status ?? "disconnected");
    if (this.document) return;
    const saved = this.live ? null : savedDocument(this.options.payload);
    if (saved) {
      await this.mount(saved, new Map());
    } else if (this.options.payload.buffers.length === 0) {
      await this.mount(this.options.payload.document, new Map());
    } else if (!this.live) {
      throw new Error("Bokeh output has unresolved buffers and no live session");
    }
    // A live payload with out-of-band buffers mounts from the first full update.
  }

  /** Re-subscribe; the host answers with a full update of the current epoch. */
  private reopen(): void {
    if (this.reopening || this.disposed) return;
    this.reopening = true;
    this.enqueue(async () => {
      this.reopening = false;
      await this.open();
    }, true);
  }

  private async applyDocUpdate(update: NteractBokehDocUpdate): Promise<void> {
    if (update.kind === "full") {
      await this.applyFull(update);
    } else if (this.document && this.epoch === update.epoch && !this.dirty) {
      await this.applyDelta(update);
    }
    this.options.onLayout();
  }

  private trackRefProps(update: NteractBokehDocUpdate): void {
    if (update.kind === "full") this.refProps.clear();
    for (const id of update.removed) this.refProps.delete(id);
    for (const [id, model] of Object.entries(update.models)) {
      this.refProps.set(id, new Set(model.refProps));
    }
  }

  private async applyFull(update: NteractBokehDocUpdate): Promise<void> {
    if (this.epoch !== null && update.epoch < this.epoch) return;
    this.trackRefProps(update);
    if (this.document && update.canSwitch && !this.dirty && this.epoch !== null) {
      this.epoch = update.epoch;
      return;
    }
    const sources: Record<string, string[] | null> = {};
    let tail = false;
    for (const [sourceId, refs] of Object.entries(update.columns)) {
      const known = this.versions.get(sourceId);
      if (known === undefined || !this.document) {
        sources[sourceId] = null;
        tail = true;
        continue;
      }
      const names = Object.entries(refs)
        .filter(([, ref]) => ref !== null && ref.version > known)
        .map(([name]) => name);
      if (names.length > 0) sources[sourceId] = names;
    }
    const loaded = await this.loadData(sources, tail);
    if (this.disposed) return;

    const catchUp = () => {
      for (const [sourceId, refs] of Object.entries(update.columns)) {
        const version = Math.max(
          maxVersion(refs, this.versions.get(sourceId)),
          maxVersion(loaded?.columns[sourceId] ?? {}),
        );
        this.versions.set(sourceId, version);
      }
      for (const id of this.versions.keys()) {
        if (!(id in update.models)) this.versions.delete(id);
      }
      if (loaded) this.replayTail(loaded.events, new Set(Object.keys(sources)));
    };
    if (!this.document) {
      // Replay the tail before views exist: some views (Panel's Tabulator)
      // drop data changes that arrive before they finish building.
      await this.mount(materializeDocJson(update, loaded?.columns ?? {}), new Map(), catchUp);
    } else {
      this.reconcile(this.document, update, sources, loaded);
      catchUp();
    }
    this.epoch = update.epoch;
    this.dirty = false;
  }

  /**
   * Bring the mounted document to a full update in place, keeping every view
   * mounted. Properties the update omits reset to their defaults.
   */
  private reconcile(
    document: BokehDocument,
    update: NteractBokehDocUpdate,
    sources: Record<string, string[] | null>,
    loaded: NteractBokehSessionDataResult | null,
  ): void {
    const expander = new ModelExpander(update.models);
    const rootIds = update.meta?.rootIds ?? [];
    for (const rootId of this.options.payload.root_ids) {
      if (!rootIds.includes(rootId)) throw new Error(`Bokeh document is missing root ${rootId}`);
    }
    const events: JsonPatchEvent[] = [
      ...rootIds
        .filter((id) => expander.has(id))
        .map((id) => ({ kind: "RootAdded", model: expander.model(id) })),
      ...document.all_roots
        .filter((root) => !root.id || !rootIds.includes(root.id))
        .map((root) => ({ kind: "RootRemoved", model: { id: root.id } })),
    ];
    if (update.meta?.title != null) events.push({ kind: "TitleChanged", title: update.meta.title });
    this.applyingRemote = true;
    try {
      deferExistingModelUpdates(this.options.runtime, () => document.apply_json_patch({ events }), {
        fullState: true,
      });
      for (const [sourceId, names] of Object.entries(sources)) {
        const columns = loaded?.columns[sourceId] ?? {};
        const current = Object.keys(update.columns[sourceId] ?? {});
        this.applyColumns(document, sourceId, columns, names === null ? "replace" : "merge");
        if (names !== null) this.removeColumns(document, sourceId, current, true);
      }
      this.reapplyPendingLocalChanges(document);
    } finally {
      this.applyingRemote = false;
    }
  }

  private async applyDelta(update: NteractBokehDocUpdate): Promise<void> {
    const document = this.document;
    if (!document) return;
    this.trackRefProps(update);
    const sources: Record<string, string[] | null> = {};
    const removed: Record<string, string[]> = {};
    for (const [sourceId, refs] of Object.entries(update.columns)) {
      const known = this.versions.get(sourceId) ?? -1;
      const names: string[] = [];
      for (const [name, ref] of Object.entries(refs)) {
        if (ref === null) (removed[sourceId] ??= []).push(name);
        else if (ref.version > known) names.push(name);
      }
      if (names.length > 0) sources[sourceId] = names;
    }
    const loaded = await this.loadData(sources, false);
    if (this.disposed || this.document !== document) return;

    const expander = new ModelExpander(update.models);
    const events: JsonPatchEvent[] = [];
    for (const [id, props] of Object.entries(update.props)) {
      if (!this.hasModel(document, id)) continue;
      for (const [attr, value] of Object.entries(props)) {
        if (this.keepsLocalValue(id, attr, value, update.propOrigins?.[id]?.[attr])) continue;
        events.push({ kind: "ModelChanged", model: { id }, attr, new: expander.value(value) });
      }
    }
    if (update.meta) {
      const current = document.all_roots.map((root) => root.id);
      for (const id of update.meta.rootIds) {
        if (current.includes(id)) continue;
        if (expander.has(id) || this.hasModel(document, id)) {
          events.push({ kind: "RootAdded", model: expander.model(id) });
        }
      }
      for (const id of current) {
        if (id && !update.meta.rootIds.includes(id)) {
          events.push({ kind: "RootRemoved", model: { id } });
        }
      }
      if (update.meta.title != null) {
        events.push({ kind: "TitleChanged", title: update.meta.title });
      }
    }

    this.applyingRemote = true;
    try {
      if (events.length > 0) {
        deferExistingModelUpdates(this.options.runtime, () =>
          document.apply_json_patch({ events }),
        );
      }
      for (const [sourceId, columns] of Object.entries(loaded?.columns ?? {})) {
        this.applyColumns(document, sourceId, columns, "merge");
        this.versions.set(sourceId, maxVersion(columns, this.versions.get(sourceId)));
      }
      for (const [sourceId, names] of Object.entries(removed)) {
        this.removeColumns(document, sourceId, names, false);
      }
    } finally {
      this.applyingRemote = false;
    }
    for (const id of update.removed) this.versions.delete(id);
  }

  private async applyEvents(events: NteractBokehResolvedEvents): Promise<void> {
    const document = this.document;
    // Before the first full update the initial load fetches the tail.
    if (!document || this.epoch === null || this.dirty) return;
    let ownEdit = this.ownTransactions.get(events.transactionId);
    const patchEvents: JsonPatchEvent[] = [];
    const removals: Array<[string, string[]]> = [];
    const gaps = new Set<string>();
    for (const event of events.dataEvents) {
      const sourceId = event.source_id;
      if (ownEdit?.sourceId === sourceId && event.kind === "ColumnDataChanged") {
        // A callback replaced the source in the edit's transaction; the
        // launcher folded the edit into this replacement, so no echo follows.
        this.ownTransactions.delete(events.transactionId);
        ownEdit = undefined;
      }
      const version = this.versions.get(sourceId);
      if (gaps.has(sourceId) || version === undefined) continue;
      if (!this.hasModel(document, sourceId)) {
        this.versions.delete(sourceId);
        continue;
      }
      if (event.new_version <= version) continue;
      if (event.base_version !== version) {
        gaps.add(sourceId);
        continue;
      }
      this.versions.set(sourceId, event.new_version);
      if (event.kind === "ColumnDataChanged") {
        patchEvents.push(columnDataChanged(sourceId, event.columns, "merge"));
        if (event.columns_removed.length > 0) removals.push([sourceId, event.columns_removed]);
      } else if (ownEdit?.sourceId === sourceId && event.echo_of === ownEdit.index) {
        // The launcher's re-emit of this frame's edit, applied when it was
        // made. Events Python callbacks derived in the same transaction carry
        // no `echo_of` and are applied like any other.
        const appliedOn = ownEdit.baseVersion;
        this.ownTransactions.delete(events.transactionId);
        ownEdit = undefined;
        // Another event for the source was versioned before the edit, so the
        // optimistic edit sits on the wrong base (a different row once a
        // rollover shifted it): take the kernel's state instead.
        if (appliedOn !== event.base_version) gaps.add(sourceId);
      } else {
        patchEvents.push(dataPatchEvent(event));
      }
    }
    for (const message of events.messages) {
      patchEvents.push({
        kind: "MessageSent",
        msg_type: message.msg_type,
        msg_data: message.msg_data,
      });
    }
    this.applyingRemote = true;
    try {
      if (patchEvents.length > 0) {
        document.apply_json_patch({ events: patchEvents }, bufferMap(events.buffers));
      }
      for (const [sourceId, names] of removals) {
        this.removeColumns(document, sourceId, names, false);
      }
    } finally {
      this.applyingRemote = false;
    }
    for (const sourceId of gaps) await this.reloadSource(sourceId);
    if (patchEvents.length > 0 || gaps.size > 0) this.options.onLayout();
  }

  /** A missed data event: reload the source from its blobs and the retained tail. */
  private async reloadSource(sourceId: string): Promise<void> {
    const loaded = await this.loadData({ [sourceId]: null }, true);
    const document = this.document;
    if (!loaded || !document || this.disposed) return;
    const columns = loaded.columns[sourceId] ?? {};
    this.applyingRemote = true;
    try {
      this.applyColumns(document, sourceId, columns, "replace");
    } finally {
      this.applyingRemote = false;
    }
    this.versions.set(sourceId, maxVersion(columns));
    this.replayTail(loaded.events, new Set([sourceId]));
  }

  /** Apply retained events in order, without the own-patch shortcut. */
  private replayTail(tail: NteractBokehResolvedEvents[], sources: Set<string>): void {
    const document = this.document;
    if (!document) return;
    for (const events of tail) {
      const patchEvents: JsonPatchEvent[] = [];
      for (const event of events.dataEvents) {
        if (!sources.has(event.source_id)) continue;
        if (this.versions.get(event.source_id) !== event.base_version) continue;
        this.versions.set(event.source_id, event.new_version);
        patchEvents.push(
          event.kind === "ColumnDataChanged"
            ? columnDataChanged(event.source_id, event.columns, "merge")
            : dataPatchEvent(event),
        );
      }
      if (patchEvents.length === 0) continue;
      this.applyingRemote = true;
      try {
        document.apply_json_patch({ events: patchEvents }, bufferMap(events.buffers));
      } finally {
        this.applyingRemote = false;
      }
    }
  }

  private async loadData(
    sources: Record<string, string[] | null>,
    tail: boolean,
  ): Promise<NteractBokehSessionDataResult | null> {
    if (Object.keys(sources).length === 0) return null;
    const params: NteractBokehSessionDataParams = {
      sessionId: this.sessionId,
      outputId: this.options.outputId,
      sources,
      tail,
    };
    return (await this.options.requestHost(
      NTERACT_BOKEH_SESSION_DATA,
      params,
    )) as NteractBokehSessionDataResult;
  }

  private applyColumns(
    document: BokehDocument,
    sourceId: string,
    columns: Record<string, NteractBokehColumnData>,
    mode: "replace" | "merge",
  ): void {
    if (!this.hasModel(document, sourceId)) return;
    if (mode === "merge" && Object.keys(columns).length === 0) return;
    document.apply_json_patch({ events: [columnDataChanged(sourceId, columns, mode)] });
  }

  /** Drop columns; with `keep`, drop every column except `names`. */
  private removeColumns(
    document: BokehDocument,
    sourceId: string,
    names: string[],
    keep: boolean,
  ): void {
    const model = document.get_model_by_id?.(sourceId);
    const data = model?.data;
    if (!model || data == null) return;
    const drop = (name: string) => (keep ? !names.includes(name) : names.includes(name));
    if (data instanceof Map) {
      if (![...data.keys()].some((name) => drop(String(name)))) return;
      model.setv(
        { data: new Map([...data].filter(([name]) => !drop(String(name)))) },
        { sync: false },
      );
    } else if (isRecord(data)) {
      if (!Object.keys(data).some(drop)) return;
      model.setv(
        { data: Object.fromEntries(Object.entries(data).filter(([name]) => !drop(name))) },
        { sync: false },
      );
    }
  }

  private hasModel(document: BokehDocument, id: string): boolean {
    return document.get_model_by_id ? document.get_model_by_id(id) != null : true;
  }

  private async mount(
    docJson: Record<string, unknown>,
    buffers: Map<string, ArrayBuffer>,
    beforeViews?: () => void,
  ) {
    this.options.container.replaceChildren();
    this.applyingRemote = true;
    try {
      const document = this.options.runtime.Document.from_json(docJson, [], buffers);
      const rootIds = new Set(document.all_roots.map((root) => root.id));
      for (const rootId of this.options.payload.root_ids) {
        if (!rootIds.has(rootId)) throw new Error(`Bokeh document is missing root ${rootId}`);
      }
      this.document = document;
      beforeViews?.();
      this.applyingRemote = true;
      this.views = await this.options.runtime.addDocumentStandalone(
        document,
        this.options.container,
      );
      document.on_change(this.onDocumentChange);
    } catch (error) {
      this.destroyDocument();
      this.options.container.replaceChildren();
      throw error;
    } finally {
      this.applyingRemote = false;
    }
    this.options.onLayout();
  }

  // ── Outbound ────────────────────────────────────────────────────────

  private readonly onDocumentChange = (event: BokehDocumentEvent) => {
    if (this.disposed || this.applyingRemote || !this.writable()) return;
    if (!shouldSyncEvent(event)) return;
    switch (event.kind) {
      case "ModelChanged":
        this.recordLocalProp(event);
        break;
      case "MessageSent":
      case "ColumnsStreamed":
      case "ColumnsPatched":
        this.sendOneOff(event);
        break;
      default:
        // Structure is kernel-owned; the session document never takes it.
        break;
    }
  };

  private writable(): boolean {
    return this.live && this.hostWritable && this.status === "connected" && this.epoch !== null;
  }

  private recordLocalProp(event: BokehDocumentEvent): void {
    const model = event.model;
    const attr = event.attr;
    if (!model?.id || !attr) return;
    // Python's ref_props decide, not BokehJS's may_have_refs: generically typed
    // properties (panel-material-ui widget values) set it without holding refs.
    if (!model.properties?.[attr] || this.refProps.get(model.id)?.has(attr) !== false) return;
    // Column data travels as data events, never as a property.
    if (attr === "data" && isColumnar(model)) return;
    let encoded: string;
    try {
      encoded = this.encode(event.value);
    } catch (error) {
      console.warn(`[bokeh-session] Cannot encode ${model.type}.${attr}:`, error);
      return;
    }
    const key = propKey(model.id, attr);
    this.pendingProps.set(key, { modelId: model.id, attr, value: event.value, encoded });
    const trail = this.trail.get(key) ?? [];
    trail.push(JSON.parse(encoded));
    this.trail.set(key, trail);
    if (this.writeTimer !== null) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => this.flushProps(), WRITE_DEBOUNCE_MS);
  }

  private encode(value: unknown): string {
    const Serializer = this.options.runtime.Serializer;
    if (!Serializer) return JSON.stringify(value);
    const references = new Map<unknown, unknown>();
    for (const model of this.document?.all_models ?? []) {
      if (typeof model.ref === "function") references.set(model, model.ref());
    }
    // Inline buffers as base64 so the stored value is self-contained.
    return JSON.stringify(new Serializer({ references, binary: false }).encode(value));
  }

  /**
   * Whether a remote value should leave the view alone. An unflushed edit
   * will be written after it and win. A value the kernel or another peer won
   * is the document's state even when it equals one of this frame's earlier
   * values, e.g. a callback clamping `2` back to an intermediate `1`. Only a
   * value this host won is matched against the values written in the grace
   * window; without an origin, every value is.
   */
  private keepsLocalValue(
    modelId: string,
    attr: string,
    value: unknown,
    origin: NteractBokehPropOrigin | undefined,
  ): boolean {
    const key = propKey(modelId, attr);
    if (this.pendingProps.has(key)) return true;
    if (origin === "kernel" || origin === "peer") return false;
    return this.trail.get(key)?.some((written) => structuralEqual(written, value)) ?? false;
  }

  private flushProps(): void {
    if (this.writeTimer !== null) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    if (this.pendingProps.size === 0) return;
    const props: Record<string, Record<string, string>> = {};
    for (const pending of this.pendingProps.values()) {
      (props[pending.modelId] ??= {})[pending.attr] = pending.encoded;
    }
    this.pendingProps.clear();
    this.startEchoGrace();
    this.sendOutbound(async () => {
      const result = (await this.options.requestHost(NTERACT_BOKEH_SET_PROPS, {
        sessionId: this.sessionId,
        outputId: this.options.outputId,
        props,
      })) as NteractBokehSetPropsResult;
      if (result.status === "rejected") {
        // The document keeps the previous value; show it again.
        console.warn("[bokeh-session] Property write rejected:", result.error);
        this.dirty = true;
        this.reopen();
      }
    });
  }

  private startEchoGrace(): void {
    if (this.graceTimer !== null) clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this.trail.clear();
    }, ECHO_GRACE_MS);
  }

  /** One-off events go after the property writes made before them. */
  private sendOneOff(event: BokehDocumentEvent): void {
    const document = this.document;
    if (!document) return;
    let patch: Record<string, unknown>;
    try {
      patch = document.create_json_patch([event]);
    } catch (error) {
      console.warn("[bokeh-session] Cannot serialize a Bokeh event:", error);
      return;
    }
    const transactionId = crypto.randomUUID();
    const buffers = extractBokehPatchBuffers(patch, this.options.runtime.Buffer, transactionId);
    const dataSource =
      event.kind === "ColumnsStreamed" || event.kind === "ColumnsPatched" ? event.model?.id : null;
    // `create_json_patch([event])` makes the edit the patch's only event.
    if (dataSource) {
      this.rememberOwnTransaction(transactionId, {
        sourceId: dataSource,
        index: 0,
        baseVersion: this.versions.get(dataSource),
      });
    }
    this.flushProps();
    this.sendOutbound(async () => {
      const reply = (await this.options.requestHost(NTERACT_BOKEH_APPLY_PATCH, {
        sessionId: this.sessionId,
        outputId: this.options.outputId,
        transactionId,
        patch,
        buffers,
      })) as NteractBokehApplyPatchResult;
      if (reply.status === "error") {
        console.warn("[bokeh-session] Bokeh event failed:", reply.error);
        // The kernel never versioned this edit; drop it locally.
        if (dataSource) {
          this.ownTransactions.delete(transactionId);
          this.enqueue(() => this.reloadSource(dataSource), false);
        }
      }
    });
  }

  private rememberOwnTransaction(transactionId: string, edit: OwnDataEdit): void {
    this.ownTransactions.set(transactionId, edit);
    if (this.ownTransactions.size > OWN_TRANSACTION_LIMIT) {
      const oldest = this.ownTransactions.keys().next().value;
      if (oldest !== undefined) this.ownTransactions.delete(oldest);
    }
  }

  private sendOutbound(task: () => Promise<void>): void {
    this.outbound = this.outbound.then(task).catch((error: unknown) => {
      if (!this.disposed) console.warn("[bokeh-session] Session request failed:", error);
    });
  }

  /** A full update may carry an older value for a property the user just changed. */
  private reapplyPendingLocalChanges(document: BokehDocument): void {
    for (const pending of this.pendingProps.values()) {
      document
        .get_model_by_id?.(pending.modelId)
        ?.setv({ [pending.attr]: pending.value }, { sync: false });
    }
  }

  // ── State ───────────────────────────────────────────────────────────

  private setStatus(status: NteractBokehSessionStatus, error?: string): void {
    this.status = status;
    this.options.onStatus(status, error);
    if (status !== "connected") this.clearLocalState();
    const readOnly = this.live && status === "connected" && !this.hostWritable;
    if (readOnly === this.readOnlyShown) return;
    this.readOnlyShown = readOnly;
    if (readOnly) this.clearLocalState();
    this.options.onReadOnly?.(readOnly);
  }

  private clearLocalState(): void {
    if (this.writeTimer !== null) clearTimeout(this.writeTimer);
    if (this.graceTimer !== null) clearTimeout(this.graceTimer);
    this.writeTimer = null;
    this.graceTimer = null;
    this.pendingProps.clear();
    this.trail.clear();
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
}

function columnDataChanged(
  sourceId: string,
  columns: Record<string, NteractBokehColumnData>,
  mode: "replace" | "merge",
): JsonPatchEvent {
  return {
    kind: "ColumnDataChanged",
    model: { id: sourceId },
    attr: "data",
    data: columnsMap(columns),
    ...(mode === "merge" ? { cols: Object.keys(columns) } : {}),
  };
}

function dataPatchEvent(
  event: Exclude<NteractBokehResolvedEvents["dataEvents"][number], { kind: "ColumnDataChanged" }>,
): JsonPatchEvent {
  if (event.kind === "ColumnsPatched") {
    return {
      kind: "ColumnsPatched",
      model: { id: event.source_id },
      attr: "data",
      patches: event.patches,
    };
  }
  return {
    kind: "ColumnsStreamed",
    model: { id: event.source_id },
    attr: "data",
    data: event.data,
    ...(event.rollover != null ? { rollover: event.rollover } : {}),
  };
}

export type { BokehRuntime, BokehSessionControllerOptions };
