import {
  colorForActorIdentity,
  peerColor,
  type RemoteCursorState,
  type RemoteSelectionState,
} from "./remote-cursors";

export interface CursorData {
  cell_id: string;
  line: number;
  column: number;
}

export interface SelectionData {
  cell_id: string;
  anchor_line: number;
  anchor_col: number;
  head_line: number;
  head_col: number;
}

export interface FocusData {
  cell_id: string;
}

export type InteractionTargetData =
  | { kind: "cell"; cell_id: string }
  | { kind: "editor"; cell_id: string }
  | { kind: "markdown_anchor"; cell_id: string; anchor_id: string }
  | { kind: "output"; cell_id: string; output_id?: string };

export interface ChannelEntry {
  channel: "cursor" | "selection" | "focus" | "interaction" | "kernel_state" | "custom";
  data: unknown;
}

export interface PresenceUpdate {
  type: "update";
  peer_id: string;
  peer_label?: string;
  actor_label?: string;
  channel: string;
  data: unknown;
}

export interface PresenceSnapshot {
  type: "snapshot";
  peer_id: string;
  peers: Array<{
    peer_id: string;
    peer_label: string;
    actor_label?: string;
    channels: ChannelEntry[];
  }>;
}

export interface PresenceLeft {
  type: "left";
  peer_id: string;
}

export interface PresenceHeartbeat {
  type: "heartbeat";
  peer_id: string;
}

export interface PresenceClearChannel {
  type: "clear_channel";
  peer_id: string;
  channel: string;
}

export type PresenceMessage =
  | PresenceUpdate
  | PresenceSnapshot
  | PresenceLeft
  | PresenceHeartbeat
  | PresenceClearChannel;

export interface PeerCursorInfo {
  peerId: string;
  peerLabel: string;
  actorLabel?: string;
  color: string;
  cursor?: CursorData;
  selection?: SelectionData;
  focus?: FocusData;
  interaction?: InteractionTargetData;
}

export interface RemoteCellPresence {
  cursors: RemoteCursorState[];
  selections: RemoteSelectionState[];
}

export class RemotePresenceState {
  private readonly peers = new Map<string, PeerCursorInfo>();
  private localPeerId: string | null;

  constructor(localPeerId: string | null = null) {
    this.localPeerId = localPeerId;
  }

  setLocalPeerId(peerId: string | null): void {
    this.localPeerId = peerId;
  }

  clear(): void {
    this.peers.clear();
  }

  clearCell(cellId: string): Set<string> {
    const affectedCells = new Set<string>();

    for (const peer of this.peers.values()) {
      if (peer.cursor?.cell_id === cellId) {
        peer.cursor = undefined;
        affectedCells.add(cellId);
      }
      if (peer.selection?.cell_id === cellId) {
        peer.selection = undefined;
        affectedCells.add(cellId);
      }
      if (peer.focus?.cell_id === cellId) {
        peer.focus = undefined;
        affectedCells.add(cellId);
      }
      if (interactionCellId(peer.interaction) === cellId) {
        peer.interaction = undefined;
        affectedCells.add(cellId);
      }
    }

    return affectedCells;
  }

  handlePresence(payload: unknown): Set<string> {
    const msg = payload as PresenceMessage;

    switch (msg.type) {
      case "update":
        return this.handleUpdate(msg);
      case "snapshot":
        return this.handleSnapshot(msg);
      case "left":
        return this.handleLeft(msg.peer_id);
      case "clear_channel":
        return this.handleClearChannel(msg.peer_id, msg.channel);
      case "heartbeat":
        return new Set();
      default:
        return new Set();
    }
  }

  presenceForCell(cellId: string): RemoteCellPresence {
    const cursors: RemoteCursorState[] = [];
    const selections: RemoteSelectionState[] = [];

    for (const [peerId, peer] of this.peers) {
      if (peerId === this.localPeerId) continue;

      const renderEditorGeometry =
        !peer.interaction ||
        (peer.interaction.kind === "editor" && peer.interaction.cell_id === cellId);

      if (renderEditorGeometry && peer.cursor?.cell_id === cellId) {
        cursors.push({
          peerId,
          peerLabel: peer.peerLabel,
          line: peer.cursor.line,
          column: peer.cursor.column,
          color: peer.color,
        });
      }

      if (renderEditorGeometry && peer.selection?.cell_id === cellId) {
        selections.push({
          peerId,
          peerLabel: peer.peerLabel,
          anchorLine: peer.selection.anchor_line,
          anchorCol: peer.selection.anchor_col,
          headLine: peer.selection.head_line,
          headCol: peer.selection.head_col,
          color: peer.color,
        });
      }
    }

    return { cursors, selections };
  }

  findPeerColorByActorLabel(actorLabel: string): string | undefined {
    for (const peer of this.peers.values()) {
      if (peer.peerId === this.localPeerId) continue;
      if (peer.actorLabel && peer.actorLabel === actorLabel) {
        return peer.color;
      }
    }
    return undefined;
  }

  /**
   * Find a connected peer's friendly label by exact actor-label match.
   *
   * Comments store the Automerge actor label, which encodes the operator
   * kind (e.g. `nteract-mcp`) rather than the client name. Presence carries
   * the same actor label alongside the `peer_label` derived from the MCP
   * client info (e.g. "Claude Code"), so a connected author can be shown by
   * the name presence already displays. Returns undefined once the author
   * disconnects; callers fall back to parsing the actor label.
   */
  findPeerLabelByActorLabel(actorLabel: string): string | undefined {
    for (const peer of this.peers.values()) {
      if (peer.peerId === this.localPeerId) continue;
      if (peer.actorLabel && peer.actorLabel === actorLabel) {
        return peer.peerLabel;
      }
    }
    return undefined;
  }

  getPeersForCell(cellId: string): PeerCursorInfo[] {
    const result: PeerCursorInfo[] = [];
    for (const peer of this.peers.values()) {
      if (peer.peerId === this.localPeerId) continue;
      const activeCellId = interactionCellId(peer.interaction);
      if (
        activeCellId
          ? activeCellId === cellId
          : peer.cursor?.cell_id === cellId || peer.focus?.cell_id === cellId
      ) {
        result.push(peer);
      }
    }
    return result;
  }

  private handleUpdate(msg: PresenceUpdate): Set<string> {
    if (msg.peer_id === this.localPeerId) return new Set();

    const existing = this.peers.get(msg.peer_id);
    const peer: PeerCursorInfo = existing ?? {
      peerId: msg.peer_id,
      peerLabel: msg.peer_label || "Peer",
      // Color keys on the durable actor identity when known, so it matches the
      // author's comments/attribution and survives reconnects; falls back to
      // the ephemeral peer id only until the actor label arrives.
      color: msg.actor_label ? colorForActorIdentity(msg.actor_label) : peerColor(msg.peer_id),
    };

    if (msg.peer_label) {
      peer.peerLabel = msg.peer_label;
    }
    if (msg.actor_label) {
      peer.actorLabel = msg.actor_label;
      peer.color = colorForActorIdentity(msg.actor_label);
    }

    const affectedCells = new Set<string>();

    if (msg.channel === "cursor") {
      const data = msg.data as CursorData;
      addInteractionCell(affectedCells, peer.interaction);
      if (peer.cursor && peer.cursor.cell_id !== data.cell_id) {
        affectedCells.add(peer.cursor.cell_id);
      }
      if (peer.focus) {
        affectedCells.add(peer.focus.cell_id);
        peer.focus = undefined;
      }
      if (peer.selection) {
        affectedCells.add(peer.selection.cell_id);
        peer.selection = undefined;
      }
      peer.cursor = data;
      peer.interaction = { kind: "editor", cell_id: data.cell_id };
      affectedCells.add(data.cell_id);
    } else if (msg.channel === "selection") {
      const data = msg.data as SelectionData;
      addInteractionCell(affectedCells, peer.interaction);
      if (peer.selection && peer.selection.cell_id !== data.cell_id) {
        affectedCells.add(peer.selection.cell_id);
      }
      peer.selection = data;
      peer.interaction = { kind: "editor", cell_id: data.cell_id };
      affectedCells.add(data.cell_id);
    } else if (msg.channel === "focus") {
      const data = msg.data as FocusData;
      addInteractionCell(affectedCells, peer.interaction);
      if (peer.cursor) {
        affectedCells.add(peer.cursor.cell_id);
        peer.cursor = undefined;
      }
      if (peer.selection) {
        affectedCells.add(peer.selection.cell_id);
        peer.selection = undefined;
      }
      if (peer.focus && peer.focus.cell_id !== data.cell_id) {
        affectedCells.add(peer.focus.cell_id);
      }
      peer.focus = data;
      if (!peer.interaction || peer.interaction.cell_id !== data.cell_id) {
        peer.interaction = { kind: "cell", cell_id: data.cell_id };
      }
      affectedCells.add(data.cell_id);
    } else if (msg.channel === "interaction") {
      const data = msg.data as InteractionTargetData;
      addInteractionCell(affectedCells, peer.interaction);
      peer.interaction = data;
      affectedCells.add(data.cell_id);
    }

    this.peers.set(msg.peer_id, peer);
    return affectedCells;
  }

  private handleSnapshot(msg: PresenceSnapshot): Set<string> {
    const affectedCells = new Set<string>();

    for (const peer of this.peers.values()) {
      addPeerCells(affectedCells, peer);
    }

    this.peers.clear();

    for (const snap of msg.peers) {
      if (snap.peer_id === this.localPeerId) continue;

      const peer: PeerCursorInfo = {
        peerId: snap.peer_id,
        peerLabel: snap.peer_label,
        actorLabel: snap.actor_label,
        color: snap.actor_label ? colorForActorIdentity(snap.actor_label) : peerColor(snap.peer_id),
      };

      for (const ch of snap.channels) {
        if (ch.channel === "cursor") {
          peer.cursor = ch.data as CursorData;
          affectedCells.add(peer.cursor.cell_id);
        } else if (ch.channel === "selection") {
          peer.selection = ch.data as SelectionData;
          affectedCells.add(peer.selection.cell_id);
        } else if (ch.channel === "focus") {
          peer.focus = ch.data as FocusData;
          affectedCells.add(peer.focus.cell_id);
        } else if (ch.channel === "interaction") {
          peer.interaction = ch.data as InteractionTargetData;
          affectedCells.add(peer.interaction.cell_id);
        }
      }

      this.peers.set(snap.peer_id, peer);
    }

    return affectedCells;
  }

  private handleLeft(peerId: string): Set<string> {
    const peer = this.peers.get(peerId);
    if (!peer) return new Set();

    const affectedCells = new Set<string>();
    addPeerCells(affectedCells, peer);

    this.peers.delete(peerId);
    return affectedCells;
  }

  private handleClearChannel(peerId: string, channel: string): Set<string> {
    const peer = this.peers.get(peerId);
    if (!peer) return new Set();

    const affectedCells = new Set<string>();
    if (channel === "cursor" && peer.cursor) {
      affectedCells.add(peer.cursor.cell_id);
      peer.cursor = undefined;
    } else if (channel === "selection" && peer.selection) {
      affectedCells.add(peer.selection.cell_id);
      peer.selection = undefined;
    } else if (channel === "focus" && peer.focus) {
      affectedCells.add(peer.focus.cell_id);
      peer.focus = undefined;
    } else if (channel === "interaction" && peer.interaction) {
      affectedCells.add(peer.interaction.cell_id);
      peer.interaction = undefined;
    }
    return affectedCells;
  }
}

function interactionCellId(target: InteractionTargetData | undefined): string | null {
  return target?.cell_id ?? null;
}

function addInteractionCell(
  affectedCells: Set<string>,
  target: InteractionTargetData | undefined,
): void {
  const cellId = interactionCellId(target);
  if (cellId) affectedCells.add(cellId);
}

function addPeerCells(affectedCells: Set<string>, peer: PeerCursorInfo): void {
  if (peer.cursor) affectedCells.add(peer.cursor.cell_id);
  if (peer.selection) affectedCells.add(peer.selection.cell_id);
  if (peer.focus) affectedCells.add(peer.focus.cell_id);
  addInteractionCell(affectedCells, peer.interaction);
}
