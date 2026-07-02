export type RuntimeStatus = "executing" | "ready" | "starting" | "stale" | "error" | "none";

export interface RuntimeStatusDotProps {
  status: RuntimeStatus;
  label?: string;
  showLabel?: boolean;
  className?: string;
}

const RUNTIME_STATUS_LABELS: Record<RuntimeStatus, string> = {
  executing: "Running",
  ready: "Kernel ready",
  starting: "Connecting",
  stale: "Disconnected",
  error: "Runtime error",
  none: "No compute",
};

/**
 * Renders the current runtime state as a calm status marker, not as runtime
 * activity history or permission state.
 */
export function RuntimeStatusDot({
  status,
  label,
  showLabel = false,
  className,
}: RuntimeStatusDotProps) {
  const displayLabel = label ?? RUNTIME_STATUS_LABELS[status];
  return (
    <span
      className={["nb-kernel", className].filter(Boolean).join(" ")}
      data-k={status}
      aria-label={displayLabel}
    >
      <i className="nb-kdot" aria-hidden="true" />
      {showLabel ? displayLabel : null}
    </span>
  );
}
