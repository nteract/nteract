/**
 * Host replicas of Bokeh session documents (frame `0x0b`).
 *
 * One `BokehSessionDocHandle` per subscribed session and epoch, keyed
 * document `("bokeh_session", session_id)`. Frames arrive routed by header
 * from the sync engine's keyed document streams, epochs follow
 * RuntimeStateDoc and the frames themselves, and a `doc_resync` drops the
 * replica and starts over. Subscribers (the per-frame bridge managers)
 * receive ordered `NteractBokehDocUpdate`s with property values decoded and
 * blob-backed values loaded.
 */

import type { BlobRef, BokehSessionState, KeyedDocFrame, KeyedDocResync } from "runtimed";
import type {
  NteractBokehColumnVersion,
  NteractBokehDocMeta,
  NteractBokehDocUpdate,
  NteractBokehModelState,
  NteractBokehPropOrigin,
  NteractBokehSetPropsResult,
} from "./bokeh-session-rpc";

/** Keyed document kind of Bokeh session documents. */
export const BOKEH_SESSION_DOC_KIND = "bokeh_session";

export interface BokehDocModel {
  type: string;
  ref_props: string[];
  props: Record<string, string>;
}

export interface BokehDocColumnRef {
  blob: string;
  size: number;
  version: number;
}

export interface BokehDocSnapshot {
  epoch: number;
  meta: {
    session_id: string;
    producer_name: string;
    producer_version: string;
    bokeh_version: string;
    root_ids: string[];
    title?: string | null;
    doc_extras?: string | null;
  };
  models: Record<string, BokehDocModel>;
  columns: Record<string, Record<string, BokehDocColumnRef>>;
}

export interface BokehDocChangeset {
  models_added: string[];
  models_removed: string[];
  props_changed: Record<string, string[]>;
  /** An empty list means the whole source. */
  columns_changed: Record<string, string[]>;
  meta_changed: boolean;
}

type FrameReply = number[] | Uint8Array | null | undefined;

export type BokehReplicaFrameEvent =
  | { type: "applied"; changed: boolean; changeset: BokehDocChangeset; reply?: FrameReply }
  | { type: "ignored"; kind: string; id: string; epoch: number }
  | { type: "sync_error"; error: string; reply?: FrameReply };

/** The parts of the WASM `BokehSessionDocHandle` the store uses. */
export interface BokehSessionDocReplica {
  readonly epoch: number;
  is_synced(): boolean;
  set_read_only(readOnly: boolean): void;
  receive_frame(frame: Uint8Array): BokehReplicaFrameEvent;
  flush_sync(): Uint8Array | undefined;
  cancel_last_flush(): void;
  snapshot(): BokehDocSnapshot | null;
  get_model(modelId: string): BokehDocModel | null;
  get_prop(modelId: string, name: string): string | undefined;
  get_prop_origin(modelId: string, name: string): NteractBokehPropOrigin | undefined;
  set_props_json(patchJson: string): boolean;
  get_heads_hex(): string[];
  free(): void;
}

export interface BokehSessionDocStoreOptions {
  createReplica(sessionId: string, epoch: number): BokehSessionDocReplica;
  /** Send a header-framed payload as frame `0x0b`. */
  sendFrame(payload: Uint8Array): Promise<void>;
  fetchBlob(ref: BlobRef): Promise<Response>;
  now?: () => number;
  logger?: { warn(message: string, ...args: unknown[]): void };
}

export type BokehSessionDocListener = (update: NteractBokehDocUpdate) => void;

/**
 * User values older than this are not rewritten after a resync or epoch
 * change: a refusal or replacement races only with writes just sent, while
 * an older value missing from the new replica was most likely corrected by
 * the kernel while the old replica was being dropped.
 */
const REWRITE_WINDOW_MS = 10_000;
const PROP_BLOB_CACHE_LIMIT = 256;

interface PendingValue {
  modelId: string;
  name: string;
  value: string;
  writtenAt: number;
}

interface SessionEntry {
  readonly sessionId: string;
  readonly listeners: Set<BokehSessionDocListener>;
  record: BokehSessionState | undefined;
  replica: BokehSessionDocReplica | null;
  synced: boolean;
  /** Heads of the state every subscriber has been sent, local writes included. */
  deliveredHeads: string[];
  /** What subscribers showed when the replica was dropped, for the switch check. */
  previousHeads: string[] | null;
  rewrite: boolean;
  /** Values this host wrote that no later remote change has touched. */
  readonly pending: Map<string, PendingValue>;
  queue: Promise<void>;
}

function propKey(modelId: string, name: string): string {
  return `${modelId}\u0000${name}`;
}

function sameHeads(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((head) => set.has(head));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Mirrors `BokehBlobRef::parse` (exactly these three keys). */
function parseBlobRef(value: unknown): BlobRef | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 3) return null;
  const { blob, size, media_type } = value;
  if (typeof blob !== "string" || typeof size !== "number" || typeof media_type !== "string") {
    return null;
  }
  return { blob, size, media_type };
}

function jsonEqual(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return structuralEqual(JSON.parse(a), JSON.parse(b));
  } catch {
    return false;
  }
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

function frameReply(reply: FrameReply): Uint8Array | null {
  if (!reply) return null;
  return reply instanceof Uint8Array ? reply : Uint8Array.from(reply);
}

export class BokehSessionDocStore {
  private readonly options: BokehSessionDocStoreOptions;
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly propBlobs = new Map<string, Promise<unknown>>();
  private records: Record<string, BokehSessionState> = {};
  private disposed = false;

  constructor(options: BokehSessionDocStoreOptions) {
    this.options = options;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Follow topology, status and epochs from RuntimeStateDoc. */
  updateSessions(records: Record<string, BokehSessionState>): void {
    this.records = records;
    for (const entry of this.sessions.values()) {
      const record = records[entry.sessionId];
      entry.record = record;
      if (!record) {
        entry.replica?.set_read_only(true);
        continue;
      }
      if (!entry.replica) {
        this.openReplica(entry, record.epoch);
      } else if (record.epoch > entry.replica.epoch) {
        this.replaceReplica(entry, record.epoch);
      }
      entry.replica?.set_read_only(record.status !== "connected");
      if (record.status !== "connected") entry.pending.clear();
    }
  }

  /**
   * Follow a session's document. The listener receives a `full` update once
   * the epoch's document has arrived, then a `delta` per sync step.
   */
  subscribe(sessionId: string, listener: BokehSessionDocListener): () => void {
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      entry = {
        sessionId,
        listeners: new Set(),
        record: this.records[sessionId],
        replica: null,
        synced: false,
        deliveredHeads: [],
        previousHeads: null,
        rewrite: false,
        pending: new Map(),
        queue: Promise.resolve(),
      };
      this.sessions.set(sessionId, entry);
    }
    entry.listeners.add(listener);
    if (!entry.replica && entry.record) {
      this.openReplica(entry, entry.record.epoch);
    } else if (entry.synced) {
      this.emitFull(entry, new Set([listener]), false);
    }
    const subscribed = entry;
    return () => {
      subscribed.listeners.delete(listener);
      if (subscribed.listeners.size > 0 || this.sessions.get(sessionId) !== subscribed) return;
      // The daemon keeps pushing frames to a subscribed peer; they are ignored
      // once no replica is left to receive them.
      subscribed.replica?.free();
      subscribed.replica = null;
      this.sessions.delete(sessionId);
    };
  }

  receiveFrame(header: KeyedDocFrame): void {
    if (this.disposed || header.kind !== BOKEH_SESSION_DOC_KIND) return;
    const frame = header.frame;
    const entry = this.sessions.get(header.id);
    if (!entry?.replica || header.epoch < entry.replica.epoch) return;
    // The daemon moves subscribed peers to a new epoch before RuntimeStateDoc
    // may announce it.
    if (header.epoch > entry.replica.epoch) this.replaceReplica(entry, header.epoch);
    const replica = entry.replica;
    if (!replica) return;

    let event: BokehReplicaFrameEvent;
    try {
      event = replica.receive_frame(frame);
    } catch (error) {
      this.options.logger?.warn("[bokeh-session] Failed to apply session frame:", error);
      return;
    }
    if (event.type === "ignored") return;
    this.send(replica, frameReply(event.reply));
    if (event.type === "sync_error") {
      this.options.logger?.warn("[bokeh-session] Session sync reset:", event.error);
      return;
    }
    if (!event.changed) return;
    if (!entry.synced) {
      if (!replica.is_synced()) return;
      entry.synced = true;
      const canSwitch = this.canSwitch(entry, replica);
      this.rewritePending(entry, replica);
      this.emitFull(entry, entry.listeners, canSwitch);
      return;
    }
    for (const [modelId, names] of Object.entries(event.changeset.props_changed)) {
      for (const name of names) entry.pending.delete(propKey(modelId, name));
    }
    this.emitDelta(entry, replica, event.changeset);
  }

  /** The daemon refused this peer's writes: start over on `epoch`. */
  handleResync(resync: KeyedDocResync): void {
    if (resync.kind !== BOKEH_SESSION_DOC_KIND) return;
    const entry = this.sessions.get(resync.id);
    if (!entry?.replica) return;
    this.options.logger?.warn(`[bokeh-session] Session ${resync.id} resync: ${resync.reason}`);
    this.replaceReplica(entry, Math.max(resync.epoch, entry.record?.epoch ?? 0));
  }

  /** A new daemon connection: restart every subscription on its current epoch. */
  resubscribeAll(): void {
    for (const entry of this.sessions.values()) {
      if (entry.replica) this.replaceReplica(entry, entry.replica.epoch);
    }
  }

  /** Write user values of existing models' non-reference properties. */
  writeProps(
    sessionId: string,
    props: Record<string, Record<string, string>>,
  ): NteractBokehSetPropsResult {
    const entry = this.sessions.get(sessionId);
    const replica = entry?.replica;
    if (!entry || !replica || !entry.synced || entry.record?.status !== "connected") {
      return { status: "read_only" };
    }
    const batch: Record<string, Record<string, string>> = {};
    let count = 0;
    for (const [modelId, values] of Object.entries(props)) {
      const model = replica.get_model(modelId);
      if (!model) continue;
      for (const [name, value] of Object.entries(values)) {
        if (model.ref_props.includes(name) || typeof value !== "string") continue;
        (batch[modelId] ??= {})[name] = value;
        count += 1;
      }
    }
    if (count === 0) return { status: "unchanged" };
    const before = replica.get_heads_hex();
    let changed: boolean;
    try {
      changed = replica.set_props_json(JSON.stringify(batch));
    } catch (error) {
      return { status: "rejected", error: error instanceof Error ? error.message : String(error) };
    }
    const writtenAt = this.now();
    for (const [modelId, values] of Object.entries(batch)) {
      for (const [name, value] of Object.entries(values)) {
        entry.pending.set(propKey(modelId, name), { modelId, name, value, writtenAt });
      }
    }
    if (!changed) return { status: "unchanged" };
    // The writing frame already shows its own values, so its delivered state
    // advances unless remote changes it has not been sent are in between.
    if (sameHeads(before, entry.deliveredHeads)) entry.deliveredHeads = replica.get_heads_hex();
    this.send(replica, replica.flush_sync() ?? null);
    return { status: "written" };
  }

  /** Current column refs of the requested sources (`null` = every column). */
  columnRefs(
    sessionId: string,
    sources: Record<string, string[] | null>,
  ): { epoch: number; columns: Record<string, Record<string, BokehDocColumnRef>> } | null {
    const replica = this.sessions.get(sessionId)?.replica;
    const snapshot = replica?.is_synced() ? replica.snapshot() : null;
    if (!replica || !snapshot) return null;
    const columns: Record<string, Record<string, BokehDocColumnRef>> = {};
    for (const [sourceId, names] of Object.entries(sources)) {
      const refs = snapshot.columns[sourceId] ?? {};
      columns[sourceId] = Object.fromEntries(
        Object.entries(refs).filter(([name]) => names === null || names.includes(name)),
      );
    }
    return { epoch: replica.epoch, columns };
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.sessions.values()) {
      entry.replica?.free();
      entry.replica = null;
      entry.listeners.clear();
    }
    this.sessions.clear();
    this.propBlobs.clear();
  }

  private openReplica(entry: SessionEntry, epoch: number): void {
    const replica = this.options.createReplica(entry.sessionId, epoch);
    replica.set_read_only(entry.record?.status !== "connected");
    entry.replica = replica;
    entry.synced = false;
    // Any frame subscribes; an empty replica's first message asks for the doc.
    this.send(replica, replica.flush_sync() ?? null);
  }

  private replaceReplica(entry: SessionEntry, epoch: number): void {
    entry.previousHeads = entry.synced ? entry.deliveredHeads : null;
    entry.rewrite = true;
    entry.replica?.free();
    entry.replica = null;
    this.openReplica(entry, epoch);
  }

  /**
   * Whether subscribers already show the new replica's state: after a
   * replacement, they had applied the old document up to `previous_heads` and
   * nothing changed since the build; after a resync, the hub's document is
   * the one they were sent.
   */
  private canSwitch(entry: SessionEntry, replica: BokehSessionDocReplica): boolean {
    const shown = entry.previousHeads;
    entry.previousHeads = null;
    if (!shown) return false;
    const heads = replica.get_heads_hex();
    if (sameHeads(shown, heads)) return true;
    const record = entry.record;
    return (
      record?.epoch === replica.epoch &&
      sameHeads(shown, record.previous_heads ?? []) &&
      sameHeads(heads, record.doc_heads)
    );
  }

  /**
   * Rewrite recent user values a new replica lacks, so a refused or
   * old-epoch write is not lost. Never while disconnected, never references.
   */
  private rewritePending(entry: SessionEntry, replica: BokehSessionDocReplica): void {
    if (!entry.rewrite) return;
    entry.rewrite = false;
    if (entry.record?.status !== "connected") {
      entry.pending.clear();
      return;
    }
    const cutoff = this.now() - REWRITE_WINDOW_MS;
    const batch: Record<string, Record<string, string>> = {};
    let count = 0;
    for (const [key, pending] of entry.pending) {
      const current = replica.get_prop(pending.modelId, pending.name);
      const model = replica.get_model(pending.modelId);
      if (
        pending.writtenAt < cutoff ||
        !model ||
        model.ref_props.includes(pending.name) ||
        (current !== undefined && jsonEqual(current, pending.value))
      ) {
        entry.pending.delete(key);
        continue;
      }
      (batch[pending.modelId] ??= {})[pending.name] = pending.value;
      count += 1;
    }
    if (count === 0) return;
    try {
      if (replica.set_props_json(JSON.stringify(batch))) {
        this.send(replica, replica.flush_sync() ?? null);
      }
    } catch (error) {
      this.options.logger?.warn("[bokeh-session] Could not rewrite user values:", error);
      entry.pending.clear();
    }
  }

  private send(replica: BokehSessionDocReplica, payload: Uint8Array | null): void {
    if (!payload) return;
    this.options.sendFrame(payload).catch((error: unknown) => {
      replica.cancel_last_flush();
      this.options.logger?.warn("[bokeh-session] Session frame send failed:", error);
    });
  }

  private emitFull(
    entry: SessionEntry,
    listeners: Iterable<BokehSessionDocListener>,
    canSwitch: boolean,
  ): void {
    const replica = entry.replica;
    const snapshot = replica?.snapshot();
    if (!replica || !snapshot) return;
    entry.deliveredHeads = replica.get_heads_hex();
    const columns: NteractBokehDocUpdate["columns"] = {};
    for (const [sourceId, refs] of Object.entries(snapshot.columns)) {
      columns[sourceId] = Object.fromEntries(
        Object.entries(refs).map(([name, ref]) => [name, columnVersion(ref)]),
      );
    }
    const targets = [...listeners];
    this.enqueue(
      entry,
      async () => {
        const [meta, models] = await Promise.all([
          this.resolveMeta(snapshot.meta),
          this.resolveModels(snapshot.models),
        ]);
        return {
          sessionId: entry.sessionId,
          epoch: replica.epoch,
          kind: "full",
          canSwitch,
          meta,
          models,
          props: {},
          removed: [],
          columns,
        };
      },
      targets,
    );
  }

  private emitDelta(
    entry: SessionEntry,
    replica: BokehSessionDocReplica,
    changeset: BokehDocChangeset,
  ): void {
    // Read synchronously: the replica keeps changing while values resolve.
    const added: Record<string, BokehDocModel> = {};
    for (const id of changeset.models_added) {
      const model = replica.get_model(id);
      if (model) added[id] = model;
    }
    const changed: Record<string, Record<string, string>> = {};
    const propOrigins: Record<string, Record<string, NteractBokehPropOrigin>> = {};
    for (const [id, names] of Object.entries(changeset.props_changed)) {
      for (const name of names) {
        const value = replica.get_prop(id, name);
        if (value === undefined) continue;
        (changed[id] ??= {})[name] = value;
        const origin = replica.get_prop_origin(id, name);
        if (origin) (propOrigins[id] ??= {})[name] = origin;
      }
    }
    const columnSources = Object.keys(changeset.columns_changed);
    const snapshot = changeset.meta_changed || columnSources.length > 0 ? replica.snapshot() : null;
    const columns: NteractBokehDocUpdate["columns"] = {};
    for (const [sourceId, names] of Object.entries(changeset.columns_changed)) {
      const refs = snapshot?.columns[sourceId] ?? {};
      const touched = names.length > 0 ? names : Object.keys(refs);
      columns[sourceId] = Object.fromEntries(
        touched.map((name) => [name, refs[name] ? columnVersion(refs[name]) : null]),
      );
    }
    entry.deliveredHeads = replica.get_heads_hex();
    this.enqueue(
      entry,
      async () => {
        const [meta, models, props] = await Promise.all([
          changeset.meta_changed && snapshot ? this.resolveMeta(snapshot.meta) : null,
          this.resolveModels(added),
          this.resolvePropMap(changed),
        ]);
        return {
          sessionId: entry.sessionId,
          epoch: replica.epoch,
          kind: "delta",
          canSwitch: false,
          meta,
          models,
          props,
          propOrigins,
          removed: changeset.models_removed,
          columns,
        };
      },
      entry.listeners,
    );
  }

  private enqueue(
    entry: SessionEntry,
    build: () => Promise<NteractBokehDocUpdate>,
    listeners: Iterable<BokehSessionDocListener>,
  ): void {
    const pending = build();
    entry.queue = entry.queue
      .then(async () => {
        const update = await pending;
        if (this.disposed) return;
        for (const listener of listeners) listener(update);
      })
      .catch((error: unknown) => {
        this.options.logger?.warn("[bokeh-session] Failed to deliver a session update:", error);
      });
  }

  private async resolveMeta(meta: BokehDocSnapshot["meta"]): Promise<NteractBokehDocMeta> {
    const extras = meta.doc_extras ? await this.resolveValue(meta.doc_extras) : null;
    return {
      rootIds: meta.root_ids,
      title: meta.title ?? null,
      bokehVersion: meta.bokeh_version,
      docExtras: isRecord(extras) ? extras : null,
    };
  }

  private async resolveModels(
    models: Record<string, BokehDocModel>,
  ): Promise<Record<string, NteractBokehModelState>> {
    const entries = await Promise.all(
      Object.entries(models).map(async ([id, model]) => {
        const props = await this.resolveProps(model.props);
        return [id, { type: model.type, refProps: model.ref_props, props }] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  private async resolvePropMap(
    changed: Record<string, Record<string, string>>,
  ): Promise<Record<string, Record<string, unknown>>> {
    const entries = await Promise.all(
      Object.entries(changed).map(async ([id, props]) => [id, await this.resolveProps(props)]),
    );
    return Object.fromEntries(entries);
  }

  private async resolveProps(props: Record<string, string>): Promise<Record<string, unknown>> {
    const entries = await Promise.all(
      Object.entries(props).map(async ([name, encoded]) => [
        name,
        await this.resolveValue(encoded),
      ]),
    );
    return Object.fromEntries(entries);
  }

  /** Decode a stored value, loading it from the blob store when offloaded. */
  private resolveValue(encoded: string): Promise<unknown> {
    const value: unknown = JSON.parse(encoded);
    const ref = parseBlobRef(value);
    if (!ref) return Promise.resolve(value);
    let loaded = this.propBlobs.get(ref.blob);
    if (!loaded) {
      loaded = this.loadJson(ref);
      loaded.catch(() => this.propBlobs.delete(ref.blob));
      this.propBlobs.set(ref.blob, loaded);
      if (this.propBlobs.size > PROP_BLOB_CACHE_LIMIT) {
        const oldest = this.propBlobs.keys().next().value;
        if (oldest !== undefined) this.propBlobs.delete(oldest);
      }
    }
    return loaded;
  }

  async loadJson(ref: BlobRef): Promise<unknown> {
    const response = await this.options.fetchBlob(ref);
    if (!response.ok) {
      throw new Error(`Failed to fetch Bokeh blob ${ref.blob}: ${response.status}`);
    }
    return JSON.parse(await response.text());
  }
}

function columnVersion(ref: BokehDocColumnRef): NteractBokehColumnVersion {
  return { version: ref.version, size: ref.size };
}
