import type { CloudflareWebSocket, DurableObjectState, Env } from "./cloudflare-types.ts";
import {
  allowsNotebookWrite,
  allowsRuntimeStateWrite,
  isAnonymousViewer,
  readTrustedIdentity,
  rewriteActorLabelPrincipal,
  type AuthenticatedConnection,
} from "./identity.ts";
import {
  decodeJsonPayload,
  encodeJsonFrame,
  encodeTypedFrame,
  FrameType,
  frameTypeName,
  isClientWritableFrame,
  splitTypedFrame,
  type SessionControlMessage,
  type TypedFrame,
} from "./protocol.ts";
import { ensureNotebook, recordRoomEvent } from "./storage.ts";

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

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_STORED_FRAMES = 500;

export class NotebookRoom {
  private readonly peers = new Map<string, Peer>();
  private nextFrameSequence = 0;
  private frameSequenceReady: Promise<void> | undefined;
  private framePersistQueue: Promise<void> = Promise.resolve();

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

    if (!isAnonymousViewer(identity)) {
      await ensureNotebook(this.env, notebookId, identity);
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

    return new Response(null, {
      status: 101,
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

    let peer = this.peers.get(attachment.peerId);
    if (!peer) {
      peer = {
        id: attachment.peerId,
        socket,
        identity: attachment.identity,
        connectedAt: attachment.connectedAt,
      };
      this.peers.set(peer.id, peer);
    }
    return peer;
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

    if (frame.payload.byteLength + 1 > MAX_FRAME_BYTES) {
      this.rejectFrame(
        notebookId,
        peer,
        frame.type,
        `${frameTypeName(frame.type)} frame exceeds ${MAX_FRAME_BYTES} byte limit`,
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
        normalizedFrame = rewritePresenceFrame(frame, peer.identity);
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
      await this.persistFrame(notebookId, peer, normalizedFrame, receivedAt);
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
        return allowsNotebookWrite(identity.scope);
      case FrameType.RUNTIME_STATE_SYNC:
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

  private async persistFrame(
    notebookId: string,
    peer: Peer,
    frame: TypedFrame,
    receivedAt: string,
  ): Promise<void> {
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
        // D1 event rows are observability only; relay delivery must not depend on D1.
        this.state.waitUntil(
          recordRoomEvent(this.env, {
            notebookId,
            peerId: peer.id,
            actorLabel: peer.identity.actorLabel,
            connectionScope: peer.identity.scope,
            frameType: frame.type,
            byteLength: frame.payload.byteLength,
            receivedAt,
          }).catch(() => undefined),
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
    for (const [peerId, peer] of this.peers) {
      if (peerId === excludePeerId) {
        continue;
      }
      this.sendFrameToPeer(notebookId, peer, frame);
    }
  }

  private sendFrameToPeer(notebookId: string, peer: Peer, frame: Uint8Array): void {
    try {
      peer.socket.send(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength));
    } catch {
      this.removePeer(notebookId, peer);
    }
  }

  private removePeer(notebookId: string, peer: Peer): void {
    if (!this.peers.delete(peer.id)) {
      return;
    }

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

export function rewritePresenceFrame(
  frame: TypedFrame,
  identity: AuthenticatedConnection,
): TypedFrame {
  // Prototype-only shim: real nteract presence is CBOR and must be handled by
  // the shared presence codec before this Worker can relay desktop presence.
  try {
    const decoded = decodeJsonPayload<unknown>(frame.payload);
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error("presence payload must be a JSON object");
    }
    const presence = decoded as Record<string, unknown>;
    const presented = typeof presence.actor_label === "string" ? presence.actor_label : undefined;
    let actorLabel: string;
    try {
      actorLabel = rewriteActorLabelPrincipal(presented, identity);
    } catch {
      actorLabel = identity.actorLabel;
    }

    return {
      type: frame.type,
      payload: new TextEncoder().encode(
        JSON.stringify({
          ...presence,
          actor_label: actorLabel,
        }),
      ),
    };
  } catch (error) {
    throw new Error(`presence payload must be JSON until the shared CBOR codec lands: ${error}`);
  }
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
