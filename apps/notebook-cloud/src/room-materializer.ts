import type { DurableObjectState, Env } from "./cloudflare-types.ts";
import { FrameType, encodeTypedFrame, type FrameTypeValue, type TypedFrame } from "./protocol.ts";
import { createEmptyRoomHost, loadRoomHostSnapshot, type RoomHostHandle } from "./runtimed-wasm.ts";
import { getNotebookCatalog } from "./storage.ts";
import { allowsNotebookWrite, type AuthenticatedConnection } from "./identity.ts";
import { cloudLog, durationMs, errorMessage } from "./observability.ts";

const ROOM_HOST_ACTOR_LABEL = "system/schema:notebook-cloud-room";
const CHECKPOINT_NOTEBOOK_KEY = "room-host:notebook-doc";
const CHECKPOINT_RUNTIME_STATE_KEY = "room-host:runtime-state-doc";
const CHECKPOINT_META_KEY = "room-host:checkpoint";
const CHECKPOINT_VERSION = 2;

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
  saved_at: string;
}

interface RoomPeer {
  id: string;
  identity: AuthenticatedConnection;
}

export class RoomMaterializer {
  private hostReady: Promise<RoomHostHandle> | undefined;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly notebookId: string,
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async syncPeer(peer: RoomPeer): Promise<RoomHostFrameResult> {
    return this.withHost((host) =>
      normalizeResult(
        host.sync_peer(
          peer.id,
          allowsNotebookWrite(peer.identity.scope),
          allowsHostedRuntimeStateWrite(peer.identity),
        ),
      ),
    );
  }

  async removePeer(peerId: string): Promise<void> {
    await this.withHost((host) => {
      host.remove_peer(peerId);
    });
  }

  async receiveFrame(peer: RoomPeer, frame: TypedFrame): Promise<RoomHostFrameResult> {
    const canWrite =
      frame.type === FrameType.AUTOMERGE_SYNC
        ? allowsNotebookWrite(peer.identity.scope)
        : allowsHostedRuntimeStateWrite(peer.identity);
    const canWriteAllNotebookChanges = peer.identity.scope === "owner";
    const encoded = encodeTypedFrame(frame.type, frame.payload);
    return this.withHost((host) =>
      normalizeResult(
        host.receive_peer_frame(
          peer.id,
          peer.identity.principal,
          canWrite,
          canWriteAllNotebookChanges,
          encoded,
        ),
      ),
    );
  }

  async checkpoint(): Promise<void> {
    const startedAt = Date.now();
    await this.withHost(async (host) => {
      const [notebookBytes, runtimeStateBytes] = [
        toStoredArrayBuffer(host.save_notebook()),
        toStoredArrayBuffer(host.save_runtime_state_doc()),
      ];
      const metadata: RoomCheckpointMetadata = {
        version: CHECKPOINT_VERSION,
        notebook_heads: Array.from(host.get_heads_hex()),
        runtime_state_heads: Array.from(host.get_runtime_state_heads_hex()),
        saved_at: new Date().toISOString(),
      };
      await Promise.all([
        this.state.storage.put(CHECKPOINT_NOTEBOOK_KEY, notebookBytes),
        this.state.storage.put(CHECKPOINT_RUNTIME_STATE_KEY, runtimeStateBytes),
        this.state.storage.put(CHECKPOINT_META_KEY, metadata),
      ]);
      cloudLog("debug", "room.materializer.checkpoint.saved", {
        notebook_id: this.notebookId,
        duration_ms: durationMs(startedAt),
        notebook_byte_length: notebookBytes.byteLength,
        runtime_state_byte_length: runtimeStateBytes.byteLength,
        notebook_head_count: metadata.notebook_heads.length,
        runtime_state_head_count: metadata.runtime_state_heads.length,
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
        const host = loadRoomHostSnapshot(checkpoint.notebookBytes, checkpoint.runtimeStateBytes);
        cloudLog("info", "room.materializer.loaded", {
          notebook_id: this.notebookId,
          source: "durable_object_checkpoint",
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
        const host = loadRoomHostSnapshot(published.notebookBytes, published.runtimeStateBytes);
        cloudLog("info", "room.materializer.loaded", {
          notebook_id: this.notebookId,
          source: "published_snapshot_pair",
          duration_ms: durationMs(startedAt),
          notebook_byte_length: published.notebookBytes.byteLength,
          runtime_state_byte_length: published.runtimeStateBytes.byteLength,
          counter: "materializer_loads",
          counter_delta: 1,
        });
        return host;
      }

      const host = createEmptyRoomHost(this.notebookId, ROOM_HOST_ACTOR_LABEL);
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

  private async loadCheckpoint(): Promise<{
    notebookBytes: Uint8Array;
    runtimeStateBytes: Uint8Array;
  } | null> {
    const [notebookBytes, runtimeStateBytes] = await Promise.all([
      this.state.storage.get<ArrayBuffer>(CHECKPOINT_NOTEBOOK_KEY),
      this.state.storage.get<ArrayBuffer>(CHECKPOINT_RUNTIME_STATE_KEY),
    ]);
    const metadata =
      await this.state.storage.get<Partial<RoomCheckpointMetadata>>(CHECKPOINT_META_KEY);
    if (!notebookBytes || !runtimeStateBytes || metadata?.version !== CHECKPOINT_VERSION) {
      return null;
    }
    return {
      notebookBytes: new Uint8Array(notebookBytes),
      runtimeStateBytes: new Uint8Array(runtimeStateBytes),
    };
  }

  private async loadLatestPublishedSnapshotPair(): Promise<{
    notebookBytes: Uint8Array;
    runtimeStateBytes: Uint8Array;
  } | null> {
    if (!this.env.DB || !this.env.NOTEBOOK_SNAPSHOTS) {
      return null;
    }

    const catalog = await getNotebookCatalog(this.env, this.notebookId);
    const latest = catalog?.revisions.find(
      (revision) => revision.id === catalog.notebook.latest_revision_id,
    );
    if (!latest?.runtime_snapshot_key) {
      return null;
    }

    const [notebookObject, runtimeObject] = await Promise.all([
      this.env.NOTEBOOK_SNAPSHOTS.get(latest.snapshot_key),
      this.env.NOTEBOOK_SNAPSHOTS.get(latest.runtime_snapshot_key),
    ]);
    if (!notebookObject || !runtimeObject) {
      cloudLog("warn", "room.materializer.snapshot_pair_missing", {
        notebook_id: this.notebookId,
        notebook_snapshot_missing: !notebookObject,
        runtime_state_snapshot_missing: !runtimeObject,
        counter: "materializer_snapshot_pair_missing",
        counter_delta: 1,
      });
      return null;
    }

    return {
      notebookBytes: new Uint8Array(await notebookObject.arrayBuffer()),
      runtimeStateBytes: new Uint8Array(await runtimeObject.arrayBuffer()),
    };
  }
}

export function isMaterializedSyncFrame(type: FrameTypeValue): boolean {
  return type === FrameType.AUTOMERGE_SYNC || type === FrameType.RUNTIME_STATE_SYNC;
}

export function typedFrameFromRoomHostOutbound(frame: RoomHostOutboundFrame): Uint8Array {
  return encodeTypedFrame(frame.frame_type, toUint8Array(frame.payload));
}

function allowsHostedRuntimeStateWrite(identity: AuthenticatedConnection): boolean {
  // Hosted editors are markdown-only until RuntimeStateDoc path validation lands.
  return identity.scope === "owner" || identity.scope === "runtime_peer";
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

function toUint8Array(value: Uint8Array | number[]): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function toStoredArrayBuffer(value: Uint8Array | number[]): ArrayBuffer {
  const bytes = toUint8Array(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
