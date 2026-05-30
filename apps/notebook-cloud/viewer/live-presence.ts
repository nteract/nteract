import type { RemoteCellPresence } from "@/components/editor/presence-state";
import { RemotePresenceState } from "@/components/editor/presence-state";
import { cloudVisiblePeerLabel } from "./presence";

export interface CloudLivePresenceSnapshot {
  version: number;
  cells: Map<string, RemoteCellPresence>;
}

export class CloudLivePresenceStore {
  private readonly state: RemotePresenceState;
  private readonly cells = new Map<string, RemoteCellPresence>();
  private version = 0;

  constructor(localPeerId: string) {
    this.state = new RemotePresenceState(localPeerId);
  }

  handlePresence(payload: unknown): CloudLivePresenceSnapshot | null {
    const affectedCells = this.state.handlePresence(normalizeCloudPresencePayload(payload));
    if (affectedCells.size === 0) return null;

    for (const cellId of affectedCells) {
      this.cells.set(cellId, this.state.presenceForCell(cellId));
    }

    this.version += 1;
    return this.snapshot();
  }

  snapshot(): CloudLivePresenceSnapshot {
    return {
      version: this.version,
      cells: new Map(this.cells),
    };
  }
}

export function emptyCloudLivePresenceSnapshot(): CloudLivePresenceSnapshot {
  return {
    version: 0,
    cells: new Map(),
  };
}

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
