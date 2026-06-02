import type { ReactNode } from "react";
import { AlertCircle, CloudOff, Loader2, RotateCcw } from "lucide-react";
import {
  NotebookNotice,
  NotebookNoticeAction,
  NotebookNoticeStack,
} from "@/components/notebook/NotebookNotice";
import { prototypeAuthSummary, type CloudPrototypeAuthState } from "./collaborator-auth";
import type { CloudAuthRenewalState, ViewerStatus } from "./notice-types";

export interface CloudNotebookNoticesProps {
  authState: CloudPrototypeAuthState;
  authRenewal: CloudAuthRenewalState;
  connectionError: string | null;
  hasReadableSnapshot?: boolean;
  status: ViewerStatus;
  diagnostics?: ReactNode;
  onResetAuth: () => void;
}

export function cloudNotebookHasNotices({
  authState,
  authRenewal,
  connectionError,
  hasReadableSnapshot = false,
  status,
  diagnostics,
}: Omit<CloudNotebookNoticesProps, "onResetAuth">): boolean {
  const connectionNotice = connectionError
    ? cloudConnectionNoticeDisplay(connectionError, hasReadableSnapshot)
    : null;
  const shouldShowStatusNotice =
    status.kind !== "ready" && !isStatusDerivedFromConnectionError(status, connectionError);

  return (
    authState.mode === "invalid" ||
    authState.mode === "oidc_expired" ||
    authRenewal.kind !== "idle" ||
    Boolean(connectionNotice) ||
    Boolean(diagnostics) ||
    shouldShowStatusNotice
  );
}

export function CloudNotebookNotices({
  authState,
  authRenewal,
  connectionError,
  hasReadableSnapshot = false,
  status,
  diagnostics,
  onResetAuth,
}: CloudNotebookNoticesProps) {
  if (
    !cloudNotebookHasNotices({
      authState,
      authRenewal,
      connectionError,
      hasReadableSnapshot,
      status,
      diagnostics,
    })
  ) {
    return null;
  }

  const connectionNotice = connectionError
    ? cloudConnectionNoticeDisplay(connectionError, hasReadableSnapshot)
    : null;
  const shouldShowStatusNotice =
    status.kind !== "ready" && !isStatusDerivedFromConnectionError(status, connectionError);

  return (
    <NotebookNoticeStack>
      {authState.mode === "invalid" || authState.mode === "oidc_expired" ? (
        <NotebookNotice
          tone="error"
          icon={<AlertCircle className="h-4 w-4" />}
          title="Auth needs attention."
          actions={<ResetAuthNoticeAction onResetAuth={onResetAuth} />}
        >
          {prototypeAuthSummary(authState)}
        </NotebookNotice>
      ) : null}

      {authRenewal.kind !== "idle" ? (
        <NotebookNotice
          tone={authRenewal.kind === "failed" ? "error" : "info"}
          icon={
            authRenewal.kind === "failed" ? (
              <AlertCircle className="h-4 w-4" />
            ) : (
              <Loader2 className="h-4 w-4 animate-spin" />
            )
          }
          title={authRenewal.kind === "failed" ? "Sign-in refresh failed." : "Refreshing sign-in."}
          actions={
            authRenewal.kind === "failed" ? (
              <ResetAuthNoticeAction onResetAuth={onResetAuth} />
            ) : null
          }
        >
          {authRenewal.message}
        </NotebookNotice>
      ) : null}

      {connectionNotice ? (
        <NotebookNotice
          tone={connectionNotice.tone}
          icon={<CloudOff className="h-4 w-4" />}
          title={connectionNotice.title}
          actions={<ResetAuthNoticeAction label="Use anonymous" onResetAuth={onResetAuth} />}
        >
          {connectionNotice.message}
        </NotebookNotice>
      ) : null}

      {diagnostics}

      {shouldShowStatusNotice ? (
        <NotebookNotice
          tone={status.kind === "error" ? "error" : "info"}
          icon={
            status.kind === "error" ? (
              <AlertCircle className="h-4 w-4" />
            ) : (
              <Loader2 className="h-4 w-4 animate-spin" />
            )
          }
          title={status.kind === "error" ? "Unable to load notebook." : "Loading notebook."}
        >
          {status.message}
        </NotebookNotice>
      ) : null}
    </NotebookNoticeStack>
  );
}

function ResetAuthNoticeAction({
  label = "Reset to anonymous",
  onResetAuth,
}: {
  label?: string;
  onResetAuth: () => void;
}) {
  return (
    <NotebookNoticeAction onClick={onResetAuth} icon={<RotateCcw className="h-3 w-3" />}>
      {label}
    </NotebookNoticeAction>
  );
}

function isStatusDerivedFromConnectionError(
  status: ViewerStatus,
  connectionError: string | null,
): boolean {
  return (
    status.kind === "error" &&
    Boolean(connectionError) &&
    status.message.startsWith("Unable to load live notebook room:")
  );
}

function cloudConnectionNoticeDisplay(
  error: string,
  hasReadableSnapshot: boolean,
): {
  title: string;
  message: string;
  tone: "warning";
} {
  if (/\bfailed to connect\s+wss?:\/\//i.test(error)) {
    if (!hasReadableSnapshot) {
      return {
        title: "Live room unavailable.",
        message: "The notebook will load once the account or connection is refreshed.",
        tone: "warning",
      };
    }
    return {
      title: "Live room reconnecting.",
      message: "The notebook stays readable while the account or connection is refreshed.",
      tone: "warning",
    };
  }

  return {
    title: "Live room needs attention.",
    message: sanitizeCloudConnectionError(error),
    tone: "warning",
  };
}

function sanitizeCloudConnectionError(error: string): string {
  return error.replace(/\bwss?:\/\/[^\s]+/gi, (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      return rawUrl.replace(/[?#].*$/, "");
    }
  });
}
