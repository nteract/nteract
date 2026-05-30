import type { SessionControlMessage } from "../src/protocol";

export type CloudViewerPresenceConnection = "connecting" | "connected" | "disconnected";

export interface CloudViewerPresenceState {
  connection: CloudViewerPresenceConnection;
  ownPeerId: string | null;
  actorLabel: string | null;
  ownPeerLabel: string | null;
  roomPeerCount: number | null;
}

export interface CloudViewerPresenceDisplay {
  label: string;
  title: string;
  connected: boolean;
}

export function initialCloudViewerPresence(): CloudViewerPresenceState {
  return {
    connection: "connecting",
    ownPeerId: null,
    actorLabel: null,
    ownPeerLabel: null,
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
        roomPeerCount: safeRoomPeerCount(message.room_peer_count),
      };
    case "cloud_peer_joined":
    case "cloud_peer_left":
      return {
        ...state,
        connection: "connected",
        roomPeerCount: safeRoomPeerCount(message.room_peer_count),
      };
    default:
      return state;
  }
}

export function cloudViewerPresenceDisplay(
  state: CloudViewerPresenceState,
): CloudViewerPresenceDisplay {
  if (state.connection === "disconnected") {
    return {
      label: "Offline",
      title: "Disconnected from the notebook room",
      connected: false,
    };
  }

  if (state.connection === "connecting" || state.roomPeerCount === null) {
    return {
      label: "Connecting",
      title: "Connecting to the notebook room",
      connected: false,
    };
  }

  const count = Math.max(1, state.roomPeerCount);
  const readerTitle =
    count === 1
      ? "1 reader connected to this notebook room"
      : `${count} readers connected to this notebook room`;
  const selfTitle = state.ownPeerLabel ? `You are ${state.ownPeerLabel}` : null;
  return {
    label: `${count} viewing`,
    title: selfTitle ? `${readerTitle}; ${selfTitle}` : readerTitle,
    connected: true,
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

  return friendlyActorLabel(actorLabel) ?? "Peer";
}

function safeRoomPeerCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

function friendlyActorLabel(actorLabel: string | null | undefined): string | null {
  const trimmedActorLabel = actorLabel?.trim();
  if (!trimmedActorLabel) return null;

  const principal = trimmedActorLabel.split("/", 1)[0];
  if (principal.startsWith("anonymous:")) {
    return "Anonymous";
  }

  if (!principal.startsWith("user:")) {
    return null;
  }

  const parts = principal.split(":");
  const namespace = parts.slice(0, 2).join(":");
  const encodedSubject = parts.slice(2).join(":");
  const subject = decodeActorLabelSubject(encodedSubject);
  if (!subject) {
    return namespace === "user:anaconda" ? "Anaconda user" : "User";
  }
  if (subject.includes("@")) {
    return subject;
  }
  if (namespace === "user:anaconda" && looksOpaqueSubject(subject)) {
    return "Anaconda user";
  }

  return subject;
}

function decodeActorLabelSubject(value: string): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function looksLikeRawIdentityLabel(value: string): boolean {
  return /^(anonymous|user):/.test(value);
}

function looksOpaqueSubject(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
