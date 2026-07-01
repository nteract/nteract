import { CodeCellCurrentLine } from "nteract-elements";

function Cell({
  label,
  detail,
  children,
}: {
  label: string;
  detail: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-card" style={{ padding: 12, width: 420 }}>
      <div className="text-sm font-medium">{label}</div>
      <div className="text-xs text-muted-foreground" style={{ marginTop: 2 }}>
        {detail}
      </div>
      <div style={{ marginTop: 12 }}>{children}</div>
    </div>
  );
}

export function Queued() {
  return (
    <Cell label="Queued" detail="Waiting keeps a simple blue boundary with only a small pulse.">
      <CodeCellCurrentLine languageLabel="Python" count={12} isQueued />
    </Cell>
  );
}

export function Running() {
  return (
    <Cell label="Running" detail="Runtime work earns a monotonic green wave if it stays busy.">
      <CodeCellCurrentLine languageLabel="Python" count={12} isExecuting />
    </Cell>
  );
}

export function Errored() {
  return (
    <Cell label="Errored" detail="Failures keep run context visible and break the boundary.">
      <CodeCellCurrentLine languageLabel="Python" count={12} isErrored />
    </Cell>
  );
}

export function Completed() {
  return (
    <Cell label="Completed" detail="Run metadata reveals on focus; elapsed time at the boundary.">
      <CodeCellCurrentLine languageLabel="Python" count={12} elapsedMs={1476} isFocused />
    </Cell>
  );
}
