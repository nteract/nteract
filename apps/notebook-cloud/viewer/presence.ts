import type { SessionControlMessage } from "../src/protocol";
import {
  notebookActorIdentityFromProjection,
  notebookActorProjectionFromLabel,
} from "@/components/notebook/actor-projection";

export type CloudViewerPresenceConnection = "connecting" | "connected" | "disconnected";

export interface CloudViewerPresenceState {
  connection: CloudViewerPresenceConnection;
  ownPeerId: string | null;
  actorLabel: string | null;
  ownPeerLabel: string | null;
  peers: CloudViewerPresencePeer[];
  roomPeerCount: number | null;
}

export interface CloudViewerPresenceDisplay {
  label: string;
  title: string;
  connected: boolean;
  peers: CloudViewerPresencePeer[];
  hiddenCount: number;
}

export interface CloudViewerPresencePeer {
  id: string;
  label: string;
  kind: "self" | "peer" | "anonymous" | "unknown";
  status: "active" | "idle" | "offline";
  count?: number;
}

export class CloudViewerPresenceStore {
  private state = initialCloudViewerPresence();
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): CloudViewerPresenceState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  reset(): void {
    this.update(initialCloudViewerPresence());
  }

  reduceConnection(connection: CloudViewerPresenceConnection): void {
    this.update(reduceCloudViewerConnection(this.state, connection));
  }

  reduceMessage(message: SessionControlMessage): void {
    this.update(reduceCloudViewerPresenceMessage(this.state, message));
  }

  private update(nextState: CloudViewerPresenceState): void {
    if (Object.is(this.state, nextState)) {
      return;
    }
    this.state = nextState;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function initialCloudViewerPresence(): CloudViewerPresenceState {
  return {
    connection: "connecting",
    ownPeerId: null,
    actorLabel: null,
    ownPeerLabel: null,
    peers: [],
    roomPeerCount: null,
  };
}

export function reduceCloudViewerConnection(
  state: CloudViewerPresenceState,
  connection: CloudViewerPresenceConnection,
): CloudViewerPresenceState {
  return {
    ...state,
    connection,
    peers: state.peers.map((peer) => ({
      ...peer,
      status:
        connection === "connected" ? "active" : connection === "disconnected" ? "offline" : "idle",
    })),
  };
}

export function reduceCloudViewerPresenceMessage(
  state: CloudViewerPresenceState,
  message: SessionControlMessage,
): CloudViewerPresenceState {
  switch (message.type) {
    case "cloud_room_ready":
      return withRoomPeerCount(
        {
          connection: "connected",
          ownPeerId: message.peer_id,
          actorLabel: message.actor_label,
          ownPeerLabel: cloudFriendlyPeerLabel({
            displayName: message.display_name,
            email: message.email,
            actorLabel: message.actor_label,
          }),
          peers: [
            cloudPresencePeerFromMessage({
              peerId: message.peer_id,
              displayName: message.display_name,
              email: message.email,
              actorLabel: message.actor_label,
              kind: "self",
            }),
          ],
          roomPeerCount: safeRoomPeerCount(message.room_peer_count),
        },
        message.room_peer_count,
      );
    case "cloud_peer_joined":
      return withRoomPeerCount(
        {
          ...state,
          connection: "connected",
          peers: upsertCloudPresencePeer(
            state.peers,
            cloudPresencePeerFromMessage({
              peerId: message.peer_id,
              actorLabel: message.actor_label,
              kind: "peer",
            }),
          ),
          roomPeerCount: safeRoomPeerCount(message.room_peer_count),
        },
        message.room_peer_count,
      );
    case "cloud_peer_left":
      return withRoomPeerCount(
        {
          ...state,
          connection: "connected",
          peers: state.peers.filter((peer) => peer.id !== message.peer_id),
          roomPeerCount: safeRoomPeerCount(message.room_peer_count),
        },
        message.room_peer_count,
      );
    default:
      return state;
  }
}

function cloudPresencePeerFromMessage({
  peerId,
  displayName,
  email,
  actorLabel,
  kind,
}: {
  peerId: string;
  displayName?: string | null;
  email?: string | null;
  actorLabel?: string | null;
  kind: "self" | "peer";
}): CloudViewerPresencePeer {
  const label = cloudFriendlyPeerLabel({ displayName, email, actorLabel });
  return {
    id: peerId,
    label,
    kind: label === "Anonymous" ? "anonymous" : kind === "self" ? "self" : "peer",
    status: "active",
  };
}

function upsertCloudPresencePeer(
  peers: CloudViewerPresencePeer[],
  nextPeer: CloudViewerPresencePeer,
): CloudViewerPresencePeer[] {
  const existingIndex = peers.findIndex((peer) => peer.id === nextPeer.id);
  if (existingIndex === -1) {
    return [...peers.filter((peer) => peer.kind !== "unknown"), nextPeer];
  }

  return peers.map((peer, index) => (index === existingIndex ? nextPeer : peer));
}

function withRoomPeerCount(
  state: CloudViewerPresenceState,
  roomPeerCount: number,
): CloudViewerPresenceState {
  const count = safeRoomPeerCount(roomPeerCount);
  const knownPeers = state.peers.filter((peer) => peer.kind !== "unknown").slice(0, count);
  const missingCount = Math.max(0, count - knownPeers.length);
  const placeholders = Array.from({ length: missingCount }, (_, index): CloudViewerPresencePeer => {
    const ordinal = knownPeers.length + index + 1;
    return {
      id: `unknown-${ordinal}`,
      label: "Anonymous",
      kind: "unknown",
      status: state.connection === "connected" ? "active" : "idle",
    };
  });

  return {
    ...state,
    roomPeerCount: count,
    peers: [...knownPeers, ...placeholders],
  };
}

export function cloudViewerPresenceDisplay(
  state: CloudViewerPresenceState,
): CloudViewerPresenceDisplay {
  if (state.connection === "disconnected") {
    return {
      label: "Offline",
      title: "Room unavailable",
      connected: false,
      peers: state.peers.map((peer) => ({ ...peer, status: "offline" })),
      hiddenCount: 0,
    };
  }

  if (state.connection === "connecting" || state.roomPeerCount === null) {
    return {
      label: "Joining room",
      title: "Joining room",
      connected: false,
      peers: [
        {
          id: "joining",
          label: "Joining room",
          kind: "unknown",
          status: "idle",
        },
      ],
      hiddenCount: 0,
    };
  }

  const count = Math.max(1, state.roomPeerCount);
  const knownPeers = state.peers.filter((peer) => peer.kind !== "unknown");
  const anonymousCount = state.peers.filter(
    (peer) => peer.kind === "anonymous" || peer.kind === "unknown",
  ).length;
  const namedPeers = knownPeers.filter((peer) => peer.kind !== "anonymous");
  const visibleNamedPeerLimit = anonymousCount > 0 ? 2 : 3;
  const visibleNamedPeers = namedPeers.slice(0, visibleNamedPeerLimit);
  const visiblePeers =
    anonymousCount > 0
      ? [
          ...visibleNamedPeers,
          {
            id: "anonymous-group",
            label:
              anonymousCount === 1 ? "Anonymous viewer" : `${anonymousCount} anonymous viewers`,
            kind: "anonymous" as const,
            status: "active" as const,
            count: anonymousCount,
          },
        ]
      : visibleNamedPeers;
  const hiddenCount = Math.max(0, namedPeers.length - visibleNamedPeers.length);
  const title = count === 1 ? "1 participant" : `${count} participants`;
  return {
    label: count === 1 ? "1 here now" : `${count} here now`,
    title,
    connected: true,
    peers: visiblePeers,
    hiddenCount,
  };
}

export interface CloudFriendlyPeerLabelInput {
  displayName?: string | null;
  email?: string | null;
  actorLabel?: string | null;
}

export function cloudVisiblePeerLabel(
  peerLabel?: string | null,
  actorLabel?: string | null,
): string {
  const trimmedPeerLabel = peerLabel?.trim();
  if (trimmedPeerLabel && !looksLikeRawIdentityLabel(trimmedPeerLabel)) {
    return trimmedPeerLabel;
  }

  return cloudFriendlyPeerLabel({ actorLabel: actorLabel ?? trimmedPeerLabel });
}

export function cloudFriendlyPeerLabel({
  displayName,
  email,
  actorLabel,
}: CloudFriendlyPeerLabelInput): string {
  const trimmedDisplayName = displayName?.trim();
  if (trimmedDisplayName && !looksLikeRawIdentityLabel(trimmedDisplayName)) {
    return trimmedDisplayName;
  }

  const trimmedEmail = email?.trim();
  if (trimmedEmail) {
    return trimmedEmail;
  }

  const trimmedActorLabel = actorLabel?.trim();
  if (!trimmedActorLabel) return "Peer";

  return notebookActorIdentityFromProjection(
    notebookActorProjectionFromLabel(trimmedActorLabel, { source: "cloud", isPublic: false }),
  ).label;
}

function safeRoomPeerCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

function looksLikeRawIdentityLabel(value: string): boolean {
  return /^(anonymous|user):/.test(value);
}
