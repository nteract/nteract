import type { ReactNode } from "react";
import { AlertCircle, Loader2, RotateCcw } from "lucide-react";
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
  status: ViewerStatus;
  diagnostics?: ReactNode;
  onResetAuth: () => void;
}

export function cloudNotebookHasNotices({
  authState,
  authRenewal,
  connectionError,
  status,
  diagnostics,
}: Omit<CloudNotebookNoticesProps, "onResetAuth">): boolean {
  const connectionNotice = connectionError ? cloudConnectionNoticeDisplay(connectionError) : null;
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
  status,
  diagnostics,
  onResetAuth,
}: CloudNotebookNoticesProps) {
  if (
    !cloudNotebookHasNotices({
      authState,
      authRenewal,
      connectionError,
      status,
      diagnostics,
    })
  ) {
    return null;
  }

  const connectionNotice = connectionError ? cloudConnectionNoticeDisplay(connectionError) : null;
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
          tone="error"
          icon={<AlertCircle className="h-4 w-4" />}
          title={connectionNotice.title}
          actions={<ResetAuthNoticeAction onResetAuth={onResetAuth} />}
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

function ResetAuthNoticeAction({ onResetAuth }: { onResetAuth: () => void }) {
  return (
    <NotebookNoticeAction onClick={onResetAuth} icon={<RotateCcw className="h-3 w-3" />}>
      Reset to anonymous
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

function cloudConnectionNoticeDisplay(error: string): { title: string; message: string } {
  if (/\bfailed to connect\s+wss?:\/\//i.test(error)) {
    return {
      title: "Live room needs attention.",
      message:
        "Unable to join the live notebook room. The notebook can stay readable while the account or connection is refreshed.",
    };
  }

  return {
    title: "Live room needs attention.",
    message: sanitizeCloudConnectionError(error),
  };
}

function sanitizeCloudConnectionError(error: string): string {
  return error.replace(/\bwss?:\/\/[^\s]+/gi, (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      return `${url.protocol}//${url.host}/...`;
    } catch {
      return "live room endpoint";
    }
  });
}
