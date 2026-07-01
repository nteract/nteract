import { Badge } from "nteract-elements";

export function Variants() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      <Badge>Running</Badge>
      <Badge variant="secondary">Idle</Badge>
      <Badge variant="outline">Python 3.12</Badge>
      <Badge variant="destructive">Error</Badge>
    </div>
  );
}

export function StatusRow() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      <Badge variant="secondary">3 cells queued</Badge>
      <Badge>Kernel ready</Badge>
      <Badge variant="outline">uv · numpy, pandas</Badge>
    </div>
  );
}
