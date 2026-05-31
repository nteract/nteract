/**
 * Cell-level presence indicators.
 *
 * Shows colored dots for remote peers that have their cursor in this cell.
 * Uses the cursor registry's subscription mechanism for efficient updates.
 */

import { useEffect, useState } from "react";
import { CellPresenceDots } from "@/components/cell/CellPresenceDots";
import { getPeersForCell, type PeerCursorInfo, subscribeToCell } from "../../lib/cursor-registry";

interface CellPresenceIndicatorsProps {
  cellId: string;
  variant?: "stack" | "inline";
  maxVisible?: number;
  prefixSeparator?: boolean;
  className?: string;
}

const MAX_VISIBLE = 3;

export function CellPresenceIndicators({
  cellId,
  variant = "stack",
  maxVisible = MAX_VISIBLE,
  prefixSeparator = false,
  className,
}: CellPresenceIndicatorsProps) {
  const [peers, setPeers] = useState<PeerCursorInfo[]>([]);

  // Subscribe to presence changes for this cell
  useEffect(() => {
    // Initial fetch
    setPeers(getPeersForCell(cellId));

    // Subscribe to updates
    const unsubscribe = subscribeToCell(cellId, () => {
      setPeers(getPeersForCell(cellId));
    });

    return unsubscribe;
  }, [cellId]);

  if (peers.length === 0) {
    return null;
  }

  return (
    <CellPresenceDots
      peers={peers}
      variant={variant}
      maxVisible={maxVisible}
      prefixSeparator={prefixSeparator}
      className={className}
    />
  );
}
