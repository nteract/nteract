import type { DurableObjectState, Env } from "./cloudflare-types.ts";
import { FrameType, encodeTypedFrame, type FrameTypeValue, type TypedFrame } from "./protocol.ts";
import {
  createEmptyMarkdownRoomHost,
  loadMarkdownRoomHostSnapshot,
  type MarkdownRoomHostHandle,
} from "./runtimed-wasm.ts";
import { getMarkdownDocumentCatalog } from "./storage.ts";
import type { AuthenticatedConnection } from "./identity.ts";
import { cloudLog, durationMs, errorMessage } from "./observability.ts";

const MARKDOWN_ROOM_ACTOR_PRINCIPAL = "system:notebook-cloud-markdown-room";
const CHECKPOINT_DOC_KEY = "markdown-room:doc";
const CHECKPOINT_META_KEY = "markdown-room:checkpoint";
const CHECKPOINT_VERSION = 1;

interface RoomHostOutboundFrame {
  peer_id: string;
  frame_type: FrameTypeValue;
  payload: Uint8Array | number[];
}

export interface MarkdownRoomFrameResult {
  changed: boolean;
  outbound: RoomHostOutboundFrame[];
}

interface MarkdownRoomCheckpointMetadata {
  version: number;
  heads: string[];
  saved_at: string;
}

interface MarkdownRoomPeer {
  id: string;
  identity: AuthenticatedConnection;
}

export class MarkdownRoomMaterializer {
  private hostReady: Promise<MarkdownRoomHostHandle> | undefined;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly documentId: string,
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async syncPeer(peer: MarkdownRoomPeer): Promise<MarkdownRoomFrameResult> {
    return this.withHost((host) =>
      normalizeMarkdownRoomResult(host.sync_peer(peer.id, peer.identity.scope)),
    );
  }

  async receiveFrame(peer: MarkdownRoomPeer, frame: TypedFrame): Promise<MarkdownRoomFrameResult> {
    const encoded = encodeTypedFrame(frame.type, frame.payload);
    return this.withHost((host) =>
      normalizeMarkdownRoomResult(
        host.receive_peer_frame(peer.id, peer.identity.principal, peer.identity.scope, encoded),
      ),
    );
  }

  async removePeer(peerId: string): Promise<void> {
    await this.withHost((host) => {
      host.remove_peer(peerId);
    });
  }

  async checkpoint(): Promise<void> {
    const startedAt = Date.now();
    await this.withHost(async (host) => {
      const bytes = toStoredArrayBuffer(host.save_doc());
      const metadata: MarkdownRoomCheckpointMetadata = {
        version: CHECKPOINT_VERSION,
        heads: Array.from(host.get_heads_hex()),
        saved_at: new Date().toISOString(),
      };
      await Promise.all([
        this.state.storage.put(CHECKPOINT_DOC_KEY, bytes),
        this.state.storage.put(CHECKPOINT_META_KEY, metadata),
      ]);
      cloudLog("debug", "markdown_room.materializer.checkpoint.saved", {
        document_id: this.documentId,
        duration_ms: durationMs(startedAt),
        byte_length: bytes.byteLength,
        head_count: metadata.heads.length,
        counter: "markdown_materializer_checkpoints_saved",
        counter_delta: 1,
      });
    });
  }

  private async withHost<T>(
    operation: (host: MarkdownRoomHostHandle) => T | Promise<T>,
  ): Promise<T> {
    const run = this.operationQueue.then(async () => operation(await this.loadHost()));
    this.operationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async loadHost(): Promise<MarkdownRoomHostHandle> {
    this.hostReady ??= this.loadHostFromStorage().catch((error: unknown) => {
      this.hostReady = undefined;
      throw error;
    });
    return this.hostReady;
  }

  private async loadHostFromStorage(): Promise<MarkdownRoomHostHandle> {
    const startedAt = Date.now();
    const checkpoint = await this.loadCheckpoint().catch((error: unknown) => {
      cloudLog("warn", "markdown_room.materializer.checkpoint_load_failed", {
        document_id: this.documentId,
        duration_ms: durationMs(startedAt),
        error: errorMessage(error),
        counter: "markdown_materializer_checkpoint_load_failures",
        counter_delta: 1,
      });
      return null;
    });
    if (checkpoint) {
      const host = await loadMarkdownRoomHostSnapshot(checkpoint.bytes);
      cloudLog("info", "markdown_room.materializer.loaded", {
        document_id: this.documentId,
        source: "durable_object_checkpoint",
        duration_ms: durationMs(startedAt),
        byte_length: checkpoint.bytes.byteLength,
        counter: "markdown_materializer_loads",
        counter_delta: 1,
      });
      return host;
    }

    const catalog = await getMarkdownDocumentCatalog(this.env, this.documentId);
    if (!catalog) {
      throw new Error(`Markdown document not found: ${this.documentId}`);
    }
    const title = catalog.document.title?.trim() || "Untitled Markdown";
    const host = await createEmptyMarkdownRoomHost(
      this.documentId,
      title,
      markdownRoomActorLabel(this.documentId),
    );
    cloudLog("info", "markdown_room.materializer.loaded", {
      document_id: this.documentId,
      source: "empty_room",
      duration_ms: durationMs(startedAt),
      counter: "markdown_materializer_loads",
      counter_delta: 1,
    });
    return host;
  }

  private async loadCheckpoint(): Promise<{
    bytes: Uint8Array;
    metadata: MarkdownRoomCheckpointMetadata | null;
  } | null> {
    const [storedBytes, metadata] = await Promise.all([
      this.state.storage.get<ArrayBuffer>(CHECKPOINT_DOC_KEY),
      this.state.storage.get<MarkdownRoomCheckpointMetadata>(CHECKPOINT_META_KEY),
    ]);
    if (!storedBytes) {
      return null;
    }
    return { bytes: new Uint8Array(storedBytes), metadata: metadata ?? null };
  }
}

export function isMarkdownMaterializedSyncFrame(type: FrameTypeValue): boolean {
  return type === FrameType.AUTOMERGE_SYNC;
}

export function typedFrameFromMarkdownRoomOutbound(frame: RoomHostOutboundFrame): Uint8Array {
  return encodeTypedFrame(frame.frame_type, Uint8Array.from(frame.payload));
}

function markdownRoomActorLabel(documentId: string): string {
  return `${MARKDOWN_ROOM_ACTOR_PRINCIPAL}/room:${documentId}`;
}

function normalizeMarkdownRoomResult(value: unknown): MarkdownRoomFrameResult {
  if (!value || typeof value !== "object") {
    return { changed: false, outbound: [] };
  }
  const record = value as Record<string, unknown>;
  return {
    changed: Boolean(record.changed),
    outbound: Array.isArray(record.outbound)
      ? record.outbound.flatMap((frame) => normalizeOutboundFrame(frame))
      : [],
  };
}

function normalizeOutboundFrame(value: unknown): RoomHostOutboundFrame[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  const peerId = typeof record.peer_id === "string" ? record.peer_id : null;
  const frameType = Number(record.frame_type);
  const payload = Array.isArray(record.payload)
    ? (record.payload.filter((byte) => Number.isInteger(byte)) as number[])
    : record.payload instanceof Uint8Array
      ? record.payload
      : null;
  if (!peerId || !Number.isInteger(frameType) || !payload) {
    return [];
  }
  return [{ peer_id: peerId, frame_type: frameType as FrameTypeValue, payload }];
}

function toStoredArrayBuffer(bytes: Uint8Array | number[]): ArrayBuffer {
  const view = Uint8Array.from(bytes);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}
