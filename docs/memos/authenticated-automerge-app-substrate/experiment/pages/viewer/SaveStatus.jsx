import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import "./save-status.css";

const workingStates = new Set(["Connecting", "Reconnecting", "Syncing", "Saving"]);
const attentionStates = new Set([
  "Saved locally",
  "Offline",
  "Sign in to sync",
  "Access changed",
  "Access removed",
  "Deleted",
]);
const failureStates = new Set(["Unsaved", "Local save failed"]);

export function SaveStatus({ status }) {
  // Only the session's exact-head durability receipt earns the saved indicator.
  // A connected socket or local checkpoint must retain its own visible status.
  const saved = status === "Saved";
  const working = workingStates.has(status);
  const failure = failureStates.has(status);
  const attention = failure || attentionStates.has(status);
  const kind = saved
    ? "saved"
    : working
      ? "working"
      : failure
        ? "error"
        : attention
          ? "attention"
          : "plain";
  const Icon = saved ? Check : working ? LoaderCircle : attention ? CircleAlert : null;
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
