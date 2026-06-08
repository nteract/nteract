import type { ReactNode } from "react";
import { AlertCircle, CloudOff, Loader2, LogIn, RotateCcw } from "lucide-react";
import {
  NotebookNotice,
  NotebookNoticeAction,
  NotebookNoticeStack,
} from "@/components/notebook/NotebookNotice";
import { prototypeAuthSummary, type CloudPrototypeAuthState } from "./collaborator-auth";
import {
  CLOUD_CONNECTION_EDIT_ACCESS_APPROVED_DIAGNOSTIC,
  CLOUD_CONNECTION_EDIT_ACCESS_PENDING_DIAGNOSTIC,
  CLOUD_CONNECTION_NO_ACCESS_DIAGNOSTIC,
  CLOUD_CONNECTION_SIGN_IN_DIAGNOSTIC,
} from "./connection-diagnostics";
import type { CloudAuthRenewalState, ViewerStatus } from "./notice-types";

export interface CloudNotebookNoticesProps {
  authState: CloudPrototypeAuthState;
  authRenewal: CloudAuthRenewalState;
  connectionError: string | null;
  hasAppSession?: boolean;
  hasReadableSnapshot?: boolean;
  status: ViewerStatus;
  diagnostics?: ReactNode;
  onResetAuth: () => void;
  onSignInAgain?: () => void | Promise<void>;
}

export function cloudNotebookHasNotices({
  authState,
  authRenewal,
  connectionError,
  hasAppSession = false,
  hasReadableSnapshot = false,
  status,
  diagnostics,
}: Omit<CloudNotebookNoticesProps, "onResetAuth">): boolean {
  const connectionNotice = connectionError
    ? cloudConnectionNoticeDisplay(connectionError, hasReadableSnapshot)
    : null;
  const shouldShowStatusNotice =
    status.kind !== "ready" &&
    !(status.kind === "empty" && hasReadableSnapshot) &&
    !isStatusDerivedFromConnectionError(status, connectionError);

  const shouldShowAuthNotice =
    !hasAppSession && (authState.mode === "invalid" || authState.mode === "oidc_expired");
  const shouldShowAuthRenewalNotice = !hasAppSession && authRenewal.kind !== "idle";

  return (
    shouldShowAuthNotice ||
    shouldShowAuthRenewalNotice ||
    Boolean(connectionNotice) ||
    Boolean(diagnostics) ||
    shouldShowStatusNotice
  );
}

export function CloudNotebookNotices({
  authState,
  authRenewal,
  connectionError,
  hasAppSession = false,
  hasReadableSnapshot = false,
  status,
  diagnostics,
  onResetAuth,
  onSignInAgain,
}: CloudNotebookNoticesProps) {
  if (
    !cloudNotebookHasNotices({
      authState,
      authRenewal,
      connectionError,
      hasAppSession,
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
    status.kind !== "ready" &&
    !(status.kind === "empty" && hasReadableSnapshot) &&
    !isStatusDerivedFromConnectionError(status, connectionError);
  const shouldShowAuthNotice =
    !hasAppSession && (authState.mode === "invalid" || authState.mode === "oidc_expired");
  const shouldShowAuthRenewalNotice = !hasAppSession && authRenewal.kind !== "idle";

  return (
    <NotebookNoticeStack>
      {shouldShowAuthNotice ? (
        <NotebookNotice
          tone="error"
          icon={<AlertCircle className="h-4 w-4" />}
          title="Auth needs attention."
          actions={<AuthNoticeAction onResetAuth={onResetAuth} onSignInAgain={onSignInAgain} />}
        >
          {prototypeAuthSummary(authState)}
        </NotebookNotice>
      ) : null}

      {shouldShowAuthRenewalNotice ? (
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
              <AuthNoticeAction onResetAuth={onResetAuth} onSignInAgain={onSignInAgain} />
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
          actions={
            <ConnectionNoticeAction
              connectionError={connectionError ?? ""}
              onResetAuth={onResetAuth}
              onSignInAgain={onSignInAgain}
            />
          }
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

function AuthNoticeAction({
  onResetAuth,
  onSignInAgain,
}: {
  onResetAuth: () => void;
  onSignInAgain?: () => void | Promise<void>;
}) {
  if (onSignInAgain) {
    return (
      <NotebookNoticeAction
        onClick={() => {
          void onSignInAgain();
        }}
        icon={<LogIn className="h-3 w-3" />}
      >
        Sign in again
      </NotebookNoticeAction>
    );
  }

  return (
    <NotebookNoticeAction onClick={onResetAuth} icon={<RotateCcw className="h-3 w-3" />}>
      Clear stale sign-in
    </NotebookNoticeAction>
  );
}

function ConnectionNoticeAction({
  connectionError,
  onResetAuth,
  onSignInAgain,
}: {
  connectionError: string;
  onResetAuth: () => void;
  onSignInAgain?: () => void | Promise<void>;
}) {
  if (connectionError === CLOUD_CONNECTION_SIGN_IN_DIAGNOSTIC && onSignInAgain) {
    return (
      <NotebookNoticeAction
        onClick={() => {
          void onSignInAgain();
        }}
        icon={<LogIn className="h-3 w-3" />}
      >
        Sign in again
      </NotebookNoticeAction>
    );
  }

  return (
    <NotebookNoticeAction onClick={onResetAuth} icon={<RotateCcw className="h-3 w-3" />}>
      Use anonymous
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
  if (error === CLOUD_CONNECTION_SIGN_IN_DIAGNOSTIC) {
    return {
      title: "Sign in required.",
      message: "Sign in again to open the live notebook room.",
      tone: "warning",
    };
  }

  if (error === CLOUD_CONNECTION_NO_ACCESS_DIAGNOSTIC) {
    return {
      title: "Notebook access needed.",
      message:
        "This account does not have access to this notebook yet. Ask the owner to share it, or refresh sign-in if an invite was just accepted.",
      tone: "warning",
    };
  }

  if (error === CLOUD_CONNECTION_EDIT_ACCESS_PENDING_DIAGNOSTIC) {
    return {
      title: "Edit access pending.",
      message: "The owner can approve the edit request from the sharing panel.",
      tone: "warning",
    };
  }

  if (error === CLOUD_CONNECTION_EDIT_ACCESS_APPROVED_DIAGNOSTIC) {
    return {
      title: "Edit access approved.",
      message: "Refresh or reconnect to open the live notebook room with editor access.",
      tone: "warning",
    };
  }

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
