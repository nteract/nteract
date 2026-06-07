import type { DurableObjectState, Env } from "./cloudflare-types.ts";
import { FrameType, encodeTypedFrame, type FrameTypeValue, type TypedFrame } from "./protocol.ts";
import { createEmptyRoomHost, loadRoomHostSnapshot, type RoomHostHandle } from "./runtimed-wasm.ts";
import { getNotebookCatalog } from "./storage.ts";
import type { AuthenticatedConnection } from "./identity.ts";
import { cloudLog, durationMs, errorMessage } from "./observability.ts";

const ROOM_HOST_ACTOR_LABEL = "system/schema:notebook-cloud-room";
const CHECKPOINT_NOTEBOOK_KEY = "room-host:notebook-doc";
const CHECKPOINT_RUNTIME_STATE_KEY = "room-host:runtime-state-doc";
const CHECKPOINT_COMMS_DOC_KEY = "room-host:comms-doc";
const CHECKPOINT_META_KEY = "room-host:checkpoint";
const CHECKPOINT_VERSION = 5;

interface RoomHostOutboundFrame {
  peer_id: string;
  frame_type: FrameTypeValue;
  payload: Uint8Array | number[];
}

export interface RoomHostFrameResult {
  changed: boolean;
  notebook_changed: boolean;
  runtime_state_changed: boolean;
  outbound: RoomHostOutboundFrame[];
}

interface RoomCheckpointMetadata {
  version: number;
  notebook_heads: string[];
  runtime_state_heads: string[];
  comms_doc_heads: string[];
  saved_at: string;
  published_revision_id: string | null;
  published_notebook_heads: string[] | null;
  published_runtime_state_heads: string[] | null;
  published_comms_doc_heads: string[] | null;
}

interface RoomPeer {
  id: string;
  identity: AuthenticatedConnection;
}

export class RoomMaterializer {
  private hostReady: Promise<RoomHostHandle> | undefined;
  private operationQueue: Promise<void> = Promise.resolve();
  private loadedPublishedRevisionId: string | null = null;
  private loadedPublishedNotebookHeads: string[] | null = null;
  private loadedPublishedRuntimeStateHeads: string[] | null = null;
  private loadedPublishedCommsDocHeads: string[] | null = null;

  constructor(
    private readonly notebookId: string,
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async syncPeer(peer: RoomPeer): Promise<RoomHostFrameResult> {
    try {
      return await this.syncPeerWithCurrentHost(peer);
    } catch (error) {
      const recovered = await this.recoverHostFromLatestPublishedSnapshot("sync_peer", error);
      if (!recovered) {
        throw error;
      }
      return this.syncPeerWithCurrentHost(peer);
    }
  }

  async removePeer(peerId: string): Promise<void> {
    await this.withHost((host) => {
      host.remove_peer(peerId);
    });
  }

  /// Reconcile the authoritative RuntimeStateDoc after the room's runtime_peer
  /// has departed without returning. Terminalizes in-flight executions and flips
  /// a phantom-live kernel to Error, returning the sync frames to broadcast to
  /// the surviving peers. See `RoomHostHandle::reconcile_runtime_peer_gone`.
  async reconcileRuntimePeerGone(reason: string): Promise<RoomHostFrameResult> {
    return this.withHost((host) => normalizeResult(host.reconcile_runtime_peer_gone(reason)));
  }

  async receiveFrame(peer: RoomPeer, frame: TypedFrame): Promise<RoomHostFrameResult> {
    const canWriteAllNotebookChanges = peer.identity.scope === "owner";
    const encoded = encodeTypedFrame(frame.type, frame.payload);
    return this.withHost((host) =>
      normalizeResult(
        host.receive_peer_frame(
          peer.id,
          peer.identity.principal,
          peer.identity.actorLabel,
          peer.identity.scope,
          canWriteAllNotebookChanges,
          encoded,
        ),
      ),
    );
  }

  async checkpoint(): Promise<void> {
    const startedAt = Date.now();
    await this.withHost(async (host) => {
      const [notebookBytes, runtimeStateBytes, commsDocBytes] = [
        toStoredArrayBuffer(host.save_notebook()),
        toStoredArrayBuffer(host.save_runtime_state_doc()),
        toStoredArrayBuffer(host.save_comms_doc()),
      ];
      const metadata: RoomCheckpointMetadata = {
        version: CHECKPOINT_VERSION,
        notebook_heads: Array.from(host.get_heads_hex()),
        runtime_state_heads: Array.from(host.get_runtime_state_heads_hex()),
        comms_doc_heads: Array.from(host.get_comms_doc_heads_hex()),
        saved_at: new Date().toISOString(),
        published_revision_id: this.loadedPublishedRevisionId,
        published_notebook_heads: this.loadedPublishedNotebookHeads,
        published_runtime_state_heads: this.loadedPublishedRuntimeStateHeads,
        published_comms_doc_heads: this.loadedPublishedCommsDocHeads,
      };
      await Promise.all([
        this.state.storage.put(CHECKPOINT_NOTEBOOK_KEY, notebookBytes),
        this.state.storage.put(CHECKPOINT_RUNTIME_STATE_KEY, runtimeStateBytes),
        this.state.storage.put(CHECKPOINT_COMMS_DOC_KEY, commsDocBytes),
        this.state.storage.put(CHECKPOINT_META_KEY, metadata),
      ]);
      cloudLog("debug", "room.materializer.checkpoint.saved", {
        notebook_id: this.notebookId,
        duration_ms: durationMs(startedAt),
        notebook_byte_length: notebookBytes.byteLength,
        runtime_state_byte_length: runtimeStateBytes.byteLength,
        comms_doc_byte_length: commsDocBytes.byteLength,
        notebook_head_count: metadata.notebook_heads.length,
        runtime_state_head_count: metadata.runtime_state_heads.length,
        comms_doc_head_count: metadata.comms_doc_heads.length,
        counter: "materializer_checkpoints_saved",
        counter_delta: 1,
      });
    });
  }

  private async withHost<T>(operation: (host: RoomHostHandle) => T | Promise<T>): Promise<T> {
    const run = this.operationQueue.then(async () => operation(await this.loadHost()));
    this.operationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async syncPeerWithCurrentHost(peer: RoomPeer): Promise<RoomHostFrameResult> {
    return this.withHost((host) => normalizeResult(host.sync_peer(peer.id, peer.identity.scope)));
  }

  private async loadHost(): Promise<RoomHostHandle> {
    this.hostReady ??= this.loadHostFromStorage().catch((error: unknown) => {
      this.hostReady = undefined;
      throw error;
    });
    return this.hostReady;
  }

  private async loadHostFromStorage(): Promise<RoomHostHandle> {
    const startedAt = Date.now();
    try {
      const checkpoint = await this.loadCheckpoint();
      if (checkpoint) {
        const latestPublished = await this.loadLatestPublishedSnapshotPairForCheckpoint();
        if (
          latestPublished &&
          checkpoint.metadata.published_revision_id !== latestPublished.revisionId
        ) {
          const checkpointKeepReason = checkpointKeepReasonForRevisionMismatch(
            checkpoint.metadata,
            latestPublished.createdAt,
          );
          if (checkpointKeepReason) {
            this.markLoadedCheckpoint(checkpoint.metadata);
            const host = await loadRoomHostSnapshot(
              checkpoint.notebookBytes,
              checkpoint.runtimeStateBytes,
              checkpoint.commsDocBytes,
            );
            cloudLog("info", "room.materializer.loaded", {
              notebook_id: this.notebookId,
              source: "durable_object_checkpoint",
              reason: checkpointKeepReason,
              checkpoint_published_revision_id: checkpoint.metadata.published_revision_id,
              published_revision_id: latestPublished.revisionId,
              duration_ms: durationMs(startedAt),
              notebook_byte_length: checkpoint.notebookBytes.byteLength,
              runtime_state_byte_length: checkpoint.runtimeStateBytes.byteLength,
              counter: "materializer_loads",
              counter_delta: 1,
            });
            return host;
          }

          const host = await loadRoomHostSnapshot(
            latestPublished.notebookBytes,
            latestPublished.runtimeStateBytes,
            latestPublished.commsDocBytes,
          );
          this.markLoadedPublishedSnapshot(latestPublished.revisionId, host);
          cloudLog("info", "room.materializer.loaded", {
            notebook_id: this.notebookId,
            source: "published_snapshot_pair",
            reason: "checkpoint_seed_revision_mismatch",
            checkpoint_published_revision_id: checkpoint.metadata.published_revision_id,
            published_revision_id: latestPublished.revisionId,
            duration_ms: durationMs(startedAt),
            notebook_byte_length: latestPublished.notebookBytes.byteLength,
            runtime_state_byte_length: latestPublished.runtimeStateBytes.byteLength,
            counter: "materializer_loads",
            counter_delta: 1,
          });
          return host;
        }

        this.markLoadedCheckpoint(checkpoint.metadata);
        const host = await loadRoomHostSnapshot(
          checkpoint.notebookBytes,
          checkpoint.runtimeStateBytes,
          checkpoint.commsDocBytes,
        );
        cloudLog("info", "room.materializer.loaded", {
          notebook_id: this.notebookId,
          source: "durable_object_checkpoint",
          published_revision_id: checkpoint.metadata.published_revision_id,
          duration_ms: durationMs(startedAt),
          notebook_byte_length: checkpoint.notebookBytes.byteLength,
          runtime_state_byte_length: checkpoint.runtimeStateBytes.byteLength,
          counter: "materializer_loads",
          counter_delta: 1,
        });
        return host;
      }

      const published = await this.loadLatestPublishedSnapshotPair();
      if (published) {
        const host = await loadRoomHostSnapshot(
          published.notebookBytes,
          published.runtimeStateBytes,
          published.commsDocBytes,
        );
        this.markLoadedPublishedSnapshot(published.revisionId, host);
        cloudLog("info", "room.materializer.loaded", {
          notebook_id: this.notebookId,
          source: "published_snapshot_pair",
          published_revision_id: published.revisionId,
          duration_ms: durationMs(startedAt),
          notebook_byte_length: published.notebookBytes.byteLength,
          runtime_state_byte_length: published.runtimeStateBytes.byteLength,
          counter: "materializer_loads",
          counter_delta: 1,
        });
        return host;
      }

      this.loadedPublishedRevisionId = null;
      this.loadedPublishedNotebookHeads = null;
      this.loadedPublishedRuntimeStateHeads = null;
      this.loadedPublishedCommsDocHeads = null;
      const host = await createEmptyRoomHost(this.notebookId, ROOM_HOST_ACTOR_LABEL);
      host.seed_initial_code_cell_if_empty(`cell-${crypto.randomUUID()}`);
      cloudLog("info", "room.materializer.loaded", {
        notebook_id: this.notebookId,
        source: "empty_room",
        duration_ms: durationMs(startedAt),
        counter: "materializer_loads",
        counter_delta: 1,
      });
      return host;
    } catch (error) {
      cloudLog("warn", "room.materializer.load_failed", {
        notebook_id: this.notebookId,
        duration_ms: durationMs(startedAt),
        error: errorMessage(error),
        counter: "materializer_load_failures",
        counter_delta: 1,
      });
      throw error;
    }
  }

  private async recoverHostFromLatestPublishedSnapshot(
    operation: string,
    cause: unknown,
  ): Promise<boolean> {
    const run = this.operationQueue.then(async () =>
      this.recoverHostFromLatestPublishedSnapshotNow(operation, cause),
    );
    this.operationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async recoverHostFromLatestPublishedSnapshotNow(
    operation: string,
    cause: unknown,
  ): Promise<boolean> {
    const startedAt = Date.now();
    const published = await this.loadLatestPublishedSnapshotPairForCheckpoint();
    if (!published) {
      cloudLog("warn", "room.materializer.recovery_skipped", {
        notebook_id: this.notebookId,
        operation,
        reason: "latest_published_snapshot_unavailable",
        error: errorMessage(cause),
        counter: "materializer_recovery_skipped",
        counter_delta: 1,
      });
      return false;
    }

    try {
      const host = await loadRoomHostSnapshot(
        published.notebookBytes,
        published.runtimeStateBytes,
        published.commsDocBytes,
      );
      this.markLoadedPublishedSnapshot(published.revisionId, host);
      await this.clearCheckpoint();
      this.hostReady = Promise.resolve(host);
      cloudLog("warn", "room.materializer.recovered_from_published_snapshot", {
        notebook_id: this.notebookId,
        operation,
        published_revision_id: published.revisionId,
        duration_ms: durationMs(startedAt),
        notebook_byte_length: published.notebookBytes.byteLength,
        runtime_state_byte_length: published.runtimeStateBytes.byteLength,
        error: errorMessage(cause),
        counter: "materializer_recovered_from_published_snapshot",
        counter_delta: 1,
      });
      return true;
    } catch (recoveryError) {
      cloudLog("warn", "room.materializer.recovery_failed", {
        notebook_id: this.notebookId,
        operation,
        published_revision_id: published.revisionId,
        duration_ms: durationMs(startedAt),
        error: errorMessage(recoveryError),
        original_error: errorMessage(cause),
        counter: "materializer_recovery_failed",
        counter_delta: 1,
      });
      return false;
    }
  }

  private async clearCheckpoint(): Promise<void> {
    await Promise.all([
      this.state.storage.delete(CHECKPOINT_NOTEBOOK_KEY),
      this.state.storage.delete(CHECKPOINT_RUNTIME_STATE_KEY),
      this.state.storage.delete(CHECKPOINT_COMMS_DOC_KEY),
      this.state.storage.delete(CHECKPOINT_META_KEY),
    ]);
  }

  private async loadCheckpoint(): Promise<{
    notebookBytes: Uint8Array;
    runtimeStateBytes: Uint8Array;
    commsDocBytes?: Uint8Array;
    metadata: RoomCheckpointMetadata;
  } | null> {
    const [notebookBytes, runtimeStateBytes, commsDocBytes] = await Promise.all([
      this.state.storage.get<ArrayBuffer>(CHECKPOINT_NOTEBOOK_KEY),
      this.state.storage.get<ArrayBuffer>(CHECKPOINT_RUNTIME_STATE_KEY),
      this.state.storage.get<ArrayBuffer>(CHECKPOINT_COMMS_DOC_KEY),
    ]);
    const metadata =
      await this.state.storage.get<Partial<RoomCheckpointMetadata>>(CHECKPOINT_META_KEY);
    if (
      !notebookBytes ||
      !runtimeStateBytes ||
      (metadata?.version !== 2 &&
        metadata?.version !== 3 &&
        metadata?.version !== 4 &&
        metadata?.version !== CHECKPOINT_VERSION)
    ) {
      return null;
    }
    if (metadata.version === CHECKPOINT_VERSION && !commsDocBytes) {
      return null;
    }
    return {
      notebookBytes: new Uint8Array(notebookBytes),
      runtimeStateBytes: new Uint8Array(runtimeStateBytes),
      commsDocBytes: commsDocBytes ? new Uint8Array(commsDocBytes) : undefined,
      metadata: {
        version: typeof metadata.version === "number" ? metadata.version : CHECKPOINT_VERSION,
        notebook_heads: Array.isArray(metadata.notebook_heads) ? metadata.notebook_heads : [],
        runtime_state_heads: Array.isArray(metadata.runtime_state_heads)
          ? metadata.runtime_state_heads
          : [],
        comms_doc_heads: Array.isArray(metadata.comms_doc_heads) ? metadata.comms_doc_heads : [],
        saved_at: typeof metadata.saved_at === "string" ? metadata.saved_at : "",
        published_revision_id:
          typeof metadata.published_revision_id === "string"
            ? metadata.published_revision_id
            : null,
        published_notebook_heads: Array.isArray(metadata.published_notebook_heads)
          ? metadata.published_notebook_heads
          : null,
        published_runtime_state_heads: Array.isArray(metadata.published_runtime_state_heads)
          ? metadata.published_runtime_state_heads
          : null,
        published_comms_doc_heads: Array.isArray(metadata.published_comms_doc_heads)
          ? metadata.published_comms_doc_heads
          : null,
      },
    };
  }

  private async loadLatestPublishedSnapshotPairForCheckpoint(): Promise<{
    revisionId: string;
    createdAt: string;
    notebookBytes: Uint8Array;
    runtimeStateBytes: Uint8Array;
    commsDocBytes?: Uint8Array;
  } | null> {
    try {
      return await this.loadLatestPublishedSnapshotPair();
    } catch (error) {
      cloudLog("warn", "room.materializer.published_snapshot_lookup_failed", {
        notebook_id: this.notebookId,
        error: errorMessage(error),
        counter: "materializer_published_snapshot_lookup_failures",
        counter_delta: 1,
      });
      return null;
    }
  }

  private markLoadedCheckpoint(metadata: RoomCheckpointMetadata): void {
    this.loadedPublishedRevisionId = metadata.published_revision_id;
    this.loadedPublishedNotebookHeads = metadata.published_notebook_heads;
    this.loadedPublishedRuntimeStateHeads = metadata.published_runtime_state_heads;
    this.loadedPublishedCommsDocHeads = metadata.published_comms_doc_heads;
  }

  private markLoadedPublishedSnapshot(revisionId: string, host: RoomHostHandle): void {
    this.loadedPublishedRevisionId = revisionId;
    this.loadedPublishedNotebookHeads = Array.from(host.get_heads_hex());
    this.loadedPublishedRuntimeStateHeads = Array.from(host.get_runtime_state_heads_hex());
    this.loadedPublishedCommsDocHeads = Array.from(host.get_comms_doc_heads_hex());
  }

  private async loadLatestPublishedSnapshotPair(): Promise<{
    revisionId: string;
    createdAt: string;
    notebookBytes: Uint8Array;
    runtimeStateBytes: Uint8Array;
    commsDocBytes?: Uint8Array;
  } | null> {
    if (!this.env.DB || !this.env.NOTEBOOK_SNAPSHOTS) {
      return null;
    }

    const catalog = await getNotebookCatalog(this.env, this.notebookId);
    const latest = catalog?.revisions.find(
      (revision) => revision.id === catalog.notebook.latest_revision_id,
    );
    if (!latest?.runtime_state_doc_id || !latest.runtime_snapshot_key) {
      return null;
    }

    const [notebookObject, runtimeObject, commsObject] = await Promise.all([
      this.env.NOTEBOOK_SNAPSHOTS.get(latest.snapshot_key),
      this.env.NOTEBOOK_SNAPSHOTS.get(latest.runtime_snapshot_key),
      latest.comms_snapshot_key ? this.env.NOTEBOOK_SNAPSHOTS.get(latest.comms_snapshot_key) : null,
    ]);
    if (!notebookObject || !runtimeObject || (latest.comms_snapshot_key && !commsObject)) {
      cloudLog("warn", "room.materializer.snapshot_pair_missing", {
        notebook_id: this.notebookId,
        notebook_snapshot_missing: !notebookObject,
        runtime_state_snapshot_missing: !runtimeObject,
        comms_doc_snapshot_missing: Boolean(latest.comms_snapshot_key && !commsObject),
        counter: "materializer_snapshot_pair_missing",
        counter_delta: 1,
      });
      return null;
    }

    return {
      revisionId: latest.id,
      createdAt: latest.created_at,
      notebookBytes: new Uint8Array(await notebookObject.arrayBuffer()),
      runtimeStateBytes: new Uint8Array(await runtimeObject.arrayBuffer()),
      commsDocBytes: commsObject ? new Uint8Array(await commsObject.arrayBuffer()) : undefined,
    };
  }
}

export function isMaterializedSyncFrame(type: FrameTypeValue): boolean {
  // REQUEST routes through the room host too: an editor/owner ExecuteCell is
  // turned into a queued execution by the host (the one peer that may create
  // execution intent), whose outbound runtime-state frames then reach peers.
  // Without this it would fall through to broadcast and never be dispatched.
  return (
    type === FrameType.AUTOMERGE_SYNC ||
    type === FrameType.RUNTIME_STATE_SYNC ||
    type === FrameType.COMMS_DOC_SYNC ||
    type === FrameType.REQUEST
  );
}

export function typedFrameFromRoomHostOutbound(frame: RoomHostOutboundFrame): Uint8Array {
  return encodeTypedFrame(frame.frame_type, toUint8Array(frame.payload));
}

function normalizeResult(value: unknown): RoomHostFrameResult {
  const result = value as Partial<RoomHostFrameResult> | undefined;
  return {
    changed: result?.changed ?? false,
    notebook_changed: result?.notebook_changed ?? false,
    runtime_state_changed: result?.runtime_state_changed ?? false,
    outbound: result?.outbound ?? [],
  };
}

function checkpointKeepReasonForRevisionMismatch(
  metadata: RoomCheckpointMetadata,
  latestPublishedCreatedAt: string,
): string | null {
  if (hasUnpublishedCheckpointChanges(metadata)) {
    return "checkpoint_has_unpublished_changes";
  }
  if (legacyCheckpointIsNewerThanPublished(metadata, latestPublishedCreatedAt)) {
    return "legacy_checkpoint_newer_than_published";
  }
  return null;
}

function hasUnpublishedCheckpointChanges(metadata: RoomCheckpointMetadata): boolean {
  return (
    headsChanged(metadata.notebook_heads, metadata.published_notebook_heads) ||
    headsChanged(metadata.runtime_state_heads, metadata.published_runtime_state_heads) ||
    headsChanged(metadata.comms_doc_heads, metadata.published_comms_doc_heads)
  );
}

function legacyCheckpointIsNewerThanPublished(
  metadata: RoomCheckpointMetadata,
  latestPublishedCreatedAt: string,
): boolean {
  if (metadata.version >= CHECKPOINT_VERSION || metadata.published_revision_id) {
    return false;
  }
  const checkpointSavedAt = Date.parse(metadata.saved_at);
  const latestPublishedAt = Date.parse(latestPublishedCreatedAt);
  if (!Number.isFinite(checkpointSavedAt) || !Number.isFinite(latestPublishedAt)) {
    return false;
  }
  return checkpointSavedAt > latestPublishedAt;
}

function headsChanged(current: string[], baseline: string[] | null): boolean {
  if (!baseline) {
    return false;
  }
  if (current.length !== baseline.length) {
    return true;
  }
  const currentSet = new Set(current);
  return baseline.some((head) => !currentSet.has(head));
}

function toUint8Array(value: Uint8Array | number[]): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function toStoredArrayBuffer(value: Uint8Array | number[]): ArrayBuffer {
  const bytes = toUint8Array(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
