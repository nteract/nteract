import { RuntimeStatusDot } from "nteract-elements";

// The calm runtime marker: dot color carries the state, the label is optional
// and terse. No pulse or glow by design.
export function States() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <RuntimeStatusDot status="executing" showLabel />
      <RuntimeStatusDot status="ready" showLabel />
      <RuntimeStatusDot status="starting" showLabel />
      <RuntimeStatusDot status="stale" showLabel />
      <RuntimeStatusDot status="error" showLabel />
      <RuntimeStatusDot status="none" showLabel />
    </div>
  );
}

export function DotsOnly() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <RuntimeStatusDot status="executing" />
      <RuntimeStatusDot status="ready" />
      <RuntimeStatusDot status="starting" />
      <RuntimeStatusDot status="stale" />
      <RuntimeStatusDot status="error" />
      <RuntimeStatusDot status="none" />
    </div>
  );
}
