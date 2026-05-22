import type { CloudflareWebSocket, DurableObjectState, Env } from "./cloudflare-types.ts";
import {
  allowsNotebookWrite,
  allowsRuntimeStateWrite,
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

export class NotebookRoom {
  private readonly peers = new Map<string, Peer>();
  private nextFrameSequence = 0;
  private frameSequenceReady: Promise<void> | undefined;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

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

    await ensureNotebook(this.env, notebookId, identity);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const peer: Peer = {
      id: crypto.randomUUID(),
      socket: server,
      identity,
      connectedAt: new Date().toISOString(),
    };

    server.accept();
    this.peers.set(peer.id, peer);

    server.addEventListener("message", (event) => {
      this.state.waitUntil(this.handleMessage(notebookId, peer, event.data));
    });
    server.addEventListener("close", () => {
      this.removePeer(notebookId, peer);
    });
    server.addEventListener("error", () => {
      this.removePeer(notebookId, peer);
    });

    this.sendControl(peer, {
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

    const normalizedFrame =
      frame.type === FrameType.PRESENCE ? rewritePresenceFrame(frame, peer.identity) : frame;
    const receivedAt = new Date().toISOString();
    await this.persistFrame(notebookId, peer, normalizedFrame, receivedAt);

    this.broadcastFrame(encodeTypedFrame(normalizedFrame.type, normalizedFrame.payload), peer.id);
    this.sendControl(peer, {
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
    const sequence = await this.allocateFrameSequence();

    const stored: StoredRoomFrame = {
      sequence,
      peerId: peer.id,
      actorLabel: peer.identity.actorLabel,
      connectionScope: peer.identity.scope,
      frameType: frame.type,
      byteLength: frame.payload.byteLength,
      receivedAt,
    };
    await Promise.all([
      this.state.storage.put("frame_sequence", sequence),
      this.state.storage.put(`frame:${sequence.toString().padStart(12, "0")}`, stored),
    ]);
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
  }

  private async allocateFrameSequence(): Promise<number> {
    this.frameSequenceReady ??= this.state.storage
      .get<number>("frame_sequence")
      .then((sequence) => {
        this.nextFrameSequence = sequence ?? 0;
      });

    await this.frameSequenceReady;
    this.nextFrameSequence += 1;
    return this.nextFrameSequence;
  }

  private rejectFrame(
    notebookId: string,
    peer: Peer,
    frameType: number | undefined,
    reason: string,
  ): void {
    this.sendControl(peer, {
      type: "cloud_frame_rejected",
      notebook_id: notebookId,
      peer_id: peer.id,
      frame_type: frameType,
      reason,
      timestamp: new Date().toISOString(),
    });
  }

  private sendControl(peer: Peer, message: SessionControlMessage): void {
    this.sendFrameToPeer(peer, encodeJsonFrame(FrameType.SESSION_CONTROL, message));
  }

  private broadcastControl(message: SessionControlMessage, excludePeerId?: string): void {
    const frame = encodeJsonFrame(FrameType.SESSION_CONTROL, message);
    this.broadcastFrame(frame, excludePeerId);
  }

  private broadcastFrame(frame: Uint8Array, excludePeerId?: string): void {
    for (const [peerId, peer] of this.peers) {
      if (peerId === excludePeerId) {
        continue;
      }
      this.sendFrameToPeer(peer, frame);
    }
  }

  private sendFrameToPeer(peer: Peer, frame: Uint8Array): void {
    try {
      peer.socket.send(frame);
    } catch {
      this.peers.delete(peer.id);
    }
  }

  private removePeer(notebookId: string, peer: Peer): void {
    if (!this.peers.delete(peer.id)) {
      return;
    }

    this.broadcastControl({
      type: "cloud_peer_left",
      notebook_id: notebookId,
      peer_id: peer.id,
      actor_label: peer.identity.actorLabel,
      room_peer_count: this.peers.size,
      timestamp: new Date().toISOString(),
    });
  }
}

export function rewritePresenceFrame(
  frame: TypedFrame,
  identity: AuthenticatedConnection,
): TypedFrame {
  let presence: Record<string, unknown>;
  try {
    presence = decodeJsonPayload<Record<string, unknown>>(frame.payload);
  } catch {
    presence = {
      presence_format: "unparsed",
    };
  }

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
