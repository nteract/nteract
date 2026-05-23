import type { SessionControlMessage } from "../src/protocol";

export type CloudViewerPresenceConnection = "connecting" | "connected" | "disconnected";

export interface CloudViewerPresenceState {
  connection: CloudViewerPresenceConnection;
  ownPeerId: string | null;
  actorLabel: string | null;
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
  return {
    label: `${count} viewing`,
    title:
      count === 1
        ? "1 reader connected to this notebook room"
        : `${count} readers connected to this notebook room`,
    connected: true,
  };
}

function safeRoomPeerCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}
