import { CellContainer } from "nteract-elements";

function Body({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="text-xs text-muted-foreground" style={{ lineHeight: 1.5 }}>{children}</p>
    </div>
  );
}

export function CellTypes() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, width: 460 }}>
      <CellContainer id="cell-code" cellType="code" isFocused>
        <Body title="Code cell">Focused code cell. The ribbon carries the type accent and the frame owns focus state.</Body>
      </CellContainer>
      <CellContainer id="cell-markdown" cellType="markdown">
        <Body title="Markdown cell">Same container contract, markdown ribbon accent when focused.</Body>
      </CellContainer>
      <CellContainer id="cell-raw" cellType="raw">
        <Body title="Raw cell">Raw cells share the frame and drag affordance with a raw ribbon accent.</Body>
      </CellContainer>
    </div>
  );
}
