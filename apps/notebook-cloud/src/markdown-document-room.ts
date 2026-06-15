import type { CloudflareWebSocket, DurableObjectState, Env } from "./cloudflare-types.ts";
import { identityDisplayLabel } from "./display-label.ts";
import { readTrustedIdentity, type AuthenticatedConnection } from "./identity.ts";
import {
  encodeTypedFrame,
  FrameType,
  frameSizeLimits,
  frameTypeName,
  isClientWritableFrame,
  LIVENESS_PING,
  LIVENESS_PONG,
  splitTypedFrame,
  type SessionControlMessage,
  type TypedFrame,
} from "./protocol.ts";
import { cloudLog, durationMs, errorMessage } from "./observability.ts";
import {
  isMarkdownMaterializedSyncFrame,
  MarkdownRoomMaterializer,
  typedFrameFromMarkdownRoomOutbound,
  type MarkdownRoomFrameResult,
} from "./markdown-room-materializer.ts";
import { json } from "./http-responses.ts";

interface Peer {
  id: string;
  socket: CloudflareWebSocket;
  identity: AuthenticatedConnection;
  connectedAt: string;
  consecutiveRejectedFrames: number;
}

interface PeerAttachment {
  documentId: string;
  peerId: string;
  identity: AuthenticatedConnection;
  connectedAt: string;
}

const MAX_CONSECUTIVE_REJECTED_FRAMES = 8;
const REJECTED_FRAME_POLICY_CLOSE_CODE = 1008;
const REJECTED_FRAME_POLICY_CLOSE_REASON = "too many rejected frames";

export class MarkdownDocumentRoom {
  private readonly peers = new Map<string, Peer>();
  private readonly materializers = new Map<string, MarkdownRoomMaterializer>();
  private readonly restoredPeersReady: Promise<void>;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    const pairCtor = (
      globalThis as {
        WebSocketRequestResponsePair?: new (
          request: string,
          response: string,
        ) => { readonly request: string; readonly response: string };
      }
    ).WebSocketRequestResponsePair;
    if (pairCtor && this.state.setWebSocketAutoResponse) {
      this.state.setWebSocketAutoResponse(new pairCtor(LIVENESS_PING, LIVENESS_PONG));
    }
    this.restoredPeersReady = this.restoreHibernatedPeers();
    this.state.waitUntil(this.restoredPeersReady);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const documentId = markdownDocumentIdFromPath(url.pathname);
    if (!documentId) {
      return json({ error: "Markdown document id is required" }, 400);
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "expected WebSocket upgrade" }, 426);
    }

    const identity = readTrustedIdentity(request);
    if (!identity) {
      return json({ error: "missing trusted identity" }, 401);
    }

    const pair = new WebSocketPair();
    const peer: Peer = {
      id: crypto.randomUUID(),
      socket: pair[1],
      identity,
      connectedAt: new Date().toISOString(),
      consecutiveRejectedFrames: 0,
    };
    this.peers.set(peer.id, peer);
    this.acceptPeerSocket(documentId, peer);
    this.sendControl(documentId, peer, {
      type: "cloud_room_ready",
      protocol: "v4",
      notebook_id: documentId,
      peer_id: peer.id,
      actor_label: identity.actorLabel,
      connection_scope: identity.scope,
      identity_provider: identity.metadata.provider,
      principal_namespace: identity.metadata.principalNamespace,
      display_name: identityDisplayLabel({
        displayName: identity.metadata.displayName,
        email: identity.metadata.email,
        principal: identity.principal,
      }),
      email: identity.metadata.email,
      room_peer_count: this.peers.size,
      timestamp: new Date().toISOString(),
    });
    this.state.waitUntil(this.syncPeerFromRoomHost(documentId, peer));
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
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
    await this.restoredPeersReady;
    await this.handleMessage(attachment.documentId, peer, message);
  }

  webSocketClose(socket: CloudflareWebSocket): void {
    this.removeAttachedPeer(socket);
  }

  webSocketError(socket: CloudflareWebSocket): void {
    this.removeAttachedPeer(socket);
  }

  private async restoreHibernatedPeers(): Promise<void> {
    const sockets = this.state.getWebSockets?.() ?? [];
    for (const socket of sockets) {
      const attachment = socketAttachment(socket);
      if (!attachment) {
        continue;
      }
      const peer: Peer = {
        id: attachment.peerId,
        socket,
        identity: attachment.identity,
        connectedAt: attachment.connectedAt,
        consecutiveRejectedFrames: 0,
      };
      this.peers.set(peer.id, peer);
      await this.syncPeerFromRoomHost(attachment.documentId, peer);
    }
  }

  private acceptPeerSocket(documentId: string, peer: Peer): void {
    const attachment: PeerAttachment = {
      documentId,
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
      this.state.waitUntil(this.handleMessage(documentId, peer, event.data));
    });
    peer.socket.addEventListener("close", () => {
      this.removePeer(documentId, peer);
    });
    peer.socket.addEventListener("error", () => {
      this.removePeer(documentId, peer);
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
    this.removePeer(attachment.documentId, peer);
  }

  private async handleMessage(
    documentId: string,
    peer: Peer,
    message: string | ArrayBuffer | ArrayBufferView,
  ): Promise<void> {
    if (message === LIVENESS_PING) {
      try {
        peer.socket.send(LIVENESS_PONG);
      } catch {
        // socket is closing; close/error hooks own cleanup.
      }
      return;
    }
    if (typeof message === "string") {
      this.rejectFrame(
        documentId,
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
      this.rejectFrame(documentId, peer, undefined, String(error));
      return;
    }

    const sizeLimits = frameSizeLimits(frame.type);
    if (frame.payload.byteLength > sizeLimits.cap) {
      this.rejectFrame(
        documentId,
        peer,
        frame.type,
        `${frameTypeName(frame.type)} frame payload exceeds ${sizeLimits.cap} byte limit`,
      );
      return;
    }

    if (!isClientWritableFrame(frame.type) || !isMarkdownMaterializedSyncFrame(frame.type)) {
      this.rejectFrame(
        documentId,
        peer,
        frame.type,
        `${frameTypeName(frame.type)} is not supported for Markdown documents`,
      );
      return;
    }

    const receivedAt = new Date().toISOString();
    const materializer = this.materializerFor(documentId);
    const startedAt = Date.now();
    let result: MarkdownRoomFrameResult;
    try {
      result = await materializer.receiveFrame(peer, frame);
    } catch (error) {
      this.rejectFrame(
        documentId,
        peer,
        frame.type,
        `Markdown room rejected ${frameTypeName(frame.type)} frame: ${String(error)}`,
        false,
      );
      return;
    }

    cloudLog("debug", "markdown_room.materialized_frame.applied", {
      document_id: documentId,
      peer_id: peer.id,
      principal: peer.identity.principal,
      scope: peer.identity.scope,
      frame_type: frameTypeName(frame.type),
      byte_length: frame.payload.byteLength,
      duration_ms: durationMs(startedAt),
      changed: result.changed,
      outbound_frame_count: result.outbound.length,
      counter: "markdown_materialized_frames_applied",
      counter_delta: 1,
    });

    this.deliverRoomHostFrames(documentId, result);
    if (result.changed) {
      this.state.waitUntil(this.checkpointRoomHost(documentId, materializer, "materialized_frame"));
    }
    this.sendControl(documentId, peer, {
      type: "cloud_frame_accepted",
      notebook_id: documentId,
      peer_id: peer.id,
      frame_type: frame.type,
      byte_length: frame.payload.byteLength,
      timestamp: receivedAt,
    });
    peer.consecutiveRejectedFrames = 0;
  }

  private async syncPeerFromRoomHost(documentId: string, peer: Peer): Promise<void> {
    const startedAt = Date.now();
    try {
      const result = await this.materializerFor(documentId).syncPeer(peer);
      cloudLog("debug", "markdown_room.peer_sync.completed", {
        document_id: documentId,
        peer_id: peer.id,
        principal: peer.identity.principal,
        scope: peer.identity.scope,
        duration_ms: durationMs(startedAt),
        outbound_frame_count: result.outbound.length,
        counter: "markdown_peer_sync_completed",
        counter_delta: 1,
      });
      this.deliverRoomHostFrames(documentId, result);
    } catch (error) {
      cloudLog("warn", "markdown_room.peer_sync.failed", {
        document_id: documentId,
        peer_id: peer.id,
        principal: peer.identity.principal,
        scope: peer.identity.scope,
        duration_ms: durationMs(startedAt),
        error: errorMessage(error),
        counter: "markdown_peer_sync_failed",
        counter_delta: 1,
      });
      this.removePeer(documentId, peer, { code: 1011, reason: "Markdown room sync failed" });
    }
  }

  private async checkpointRoomHost(
    documentId: string,
    materializer: MarkdownRoomMaterializer,
    operation: string,
  ): Promise<void> {
    try {
      await materializer.checkpoint();
    } catch (error) {
      cloudLog("warn", "markdown_room.materializer.checkpoint_failed", {
        document_id: documentId,
        operation,
        error: errorMessage(error),
        counter: "markdown_materializer_checkpoint_failures",
        counter_delta: 1,
      });
    }
  }

  private deliverRoomHostFrames(documentId: string, result: MarkdownRoomFrameResult): void {
    for (const frame of result.outbound) {
      const peer = this.peers.get(frame.peer_id);
      if (!peer) {
        continue;
      }
      try {
        peer.socket.send(typedFrameFromMarkdownRoomOutbound(frame));
      } catch (error) {
        cloudLog("warn", "markdown_room.outbound_frame_failed", {
          document_id: documentId,
          peer_id: peer.id,
          frame_type: frameTypeName(frame.frame_type),
          error: errorMessage(error),
          counter: "markdown_outbound_frame_failures",
          counter_delta: 1,
        });
        this.removePeer(documentId, peer);
      }
    }
  }

  private rejectFrame(
    documentId: string,
    peer: Peer,
    frameType: number | undefined,
    reason: string,
    countsTowardStreak = true,
  ): void {
    if (countsTowardStreak) {
      peer.consecutiveRejectedFrames += 1;
    }
    const shouldClose = peer.consecutiveRejectedFrames >= MAX_CONSECUTIVE_REJECTED_FRAMES;
    cloudLog(
      "warn",
      shouldClose
        ? "markdown_room.peer.closed_for_rejected_frames"
        : "markdown_room.frame.rejected",
      {
        document_id: documentId,
        peer_id: peer.id,
        principal: peer.identity.principal,
        scope: peer.identity.scope,
        frame_type: frameType === undefined ? "unknown" : frameTypeName(frameType),
        reason,
        consecutive_rejected_frames: peer.consecutiveRejectedFrames,
        counter: shouldClose
          ? "markdown_peers_closed_for_rejected_frames"
          : "markdown_frames_rejected",
        counter_delta: 1,
      },
    );
    if (shouldClose) {
      this.removePeer(documentId, peer, {
        code: REJECTED_FRAME_POLICY_CLOSE_CODE,
        reason: REJECTED_FRAME_POLICY_CLOSE_REASON,
      });
      return;
    }
    this.sendControl(documentId, peer, {
      type: "cloud_frame_rejected",
      notebook_id: documentId,
      peer_id: peer.id,
      ...(frameType === undefined ? {} : { frame_type: frameType }),
      reason,
      timestamp: new Date().toISOString(),
    });
  }

  private sendControl(documentId: string, peer: Peer, message: SessionControlMessage): void {
    try {
      peer.socket.send(
        encodeTypedFrame(
          FrameType.SESSION_CONTROL,
          new TextEncoder().encode(JSON.stringify(message)),
        ),
      );
    } catch (error) {
      cloudLog("warn", "markdown_room.control_frame_failed", {
        document_id: documentId,
        peer_id: peer.id,
        error: errorMessage(error),
        counter: "markdown_control_frame_failures",
        counter_delta: 1,
      });
      this.removePeer(documentId, peer);
    }
  }

  private removePeer(
    documentId: string,
    peer: Peer,
    closeOptions: { code?: number; reason?: string } = {},
  ): void {
    if (!this.peers.delete(peer.id)) {
      return;
    }
    this.state.waitUntil(this.materializerFor(documentId).removePeer(peer.id));
    try {
      peer.socket.close(closeOptions.code, closeOptions.reason);
    } catch {
      // already closed
    }
  }

  private materializerFor(documentId: string): MarkdownRoomMaterializer {
    let materializer = this.materializers.get(documentId);
    if (!materializer) {
      materializer = new MarkdownRoomMaterializer(documentId, this.state, this.env);
      this.materializers.set(documentId, materializer);
    }
    return materializer;
  }
}

function socketAttachment(socket: CloudflareWebSocket): PeerAttachment | null {
  const value = socket.deserializeAttachment?.();
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Partial<PeerAttachment>;
  if (
    typeof record.documentId !== "string" ||
    typeof record.peerId !== "string" ||
    typeof record.connectedAt !== "string" ||
    !record.identity
  ) {
    return null;
  }
  return {
    documentId: record.documentId,
    peerId: record.peerId,
    identity: record.identity,
    connectedAt: record.connectedAt,
  };
}

function markdownDocumentIdFromPath(pathname: string): string | null {
  const documentId = decodeURIComponent(pathname.match(/^\/m\/([^/]+)\/sync\/?$/)?.[1] ?? "");
  return documentId || null;
}
