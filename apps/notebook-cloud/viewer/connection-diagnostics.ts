import { withCloudPrototypeAuthHeaders, type CloudPrototypeAuthState } from "./collaborator-auth";
import { isRuntimedWasmAssetFailure } from "./runtimed-wasm-failure";
import type { CloudNotebookAccessRequest } from "./sharing-client";

export const CLOUD_CONNECTION_SIGN_IN_DIAGNOSTIC = "Sign in again to open this notebook.";
export const CLOUD_CONNECTION_NO_ACCESS_DIAGNOSTIC =
  "This account does not have access to this notebook. Ask the owner to share it, or refresh sign-in if an invite was just accepted.";
export const CLOUD_CONNECTION_EDIT_ACCESS_PENDING_DIAGNOSTIC =
  "Edit access is waiting for owner approval.";
export const CLOUD_CONNECTION_EDIT_ACCESS_APPROVED_DIAGNOSTIC =
  "Edit access was approved. Reconnect to open the live notebook room with editor access.";

/**
 * Whether an access diagnostic may replace the current connection error.
 *
 * Terminal runtimed-WASM asset failures own the connection notice: their
 * Retry affordance is the documented re-entry (the wasm client clears its
 * caches on rejection, so the retry genuinely re-imports), and an access
 * diagnostic resolving around the same time (sign-in, pending edit access)
 * must not overwrite it — auth-flavored copy and actions cannot fix a
 * failed WASM load.
 */
export function cloudConnectionErrorAcceptsAccessDiagnostic(message: string): boolean {
  return !isRuntimedWasmAssetFailure(message);
}

/**
 * Merge a LATE-resolving access diagnostic into the connection error that
 * is current at resolution time. Guarding only at kick time is not
 * enough: `diagnoseCloudConnectionAccess` has no deadline, and by the
 * time it resolves a terminal WASM asset failure may own the notice — its
 * Retry affordance must not be replaced with auth-flavored copy whose
 * "Use anonymous" action can destroy a signed-in session without fixing
 * the asset load.
 */
export function cloudConnectionErrorWithAccessDiagnostic(
  current: string | null,
  diagnostic: string,
): string {
  if (current !== null && !cloudConnectionErrorAcceptsAccessDiagnostic(current)) {
    return current;
  }
  return diagnostic;
}

export interface DiagnoseCloudConnectionAccessOptions {
  accessRequestsEndpoint: string;
  authState: CloudPrototypeAuthState;
  fetchImpl?: typeof fetch;
  hasAppSession?: boolean;
}

export async function diagnoseCloudConnectionAccess({
  accessRequestsEndpoint,
  authState,
  fetchImpl = fetch,
  hasAppSession = false,
}: DiagnoseCloudConnectionAccessOptions): Promise<string | null> {
  if (!hasAppSession && authState.mode !== "dev" && authState.mode !== "oidc") {
    return null;
  }

  try {
    const response = await fetchImpl(
      accessRequestsEndpoint,
      withCloudPrototypeAuthHeaders(
        {
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        },
        authState,
      ),
    );
    if (response.ok) {
      return await diagnoseSuccessfulAccessResponse(response, authState);
    }
    if (response.status === 401) {
      return CLOUD_CONNECTION_SIGN_IN_DIAGNOSTIC;
    }
    if (response.status === 403 || response.status === 404) {
      return CLOUD_CONNECTION_NO_ACCESS_DIAGNOSTIC;
    }
  } catch {
    return null;
  }

  return null;
}

async function diagnoseSuccessfulAccessResponse(
  response: Response,
  authState: CloudPrototypeAuthState,
): Promise<string | null> {
  if (authState.requestedScope !== "editor") {
    return null;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }

  if (!isAccessRequestsBody(body) || body.access_requests.length !== 1) {
    return null;
  }

  const request = body.access_requests[0];
  if (request.scope !== "editor") {
    return null;
  }

  if (request.status === "pending") {
    return CLOUD_CONNECTION_EDIT_ACCESS_PENDING_DIAGNOSTIC;
  }
  if (request.status === "approved") {
    return CLOUD_CONNECTION_EDIT_ACCESS_APPROVED_DIAGNOSTIC;
  }

  return null;
}

function isAccessRequestsBody(
  candidate: unknown,
): candidate is { access_requests: Pick<CloudNotebookAccessRequest, "scope" | "status">[] } {
  if (!candidate || typeof candidate !== "object") {
    return false;
  }
  const requests = (candidate as { access_requests?: unknown }).access_requests;
  return (
    Array.isArray(requests) &&
    requests.every(
      (request) =>
        request &&
        typeof request === "object" &&
        typeof (request as { scope?: unknown }).scope === "string" &&
        typeof (request as { status?: unknown }).status === "string",
    )
  );
}
