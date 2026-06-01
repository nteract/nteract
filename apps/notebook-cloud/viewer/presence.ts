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
      label: "Joining room",
      title: "Connecting to the notebook room",
      connected: false,
    };
  }

  const count = Math.max(1, state.roomPeerCount);
  const readerTitle =
    count === 1
      ? "1 participant is in this notebook"
      : `${count} participants are in this notebook`;
  const selfTitle = state.ownPeerLabel ? `You are ${state.ownPeerLabel}` : null;
  return {
    label: count === 1 ? "1 here now" : `${count} here now`,
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
