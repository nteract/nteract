import { Check, CircleAlert } from "lucide-react";
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
  "catching-up": "working",
  attention: "attention",
  failed: "error",
};
// Sync in progress is drawn as the dot alone, on desktop too: no spinner and
// no text. Its label stays for screen readers and in the tooltip. Only this
// person's own edits, still pending after SLOW_SAVE_MS, pulse.
const IN_PROGRESS = new Set(["connecting", "connected", "syncing", "saving"]);

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

// One dot whose color and motion carry the state, with the label for screen
// readers and in the tooltip. On phones it draws every status; on desktop,
// sync in progress. Saving pulses (a still dot with reduced motion), syncing
// and connecting are a still dot, saved shows nothing, and anything that
// needs attention or failed takes a warning color.
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

// Catching up after a Page opens is the one in-progress status that shows
// its words, on phones too: remote changes are still landing on the page.
// The dot stays still. The label sits beside it in the header's free space,
// so nothing else in the header moves when it comes and goes.
function CatchingUp({ status }) {
  return (
    <span
      className="save-status save-status--dot save-status--working save-status--catching-up"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-status={status}
    >
      <span className="status-dot" aria-hidden="true" />
      <span className="save-status-label">{status}</span>
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
  if (statusKey === "catching-up") return <CatchingUp status={status} />;
  if (compact || IN_PROGRESS.has(statusKey))
    return <StatusDot status={status} statusKey={statusKey} kind={kind} />;
  // Text stays for what needs a decision: Not saved, Offline and the other
  // attention and failure statuses, and a status this table doesn't know.
  const saved = kind === "saved";
  const Icon = saved ? Check : kind === "attention" || kind === "error" ? CircleAlert : null;
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
