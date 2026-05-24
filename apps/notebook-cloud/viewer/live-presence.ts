import type { RemoteCellPresence } from "@/components/editor/presence-state";
import { RemotePresenceState } from "@/components/editor/presence-state";

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
    const affectedCells = this.state.handlePresence(payload);
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
