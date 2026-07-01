import { CellInsertionRibbon } from "nteract-elements";

function Frame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="rounded-md border border-border" style={{ width: 460, overflow: "hidden" }}>
        {children}
      </div>
    </div>
  );
}

export function BetweenCells() {
  return (
    <Frame label="Between cells (code)">
      <CellInsertionRibbon activeType="code" forceActionsVisible onInsert={() => undefined} />
    </Frame>
  );
}

export function Markdown() {
  return (
    <Frame label="Between cells (markdown)">
      <CellInsertionRibbon activeType="markdown" forceActionsVisible onInsert={() => undefined} />
    </Frame>
  );
}

export function DocumentTail() {
  return (
    <Frame label="Document tail">
      <CellInsertionRibbon activeType="code" terminal forceActionsVisible onInsert={() => undefined} />
    </Frame>
  );
}
