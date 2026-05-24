import type { CloudflareWebSocket, DurableObjectState, Env } from "./cloudflare-types.ts";
import {
  allowsRuntimeStateWrite,
  isAnonymousViewer,
  readTrustedIdentity,
  type AuthenticatedConnection,
} from "./identity.ts";
import {
  encodeJsonFrame,
  encodeTypedFrame,
  FrameType,
  frameSizeLimits,
  frameTypeName,
  isClientWritableFrame,
  splitTypedFrame,
  type SessionControlMessage,
  type TypedFrame,
} from "./protocol.ts";
import { cloudLog, durationMs, errorMessage } from "./observability.ts";
import { rewritePresenceIngress } from "./runtimed-wasm.ts";
import {
  isMaterializedSyncFrame,
  RoomMaterializer,
  typedFrameFromRoomHostOutbound,
  type RoomHostFrameResult,
} from "./room-materializer.ts";

interface Peer {
  id: string;
  socket: CloudflareWebSocket;
  identity: AuthenticatedConnection;
  connectedAt: string;
}

interface StoredRoomFrame {
  sequence: number;
  peerId: string;
  actorLabel: string;
  connectionScope: string;
  frameType: number;
  byteLength: number;
  receivedAt: string;
}

interface PeerAttachment {
  notebookId: string;
  peerId: string;
  identity: AuthenticatedConnection;
  connectedAt: string;
}

const MAX_STORED_FRAMES = 500;

export class NotebookRoom {
  private readonly peers = new Map<string, Peer>();
  private readonly pendingRemovals = new Map<string, { notebookId: string; peer: Peer }>();
  private nextFrameSequence = 0;
  private frameSequenceReady: Promise<void> | undefined;
  private framePersistQueue: Promise<void> = Promise.resolve();
  private broadcastDepth = 0;
  private readonly materializers = new Map<string, RoomMaterializer>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.restoreHibernatedPeers();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const notebookId = notebookIdFromPath(url.pathname);

    if (!notebookId) {
      return json({ error: "notebook id is required" }, 400);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "expected WebSocket upgrade" }, 426);
    }

    let identity: AuthenticatedConnection;
    try {
      identity = readTrustedIdentity(request);
    } catch (error) {
      return json({ error: String(error) }, 401);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const peer: Peer = {
      id: crypto.randomUUID(),
      socket: server,
      identity,
      connectedAt: new Date().toISOString(),
    };

    this.acceptPeerSocket(notebookId, peer);
    this.peers.set(peer.id, peer);
    cloudLog("info", "room.connection.accepted", {
      notebook_id: notebookId,
      peer_id: peer.id,
      principal: identity.principal,
      scope: identity.scope,
      room_peer_count: this.peers.size,
      counter: "connections_accepted",
      counter_delta: 1,
    });

    this.sendControl(notebookId, peer, {
      type: "cloud_room_ready",
      protocol: "v4",
      notebook_id: notebookId,
      peer_id: peer.id,
      actor_label: identity.actorLabel,
      connection_scope: identity.scope,
      room_peer_count: this.peers.size,
      timestamp: peer.connectedAt,
    });

    this.broadcastControl(
      notebookId,
      {
        type: "cloud_peer_joined",
        notebook_id: notebookId,
        peer_id: peer.id,
        actor_label: identity.actorLabel,
        room_peer_count: this.peers.size,
        timestamp: peer.connectedAt,
      },
      peer.id,
    );
    this.state.waitUntil(this.syncPeerFromRoomHost(notebookId, peer));

    return new Response(null, {
      status: 101,
      headers: webSocketUpgradeHeaders(identity),
      webSocket: client,
    } as ResponseInit & { webSocket: CloudflareWebSocket });
  }

  async webSocketMessage(
    socket: CloudflareWebSocket,
    message: string | ArrayBuffer | ArrayBufferView,
  ): Promise<void> {
    const peer = this.peerForSocket(socket);
    if (!peer) {
      return;
    }

    const attachment = socketAttachment(socket);
    if (!attachment) {
      return;
    }

    await this.handleMessage(attachment.notebookId, peer, message);
  }

  webSocketClose(socket: CloudflareWebSocket): void {
    this.removeAttachedPeer(socket);
  }

  webSocketError(socket: CloudflareWebSocket): void {
    this.removeAttachedPeer(socket);
  }

  private restoreHibernatedPeers(): void {
    const sockets = this.state.getWebSockets?.() ?? [];
    for (const socket of sockets) {
      const attachment = socketAttachment(socket);
      if (!attachment) {
        continue;
      }

      this.peers.set(attachment.peerId, {
        id: attachment.peerId,
        socket,
        identity: attachment.identity,
        connectedAt: attachment.connectedAt,
      });
    }
    if (sockets.length > 0) {
      cloudLog("info", "room.hibernation.restored_peers", {
        restored_peer_count: this.peers.size,
      });
    }
  }

  private acceptPeerSocket(notebookId: string, peer: Peer): void {
    const attachment: PeerAttachment = {
      notebookId,
      peerId: peer.id,
      identity: peer.identity,
      connectedAt: peer.connectedAt,
    };

    if (this.state.acceptWebSocket && peer.socket.serializeAttachment) {
      this.state.acceptWebSocket(peer.socket);
      peer.socket.serializeAttachment(attachment);
      return;
    }

    peer.socket.accept();
    peer.socket.addEventListener("message", (event) => {
      this.state.waitUntil(this.handleMessage(notebookId, peer, event.data));
    });
    peer.socket.addEventListener("close", () => {
      this.removePeer(notebookId, peer);
    });
    peer.socket.addEventListener("error", () => {
      this.removePeer(notebookId, peer);
    });
  }

  private peerForSocket(socket: CloudflareWebSocket): Peer | undefined {
    const attachment = socketAttachment(socket);
    if (!attachment) {
      return undefined;
    }
    return this.peers.get(attachment.peerId);
  }

  private removeAttachedPeer(socket: CloudflareWebSocket): void {
    const attachment = socketAttachment(socket);
    if (!attachment) {
      return;
    }

    const peer = this.peers.get(attachment.peerId);
    if (!peer) {
      return;
    }

    this.removePeer(attachment.notebookId, peer);
  }

  private async handleMessage(
    notebookId: string,
    peer: Peer,
    message: string | ArrayBuffer | ArrayBufferView,
  ): Promise<void> {
    if (typeof message === "string") {
      this.rejectFrame(
        notebookId,
        peer,
        undefined,
        "typed-frame WebSocket messages must be binary",
      );
      return;
    }

    let frame: TypedFrame;
    try {
      frame = splitTypedFrame(message);
    } catch (error) {
      this.rejectFrame(notebookId, peer, undefined, String(error));
      return;
    }

    const sizeLimits = frameSizeLimits(frame.type);
    if (frame.payload.byteLength > sizeLimits.cap) {
      this.rejectFrame(
        notebookId,
        peer,
        frame.type,
        `${frameTypeName(frame.type)} frame payload exceeds ${sizeLimits.cap} byte limit`,
      );
      return;
    }

    if (!isClientWritableFrame(frame.type)) {
      this.rejectFrame(
        notebookId,
        peer,
        frame.type,
        `${frameTypeName(frame.type)} is server-originated`,
      );
      return;
    }

    if (!this.scopeAllowsFrame(peer.identity, frame)) {
      this.rejectFrame(
        notebookId,
        peer,
        frame.type,
        `${peer.identity.scope} cannot write ${frameTypeName(frame.type)} frames`,
      );
      return;
    }

    let normalizedFrame = frame;
    if (frame.type === FrameType.PRESENCE) {
      try {
        normalizedFrame = await rewritePresenceFrame(frame, peer);
      } catch (error) {
        this.rejectFrame(
          notebookId,
          peer,
          frame.type,
          `unsupported presence payload: ${String(error)}`,
        );
        return;
      }
    }

    const receivedAt = new Date().toISOString();
    if (!shouldBroadcastFrame(normalizedFrame, peer.identity)) {
      // Anonymous public viewers are read-only observers. Their presence is
      // acknowledged locally but not broadcast or persisted as room activity.
      cloudLog("debug", "room.presence.local_only", {
        notebook_id: notebookId,
        peer_id: peer.id,
        principal: peer.identity.principal,
        scope: peer.identity.scope,
        frame_type: frameTypeName(normalizedFrame.type),
        byte_length: normalizedFrame.payload.byteLength,
        counter: "local_only_presence_frames",
        counter_delta: 1,
      });
      this.sendControl(notebookId, peer, {
        type: "cloud_frame_accepted",
        notebook_id: notebookId,
        peer_id: peer.id,
        frame_type: normalizedFrame.type,
        byte_length: normalizedFrame.payload.byteLength,
        timestamp: receivedAt,
      });
      return;
    }

    if (isMaterializedSyncFrame(normalizedFrame.type)) {
      let result: RoomHostFrameResult;
      const materializer = this.materializerFor(notebookId);
      const startedAt = Date.now();
      try {
        result = await materializer.receiveFrame(peer, normalizedFrame);
      } catch (error) {
        this.rejectFrame(
          notebookId,
          peer,
          normalizedFrame.type,
          `room host rejected ${frameTypeName(normalizedFrame.type)} frame: ${String(error)}`,
        );
        return;
      }
      const persistMaterializedFrame = shouldPersistMaterializedSyncFrame(result);
      cloudLog("debug", "room.materialized_frame.applied", {
        notebook_id: notebookId,
        peer_id: peer.id,
        principal: peer.identity.principal,
        scope: peer.identity.scope,
        frame_type: frameTypeName(normalizedFrame.type),
        byte_length: normalizedFrame.payload.byteLength,
        duration_ms: durationMs(startedAt),
        changed: result.changed,
        notebook_changed: result.notebook_changed,
        runtime_state_changed: result.runtime_state_changed,
        persisted: persistMaterializedFrame,
        outbound_frame_count: result.outbound.length,
        counter: "materialized_frames_applied",
        counter_delta: 1,
      });

      if (persistMaterializedFrame) {
        this.state.waitUntil(
          this.persistFrame(peer, normalizedFrame, receivedAt).catch(() => undefined),
        );
      }
      this.deliverRoomHostFrames(notebookId, result);
      if (result.changed) {
        this.state.waitUntil(materializer.checkpoint().catch(() => undefined));
      }
      this.sendControl(notebookId, peer, {
        type: "cloud_frame_accepted",
        notebook_id: notebookId,
        peer_id: peer.id,
        frame_type: normalizedFrame.type,
        byte_length: normalizedFrame.payload.byteLength,
        timestamp: receivedAt,
      });
      return;
    }

    try {
      await this.persistFrame(peer, normalizedFrame, receivedAt);
    } catch (error) {
      this.rejectFrame(
        notebookId,
        peer,
        normalizedFrame.type,
        `failed to persist ${frameTypeName(normalizedFrame.type)} frame: ${String(error)}`,
      );
      return;
    }

    this.broadcastFrame(
      notebookId,
      encodeTypedFrame(normalizedFrame.type, normalizedFrame.payload),
      peer.id,
    );
    this.sendControl(notebookId, peer, {
      type: "cloud_frame_accepted",
      notebook_id: notebookId,
      peer_id: peer.id,
      frame_type: normalizedFrame.type,
      byte_length: normalizedFrame.payload.byteLength,
      timestamp: receivedAt,
    });
  }

  private scopeAllowsFrame(identity: AuthenticatedConnection, frame: TypedFrame): boolean {
    switch (frame.type) {
      case FrameType.AUTOMERGE_SYNC:
      case FrameType.RUNTIME_STATE_SYNC:
        // These frames are both data and protocol control. Read-only peers may
        // send empty sync acks/needs; RoomMaterializer rejects messages carrying
        // document changes when the connection lacks write scope.
        return true;
      case FrameType.PUT_BLOB:
        return allowsRuntimeStateWrite(identity.scope);
      case FrameType.POOL_STATE_SYNC:
        return identity.scope === "owner";
      case FrameType.REQUEST:
        return identity.scope !== "viewer";
      case FrameType.PRESENCE:
        return true;
      default:
        return false;
    }
  }

  private async syncPeerFromRoomHost(notebookId: string, peer: Peer): Promise<void> {
    const startedAt = Date.now();
    try {
      const result = await this.materializerFor(notebookId).syncPeer(peer);
      cloudLog("debug", "room.peer_sync.completed", {
        notebook_id: notebookId,
        peer_id: peer.id,
        principal: peer.identity.principal,
        scope: peer.identity.scope,
        duration_ms: durationMs(startedAt),
        outbound_frame_count: result.outbound.length,
        counter: "peer_sync_completed",
        counter_delta: 1,
      });
      this.deliverRoomHostFrames(notebookId, result);
    } catch (error) {
      cloudLog("warn", "room.peer_sync.failed", {
        notebook_id: notebookId,
        peer_id: peer.id,
        principal: peer.identity.principal,
        scope: peer.identity.scope,
        duration_ms: durationMs(startedAt),
        error: errorMessage(error),
        counter: "peer_sync_failed",
        counter_delta: 1,
      });
      this.removePeer(notebookId, peer);
    }
  }

  private materializerFor(notebookId: string): RoomMaterializer {
    let materializer = this.materializers.get(notebookId);
    if (!materializer) {
      materializer = new RoomMaterializer(notebookId, this.state, this.env);
      this.materializers.set(notebookId, materializer);
    }
    return materializer;
  }

  private deliverRoomHostFrames(notebookId: string, result: RoomHostFrameResult): void {
    for (const outbound of result.outbound) {
      const target = this.peers.get(outbound.peer_id);
      if (!target) {
        continue;
      }
      this.sendFrameToPeer(notebookId, target, typedFrameFromRoomHostOutbound(outbound));
    }
  }

  private async persistFrame(peer: Peer, frame: TypedFrame, receivedAt: string): Promise<void> {
    const operation = this.framePersistQueue
      .catch(() => undefined)
      .then(async () => {
        await this.prepareFrameSequence();
        const sequence = this.nextFrameSequence + 1;
        const stored: StoredRoomFrame = {
          sequence,
          peerId: peer.id,
          actorLabel: peer.identity.actorLabel,
          connectionScope: peer.identity.scope,
          frameType: frame.type,
          byteLength: frame.payload.byteLength,
          receivedAt,
        };

        await this.state.storage.put(frameStorageKey(sequence), stored);
        await this.state.storage.put("frame_sequence", sequence);
        this.nextFrameSequence = sequence;
        this.state.waitUntil(
          this.evictStoredFrame(sequence - MAX_STORED_FRAMES).catch(() => undefined),
        );
      });

    this.framePersistQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }

  private async prepareFrameSequence(): Promise<void> {
    this.frameSequenceReady ??= this.state.storage
      .get<number>("frame_sequence")
      .then((sequence) => {
        this.nextFrameSequence = sequence ?? 0;
      });

    await this.frameSequenceReady;
  }

  private async evictStoredFrame(sequence: number): Promise<void> {
    if (sequence < 1) {
      return;
    }

    await this.state.storage.delete(frameStorageKey(sequence));
  }

  private rejectFrame(
    notebookId: string,
    peer: Peer,
    frameType: number | undefined,
    reason: string,
  ): void {
    cloudLog("warn", "room.frame.rejected", {
      notebook_id: notebookId,
      peer_id: peer.id,
      principal: peer.identity.principal,
      scope: peer.identity.scope,
      frame_type: frameType === undefined ? "unknown" : frameTypeName(frameType),
      reason,
      room_peer_count: this.peers.size,
      counter: "rejected_frames",
      counter_delta: 1,
    });
    this.sendControl(notebookId, peer, {
      type: "cloud_frame_rejected",
      notebook_id: notebookId,
      peer_id: peer.id,
      frame_type: frameType,
      reason,
      timestamp: new Date().toISOString(),
    });
  }

  private sendControl(notebookId: string, peer: Peer, message: SessionControlMessage): void {
    this.sendFrameToPeer(notebookId, peer, encodeJsonFrame(FrameType.SESSION_CONTROL, message));
  }

  private broadcastControl(
    notebookId: string,
    message: SessionControlMessage,
    excludePeerId?: string,
  ): void {
    const frame = encodeJsonFrame(FrameType.SESSION_CONTROL, message);
    this.broadcastFrame(notebookId, frame, excludePeerId);
  }

  private broadcastFrame(notebookId: string, frame: Uint8Array, excludePeerId?: string): void {
    const peers = Array.from(this.peers.values()).filter((peer) => peer.id !== excludePeerId);
    this.broadcastDepth += 1;
    try {
      for (const peer of peers) {
        if (!this.trySendFrame(peer, frame)) {
          this.queuePeerRemoval(notebookId, peer);
        }
      }
    } finally {
      this.broadcastDepth -= 1;
      if (this.broadcastDepth === 0) {
        this.flushPendingRemovals();
      }
    }
  }

  private sendFrameToPeer(notebookId: string, peer: Peer, frame: Uint8Array): void {
    if (!this.trySendFrame(peer, frame)) {
      cloudLog("warn", "room.peer_send.failed", {
        notebook_id: notebookId,
        peer_id: peer.id,
        principal: peer.identity.principal,
        scope: peer.identity.scope,
        frame_byte_length: frame.byteLength,
        counter: "peer_send_failed",
        counter_delta: 1,
      });
      this.removePeer(notebookId, peer);
    }
  }

  private trySendFrame(peer: Peer, frame: Uint8Array): boolean {
    try {
      peer.socket.send(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength));
      return true;
    } catch {
      return false;
    }
  }

  private queuePeerRemoval(notebookId: string, peer: Peer): void {
    if (!this.peers.has(peer.id)) {
      return;
    }

    this.pendingRemovals.set(peer.id, { notebookId, peer });
  }

  private flushPendingRemovals(): void {
    while (this.pendingRemovals.size > 0) {
      const removals = Array.from(this.pendingRemovals.values());
      this.pendingRemovals.clear();
      for (const { notebookId, peer } of removals) {
        this.removePeer(notebookId, peer);
      }
    }
  }

  private removePeer(notebookId: string, peer: Peer): void {
    if (this.broadcastDepth > 0) {
      this.queuePeerRemoval(notebookId, peer);
      return;
    }

    if (!this.peers.delete(peer.id)) {
      return;
    }
    this.state.waitUntil(
      this.materializerFor(notebookId)
        .removePeer(peer.id)
        .catch(() => undefined),
    );

    try {
      peer.socket.close();
    } catch {
      // Socket is already gone; the peer has still been removed from room state.
    }

    cloudLog("info", "room.connection.closed", {
      notebook_id: notebookId,
      peer_id: peer.id,
      principal: peer.identity.principal,
      scope: peer.identity.scope,
      room_peer_count: this.peers.size,
      counter: "connections_closed",
      counter_delta: 1,
    });

    this.broadcastControl(notebookId, {
      type: "cloud_peer_left",
      notebook_id: notebookId,
      peer_id: peer.id,
      actor_label: peer.identity.actorLabel,
      room_peer_count: this.peers.size,
      timestamp: new Date().toISOString(),
    });
  }
}

export function shouldBroadcastFrame(
  frame: TypedFrame,
  identity: AuthenticatedConnection,
): boolean {
  return !(frame.type === FrameType.PRESENCE && isAnonymousViewer(identity));
}

export function shouldPersistMaterializedSyncFrame(
  result: Pick<RoomHostFrameResult, "notebook_changed" | "runtime_state_changed">,
): boolean {
  return result.notebook_changed || result.runtime_state_changed;
}

export function webSocketUpgradeHeaders(identity: AuthenticatedConnection): Headers {
  const headers = new Headers();
  if (identity.webSocketProtocol) {
    headers.set("Sec-WebSocket-Protocol", identity.webSocketProtocol);
  }
  return headers;
}

export function rewritePresenceFrame(
  frame: TypedFrame,
  peer: { id: string; identity: AuthenticatedConnection },
): Promise<TypedFrame> {
  return rewritePresenceIngress(
    frame.payload,
    peer.id,
    peer.identity.principal,
    peer.identity.principal,
    peer.identity.operator,
  ).then((payload) => ({
    type: frame.type,
    payload,
  }));
}

function notebookIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/n\/([^/]+)\/sync\/?$/);
  if (!match) {
    return undefined;
  }
  return decodeURIComponent(match[1]);
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function frameStorageKey(sequence: number): string {
  return `frame:${sequence.toString().padStart(12, "0")}`;
}

function socketAttachment(socket: CloudflareWebSocket): PeerAttachment | undefined {
  const value = socket.deserializeAttachment?.();
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Partial<PeerAttachment>;
  if (
    typeof candidate.notebookId !== "string" ||
    typeof candidate.peerId !== "string" ||
    typeof candidate.connectedAt !== "string" ||
    !candidate.identity
  ) {
    return undefined;
  }

  return candidate as PeerAttachment;
}
