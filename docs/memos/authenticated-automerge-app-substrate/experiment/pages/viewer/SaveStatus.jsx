import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import "./save-status.css";

// How each presentation key (STATUS_KEYS in sync-status-machine.mjs) is
// drawn. A key outside this table, or none, is drawn plain and never as saved.
const KINDS = {
  connecting: "working",
  connected: "plain",
  syncing: "working",
  quiet: "quiet",
  saving: "working",
  saved: "saved",
  attention: "attention",
  failed: "error",
};

// A save inside its first SLOW_SAVE_MS draws nothing and says nothing, on
// desktop and phone alike. The live region stays mounted, empty, so the
// status that follows is still announced.
function QuietStatus({ compact }) {
  return (
    <span
      className={`save-status${compact ? " save-status--dot" : ""} save-status--quiet`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    />
  );
}

// The compact form on phones: one dot whose color and motion carry the
// state, with the label for screen readers and in the tooltip. Saving pulses,
// syncing and connecting are a quiet dot, saved shows nothing, and anything
// that needs attention or failed takes a warning color.
function StatusDot({ status, statusKey, kind }) {
  return (
    <span
      className={`save-status save-status--dot save-status--${kind}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={kind === "saved" ? "All changes saved" : undefined}
      title={kind === "saved" ? "All changes saved" : status}
      data-status={status}
    >
      {kind !== "saved" && (
        <span
          className={`status-dot${statusKey === "saving" ? " is-pulsing" : ""}`}
          aria-hidden="true"
        />
      )}
      <span className="sr-only">{status}</span>
    </span>
  );
}

/**
 * `status` is the label people read; `statusKey` is how it is drawn. Both come
 * from the same PageSession status (`session.status`, `session.statusKey`).
 */
export function SaveStatus({ status, statusKey, compact = false }) {
  // Only the session's exact-head durability receipt earns the saved indicator.
  // A connected socket or local checkpoint must retain its own visible status.
  const kind = Object.hasOwn(KINDS, statusKey) ? KINDS[statusKey] : "plain";
  if (kind === "quiet") return <QuietStatus compact={compact} />;
  if (compact) return <StatusDot status={status} statusKey={statusKey} kind={kind} />;
  const saved = kind === "saved";
  const Icon = saved
    ? Check
    : kind === "working"
      ? LoaderCircle
      : kind === "attention" || kind === "error"
        ? CircleAlert
        : null;
  return (
    <span
      className={`save-status save-status--${kind}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={saved ? "All changes saved" : undefined}
      title={saved ? "All changes saved" : undefined}
    >
      {Icon && <Icon size={15} aria-hidden="true" />}
      <span className={saved ? "sr-only" : "save-status-label"}>{status}</span>
    </span>
  );
}
