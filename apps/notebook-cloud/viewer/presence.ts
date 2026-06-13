import type { CloudRoomPeerRosterEntry, SessionControlMessage } from "../src/protocol";
import type { ConnectionScope } from "../src/auth-shared";
import { notebookActorIdentityFromProjection, notebookActorProjectionFromLabel } from "runtimed";

export type CloudViewerPresenceConnection = "connecting" | "connected" | "disconnected";

export interface CloudViewerPresenceState {
  connection: CloudViewerPresenceConnection;
  ownPeerId: string | null;
  actorLabel: string | null;
  ownPeerLabel: string | null;
  peers: CloudViewerPresencePeer[];
  roomPeerCount: number | null;
  runtimePeerCount: number;
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
  participantKey: string;
  label: string;
  connectionScope: ConnectionScope | null;
  kind: "self" | "peer" | "anonymous" | "runtime" | "unknown";
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
    runtimePeerCount: 0,
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
      return {
        connection: "connected",
        ownPeerId: message.peer_id,
        actorLabel: message.actor_label,
        ownPeerLabel: cloudFriendlyPeerLabel({
          displayName: message.display_name,
          email: message.email,
          actorLabel: message.actor_label,
        }),
        peers:
          message.peers && message.peers.length > 0
            ? cloudPresencePeersFromRoster(message.peers, message.peer_id)
            : [
                cloudPresencePeerFromMessage({
                  peerId: message.peer_id,
                  displayName: message.display_name,
                  email: message.email,
                  actorLabel: message.actor_label,
                  connectionScope: message.connection_scope,
                  kind: "self",
                }),
              ],
        roomPeerCount: safeRoomPeerCount(message.room_peer_count),
        runtimePeerCount: safeRuntimePeerCount(
          message.runtime_peer_count,
          message.connection_scope === "runtime_peer" ? 1 : 0,
        ),
      };
    case "cloud_peer_joined":
      return {
        ...state,
        connection: "connected",
        peers: upsertCloudPresencePeer(
          state.peers,
          cloudPresencePeerFromMessage({
            peerId: message.peer_id,
            displayName: message.display_name,
            actorLabel: message.actor_label,
            connectionScope: message.connection_scope ?? null,
            participantKey: message.participant_key,
            kind: "peer",
          }),
        ),
        roomPeerCount: safeRoomPeerCount(message.room_peer_count),
        runtimePeerCount: safeRuntimePeerCount(
          message.runtime_peer_count,
          state.runtimePeerCount + (message.connection_scope === "runtime_peer" ? 1 : 0),
        ),
      };
    case "cloud_peer_left":
      return {
        ...state,
        connection: "connected",
        peers: state.peers.filter((peer) => peer.id !== message.peer_id),
        roomPeerCount: safeRoomPeerCount(message.room_peer_count),
        runtimePeerCount: safeRuntimePeerCount(
          message.runtime_peer_count,
          state.runtimePeerCount - (message.connection_scope === "runtime_peer" ? 1 : 0),
        ),
      };
    default:
      return state;
  }
}

function cloudPresencePeerFromMessage({
  peerId,
  displayName,
  email,
  actorLabel,
  connectionScope,
  participantKey,
  kind,
}: {
  peerId: string;
  displayName?: string | null;
  email?: string | null;
  actorLabel?: string | null;
  connectionScope?: string | null;
  participantKey?: string | null;
  kind: "self" | "peer";
}): CloudViewerPresencePeer {
  const label = cloudFriendlyPeerLabel({ displayName, email, actorLabel });
  const normalizedConnectionScope = normalizePresenceConnectionScope(connectionScope);
  const isRuntimePeer = normalizedConnectionScope === "runtime_peer";
  const isAnonymous = !isRuntimePeer && label === "Anonymous";
  return {
    id: peerId,
    participantKey: cloudPresenceParticipantKey({ participantKey, actorLabel, peerId }),
    label,
    connectionScope: normalizedConnectionScope,
    kind: isRuntimePeer ? "runtime" : isAnonymous ? "anonymous" : kind === "self" ? "self" : "peer",
    status: "active",
  };
}

function cloudPresencePeersFromRoster(
  roster: readonly CloudRoomPeerRosterEntry[],
  ownPeerId: string,
): CloudViewerPresencePeer[] {
  return roster.map((entry) =>
    cloudPresencePeerFromMessage({
      peerId: entry.peer_id,
      displayName: entry.display_name,
      actorLabel: entry.actor_label,
      connectionScope: entry.connection_scope,
      participantKey: entry.participant_key,
      kind: entry.peer_id === ownPeerId ? "self" : "peer",
    }),
  );
}

function upsertCloudPresencePeer(
  peers: CloudViewerPresencePeer[],
  nextPeer: CloudViewerPresencePeer,
): CloudViewerPresencePeer[] {
  const existingIndex = peers.findIndex((peer) => peer.id === nextPeer.id);
  if (existingIndex === -1) {
    return [...peers, nextPeer];
  }

  return peers.map((peer, index) => (index === existingIndex ? nextPeer : peer));
}

export function cloudViewerPresenceDisplay(
  state: CloudViewerPresenceState,
): CloudViewerPresenceDisplay {
  if (state.connection === "disconnected") {
    const displayPeers = cloudHumanPresenceDisplayPeers(state.peers);
    return {
      label: "Offline",
      title: "Room unavailable",
      connected: false,
      peers: displayPeers.peers.map((peer) => ({ ...peer, status: "offline" })),
      hiddenCount: displayPeers.hiddenCount,
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
          participantKey: "joining",
          label: "Joining room",
          connectionScope: null,
          kind: "unknown",
          status: "idle",
        },
      ],
      hiddenCount: 0,
    };
  }

  const displayPeers = cloudHumanPresenceDisplayPeers(state.peers);
  const count = displayPeers.count;
  const title = count === 1 ? "1 participant" : `${count} participants`;
  return {
    label: count === 1 ? "1 here now" : `${count} here now`,
    title,
    connected: true,
    peers: displayPeers.peers,
    hiddenCount: displayPeers.hiddenCount,
  };
}

function cloudHumanPresenceDisplayPeers(peers: readonly CloudViewerPresencePeer[]): {
  count: number;
  peers: CloudViewerPresencePeer[];
  hiddenCount: number;
} {
  const humanPeerGroups = cloudHumanPresenceGroups(peers);
  const anonymousCount = peers.filter((peer) => peer.kind === "anonymous").length;
  const namedPeers = humanPeerGroups.filter((peer) => peer.kind !== "anonymous");
  const visibleNamedPeerLimit = anonymousCount > 0 ? 2 : 3;
  const visibleNamedPeers = namedPeers.slice(0, visibleNamedPeerLimit);
  const visiblePeers =
    anonymousCount > 0
      ? [
          ...visibleNamedPeers,
          {
            id: "anonymous-group",
            participantKey: "anonymous",
            label:
              anonymousCount === 1 ? "Anonymous viewer" : `${anonymousCount} anonymous viewers`,
            connectionScope: null,
            kind: "anonymous" as const,
            status: "active" as const,
            count: anonymousCount,
          },
        ]
      : visibleNamedPeers;
  const hiddenCount = Math.max(0, namedPeers.length - visibleNamedPeers.length);
  const count = namedPeers.length + anonymousCount;
  return {
    count,
    peers: visiblePeers,
    hiddenCount,
  };
}

function cloudHumanPresenceGroups(
  peers: readonly CloudViewerPresencePeer[],
): CloudViewerPresencePeer[] {
  const groups = new Map<string, CloudViewerPresencePeer>();
  for (const peer of peers) {
    if (peer.kind === "runtime" || peer.kind === "unknown") {
      continue;
    }
    if (peer.kind === "anonymous") {
      continue;
    }
    const existing = groups.get(peer.participantKey);
    if (!existing || (peer.kind === "self" && existing.kind !== "self")) {
      groups.set(peer.participantKey, peer);
    }
  }
  return Array.from(groups.values());
}

export function cloudPresenceHasRuntimePeer(state: CloudViewerPresenceState): boolean {
  return cloudPresenceRuntimePeerCount(state) > 0;
}

export function cloudPresenceRuntimePeerCount(state: CloudViewerPresenceState): number {
  const visibleRuntimePeers = state.peers.filter(
    (peer) => peer.connectionScope === "runtime_peer",
  ).length;
  return Math.max(state.runtimePeerCount, visibleRuntimePeers);
}

export function cloudPresenceInitials(label: string): string {
  const trimmed = label.trim();
  if (looksLikeEmailAddress(trimmed)) {
    return "U";
  }
  const words = trimmed
    .split(/[\s@._-]+/g)
    .map((word) => word.trim())
    .filter(Boolean);
  const initials = words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
  return initials || "?";
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
  if (
    trimmedPeerLabel &&
    !looksLikeRawIdentityLabel(trimmedPeerLabel) &&
    !looksLikeEmailAddress(trimmedPeerLabel)
  ) {
    return trimmedPeerLabel;
  }

  return cloudFriendlyPeerLabel({
    actorLabel: actorLabel ?? trimmedPeerLabel,
    email: looksLikeEmailAddress(trimmedPeerLabel ?? "") ? trimmedPeerLabel : null,
  });
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

  const trimmedActorLabel = actorLabel?.trim();
  if (trimmedActorLabel) {
    return notebookActorIdentityFromProjection(
      notebookActorProjectionFromLabel(trimmedActorLabel, { source: "cloud", isPublic: false }),
    ).label;
  }

  return email?.trim() ? "User" : "Peer";
}

function safeRoomPeerCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

function safeRuntimePeerCount(value: number | undefined, fallback: number): number {
  const count = value ?? fallback;
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function cloudPresenceParticipantKey({
  participantKey,
  actorLabel,
  peerId,
}: {
  participantKey?: string | null;
  actorLabel?: string | null;
  peerId: string;
}): string {
  const trimmedParticipantKey = participantKey?.trim();
  if (trimmedParticipantKey) return trimmedParticipantKey;

  const trimmedActorLabel = actorLabel?.trim();
  if (trimmedActorLabel) {
    return notebookActorProjectionFromLabel(trimmedActorLabel, {
      source: "cloud",
      isPublic: trimmedActorLabel.startsWith("anonymous:"),
    }).principal.id;
  }

  return `peer:${peerId}`;
}

function looksLikeRawIdentityLabel(value: string): boolean {
  return /^(anonymous|user):/.test(value);
}

function looksLikeEmailAddress(label: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(label);
}

function normalizePresenceConnectionScope(
  value: string | null | undefined,
): ConnectionScope | null {
  switch (value) {
    case "viewer":
    case "editor":
    case "runtime_peer":
    case "owner":
      return value;
    default:
      return null;
  }
}
