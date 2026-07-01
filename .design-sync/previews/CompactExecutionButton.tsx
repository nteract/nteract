import { CompactExecutionButton } from "nteract-elements";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span className="text-xs text-muted-foreground" style={{ width: 96 }}>{label}</span>
      {children}
    </div>
  );
}

export function States() {
  const noop = () => undefined;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Row label="Idle"><CompactExecutionButton count={null} canExecute isCellFocused onExecute={noop} /></Row>
      <Row label="Ran"><CompactExecutionButton count={12} canExecute onExecute={noop} /></Row>
      <Row label="Queued"><CompactExecutionButton count={12} isQueued onInterrupt={noop} /></Row>
      <Row label="Running"><CompactExecutionButton count={12} isExecuting onInterrupt={noop} /></Row>
      <Row label="Errored"><CompactExecutionButton count={12} isErrored canExecute onExecute={noop} /></Row>
    </div>
  );
}
