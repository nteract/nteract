import { cn } from "@/lib/utils";

export interface CellPresencePeer {
  peerId: string;
  peerLabel?: string | null;
  color: string;
}

export interface CellPresenceDotsProps {
  peers: readonly CellPresencePeer[];
  variant?: "stack" | "inline";
  maxVisible?: number;
  prefixSeparator?: boolean;
  className?: string;
}

const DEFAULT_MAX_VISIBLE = 3;

export function CellPresenceDots({
  peers,
  variant = "stack",
  maxVisible = DEFAULT_MAX_VISIBLE,
  prefixSeparator = false,
  className,
}: CellPresenceDotsProps) {
  if (peers.length === 0) {
    return null;
  }

  const visiblePeers = peers.slice(0, maxVisible);
  const overflowCount = peers.length - maxVisible;
  const label = formatTooltip(peers);

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
      {prefixSeparator ? (
        <span className="text-muted-foreground/30" aria-hidden="true">
          ·
        </span>
      ) : null}
      {visiblePeers.map((peer) => (
        <PresenceDot key={peer.peerId} peer={peer} />
      ))}
      {overflowCount > 0 ? (
        <span className="text-[9px] leading-none font-medium text-muted-foreground">
          +{overflowCount}
        </span>
      ) : null}
    </div>
  );
}

function PresenceDot({ peer }: { peer: CellPresencePeer }) {
  return (
    <span
      className="h-2 w-2 shrink-0 rounded-full transition-colors"
      style={{ backgroundColor: peer.color }}
      title={peer.peerLabel || "Peer"}
    />
  );
}

function formatTooltip(peers: readonly CellPresencePeer[]): string {
  if (peers.length === 0) return "";
  if (peers.length === 1) {
    return peers[0].peerLabel || "1 peer";
  }
  const labels = peers
    .map((peer) => peer.peerLabel)
    .filter(Boolean)
    .join(", ");
  return labels || `${peers.length} peers`;
}
