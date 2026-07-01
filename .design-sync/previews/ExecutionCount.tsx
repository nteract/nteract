import { ExecutionCount } from "nteract-elements";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span className="text-xs text-muted-foreground" style={{ width: 96 }}>{label}</span>
      {children}
    </div>
  );
}

export function States() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Row label="Not run"><ExecutionCount count={null} /></Row>
      <Row label="Ran"><ExecutionCount count={7} /></Row>
      <Row label="Ran (high)"><ExecutionCount count={128} /></Row>
      <Row label="Running"><ExecutionCount count={7} isExecuting /></Row>
    </div>
  );
}
