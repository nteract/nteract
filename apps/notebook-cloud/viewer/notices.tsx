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
  return (
    authState.mode === "invalid" ||
    authState.mode === "oidc_expired" ||
    authRenewal.kind !== "idle" ||
    Boolean(connectionError) ||
    Boolean(diagnostics) ||
    status.kind !== "ready"
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

      {connectionError ? (
        <NotebookNotice
          tone="error"
          icon={<AlertCircle className="h-4 w-4" />}
          title="Live room connection failed."
          actions={<ResetAuthNoticeAction onResetAuth={onResetAuth} />}
        >
          {connectionError}
        </NotebookNotice>
      ) : null}

      {diagnostics}

      {status.kind === "ready" ? null : (
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
      )}
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
