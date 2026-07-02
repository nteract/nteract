import { NotebookCompositionTicks } from "nteract-elements";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span className="text-xs text-muted-foreground" style={{ width: 132 }}>
        {label}
      </span>
      <div style={{ width: 220 }}>{children}</div>
    </div>
  );
}

// One tick per cell, colored by type (code / markdown / raw), evenly
// interleaved and capped - the dashboard's at-a-glance content fingerprint.
export function Compositions() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Row label="Analysis (19·6·0)">
        <NotebookCompositionTicks composition={{ code: 19, markdown: 6, raw: 0 }} />
      </Row>
      <Row label="Narrative (3·16·0)">
        <NotebookCompositionTicks composition={{ code: 3, markdown: 16, raw: 0 }} />
      </Row>
      <Row label="Mixed (12·2·4)">
        <NotebookCompositionTicks composition={{ code: 12, markdown: 2, raw: 4 }} />
      </Row>
      <Row label="Large, capped (90·30·10)">
        <NotebookCompositionTicks composition={{ code: 90, markdown: 30, raw: 10 }} />
      </Row>
    </div>
  );
}
