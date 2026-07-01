import { CellPresenceIndicators } from "nteract-elements";

const peers = [
  { peerId: "p1", peerLabel: "Kyle", color: "#de5fe9" },
  { peerId: "p2", peerLabel: "Ana", color: "#2563eb" },
  { peerId: "p3", peerLabel: "Rin", color: "#16a34a" },
  { peerId: "p4", peerLabel: "Sam", color: "#f59e0b" },
];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span className="text-xs text-muted-foreground" style={{ width: 88 }}>
        {label}
      </span>
      {children}
    </div>
  );
}

export function Variants() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Row label="Stack">
        <CellPresenceIndicators peers={peers} variant="stack" />
      </Row>
      <Row label="Inline">
        <CellPresenceIndicators peers={peers} variant="inline" />
      </Row>
      <Row label="Overflow">
        <CellPresenceIndicators peers={peers} variant="stack" maxVisible={2} />
      </Row>
    </div>
  );
}
