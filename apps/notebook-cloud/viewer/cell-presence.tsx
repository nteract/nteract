import { CellPresenceDots, type CellPresencePeer } from "@/components/cell/CellPresenceDots";
import type { RemoteCellPresence } from "@/components/editor/presence-state";
import { useMemo } from "react";

export interface CloudCellPresenceIndicatorsProps {
  presence?: RemoteCellPresence;
}

export function CloudCellPresenceIndicators({ presence }: CloudCellPresenceIndicatorsProps) {
  const peers = useMemo(() => remotePresencePeers(presence), [presence]);
  return <CellPresenceDots peers={peers} maxVisible={4} />;
}

function remotePresencePeers(presence?: RemoteCellPresence): CellPresencePeer[] {
  const byPeer = new Map<string, CellPresencePeer>();
  for (const cursor of presence?.cursors ?? []) {
    byPeer.set(cursor.peerId, {
      peerId: cursor.peerId,
      peerLabel: cursor.peerLabel,
      color: cursor.color,
    });
  }
  for (const selection of presence?.selections ?? []) {
    byPeer.set(selection.peerId, {
      peerId: selection.peerId,
      peerLabel: selection.peerLabel,
      color: selection.color,
    });
  }
  return Array.from(byPeer.values());
}
