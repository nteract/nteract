import type { CloudflareWebSocket, DurableObjectState, Env } from "./cloudflare-types.ts";
import type { WorkstationAttachmentState } from "runtimed";
import { identityDisplayLabel } from "./display-label.ts";
import {
  allowsBlobUpload,
  allowsExecutionRequestSubmit,
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
import {
  syncFrameBudgetLogFields,
  SyncFrameBudgetTracker,
  type SyncFrameBudgetDirection,
  type SyncFrameBudgetSummary,
} from "./sync-frame-budget.ts";

interface Peer {
  id: string;
  socket: CloudflareWebSocket;
  identity: AuthenticatedConnection;
  connectedAt: string;
  workstation: RuntimePeerWorkstationMetadata | null;
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
  workstation?: RuntimePeerWorkstationMetadata | null;
}

interface RuntimePeerWorkstationMetadata {
  workstationId?: string;
  displayName?: string;
  defaultEnvironmentLabel?: string;
  environmentPolicy?: string;
  workingDirectory?: string;
}

const MAX_STORED_FRAMES = 500;

/// Grace window after the last `runtime_peer` leaves before the room reconciles
/// its in-flight state (lifecycle-analysis reqs #3/#7). Tolerates a transient
/// disconnect/reconnect (idle eviction, network blip) without terminalizing a
/// kernel that is about to come back: if a `runtime_peer` rejoins inside the
/// window the alarm is disarmed.
const RUNTIME_PEER_GONE_GRACE_MS = 30_000;

/// Storage key holding the notebook id whose `runtime_peer` departure armed the
/// reconciliation alarm. Persisted so a DO that hibernates between the alarm
/// being set and firing still knows which room to reconcile.
const RUNTIME_PEER_WATCH_KEY = "runtime_peer_gone_watch";

export class NotebookRoom {
  private readonly peers = new Map<string, Peer>();
  private readonly pendingRemovals = new Map<string, { notebookId: string; peer: Peer }>();
  private nextFrameSequence = 0;
  private frameSequenceReady: Promise<void> | undefined;
  private framePersistQueue: Promise<void> = Promise.resolve();
  private broadcastDepth = 0;
  private readonly materializers = new Map<string, RoomMaterializer>();
  private readonly restoredPeersReady: Promise<void>;
  private readonly frameBudget = new SyncFrameBudgetTracker();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.restoredPeersReady = this.restoreHibernatedPeers();
    this.state.waitUntil(this.restoredPeersReady);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const workstationAttachmentNotebookId = workstationAttachmentControlNotebookId(url.pathname);
    if (workstationAttachmentNotebookId) {
      return this.handleWorkstationAttachmentControl(workstationAttachmentNotebookId, request);
    }

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

    await this.restoredPeersReady;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const peer: Peer = {
      id: crypto.randomUUID(),
      socket: server,
      identity,
      connectedAt: new Date().toISOString(),
      workstation: runtimePeerWorkstationMetadataFromRequest(request, identity),
    };

    this.acceptPeerSocket(notebookId, peer);
    this.peers.set(peer.id, peer);
    // A runtime_peer (re)joining cancels any pending reconciliation alarm: the
    // kernel host is back, so its in-flight state must not be terminalized.
    if (identity.scope === "runtime_peer") {
      this.refreshRuntimePeerWatch(notebookId);
      this.state.waitUntil(this.publishRuntimePeerAttachment(notebookId, peer));
    }
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
      identity_provider: identity.metadata.provider,
      principal_namespace: identity.metadata.principalNamespace,
      display_name: identity.metadata.displayName,
      email: identity.metadata.email,
      room_peer_count: this.peers.size,
      runtime_peer_count: this.runtimePeerCount(),
      timestamp: peer.connectedAt,
    });

    this.broadcastControl(
      notebookId,
      {
        type: "cloud_peer_joined",
        notebook_id: notebookId,
        peer_id: peer.id,
        actor_label: identity.actorLabel,
        connection_scope: identity.scope,
        room_peer_count: this.peers.size,
        runtime_peer_count: this.runtimePeerCount(),
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

  private async handleWorkstationAttachmentControl(
    notebookId: string,
    request: Request,
  ): Promise<Response> {
    // Worker-internal control path only. External traffic reaches this Durable
    // Object through the Worker's strict `/n/:notebookId/sync` WebSocket route,
    // so `/internal/*` is not publicly routable unless that router changes.
    if (request.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "workstation attachment control body must be JSON" }, 400);
    }
    if (!isRecord(payload) || !("attachment" in payload)) {
      return json({ error: "workstation attachment control body requires attachment" }, 400);
    }

    const attachment = payload.attachment as WorkstationAttachmentState | null;
    const startedAt = Date.now();
    try {
      const materializer = this.materializerFor(notebookId);
      const result = await materializer.setWorkstationAttachment(attachment);
      if (result.changed) {
        this.deliverRoomHostFrames(notebookId, result);
        await materializer.checkpoint();
      }
      cloudLog("debug", "room.workstation_attachment.control_published", {
        notebook_id: notebookId,
        changed: result.changed,
        duration_ms: durationMs(startedAt),
        outbound_frame_count: result.outbound.length,
        counter: "workstation_attachment_control_published",
        counter_delta: result.changed ? 1 : 0,
      });
      return json({ ok: true, changed: result.changed }, 200);
    } catch (error) {
      cloudLog("warn", "room.workstation_attachment.control_publish_failed", {
        notebook_id: notebookId,
        duration_ms: durationMs(startedAt),
        error: errorMessage(error),
        counter: "workstation_attachment_control_publish_failed",
        counter_delta: 1,
      });
      return json({ error: "workstation attachment publish failed" }, 500);
    }
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
    await this.handleMessage(attachment.notebookId, peer, message);
  }

  webSocketClose(socket: CloudflareWebSocket): void {
    this.removeAttachedPeer(socket);
  }

  webSocketError(socket: CloudflareWebSocket): void {
    this.removeAttachedPeer(socket);
  }

  private async restoreHibernatedPeers(): Promise<void> {
    const sockets = this.state.getWebSockets?.() ?? [];
    const restored: Array<{ notebookId: string; peer: Peer }> = [];
    for (const socket of sockets) {
      const attachment = socketAttachment(socket);
      if (!attachment) {
        continue;
      }

      const peer = {
        id: attachment.peerId,
        socket,
        identity: attachment.identity,
        connectedAt: attachment.connectedAt,
        workstation: normalizeRuntimePeerWorkstationMetadata(attachment.workstation),
      };
      this.peers.set(attachment.peerId, peer);
      restored.push({ notebookId: attachment.notebookId, peer });
    }
    if (sockets.length > 0) {
      cloudLog("info", "room.hibernation.restored_peers", {
        restored_peer_count: this.peers.size,
      });
    }
    await Promise.all(
      restored.map(async ({ notebookId, peer }) => {
        await this.syncPeerFromRoomHost(notebookId, peer);
        if (peer.identity.scope === "runtime_peer") {
          this.refreshRuntimePeerWatch(notebookId);
        }
      }),
    );
  }

  private acceptPeerSocket(notebookId: string, peer: Peer): void {
    const attachment: PeerAttachment = {
      notebookId,
      peerId: peer.id,
      identity: peer.identity,
      connectedAt: peer.connectedAt,
      workstation: peer.workstation,
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
    const incomingByteLength = webSocketMessageByteLength(message);
    if (typeof message === "string") {
      this.recordFrameBudget(notebookId, peer, "incoming", "text", incomingByteLength);
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
      this.recordFrameBudget(notebookId, peer, "incoming", "malformed", incomingByteLength);
      this.rejectFrame(notebookId, peer, undefined, String(error));
      return;
    }
    this.recordFrameBudget(
      notebookId,
      peer,
      "incoming",
      frameTypeName(frame.type),
      incomingByteLength,
    );

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
      case FrameType.COMMS_DOC_SYNC:
        // These frames are both data and protocol control. Read-only peers may
        // send empty sync acks/needs; RoomMaterializer rejects messages carrying
        // document changes when the connection lacks write scope.
        return true;
      case FrameType.PUT_BLOB:
        return allowsBlobUpload(identity.scope);
      case FrameType.POOL_STATE_SYNC:
        return identity.scope === "owner";
      case FrameType.REQUEST:
        return allowsExecutionRequestSubmit(identity.scope);
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

  private async publishRuntimePeerAttachment(notebookId: string, peer: Peer): Promise<void> {
    const startedAt = Date.now();
    try {
      const materializer = this.materializerFor(notebookId);
      const result = await materializer.setWorkstationAttachment(
        runtimePeerWorkstationAttachment(peer),
      );
      if (result.changed) {
        this.deliverRoomHostFrames(notebookId, result);
        await materializer.checkpoint();
      }
      cloudLog("debug", "room.workstation_attachment.published", {
        notebook_id: notebookId,
        peer_id: peer.id,
        scope: peer.identity.scope,
        changed: result.changed,
        duration_ms: durationMs(startedAt),
        outbound_frame_count: result.outbound.length,
        counter: "workstation_attachments_published",
        counter_delta: result.changed ? 1 : 0,
      });
    } catch (error) {
      cloudLog("warn", "room.workstation_attachment.publish_failed", {
        notebook_id: notebookId,
        peer_id: peer.id,
        scope: peer.identity.scope,
        duration_ms: durationMs(startedAt),
        error: errorMessage(error),
        counter: "workstation_attachment_publish_failed",
        counter_delta: 1,
      });
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
        if (!this.trySendFrame(notebookId, peer, frame)) {
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
    if (!this.trySendFrame(notebookId, peer, frame)) {
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

  private trySendFrame(notebookId: string, peer: Peer, frame: Uint8Array): boolean {
    this.recordFrameBudget(
      notebookId,
      peer,
      "outgoing",
      frameTypeName(frame[0] ?? -1),
      frame.byteLength,
    );
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
    this.logPeerFrameBudget(notebookId, peer);

    this.broadcastControl(notebookId, {
      type: "cloud_peer_left",
      notebook_id: notebookId,
      peer_id: peer.id,
      actor_label: peer.identity.actorLabel,
      connection_scope: peer.identity.scope,
      room_peer_count: this.peers.size,
      runtime_peer_count: this.runtimePeerCount(),
      timestamp: new Date().toISOString(),
    });

    // A runtime_peer departure is the one failure the daemon can't self-correct
    // (its death IS the trigger). Arm the reconciliation watchdog if it left no
    // runtime_peer behind.
    if (peer.identity.scope === "runtime_peer") {
      this.refreshRuntimePeerWatch(notebookId);
    }
  }

  private recordFrameBudget(
    notebookId: string,
    peer: Peer,
    direction: SyncFrameBudgetDirection,
    frameType: string,
    byteLength: number,
  ): void {
    const nowMs = Date.now();
    this.frameBudget.record({
      peerId: peer.id,
      scope: peer.identity.scope,
      direction,
      frameType,
      byteLength,
      nowMs,
    });
    const summary = this.frameBudget.summarizeWindowIfNeeded(nowMs);
    if (summary) {
      this.logFrameBudgetSummary(notebookId, "periodic", summary);
    }
  }

  private logFrameBudgetSummary(
    notebookId: string,
    reason: "periodic" | "peer_closed",
    summary: SyncFrameBudgetSummary,
    peer?: Peer,
  ): void {
    cloudLog("info", "room.sync_frame_budget.summary", {
      notebook_id: notebookId,
      reason,
      peer_id: peer?.id,
      scope: peer?.identity.scope,
      ...syncFrameBudgetLogFields(summary),
      counter:
        reason === "peer_closed" ? "sync_frame_budget_peer_summaries" : "sync_frame_budget_windows",
      counter_delta: 1,
    });
  }

  private logPeerFrameBudget(notebookId: string, peer: Peer): void {
    const summary = this.frameBudget.consumePeer(peer.id);
    if (!summary) {
      return;
    }
    this.logFrameBudgetSummary(notebookId, "peer_closed", summary, peer);
  }

  /// Whether any currently-attached peer is a `runtime_peer`.
  ///
  /// Invariant: one DurableObject instance per notebook (`idFromName(notebookId)`),
  /// so this unscoped scan and the single `RUNTIME_PEER_WATCH_KEY` are
  /// notebook-scoped implicitly. If a DO ever hosts more than one notebook, both
  /// this check and the watch key must be keyed per notebook id.
  private hasRuntimePeer(): boolean {
    return this.runtimePeerCount() > 0;
  }

  private runtimePeerCount(): number {
    let count = 0;
    for (const peer of this.peers.values()) {
      if (peer.identity.scope === "runtime_peer") {
        count += 1;
      }
    }
    return count;
  }

  /// Arm or disarm the runtime_peer-gone reconciliation alarm to match current
  /// membership: arm (grace window) when no `runtime_peer` is attached, disarm
  /// when one is present. Called when a `runtime_peer` joins or leaves. A no-op
  /// where the storage backend doesn't expose the alarm API (e.g. test fakes).
  private refreshRuntimePeerWatch(notebookId: string): void {
    const storage = this.state.storage;
    if (!storage.setAlarm || !storage.deleteAlarm) {
      return;
    }
    this.state.waitUntil(
      (async () => {
        try {
          if (this.hasRuntimePeer()) {
            await storage.deleteAlarm?.();
            await storage.delete(RUNTIME_PEER_WATCH_KEY);
            return;
          }
          await storage.put(RUNTIME_PEER_WATCH_KEY, notebookId);
          await storage.setAlarm?.(Date.now() + RUNTIME_PEER_GONE_GRACE_MS);
        } catch (error) {
          cloudLog("warn", "room.runtime_peer_watch.refresh_failed", {
            notebook_id: notebookId,
            error: errorMessage(error),
          });
        }
      })(),
    );
  }

  /// DurableObject alarm handler. Fires `RUNTIME_PEER_GONE_GRACE_MS` after the
  /// last `runtime_peer` left. If one has since rejoined, it's a no-op (the blip
  /// recovered). Otherwise it reconciles the room's authoritative RuntimeStateDoc
  /// — terminalizing orphaned executions and flipping a phantom-live kernel to
  /// Error — and broadcasts the corrected state to the surviving peers.
  async alarm(): Promise<void> {
    const storage = this.state.storage;
    const notebookId = await storage.get<string>(RUNTIME_PEER_WATCH_KEY);
    if (!notebookId) {
      return;
    }
    await storage.delete(RUNTIME_PEER_WATCH_KEY);

    if (this.hasRuntimePeer()) {
      cloudLog("info", "room.runtime_peer_watch.recovered", {
        notebook_id: notebookId,
        counter: "runtime_peer_gone_recovered",
        counter_delta: 1,
      });
      return;
    }

    try {
      const result = await this.materializerFor(notebookId).reconcileRuntimePeerGone(
        "runtime peer left the room and did not return within the grace window",
      );
      if (result.changed) {
        this.deliverRoomHostFrames(notebookId, result);
        this.state.waitUntil(
          this.materializerFor(notebookId)
            .checkpoint()
            .catch(() => undefined),
        );
      }
      cloudLog("info", "room.runtime_peer_watch.reconciled", {
        notebook_id: notebookId,
        changed: result.changed,
        counter: "runtime_peer_gone_reconciled",
        counter_delta: 1,
      });
    } catch (error) {
      cloudLog("error", "room.runtime_peer_watch.reconcile_failed", {
        notebook_id: notebookId,
        error: errorMessage(error),
      });
    }
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
    presencePeerLabel(peer.identity),
    peer.identity.principal,
    peer.identity.operator,
  ).then((payload) => ({
    type: frame.type,
    payload,
  }));
}

export function presencePeerLabel(identity: AuthenticatedConnection): string {
  return identityDisplayLabel({
    displayName: identity.metadata.displayName,
    email: identity.metadata.email,
    principal: identity.principal,
  });
}

function runtimePeerWorkstationAttachment(peer: Peer): WorkstationAttachmentState {
  const workstation = peer.workstation;
  return {
    workstation_id: workstation?.workstationId ?? "runtime-peer",
    display_name: workstation?.displayName ?? "Attached workstation",
    provider: "runtime_peer",
    default_environment_label: workstation?.defaultEnvironmentLabel ?? "Current Python",
    environment_policy: workstation?.environmentPolicy ?? "runtime_peer",
    status: "ready",
    status_message: null,
    cpu_count: null,
    memory_bytes: null,
    working_directory: workstation?.workingDirectory ?? null,
    updated_at: peer.connectedAt,
  };
}

export function runtimePeerWorkstationMetadataFromRequest(
  request: Request,
  identity: AuthenticatedConnection,
): RuntimePeerWorkstationMetadata | null {
  if (identity.scope !== "runtime_peer") {
    return null;
  }
  return normalizeRuntimePeerWorkstationMetadata({
    workstationId: boundedHeader(request, "x-nteract-workstation-id", 128),
    displayName: boundedHeader(request, "x-nteract-workstation-display-name", 160),
    defaultEnvironmentLabel: boundedHeader(
      request,
      "x-nteract-workstation-default-environment",
      160,
    ),
    environmentPolicy: boundedHeader(request, "x-nteract-workstation-environment-policy", 80),
    workingDirectory: boundedHeader(request, "x-nteract-workstation-working-directory", 512),
  });
}

function normalizeRuntimePeerWorkstationMetadata(
  value: unknown,
): RuntimePeerWorkstationMetadata | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<RuntimePeerWorkstationMetadata>;
  const metadata: RuntimePeerWorkstationMetadata = {};
  setBoundedMetadataField(metadata, "workstationId", candidate.workstationId, 128);
  setBoundedMetadataField(metadata, "displayName", candidate.displayName, 160);
  setBoundedMetadataField(
    metadata,
    "defaultEnvironmentLabel",
    candidate.defaultEnvironmentLabel,
    160,
  );
  setBoundedMetadataField(metadata, "environmentPolicy", candidate.environmentPolicy, 80);
  setBoundedMetadataField(metadata, "workingDirectory", candidate.workingDirectory, 512);

  return Object.keys(metadata).length > 0 ? metadata : null;
}

function setBoundedMetadataField(
  metadata: RuntimePeerWorkstationMetadata,
  key: keyof RuntimePeerWorkstationMetadata,
  value: unknown,
  maxLength: number,
): void {
  if (typeof value !== "string") {
    return;
  }
  const bounded = value.trim().slice(0, maxLength);
  if (!bounded) {
    return;
  }
  switch (key) {
    case "workstationId":
      metadata.workstationId = bounded;
      break;
    case "displayName":
      metadata.displayName = bounded;
      break;
    case "defaultEnvironmentLabel":
      metadata.defaultEnvironmentLabel = bounded;
      break;
    case "environmentPolicy":
      metadata.environmentPolicy = bounded;
      break;
    case "workingDirectory":
      metadata.workingDirectory = bounded;
      break;
  }
}

function boundedHeader(
  request: Request,
  headerName: string,
  maxLength: number,
): string | undefined {
  const value = request.headers.get(headerName)?.trim();
  if (!value) {
    return undefined;
  }
  return value.slice(0, maxLength);
}

function notebookIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/n\/([^/]+)\/sync\/?$/);
  if (!match) {
    return undefined;
  }
  return decodeURIComponent(match[1]);
}

function workstationAttachmentControlNotebookId(pathname: string): string | undefined {
  const match = pathname.match(/^\/internal\/n\/([^/]+)\/workstation-attachment\/?$/);
  if (!match) {
    return undefined;
  }
  return decodeURIComponent(match[1]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function webSocketMessageByteLength(message: string | ArrayBuffer | ArrayBufferView): number {
  if (typeof message === "string") {
    return new TextEncoder().encode(message).byteLength;
  }
  if (message instanceof ArrayBuffer) {
    return message.byteLength;
  }
  return message.byteLength;
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
