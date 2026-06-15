import type {
  CloudflareWebSocket,
  DurableObjectState,
  Env,
  WebSocketRequestResponsePair,
} from "./cloudflare-types.ts";
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
  LIVENESS_PING,
  LIVENESS_PONG,
  splitTypedFrame,
  type SessionControlMessage,
  type CloudRoomPeerRosterEntry,
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
  consecutiveRejectedFrames: number;
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
  runtimeSessionId?: string;
  displayName?: string;
  defaultEnvironmentLabel?: string;
  environmentPolicy?: string;
  workingDirectory?: string;
}

interface SelectedRuntimePeerSession {
  workstationId: string;
  runtimeSessionId: string | null;
}

interface RejectFrameOptions {
  countsTowardStreak?: boolean;
}

interface PeerCloseOptions {
  code?: number;
  reason?: string;
  suppressRuntimePeerWatch?: boolean;
}

type RuntimePeerForwardedRequestAction = "interrupt_execution" | "send_comm";
type RuntimePeerQueryRequestAction = "complete";
type UnsupportedHostedRuntimeRequestAction =
  | "launch_kernel"
  | "restart_kernel"
  | "shutdown_kernel"
  | "sync_environment"
  | "get_history";

interface RequestEnvelopeMetadata {
  id: string | null;
  action: string | null;
}

interface PendingRuntimePeerResponse {
  notebookId: string;
  sourcePeerId: string;
  runtimePeerId: string;
  action: RuntimePeerQueryRequestAction;
  createdAtMs: number;
}

/// Grace window after the last `runtime_peer` leaves before the room reconciles
/// its in-flight state (lifecycle-analysis reqs #3/#7). Tolerates a transient
/// disconnect/reconnect (idle eviction, network blip) without terminalizing a
/// kernel that is about to come back: if a `runtime_peer` rejoins inside the
/// window the alarm is disarmed.
const RUNTIME_PEER_GONE_GRACE_MS = 30_000;
const MAX_CONSECUTIVE_REJECTED_FRAMES = 8;
const REJECTED_FRAME_POLICY_CLOSE_CODE = 1008;
const REJECTED_FRAME_POLICY_CLOSE_REASON = "too many rejected frames";
const DUPLICATE_RUNTIME_PEER_CLOSE_CODE = 1008;
const DUPLICATE_RUNTIME_PEER_CLOSE_REASON = "replaced by newer runtime peer";

/// Storage key holding the notebook id whose `runtime_peer` departure armed the
/// reconciliation alarm. Persisted so a DO that hibernates between the alarm
/// being set and firing still knows which room to reconcile.
const RUNTIME_PEER_WATCH_KEY = "runtime_peer_gone_watch";
const runtimePeerForwardedRequestActions = new Set<RuntimePeerForwardedRequestAction>([
  "interrupt_execution",
  "send_comm",
]);
const runtimePeerQueryRequestActions = new Set<RuntimePeerQueryRequestAction>(["complete"]);
const unsupportedHostedRuntimeRequestActions = new Set<UnsupportedHostedRuntimeRequestAction>([
  "launch_kernel",
  "restart_kernel",
  "shutdown_kernel",
  "sync_environment",
  "get_history",
]);

const MAX_PENDING_RUNTIME_PEER_RESPONSES = 128;
const PENDING_RUNTIME_PEER_RESPONSE_MAX_AGE_MS = 60_000;

function requestEnvelopeMetadataFromPayload(payload: Uint8Array): RequestEnvelopeMetadata {
  try {
    const value = JSON.parse(new TextDecoder().decode(payload)) as unknown;
    if (typeof value !== "object" || value === null) {
      return { id: null, action: null };
    }
    const record = value as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : null;
    const action = typeof record.action === "string" ? record.action : null;
    return { id, action };
  } catch {
    return { id: null, action: null };
  }
}

function runtimeResponseIdFromPayload(payload: Uint8Array): string | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(payload)) as unknown;
    if (typeof value !== "object" || value === null) {
      return null;
    }
    const id = (value as Record<string, unknown>).id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

function runtimePeerForwardedRequestAction(
  action: string | null,
): RuntimePeerForwardedRequestAction | null {
  if (!action) {
    return null;
  }
  return runtimePeerForwardedRequestActions.has(action as RuntimePeerForwardedRequestAction)
    ? (action as RuntimePeerForwardedRequestAction)
    : null;
}

function runtimePeerQueryRequestAction(
  action: string | null,
): RuntimePeerQueryRequestAction | null {
  if (!action) {
    return null;
  }
  return runtimePeerQueryRequestActions.has(action as RuntimePeerQueryRequestAction)
    ? (action as RuntimePeerQueryRequestAction)
    : null;
}

function unsupportedHostedRuntimeRequestAction(
  action: string | null,
): UnsupportedHostedRuntimeRequestAction | null {
  if (!action) {
    return null;
  }
  return unsupportedHostedRuntimeRequestActions.has(action as UnsupportedHostedRuntimeRequestAction)
    ? (action as UnsupportedHostedRuntimeRequestAction)
    : null;
}

export class NotebookRoom {
  private readonly peers = new Map<string, Peer>();
  private readonly pendingRemovals = new Map<
    string,
    { notebookId: string; peer: Peer; closeOptions: PeerCloseOptions }
  >();
  private broadcastDepth = 0;
  private readonly materializers = new Map<string, RoomMaterializer>();
  private readonly selectedRuntimePeerSessions = new Map<
    string,
    SelectedRuntimePeerSession | null
  >();
  private readonly restoredPeersReady: Promise<void>;
  private readonly pendingRuntimePeerResponses = new Map<string, PendingRuntimePeerResponse>();
  // In-memory only by design: persisting on the frame hot path would cost more
  // than the data is worth. Hibernation resets it, so peer_closed summaries
  // under-count peers whose connection outlives the DO instance — treat the
  // numbers as trend data, not billing-exact totals.
  private readonly frameBudget = new SyncFrameBudgetTracker();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    // CF-native liveness: the runtime answers the client's text ping for
    // hibernatable sockets WITHOUT waking the DO. The pair persists across
    // hibernation, so re-setting it per wake is idempotent; matching pings
    // never reach webSocketMessage, so frame budgets and the hibernation
    // restore path are untouched. Feature-detected like the other
    // hibernation APIs (handleMessage answers manually as the fallback).
    const pairCtor = (
      globalThis as {
        WebSocketRequestResponsePair?: new (
          request: string,
          response: string,
        ) => WebSocketRequestResponsePair;
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
    const workstationAttachmentNotebookId = workstationAttachmentControlNotebookId(url.pathname);
    if (workstationAttachmentNotebookId) {
      return this.handleWorkstationAttachmentControl(workstationAttachmentNotebookId, request);
    }
    const runtimeStateRepairNotebookId = runtimeStateRepairControlNotebookId(url.pathname);
    if (runtimeStateRepairNotebookId) {
      return this.handleRuntimeStateRepairControl(runtimeStateRepairNotebookId, request);
    }
    const accessControlNotebookId = accessRevocationControlNotebookId(url.pathname);
    if (accessControlNotebookId) {
      return this.handleAccessRevocationControl(accessControlNotebookId, request);
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

    const workstation = runtimePeerWorkstationMetadataFromRequest(request, identity);
    if (identity.scope === "runtime_peer") {
      const authorityError = await this.runtimePeerAuthorityError(notebookId, workstation);
      if (authorityError) {
        return json({ error: authorityError }, 409);
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const peer: Peer = {
      id: crypto.randomUUID(),
      socket: server,
      identity,
      connectedAt: new Date().toISOString(),
      workstation,
      consecutiveRejectedFrames: 0,
    };

    if (identity.scope === "runtime_peer") {
      this.removeDuplicateRuntimePeers(notebookId, peer);
    }
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
      peers: this.roomPeerRoster(),
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
        participant_key: roomPeerParticipantKey(peer),
        display_name: identity.metadata.displayName,
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
    const closeRuntimePeers =
      payload.close_runtime_peers === true || payload.closeRuntimePeers === true;
    const closeReason =
      typeof payload.close_reason === "string" && payload.close_reason.trim().length > 0
        ? payload.close_reason.trim().slice(0, 120)
        : "workstation attachment replaced";
    const startedAt = Date.now();
    try {
      const materializer = this.materializerFor(notebookId);
      const result = await materializer.setWorkstationAttachment(attachment);
      this.cacheSelectedRuntimePeerSession(notebookId, attachment);
      if (closeRuntimePeers) {
        this.removeRuntimePeers(notebookId, {
          code: 1012,
          reason: closeReason,
          suppressRuntimePeerWatch: true,
        });
      }
      if (result.changed) {
        this.deliverRoomHostFrames(notebookId, result);
      }
      const checkpointPersisted = result.changed
        ? await this.checkpointRoomHost(notebookId, materializer, "workstation_attachment_control")
        : true;
      cloudLog("debug", "room.workstation_attachment.control_published", {
        notebook_id: notebookId,
        changed: result.changed,
        checkpoint_persisted: checkpointPersisted,
        duration_ms: durationMs(startedAt),
        outbound_frame_count: result.outbound.length,
        closed_runtime_peers: closeRuntimePeers,
        counter: "workstation_attachment_control_published",
        counter_delta: result.changed ? 1 : 0,
      });
      return json(
        { ok: true, changed: result.changed, checkpoint_persisted: checkpointPersisted },
        200,
      );
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

  private async handleRuntimeStateRepairControl(
    notebookId: string,
    request: Request,
  ): Promise<Response> {
    // Worker-internal/admin control path only. External traffic reaches this
    // Durable Object through the Worker's strict `/n/:notebookId/sync`
    // WebSocket route; the public alpha admin API calls this path from the
    // Worker after owner authorization.
    if (request.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }

    const payload = await readOptionalJsonObject(request, "runtime state repair body");
    if (payload instanceof Response) {
      return payload;
    }
    const force = payload?.force === true;
    const reason =
      optionalBoundedStringField(payload?.reason, "reason", 240) ?? "manual runtime state repair";
    if (reason instanceof Response) {
      return reason;
    }

    if (this.hasRuntimePeer()) {
      if (!force) {
        return json(
          {
            error: "runtime peer is connected; reconnecting compute should reconcile live state",
            runtime_peer_count: this.runtimePeerCount(),
          },
          409,
        );
      }
      this.removeRuntimePeers(notebookId, {
        code: 1008,
        reason: "runtime state repair",
      });
    }

    const startedAt = Date.now();
    try {
      const materializer = this.materializerFor(notebookId);
      const result = await materializer.reconcileRuntimePeerGone(reason);
      this.invalidateSelectedRuntimePeerSession(notebookId);
      if (result.changed) {
        this.deliverRoomHostFrames(notebookId, result);
      }
      const checkpointPersisted = result.changed
        ? await this.checkpointRoomHost(notebookId, materializer, "runtime_state_repair")
        : true;
      cloudLog("info", "room.runtime_state_repair.completed", {
        notebook_id: notebookId,
        changed: result.changed,
        forced: force,
        checkpoint_persisted: checkpointPersisted,
        runtime_peer_count: this.runtimePeerCount(),
        duration_ms: durationMs(startedAt),
        outbound_frame_count: result.outbound.length,
        counter: "runtime_state_repairs_completed",
        counter_delta: 1,
      });
      return json(
        {
          ok: true,
          changed: result.changed,
          forced: force,
          checkpoint_persisted: checkpointPersisted,
          runtime_peer_count: this.runtimePeerCount(),
        },
        200,
      );
    } catch (error) {
      cloudLog("warn", "room.runtime_state_repair.failed", {
        notebook_id: notebookId,
        forced: force,
        duration_ms: durationMs(startedAt),
        error: errorMessage(error),
        counter: "runtime_state_repairs_failed",
        counter_delta: 1,
      });
      return json({ error: "runtime state repair failed" }, 500);
    }
  }

  private async handleAccessRevocationControl(
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
      return json({ error: "access revocation control body must be JSON" }, 400);
    }
    if (!isRecord(payload)) {
      return json({ error: "access revocation control body must be an object" }, 400);
    }

    const closeAnonymousViewers =
      payload.close_anonymous_viewers === true || payload.closeAnonymousViewers === true;
    const closeReason =
      typeof payload.close_reason === "string" && payload.close_reason.trim().length > 0
        ? payload.close_reason.trim().slice(0, 120)
        : "public link access revoked";
    const closedAnonymousViewers = closeAnonymousViewers
      ? this.removeAnonymousViewerPeers(notebookId, {
          code: 1008,
          reason: closeReason,
        })
      : 0;

    cloudLog("info", "room.access_revocation.control_completed", {
      notebook_id: notebookId,
      closed_anonymous_viewers: closedAnonymousViewers,
      counter: "access_revocation_controls_completed",
      counter_delta: 1,
    });
    return json({ ok: true, closed_anonymous_viewers: closedAnonymousViewers }, 200);
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
        consecutiveRejectedFrames: 0,
      };
      this.peers.set(attachment.peerId, peer);
      restored.push({ notebookId: attachment.notebookId, peer });
    }
    if (sockets.length > 0) {
      cloudLog("info", "room.hibernation.restored_peers", {
        restored_peer_count: this.peers.size,
      });
    }
    const authorizedRestored: Array<{ notebookId: string; peer: Peer }> = [];
    for (const { notebookId, peer } of restored) {
      if (peer.identity.scope === "runtime_peer") {
        const authorityError = await this.runtimePeerAuthorityError(notebookId, peer.workstation);
        if (authorityError) {
          cloudLog("warn", "room.runtime_peer.rejected_on_restore", {
            notebook_id: notebookId,
            peer_id: peer.id,
            principal: peer.identity.principal,
            reason: authorityError,
            workstation_id: runtimePeerWorkstationId(peer.workstation),
            runtime_session_id: runtimePeerRuntimeSessionId(peer.workstation),
            counter: "runtime_peers_rejected_on_restore",
            counter_delta: 1,
          });
          this.removePeer(notebookId, peer, {
            code: 1008,
            reason: "stale runtime session",
          });
          continue;
        }
      }
      authorizedRestored.push({ notebookId, peer });
    }

    const activeRestored = this.removeDuplicateRestoredRuntimePeers(authorizedRestored);
    await Promise.all(
      activeRestored.map(async ({ notebookId, peer }) => {
        await this.syncPeerFromRoomHost(notebookId, peer);
        if (peer.identity.scope === "runtime_peer") {
          this.refreshRuntimePeerWatch(notebookId);
          await this.publishRuntimePeerAttachment(notebookId, peer);
        }
      }),
    );
  }

  private removeDuplicateRestoredRuntimePeers(
    restored: Array<{ notebookId: string; peer: Peer }>,
  ): Array<{ notebookId: string; peer: Peer }> {
    const latestByWorkstation = new Map<string, { notebookId: string; peer: Peer }>();
    for (const restoredPeer of restored) {
      const { notebookId, peer } = restoredPeer;
      if (peer.identity.scope !== "runtime_peer") {
        continue;
      }
      const workstationId = runtimePeerWorkstationId(peer.workstation);
      if (!workstationId) {
        continue;
      }
      const key = `${notebookId}\0${workstationId}`;
      const latest = latestByWorkstation.get(key);
      if (!latest || peer.connectedAt >= latest.peer.connectedAt) {
        latestByWorkstation.set(key, restoredPeer);
      }
    }

    const active: Array<{ notebookId: string; peer: Peer }> = [];
    for (const restoredPeer of restored) {
      const { notebookId, peer } = restoredPeer;
      if (peer.identity.scope !== "runtime_peer") {
        active.push(restoredPeer);
        continue;
      }
      const workstationId = runtimePeerWorkstationId(peer.workstation);
      if (!workstationId) {
        active.push(restoredPeer);
        continue;
      }
      const key = `${notebookId}\0${workstationId}`;
      const latest = latestByWorkstation.get(key);
      if (latest?.peer.id === peer.id) {
        active.push(restoredPeer);
        continue;
      }
      this.removePeer(notebookId, peer, {
        code: DUPLICATE_RUNTIME_PEER_CLOSE_CODE,
        reason: DUPLICATE_RUNTIME_PEER_CLOSE_REASON,
        suppressRuntimePeerWatch: true,
      });
      cloudLog("warn", "room.runtime_peer.duplicate_replaced_on_restore", {
        notebook_id: notebookId,
        closed_peer_id: peer.id,
        replacement_peer_id: latest?.peer.id,
        workstation_id: workstationId,
        counter: "runtime_peer_restore_duplicates_replaced",
        counter_delta: 1,
      });
    }

    return active;
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
    if (message === LIVENESS_PING) {
      // Fallback for non-hibernation sockets and runtimes without
      // setWebSocketAutoResponse — must answer BEFORE the binary-only
      // rejection so pings never count toward consecutiveRejectedFrames.
      try {
        peer.socket.send(LIVENESS_PONG);
      } catch {
        // socket is closing; the close handler owns cleanup
      }
      return;
    }
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

    if (peer.identity.scope === "runtime_peer") {
      const authorityError = await this.runtimePeerAuthorityError(notebookId, peer.workstation);
      if (authorityError) {
        cloudLog("warn", "room.runtime_peer.stale_frame_closed", {
          notebook_id: notebookId,
          peer_id: peer.id,
          principal: peer.identity.principal,
          reason: authorityError,
          workstation_id: runtimePeerWorkstationId(peer.workstation),
          runtime_session_id: runtimePeerRuntimeSessionId(peer.workstation),
          frame_type: frameTypeName(frame.type),
          counter: "runtime_peer_stale_frames_closed",
          counter_delta: 1,
        });
        this.removePeer(notebookId, peer, {
          code: 1008,
          reason: "stale runtime session",
          suppressRuntimePeerWatch: true,
        });
        return;
      }
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
    if (normalizedFrame.type === FrameType.RESPONSE) {
      const routed = this.routeRuntimePeerResponse(notebookId, peer, normalizedFrame);
      if (routed) {
        this.resetRejectedFrameStreak(peer);
        return;
      }
      this.rejectFrame(
        notebookId,
        peer,
        normalizedFrame.type,
        "runtime peer response does not match an in-flight hosted request",
      );
      return;
    }

    if (!shouldBroadcastFrame(normalizedFrame, peer.identity)) {
      // Anonymous public viewers are read-only observers. Their presence is
      // acknowledged locally but not broadcast as room activity.
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
      this.resetRejectedFrameStreak(peer);
      return;
    }

    if (normalizedFrame.type === FrameType.PRESENCE) {
      // Presence is live-only coordination. Persisting it burns Durable Object
      // storage writes without improving recovery; reconnecting peers send a
      // fresh heartbeat/cursor snapshot.
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
      this.resetRejectedFrameStreak(peer);
      return;
    }

    const requestMetadata =
      normalizedFrame.type === FrameType.REQUEST
        ? requestEnvelopeMetadataFromPayload(normalizedFrame.payload)
        : null;
    const forwardedRequestAction = runtimePeerForwardedRequestAction(
      requestMetadata?.action ?? null,
    );
    if (forwardedRequestAction) {
      const forwardedRuntimePeerId = await this.forwardRequestToActiveRuntimePeer(
        notebookId,
        normalizedFrame,
        peer.id,
      );
      if (!forwardedRuntimePeerId) {
        this.rejectFrame(
          notebookId,
          peer,
          normalizedFrame.type,
          `no runtime peer is attached for ${forwardedRequestAction}`,
          { countsTowardStreak: false },
        );
        return;
      }

      cloudLog("debug", "room.runtime_peer_request.forwarded", {
        notebook_id: notebookId,
        peer_id: peer.id,
        principal: peer.identity.principal,
        scope: peer.identity.scope,
        action: forwardedRequestAction,
        forwarded_runtime_peer_id: forwardedRuntimePeerId,
        byte_length: normalizedFrame.payload.byteLength,
        counter: "runtime_peer_requests_forwarded",
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
      this.resetRejectedFrameStreak(peer);
      return;
    }

    const runtimePeerQueryAction = runtimePeerQueryRequestAction(requestMetadata?.action ?? null);
    if (runtimePeerQueryAction) {
      const requestId = requestMetadata?.id;
      if (!requestId) {
        this.rejectFrame(
          notebookId,
          peer,
          normalizedFrame.type,
          `hosted runtime query ${runtimePeerQueryAction} is missing a request id`,
          { countsTowardStreak: false },
        );
        return;
      }
      if (this.pendingRuntimePeerResponses.has(requestId)) {
        this.rejectFrame(
          notebookId,
          peer,
          normalizedFrame.type,
          `hosted runtime query ${runtimePeerQueryAction} request id is already pending`,
          { countsTowardStreak: false },
        );
        return;
      }

      const forwardedRuntimePeerId = await this.forwardQueryToActiveRuntimePeer(
        notebookId,
        normalizedFrame,
        peer.id,
        requestId,
        runtimePeerQueryAction,
      );
      if (!forwardedRuntimePeerId) {
        this.rejectFrame(
          notebookId,
          peer,
          normalizedFrame.type,
          `no runtime peer is attached for ${runtimePeerQueryAction}`,
          { countsTowardStreak: false },
        );
        return;
      }

      cloudLog("debug", "room.runtime_peer_query.forwarded", {
        notebook_id: notebookId,
        peer_id: peer.id,
        principal: peer.identity.principal,
        scope: peer.identity.scope,
        action: runtimePeerQueryAction,
        request_id: requestId,
        forwarded_runtime_peer_id: forwardedRuntimePeerId,
        byte_length: normalizedFrame.payload.byteLength,
        counter: "runtime_peer_queries_forwarded",
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
      this.resetRejectedFrameStreak(peer);
      return;
    }

    const unsupportedRuntimeRequestAction =
      normalizedFrame.type === FrameType.REQUEST
        ? unsupportedHostedRuntimeRequestAction(requestMetadata?.action ?? null)
        : null;
    if (unsupportedRuntimeRequestAction) {
      this.rejectFrame(
        notebookId,
        peer,
        normalizedFrame.type,
        `hosted cloud rooms do not yet support response-bearing runtime request ${unsupportedRuntimeRequestAction}`,
        { countsTowardStreak: false },
      );
      return;
    }

    if (isMaterializedSyncFrame(normalizedFrame.type)) {
      let result: RoomHostFrameResult;
      const materializer = this.materializerFor(notebookId);
      const startedAt = Date.now();
      try {
        result = await materializer.receiveFrame(peer, normalizedFrame);
      } catch (error) {
        if (isRoomStorageDegradedError(error)) {
          this.sendRoomDegradedControl(notebookId, peer, errorMessage(error));
          return;
        }
        this.rejectFrame(
          notebookId,
          peer,
          normalizedFrame.type,
          `room host rejected ${frameTypeName(normalizedFrame.type)} frame: ${String(error)}`,
          { countsTowardStreak: false },
        );
        return;
      }
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
        outbound_frame_count: result.outbound.length,
        counter: "materialized_frames_applied",
        counter_delta: 1,
      });

      this.deliverRoomHostFrames(notebookId, result);
      if (result.changed) {
        this.scheduleRoomHostCheckpoint(notebookId, materializer, "materialized_frame");
      }
      this.sendControl(notebookId, peer, {
        type: "cloud_frame_accepted",
        notebook_id: notebookId,
        peer_id: peer.id,
        frame_type: normalizedFrame.type,
        byte_length: normalizedFrame.payload.byteLength,
        timestamp: receivedAt,
      });
      this.resetRejectedFrameStreak(peer);
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
    this.resetRejectedFrameStreak(peer);
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
      case FrameType.RESPONSE:
        return identity.scope === "runtime_peer";
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
      const reason = errorMessage(error);
      cloudLog("warn", "room.peer_sync.failed", {
        notebook_id: notebookId,
        peer_id: peer.id,
        principal: peer.identity.principal,
        scope: peer.identity.scope,
        duration_ms: durationMs(startedAt),
        error: reason,
        counter: "peer_sync_failed",
        counter_delta: 1,
      });
      if (!isRoomStorageDegradedError(error)) {
        this.removePeer(notebookId, peer, {
          code: 1011,
          reason: "room sync failed",
        });
        return;
      }
      this.sendRoomDegradedControl(notebookId, peer, reason);
    }
  }

  private sendRoomDegradedControl(notebookId: string, peer: Peer, reason: string): void {
    this.sendControl(notebookId, peer, {
      type: "cloud_room_degraded",
      notebook_id: notebookId,
      peer_id: peer.id,
      reason,
      timestamp: new Date().toISOString(),
    });
  }

  private scheduleRoomHostCheckpoint(
    notebookId: string,
    materializer: RoomMaterializer,
    operation: string,
  ): void {
    this.state.waitUntil(this.checkpointRoomHost(notebookId, materializer, operation));
  }

  private async checkpointRoomHost(
    notebookId: string,
    materializer: RoomMaterializer,
    operation: string,
  ): Promise<boolean> {
    try {
      await materializer.checkpoint();
      return true;
    } catch (error) {
      cloudLog("warn", "room.materializer.checkpoint_failed", {
        notebook_id: notebookId,
        operation,
        error: errorMessage(error),
        counter: "materializer_checkpoint_failures",
        counter_delta: 1,
      });
      return false;
    }
  }

  private async publishRuntimePeerAttachment(notebookId: string, peer: Peer): Promise<void> {
    const startedAt = Date.now();
    try {
      const materializer = this.materializerFor(notebookId);
      const attachment = runtimePeerWorkstationAttachment(peer);
      const result = await materializer.setWorkstationAttachment(attachment);
      this.cacheSelectedRuntimePeerSession(notebookId, attachment);
      if (result.changed) {
        this.deliverRoomHostFrames(notebookId, result);
        await this.checkpointRoomHost(notebookId, materializer, "runtime_peer_attachment");
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

  private async runtimePeerAuthorityError(
    notebookId: string,
    workstation: RuntimePeerWorkstationMetadata | null,
  ): Promise<string | null> {
    const selected = await this.selectedRuntimePeerSession(notebookId);
    if (!selected) {
      return null;
    }

    const presentedWorkstationId = runtimePeerWorkstationId(workstation);
    if (presentedWorkstationId === selected.workstationId) {
      if (!selected.runtimeSessionId) {
        return null;
      }
      const presentedSessionId = runtimePeerRuntimeSessionId(workstation);
      if (presentedSessionId === selected.runtimeSessionId) {
        return null;
      }
      return `runtime peer session ${presentedSessionId ?? "unknown"} does not match selected runtime session ${selected.runtimeSessionId}`;
    }

    return `runtime peer workstation ${presentedWorkstationId} does not match selected workstation ${selected.workstationId}`;
  }

  private removeRuntimePeers(notebookId: string, closeOptions: PeerCloseOptions): void {
    for (const peer of Array.from(this.peers.values())) {
      if (peer.identity.scope === "runtime_peer") {
        this.removePeer(notebookId, peer, closeOptions);
      }
    }
  }

  private removeAnonymousViewerPeers(notebookId: string, closeOptions: PeerCloseOptions): number {
    let closedCount = 0;
    for (const peer of Array.from(this.peers.values())) {
      if (!isAnonymousViewer(peer.identity)) {
        continue;
      }
      this.removePeer(notebookId, peer, closeOptions);
      closedCount += 1;
    }
    return closedCount;
  }

  private removeDuplicateRuntimePeers(notebookId: string, incomingPeer: Peer): void {
    const incomingWorkstationId = runtimePeerWorkstationId(incomingPeer.workstation);
    let closedCount = 0;
    for (const peer of Array.from(this.peers.values())) {
      if (peer.identity.scope !== "runtime_peer") {
        continue;
      }
      if (runtimePeerWorkstationId(peer.workstation) !== incomingWorkstationId) {
        continue;
      }

      this.removePeer(notebookId, peer, {
        code: DUPLICATE_RUNTIME_PEER_CLOSE_CODE,
        reason: DUPLICATE_RUNTIME_PEER_CLOSE_REASON,
        suppressRuntimePeerWatch: true,
      });
      closedCount += 1;
    }

    if (closedCount > 0) {
      cloudLog("warn", "room.runtime_peer.duplicate_replaced", {
        notebook_id: notebookId,
        incoming_peer_id: incomingPeer.id,
        workstation_id: incomingWorkstationId,
        closed_runtime_peers: closedCount,
        counter: "runtime_peer_duplicates_replaced",
        counter_delta: closedCount,
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

  private async forwardRequestToActiveRuntimePeer(
    notebookId: string,
    frame: TypedFrame,
    sourcePeerId: string,
  ): Promise<string | null> {
    const runtimePeer = await this.activeRuntimePeer(notebookId, sourcePeerId);
    if (!runtimePeer) {
      return null;
    }
    return this.forwardFrameToRuntimePeer(notebookId, runtimePeer, frame) ? runtimePeer.id : null;
  }

  private async forwardQueryToActiveRuntimePeer(
    notebookId: string,
    frame: TypedFrame,
    sourcePeerId: string,
    requestId: string,
    action: RuntimePeerQueryRequestAction,
  ): Promise<string | null> {
    const runtimePeer = await this.activeRuntimePeer(notebookId, sourcePeerId);
    if (!runtimePeer) {
      return null;
    }

    this.prunePendingRuntimePeerResponses();
    if (this.pendingRuntimePeerResponses.size >= MAX_PENDING_RUNTIME_PEER_RESPONSES) {
      const oldest = Array.from(this.pendingRuntimePeerResponses.entries()).sort(
        (a, b) => a[1].createdAtMs - b[1].createdAtMs,
      )[0];
      if (oldest) {
        this.rejectPendingRuntimePeerResponse(
          oldest[1].notebookId,
          oldest[0],
          oldest[1],
          `runtime peer query ${oldest[1].action} was evicted because too many queries are pending`,
        );
      }
    }

    this.pendingRuntimePeerResponses.set(requestId, {
      notebookId,
      sourcePeerId,
      runtimePeerId: runtimePeer.id,
      action,
      createdAtMs: Date.now(),
    });

    if (!this.forwardFrameToRuntimePeer(notebookId, runtimePeer, frame)) {
      this.pendingRuntimePeerResponses.delete(requestId);
      return null;
    }

    return runtimePeer.id;
  }

  private async activeRuntimePeer(
    notebookId: string,
    sourcePeerId: string,
  ): Promise<Peer | undefined> {
    const selectedRuntimeSession = await this.selectedRuntimePeerSession(notebookId);
    let selected: Peer | undefined;
    for (const peer of this.peers.values()) {
      if (peer.id === sourcePeerId || peer.identity.scope !== "runtime_peer") {
        continue;
      }
      if (!runtimePeerMatchesSelectedSession(peer, selectedRuntimeSession)) {
        continue;
      }
      if (!selected || peer.connectedAt >= selected.connectedAt) {
        selected = peer;
      }
    }
    return selected;
  }

  private async selectedRuntimePeerSession(
    notebookId: string,
  ): Promise<SelectedRuntimePeerSession | null> {
    if (this.selectedRuntimePeerSessions.has(notebookId)) {
      return this.selectedRuntimePeerSessions.get(notebookId) ?? null;
    }
    const materializer = this.materializerFor(notebookId);
    if (typeof materializer.getWorkstationAttachment !== "function") {
      return null;
    }
    const attachment = await materializer.getWorkstationAttachment();
    const selected = selectedRuntimePeerSessionFromAttachment(attachment);
    this.selectedRuntimePeerSessions.set(notebookId, selected);
    return selected;
  }

  private cacheSelectedRuntimePeerSession(
    notebookId: string,
    attachment: WorkstationAttachmentState | null,
  ): void {
    this.selectedRuntimePeerSessions.set(
      notebookId,
      selectedRuntimePeerSessionFromAttachment(attachment),
    );
  }

  private invalidateSelectedRuntimePeerSession(notebookId: string): void {
    this.selectedRuntimePeerSessions.delete(notebookId);
  }

  private forwardFrameToRuntimePeer(
    notebookId: string,
    runtimePeer: Peer,
    frame: TypedFrame,
  ): boolean {
    const encoded = encodeTypedFrame(frame.type, frame.payload);

    // Overlapping runtime peers can happen during reconnect races. Stale
    // sessions are rejected on connect/restore/frame ingress; within the
    // accepted session, command requests target the latest peer.
    this.broadcastDepth += 1;
    let delivered = false;
    try {
      if (this.trySendFrame(notebookId, runtimePeer, encoded)) {
        delivered = true;
      } else {
        this.queuePeerRemoval(notebookId, runtimePeer);
      }
    } finally {
      this.broadcastDepth -= 1;
      if (this.broadcastDepth === 0) {
        this.flushPendingRemovals();
      }
    }

    return delivered;
  }

  private routeRuntimePeerResponse(notebookId: string, peer: Peer, frame: TypedFrame): boolean {
    if (peer.identity.scope !== "runtime_peer") {
      return false;
    }

    const requestId = runtimeResponseIdFromPayload(frame.payload);
    if (!requestId) {
      return false;
    }

    const pending = this.pendingRuntimePeerResponses.get(requestId);
    if (!pending || pending.runtimePeerId !== peer.id || pending.notebookId !== notebookId) {
      return false;
    }

    this.pendingRuntimePeerResponses.delete(requestId);
    const sourcePeer = this.peers.get(pending.sourcePeerId);
    if (!sourcePeer) {
      return true;
    }

    const encoded = encodeTypedFrame(frame.type, frame.payload);
    if (!this.trySendFrame(notebookId, sourcePeer, encoded)) {
      this.queuePeerRemoval(notebookId, sourcePeer);
    }
    cloudLog("debug", "room.runtime_peer_query.response_forwarded", {
      notebook_id: notebookId,
      peer_id: sourcePeer.id,
      runtime_peer_id: peer.id,
      request_id: requestId,
      action: pending.action,
      byte_length: frame.payload.byteLength,
      counter: "runtime_peer_query_responses_forwarded",
      counter_delta: 1,
    });
    return true;
  }

  private prunePendingRuntimePeerResponses(nowMs = Date.now()): void {
    for (const [requestId, pending] of this.pendingRuntimePeerResponses) {
      if (nowMs - pending.createdAtMs > PENDING_RUNTIME_PEER_RESPONSE_MAX_AGE_MS) {
        this.rejectPendingRuntimePeerResponse(
          pending.notebookId,
          requestId,
          pending,
          `runtime peer query ${pending.action} expired before the runtime peer responded`,
        );
      }
    }
  }

  private rejectPendingRuntimePeerResponse(
    notebookId: string,
    requestId: string,
    pending: PendingRuntimePeerResponse,
    reason: string,
  ): void {
    this.pendingRuntimePeerResponses.delete(requestId);
    const sourcePeer = this.peers.get(pending.sourcePeerId);
    if (!sourcePeer) {
      return;
    }

    const payload = new TextEncoder().encode(
      JSON.stringify({
        id: requestId,
        result: "error",
        error: reason,
      }),
    );
    if (!this.trySendFrame(notebookId, sourcePeer, encodeTypedFrame(FrameType.RESPONSE, payload))) {
      this.queuePeerRemoval(notebookId, sourcePeer);
    }
  }

  private rejectPendingRuntimePeerResponsesForPeer(
    notebookId: string,
    peerId: string,
    reason: string,
  ): void {
    for (const [requestId, pending] of Array.from(this.pendingRuntimePeerResponses)) {
      if (
        pending.notebookId !== notebookId ||
        (pending.sourcePeerId !== peerId && pending.runtimePeerId !== peerId)
      ) {
        continue;
      }

      this.pendingRuntimePeerResponses.delete(requestId);
      if (pending.sourcePeerId === peerId) {
        continue;
      }

      this.rejectPendingRuntimePeerResponse(notebookId, requestId, pending, reason);
    }
  }

  private rejectFrame(
    notebookId: string,
    peer: Peer,
    frameType: number | undefined,
    reason: string,
    options: RejectFrameOptions = {},
  ): void {
    const countsTowardStreak = options.countsTowardStreak ?? true;
    const policy = countsTowardStreak
      ? rejectedFramePolicy(peer.consecutiveRejectedFrames)
      : {
          consecutiveRejectedFrames: peer.consecutiveRejectedFrames,
          limit: MAX_CONSECUTIVE_REJECTED_FRAMES,
          shouldClose: false,
        };
    if (countsTowardStreak) {
      peer.consecutiveRejectedFrames = policy.consecutiveRejectedFrames;
    }

    if (policy.shouldClose) {
      cloudLog("warn", "room.peer.closed_for_rejected_frames", {
        notebook_id: notebookId,
        peer_id: peer.id,
        principal: peer.identity.principal,
        scope: peer.identity.scope,
        frame_type: frameType === undefined ? "unknown" : frameTypeName(frameType),
        reason,
        consecutive_rejected_frame_count: policy.consecutiveRejectedFrames,
        consecutive_rejected_frame_limit: policy.limit,
        room_peer_count: this.peers.size,
        counter: "peers_closed_for_rejected_frames",
        counter_delta: 1,
      });
      this.removePeer(notebookId, peer, {
        code: REJECTED_FRAME_POLICY_CLOSE_CODE,
        reason: REJECTED_FRAME_POLICY_CLOSE_REASON,
      });
      return;
    }

    cloudLog("warn", "room.frame.rejected", {
      notebook_id: notebookId,
      peer_id: peer.id,
      principal: peer.identity.principal,
      scope: peer.identity.scope,
      frame_type: frameType === undefined ? "unknown" : frameTypeName(frameType),
      reason,
      counts_toward_rejected_frame_streak: countsTowardStreak,
      consecutive_rejected_frame_count: policy.consecutiveRejectedFrames,
      consecutive_rejected_frame_limit: policy.limit,
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

  private resetRejectedFrameStreak(peer: Peer): void {
    peer.consecutiveRejectedFrames = 0;
  }

  private sendControl(notebookId: string, peer: Peer, message: SessionControlMessage): void {
    this.sendFrameToPeer(notebookId, peer, encodeJsonFrame(FrameType.SESSION_CONTROL, message));
  }

  private roomPeerRoster(): CloudRoomPeerRosterEntry[] {
    return Array.from(this.peers.values(), (peer) => this.roomPeerRosterEntry(peer));
  }

  private roomPeerRosterEntry(peer: Peer): CloudRoomPeerRosterEntry {
    return {
      peer_id: peer.id,
      actor_label: peer.identity.actorLabel,
      connection_scope: peer.identity.scope,
      participant_key: roomPeerParticipantKey(peer),
      identity_provider: peer.identity.metadata.provider,
      principal_namespace: peer.identity.metadata.principalNamespace,
      display_name: peer.identity.metadata.displayName,
      connected_at: peer.connectedAt,
    };
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

  private queuePeerRemoval(
    notebookId: string,
    peer: Peer,
    closeOptions: PeerCloseOptions = {},
  ): void {
    if (!this.peers.has(peer.id)) {
      return;
    }

    this.pendingRemovals.set(peer.id, { notebookId, peer, closeOptions });
  }

  private flushPendingRemovals(): void {
    while (this.pendingRemovals.size > 0) {
      const removals = Array.from(this.pendingRemovals.values());
      this.pendingRemovals.clear();
      for (const { notebookId, peer, closeOptions } of removals) {
        this.removePeer(notebookId, peer, closeOptions);
      }
    }
  }

  private removePeer(notebookId: string, peer: Peer, closeOptions: PeerCloseOptions = {}): void {
    if (this.broadcastDepth > 0) {
      this.queuePeerRemoval(notebookId, peer, closeOptions);
      return;
    }

    if (!this.peers.delete(peer.id)) {
      return;
    }
    this.rejectPendingRuntimePeerResponsesForPeer(
      notebookId,
      peer.id,
      `${peer.identity.scope} disconnected before runtime query completed`,
    );
    this.state.waitUntil(
      this.materializerFor(notebookId)
        .removePeer(peer.id)
        .catch(() => undefined),
    );

    try {
      peer.socket.close(closeOptions.code, closeOptions.reason);
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
      participant_key: roomPeerParticipantKey(peer),
      room_peer_count: this.peers.size,
      runtime_peer_count: this.runtimePeerCount(),
      timestamp: new Date().toISOString(),
    });

    // A runtime_peer departure is the one failure the daemon can't self-correct
    // (its death IS the trigger). Arm the reconciliation watchdog if it left no
    // runtime_peer behind.
    if (peer.identity.scope === "runtime_peer" && !closeOptions.suppressRuntimePeerWatch) {
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
      this.invalidateSelectedRuntimePeerSession(notebookId);
      if (result.changed) {
        this.deliverRoomHostFrames(notebookId, result);
        this.scheduleRoomHostCheckpoint(
          notebookId,
          this.materializerFor(notebookId),
          "runtime_peer_watch_reconcile",
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

export function rejectedFramePolicy(
  consecutiveRejectedFrames: number,
  limit = MAX_CONSECUTIVE_REJECTED_FRAMES,
): { consecutiveRejectedFrames: number; limit: number; shouldClose: boolean } {
  const normalizedLimit = Math.max(1, normalizeNonNegativeInteger(limit, 1));
  const nextCount = normalizeNonNegativeInteger(consecutiveRejectedFrames, 0) + 1;
  return {
    consecutiveRejectedFrames: nextCount,
    limit: normalizedLimit,
    shouldClose: nextCount >= normalizedLimit,
  };
}

function normalizeNonNegativeInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.trunc(value));
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
    runtime_session_id: workstation?.runtimeSessionId ?? null,
  };
}

function runtimePeerWorkstationId(workstation: RuntimePeerWorkstationMetadata | null): string {
  const workstationId = workstation?.workstationId?.trim();
  return workstationId && workstationId.length > 0 ? workstationId : "runtime-peer";
}

function runtimePeerRuntimeSessionId(
  workstation: RuntimePeerWorkstationMetadata | null,
): string | null {
  const runtimeSessionId = workstation?.runtimeSessionId?.trim();
  return runtimeSessionId && runtimeSessionId.length > 0 ? runtimeSessionId : null;
}

function selectedRuntimePeerSessionFromAttachment(
  attachment: WorkstationAttachmentState | null,
): SelectedRuntimePeerSession | null {
  if (!attachment) {
    return null;
  }
  const workstationId = attachment.workstation_id.trim();
  if (!workstationId || workstationId === "runtime-peer") {
    return null;
  }
  return {
    workstationId,
    runtimeSessionId: attachment.runtime_session_id?.trim() || null,
  };
}

function runtimePeerMatchesSelectedSession(
  peer: Peer,
  selected: SelectedRuntimePeerSession | null,
): boolean {
  if (!selected) {
    return true;
  }
  if (runtimePeerWorkstationId(peer.workstation) !== selected.workstationId) {
    return false;
  }
  if (!selected.runtimeSessionId) {
    return true;
  }
  return runtimePeerRuntimeSessionId(peer.workstation) === selected.runtimeSessionId;
}

function roomPeerParticipantKey(peer: Peer): string {
  if (isAnonymousViewer(peer.identity)) {
    return `anonymous:${peer.id}`;
  }
  return peer.identity.principal;
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
    runtimeSessionId: boundedHeader(request, "x-nteract-runtime-session-id", 128),
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
  setBoundedMetadataField(metadata, "runtimeSessionId", candidate.runtimeSessionId, 128);
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
    case "runtimeSessionId":
      metadata.runtimeSessionId = bounded;
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

function runtimeStateRepairControlNotebookId(pathname: string): string | undefined {
  const match = pathname.match(/^\/internal\/n\/([^/]+)\/runtime-state-repair\/?$/);
  if (!match) {
    return undefined;
  }
  return decodeURIComponent(match[1]);
}

function accessRevocationControlNotebookId(pathname: string): string | undefined {
  const match = pathname.match(/^\/internal\/n\/([^/]+)\/access-revocation\/?$/);
  if (!match) {
    return undefined;
  }
  return decodeURIComponent(match[1]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readOptionalJsonObject(
  request: Request,
  label: string,
): Promise<Record<string, unknown> | null | Response> {
  const text = await request.text();
  if (!text.trim()) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return json({ error: `${label} must be JSON` }, 400);
  }
  if (!isRecord(payload)) {
    return json({ error: `${label} must be a JSON object` }, 400);
  }
  return payload;
}

function optionalBoundedStringField(
  value: unknown,
  fieldName: string,
  maxLength: number,
): string | null | Response {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return json({ error: `${fieldName} must be a string` }, 400);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, maxLength);
}

function webSocketMessageByteLength(message: string | ArrayBuffer | ArrayBufferView): number {
  if (typeof message === "string") {
    // Text frames are rejected unconditionally, so an exact UTF-8 byte count
    // is not worth an encoder allocation + full copy on a path a misbehaving
    // client can hammer. UTF-16 code-unit length is close enough for budgets.
    return message.length;
  }
  if (message instanceof ArrayBuffer) {
    return message.byteLength;
  }
  return message.byteLength;
}

function isRoomStorageDegradedError(error: unknown): boolean {
  const message = errorMessage(error);
  // Cloudflare Durable Objects and SQLite surface storage quota/full-disk
  // failures as message text, not typed errors. Keep this classifier narrow so
  // only storage pressure enters the recoverable degraded-room path.
  return (
    message.includes("Exceeded allowed rows written in Durable Objects free tier") ||
    message.includes("SQLITE_FULL") ||
    message.includes("database or disk is full")
  );
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
