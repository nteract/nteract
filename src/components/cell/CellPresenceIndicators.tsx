import { cn } from "@/lib/utils";

export interface CellPresencePeer {
  peerId: string;
  peerLabel?: string | null;
  color: string;
}

export interface CellPresenceIndicatorsProps {
  peers: readonly CellPresencePeer[];
  variant?: "stack" | "inline";
  maxVisible?: number;
  prefixSeparator?: boolean;
  className?: string;
}

const MAX_VISIBLE = 3;

export function CellPresenceIndicators({
  peers,
  variant = "stack",
  maxVisible = MAX_VISIBLE,
  prefixSeparator = false,
  className,
}: CellPresenceIndicatorsProps) {
  if (peers.length === 0) {
    return null;
  }

  const visiblePeers = peers.slice(0, maxVisible);
  const overflowCount = peers.length - visiblePeers.length;
  const label = formatCellPresenceTooltip(peers);

  return (
    <div
      data-slot="cell-presence-indicators"
      className={cn(
        "flex items-center gap-0.5",
        variant === "stack" ? "flex-col" : "flex-row",
        className,
      )}
      title={label}
      aria-label={label}
    >
      {prefixSeparator && (
        <span className="text-muted-foreground/30" aria-hidden="true">
          ·
        </span>
      )}
      {visiblePeers.map((peer) => (
        <PresenceDot key={peer.peerId} peer={peer} />
      ))}
      {overflowCount > 0 && (
        <span className="text-[9px] leading-none font-medium text-muted-foreground">
          +{overflowCount}
        </span>
      )}
    </div>
  );
}

function PresenceDot({ peer }: { peer: CellPresencePeer }) {
  return (
    <div
      className="size-2 rounded-full shrink-0 transition-colors"
      style={{ backgroundColor: peer.color }}
      title={peer.peerLabel || "Peer"}
    />
  );
}

export function formatCellPresenceTooltip(peers: readonly CellPresencePeer[]): string {
  if (peers.length === 0) return "";
  if (peers.length === 1) {
    return peers[0].peerLabel || "1 peer";
  }
  const labels = peers
    .map((peer) => peer.peerLabel)
    .filter(Boolean)
    .join(", ");
  if (labels) {
    return labels;
  }
  return `${peers.length} peers`;
}
