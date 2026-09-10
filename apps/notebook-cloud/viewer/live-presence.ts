import { cloudVisiblePeerLabel } from "./presence";

export function normalizeCloudPresencePayload(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;

  if (payload.type === "update") {
    const peerLabel = stringValue(payload.peer_label);
    const actorLabel = stringValue(payload.actor_label);
    return {
      ...payload,
      peer_label: cloudVisiblePeerLabel(peerLabel, actorLabel),
    };
  }

  if (payload.type === "snapshot" && Array.isArray(payload.peers)) {
    return {
      ...payload,
      peers: payload.peers.map((peer) => {
        if (!isRecord(peer)) return peer;
        const peerLabel = stringValue(peer.peer_label);
        const actorLabel = stringValue(peer.actor_label);
        return {
          ...peer,
          peer_label: cloudVisiblePeerLabel(peerLabel, actorLabel),
        };
      }),
    };
  }

  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
