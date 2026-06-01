import { useEffect, useState } from "react";
import {
  CellPresenceIndicators as SharedCellPresenceIndicators,
  type CellPresenceIndicatorsProps as SharedCellPresenceIndicatorsProps,
} from "@/components/cell/CellPresenceIndicators";
import { getPeersForCell, type PeerCursorInfo, subscribeToCell } from "../../lib/cursor-registry";

interface CellPresenceIndicatorsProps extends Omit<SharedCellPresenceIndicatorsProps, "peers"> {
  cellId: string;
}

export function CellPresenceIndicators({ cellId, ...props }: CellPresenceIndicatorsProps) {
  const [peers, setPeers] = useState<PeerCursorInfo[]>([]);

  useEffect(() => {
    setPeers(getPeersForCell(cellId));

    const unsubscribe = subscribeToCell(cellId, () => {
      setPeers(getPeersForCell(cellId));
    });

    return unsubscribe;
  }, [cellId]);

  return <SharedCellPresenceIndicators peers={peers} {...props} />;
}
