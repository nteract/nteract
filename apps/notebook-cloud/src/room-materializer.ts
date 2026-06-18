import type { DurableObjectState, Env } from "./cloudflare-types.ts";
import type { WorkstationAttachmentState } from "runtimed";
import { FrameType, encodeTypedFrame, type FrameTypeValue, type TypedFrame } from "./protocol.ts";
import { createEmptyRoomHost, loadRoomHostSnapshot, type RoomHostHandle } from "./runtimed-wasm.ts";
import { getNotebookCatalog } from "./storage.ts";
import type { AuthenticatedConnection } from "./identity.ts";
import { cloudLog, durationMs, errorMessage } from "./observability.ts";

const ROOM_HOST_ACTOR_PRINCIPAL = "system:notebook-cloud-room";
const CHECKPOINT_NOTEBOOK_KEY = "room-host:notebook-doc";
const CHECKPOINT_RUNTIME_STATE_KEY = "room-host:runtime-state-doc";
const CHECKPOINT_COMMS_DOC_KEY = "room-host:comms-doc";
const CHECKPOINT_COMMENTS_DOC_KEY = "room-host:comments-doc";
const CHECKPOINT_META_KEY = "room-host:checkpoint";
const CHECKPOINT_VERSION = 6;

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
  comments_doc_heads: string[];
  saved_at: string;
  published_revision_id: string | null;
  published_notebook_heads: string[] | null;
  published_runtime_state_heads: string[] | null;
  published_comms_doc_heads: string[] | null;
  published_comments_doc_heads: string[] | null;
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
  private loadedPublishedCommentsDocHeads: string[] | null = null;

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

  async getWorkstationAttachment(): Promise<WorkstationAttachmentState | null> {
    return this.withHost((host) =>
      normalizeWorkstationAttachmentJson(host.get_workstation_attachment_json()),
    );
  }

  /// Publish the room-host-owned active workstation attachment into the
  /// RuntimeStateDoc. Runtime peers do not mutate this map directly; the room
  /// host owns the notebook-visible selected-compute projection.
  async setWorkstationAttachment(
    attachment: WorkstationAttachmentState | null,
  ): Promise<RoomHostFrameResult> {
    return this.withHost((host) =>
      normalizeResult(host.set_workstation_attachment_json(JSON.stringify(attachment))),
    );
  }

  async receiveFrame(peer: RoomPeer, frame: TypedFrame): Promise<RoomHostFrameResult> {
    try {
      return await this.receiveFrameWithCurrentHost(peer, frame);
    } catch (error) {
      if (!shouldRecoverReceiveFrame(frame, error)) {
        throw error;
      }
      const recovered = await this.recoverHostFromLatestPublishedSnapshot(
        `receive_${frameTypeNameForRecovery(frame.type)}`,
        error,
      );
      if (!recovered) {
        throw error;
      }
      return this.syncPeerWithCurrentHost(peer);
    }
  }

  private async receiveFrameWithCurrentHost(
    peer: RoomPeer,
    frame: TypedFrame,
  ): Promise<RoomHostFrameResult> {
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
      const [notebookBytes, runtimeStateBytes, commsDocBytes, commentsDocBytes] = [
        toStoredArrayBuffer(host.save_notebook()),
        toStoredArrayBuffer(host.save_runtime_state_doc()),
        toStoredArrayBuffer(host.save_comms_doc()),
        toStoredArrayBuffer(host.save_comments_doc()),
      ];
      const metadata: RoomCheckpointMetadata = {
        version: CHECKPOINT_VERSION,
        notebook_heads: Array.from(host.get_heads_hex()),
        runtime_state_heads: Array.from(host.get_runtime_state_heads_hex()),
        comms_doc_heads: Array.from(host.get_comms_doc_heads_hex()),
        comments_doc_heads: Array.from(host.get_comments_doc_heads_hex()),
        saved_at: new Date().toISOString(),
        published_revision_id: this.loadedPublishedRevisionId,
        published_notebook_heads: this.loadedPublishedNotebookHeads,
        published_runtime_state_heads: this.loadedPublishedRuntimeStateHeads,
        published_comms_doc_heads: this.loadedPublishedCommsDocHeads,
        published_comments_doc_heads: this.loadedPublishedCommentsDocHeads,
      };
      await Promise.all([
        this.state.storage.put(CHECKPOINT_NOTEBOOK_KEY, notebookBytes),
        this.state.storage.put(CHECKPOINT_RUNTIME_STATE_KEY, runtimeStateBytes),
        this.state.storage.put(CHECKPOINT_COMMS_DOC_KEY, commsDocBytes),
        this.state.storage.put(CHECKPOINT_COMMENTS_DOC_KEY, commentsDocBytes),
        this.state.storage.put(CHECKPOINT_META_KEY, metadata),
      ]);
      cloudLog("debug", "room.materializer.checkpoint.saved", {
        notebook_id: this.notebookId,
        duration_ms: durationMs(startedAt),
        notebook_byte_length: notebookBytes.byteLength,
        runtime_state_byte_length: runtimeStateBytes.byteLength,
        comms_doc_byte_length: commsDocBytes.byteLength,
        comments_doc_byte_length: commentsDocBytes.byteLength,
        notebook_head_count: metadata.notebook_heads.length,
        runtime_state_head_count: metadata.runtime_state_heads.length,
        comms_doc_head_count: metadata.comms_doc_heads.length,
        comments_doc_head_count: metadata.comments_doc_heads.length,
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
      const checkpointResult = await this.loadCheckpointForHydration(startedAt);
      const checkpoint = checkpointResult.checkpoint;
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
              checkpoint.commentsDocBytes,
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
            latestPublished.commentsDocBytes,
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
          checkpoint.commentsDocBytes,
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
          published.commentsDocBytes,
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

      if (checkpointResult.error) {
        throw checkpointResult.error;
      }

      this.loadedPublishedRevisionId = null;
      this.loadedPublishedNotebookHeads = null;
      this.loadedPublishedRuntimeStateHeads = null;
      this.loadedPublishedCommsDocHeads = null;
      this.loadedPublishedCommentsDocHeads = null;
      const host = await createEmptyRoomHost(this.notebookId, roomHostActorLabel(this.notebookId));
      host.seed_initial_code_cell_if_empty(initialHostedCellId(this.notebookId));
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

  private async loadCheckpointForHydration(startedAt: number): Promise<{
    checkpoint: {
      notebookBytes: Uint8Array;
      runtimeStateBytes: Uint8Array;
      commsDocBytes?: Uint8Array;
      commentsDocBytes?: Uint8Array;
      metadata: RoomCheckpointMetadata;
    } | null;
    error: unknown | null;
  }> {
    try {
      return { checkpoint: await this.loadCheckpoint(), error: null };
    } catch (error) {
      cloudLog("warn", "room.materializer.checkpoint_load_failed", {
        notebook_id: this.notebookId,
        duration_ms: durationMs(startedAt),
        error: errorMessage(error),
        counter: "materializer_checkpoint_load_failures",
        counter_delta: 1,
      });
      return { checkpoint: null, error };
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
        published.commentsDocBytes,
      );
      this.markLoadedPublishedSnapshot(published.revisionId, host);
      await this.clearCheckpoint().catch((clearError: unknown) => {
        cloudLog("warn", "room.materializer.checkpoint_clear_failed", {
          notebook_id: this.notebookId,
          operation,
          published_revision_id: published.revisionId,
          error: errorMessage(clearError),
          counter: "materializer_checkpoint_clear_failures",
          counter_delta: 1,
        });
      });
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
      this.state.storage.delete(CHECKPOINT_COMMENTS_DOC_KEY),
      this.state.storage.delete(CHECKPOINT_META_KEY),
    ]);
  }

  private async loadCheckpoint(): Promise<{
    notebookBytes: Uint8Array;
    runtimeStateBytes: Uint8Array;
    commsDocBytes?: Uint8Array;
    commentsDocBytes?: Uint8Array;
    metadata: RoomCheckpointMetadata;
  } | null> {
    const [notebookBytes, runtimeStateBytes, commsDocBytes, commentsDocBytes] = await Promise.all([
      this.state.storage.get<ArrayBuffer>(CHECKPOINT_NOTEBOOK_KEY),
      this.state.storage.get<ArrayBuffer>(CHECKPOINT_RUNTIME_STATE_KEY),
      this.state.storage.get<ArrayBuffer>(CHECKPOINT_COMMS_DOC_KEY),
      this.state.storage.get<ArrayBuffer>(CHECKPOINT_COMMENTS_DOC_KEY),
    ]);
    const metadata =
      await this.state.storage.get<Partial<RoomCheckpointMetadata>>(CHECKPOINT_META_KEY);
    if (
      !notebookBytes ||
      !runtimeStateBytes ||
      (metadata?.version !== 2 &&
        metadata?.version !== 3 &&
        metadata?.version !== 4 &&
        metadata?.version !== 5 &&
        metadata?.version !== CHECKPOINT_VERSION)
    ) {
      return null;
    }
    if (metadata.version >= 5 && !commsDocBytes) {
      return null;
    }
    if (metadata.version === CHECKPOINT_VERSION && !commentsDocBytes) {
      return null;
    }
    return {
      notebookBytes: new Uint8Array(notebookBytes),
      runtimeStateBytes: new Uint8Array(runtimeStateBytes),
      commsDocBytes: commsDocBytes ? new Uint8Array(commsDocBytes) : undefined,
      commentsDocBytes: commentsDocBytes ? new Uint8Array(commentsDocBytes) : undefined,
      metadata: {
        version: typeof metadata.version === "number" ? metadata.version : CHECKPOINT_VERSION,
        notebook_heads: Array.isArray(metadata.notebook_heads) ? metadata.notebook_heads : [],
        runtime_state_heads: Array.isArray(metadata.runtime_state_heads)
          ? metadata.runtime_state_heads
          : [],
        comms_doc_heads: Array.isArray(metadata.comms_doc_heads) ? metadata.comms_doc_heads : [],
        comments_doc_heads: Array.isArray(metadata.comments_doc_heads)
          ? metadata.comments_doc_heads
          : [],
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
        published_comments_doc_heads: Array.isArray(metadata.published_comments_doc_heads)
          ? metadata.published_comments_doc_heads
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
    commentsDocBytes?: Uint8Array;
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
    this.loadedPublishedCommentsDocHeads = metadata.published_comments_doc_heads;
  }

  private markLoadedPublishedSnapshot(revisionId: string, host: RoomHostHandle): void {
    this.loadedPublishedRevisionId = revisionId;
    this.loadedPublishedNotebookHeads = Array.from(host.get_heads_hex());
    this.loadedPublishedRuntimeStateHeads = Array.from(host.get_runtime_state_heads_hex());
    this.loadedPublishedCommsDocHeads = Array.from(host.get_comms_doc_heads_hex());
    this.loadedPublishedCommentsDocHeads = Array.from(host.get_comments_doc_heads_hex());
  }

  private async loadLatestPublishedSnapshotPair(): Promise<{
    revisionId: string;
    createdAt: string;
    notebookBytes: Uint8Array;
    runtimeStateBytes: Uint8Array;
    commsDocBytes?: Uint8Array;
    commentsDocBytes?: Uint8Array;
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

    const [notebookObject, runtimeObject, commsObject, commentsObject] = await Promise.all([
      this.env.NOTEBOOK_SNAPSHOTS.get(latest.snapshot_key),
      this.env.NOTEBOOK_SNAPSHOTS.get(latest.runtime_snapshot_key),
      latest.comms_snapshot_key ? this.env.NOTEBOOK_SNAPSHOTS.get(latest.comms_snapshot_key) : null,
      latest.comments_snapshot_key
        ? this.env.NOTEBOOK_SNAPSHOTS.get(latest.comments_snapshot_key)
        : null,
    ]);
    if (
      !notebookObject ||
      !runtimeObject ||
      (latest.comms_snapshot_key && !commsObject) ||
      (latest.comments_snapshot_key && !commentsObject)
    ) {
      cloudLog("warn", "room.materializer.snapshot_pair_missing", {
        notebook_id: this.notebookId,
        notebook_snapshot_missing: !notebookObject,
        runtime_state_snapshot_missing: !runtimeObject,
        comms_doc_snapshot_missing: Boolean(latest.comms_snapshot_key && !commsObject),
        comments_doc_snapshot_missing: Boolean(latest.comments_snapshot_key && !commentsObject),
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
      commentsDocBytes: commentsObject
        ? new Uint8Array(await commentsObject.arrayBuffer())
        : undefined,
    };
  }
}

function roomHostActorLabel(notebookId: string): string {
  return `${ROOM_HOST_ACTOR_PRINCIPAL}/room:${stableRoomKey(notebookId)}`;
}

function initialHostedCellId(notebookId: string): string {
  return `cell-room-${stableRoomKey(notebookId)}`;
}

// This is part of the hosted room actor contract: empty-room bootstrap must
// derive the same room-owned actor and starter-cell id across Durable Object
// restarts so uncheckpointed rooms do not fork different seq-2 changes.
function stableRoomKey(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function shouldRecoverReceiveFrame(frame: TypedFrame, error: unknown): boolean {
  if (!isMaterializedSyncFrameForRecovery(frame.type)) {
    return false;
  }
  return isRecoverableAutomergeSyncBoundaryError(errorMessage(error));
}

function isMaterializedSyncFrameForRecovery(type: FrameTypeValue): boolean {
  return (
    type === FrameType.AUTOMERGE_SYNC ||
    type === FrameType.RUNTIME_STATE_SYNC ||
    type === FrameType.COMMS_DOC_SYNC ||
    type === FrameType.COMMENTS_DOC_SYNC
  );
}

function isRecoverableAutomergeSyncBoundaryError(message: string): boolean {
  return (
    /recursive use of an object detected which would lead to unsafe aliasing/i.test(message) ||
    /\bPatchLogMismatch\b/i.test(message) ||
    /patch logs cannot be shared between documents/i.test(message)
  );
}

function frameTypeNameForRecovery(type: FrameTypeValue): string {
  switch (type) {
    case FrameType.AUTOMERGE_SYNC:
      return "notebook_sync";
    case FrameType.RUNTIME_STATE_SYNC:
      return "runtime_state_sync";
    case FrameType.COMMS_DOC_SYNC:
      return "comms_doc_sync";
    case FrameType.COMMENTS_DOC_SYNC:
      return "comments_doc_sync";
    default:
      return `frame_${type}`;
  }
}

export function isMaterializedSyncFrame(type: FrameTypeValue): boolean {
  // REQUEST routes through the room host too: an authorized ExecuteCell request
  // is turned into queued execution intent by the one peer that may create it.
  // Without this it would fall through to broadcast and never be dispatched.
  return (
    type === FrameType.AUTOMERGE_SYNC ||
    type === FrameType.RUNTIME_STATE_SYNC ||
    type === FrameType.COMMS_DOC_SYNC ||
    type === FrameType.COMMENTS_DOC_SYNC ||
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

function normalizeWorkstationAttachmentJson(value: string): WorkstationAttachmentState | null {
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || isWorkstationAttachmentState(parsed)) {
    return parsed;
  }
  throw new Error("RoomHostHandle returned an invalid workstation attachment");
}

function isWorkstationAttachmentState(value: unknown): value is WorkstationAttachmentState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.workstation_id === "string" &&
    typeof record.display_name === "string" &&
    typeof record.provider === "string" &&
    typeof record.default_environment_label === "string" &&
    typeof record.environment_policy === "string" &&
    typeof record.status === "string"
  );
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
    headsChanged(metadata.comms_doc_heads, metadata.published_comms_doc_heads) ||
    headsChanged(metadata.comments_doc_heads, metadata.published_comments_doc_heads)
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
