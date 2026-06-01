import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { NotebookNotice, NotebookNoticeAction } from "@/components/notebook/NotebookNotice";

/**
 * Status of the daemon during startup or operation.
 * Matches the DaemonProgress enum from Rust.
 */
export type DaemonStatus =
  | { status: "checking" }
  | { status: "installing" }
  | { status: "upgrading" }
  | { status: "starting" }
  | { status: "waiting_for_ready"; attempt: number; max_attempts: number }
  | { status: "ready"; endpoint: string }
  | { status: "failed"; error: string; guidance?: string }
  | null;

interface DaemonStatusBannerProps {
  status: DaemonStatus;
  onDismiss?: () => void;
  onRetry?: () => void;
}

/**
 * Banner component showing daemon startup progress or errors.
 *
 * Shows different visual states:
 * - Blue/info with spinner: Installing, upgrading, starting, waiting
 * - Amber/warning: Failed state with retry button
 * - Hidden: Ready state or null
 */
export function DaemonStatusBanner({ status, onDismiss, onRetry }: DaemonStatusBannerProps) {
  // Don't show banner for ready or null state
  if (!status || status.status === "ready") {
    return null;
  }

  // Failed state - amber banner with error message and retry button
  if (status.status === "failed") {
    return (
      <NotebookNotice
        tone="warning"
        icon={<AlertTriangle className="h-3 w-3" />}
        title="Runtime unavailable"
        onDismiss={onDismiss}
        actions={
          onRetry ? (
            <NotebookNoticeAction onClick={onRetry} icon={<RefreshCw className="h-3 w-3" />}>
              Retry
            </NotebookNoticeAction>
          ) : null
        }
        details={status.guidance ? <div>{status.guidance}</div> : null}
      >
        <span>{status.error}</span>
      </NotebookNotice>
    );
  }

  // Progress states - soft blue banner with spinner
  const message = getProgressMessage(status);

  return (
    <NotebookNotice
      tone="info"
      icon={<Loader2 className="h-3 w-3 animate-spin" />}
      className="py-1"
    >
      {message}
    </NotebookNotice>
  );
}

function getProgressMessage(
  status: Exclude<DaemonStatus, null | { status: "ready" } | { status: "failed" }>,
): string {
  switch (status.status) {
    case "checking":
      return "Checking runtime status...";
    case "installing":
      return "Installing runtime (first launch)...";
    case "upgrading":
      return "Upgrading runtime...";
    case "starting":
      return "Starting runtime...";
    case "waiting_for_ready":
      return `Starting runtime (${status.attempt}/${status.max_attempts})...`;
  }
}
