import { withCloudPrototypeAuthHeaders, type CloudPrototypeAuthState } from "./collaborator-auth";
import type { CloudNotebookAccessRequest } from "./sharing-client";

export const CLOUD_CONNECTION_SIGN_IN_DIAGNOSTIC = "Sign in again to open this notebook.";
export const CLOUD_CONNECTION_NO_ACCESS_DIAGNOSTIC =
  "This account does not have access to this notebook. Ask the owner to share it, or refresh sign-in if an invite was just accepted.";
export const CLOUD_CONNECTION_EDIT_ACCESS_PENDING_DIAGNOSTIC =
  "Edit access is waiting for owner approval.";
export const CLOUD_CONNECTION_EDIT_ACCESS_APPROVED_DIAGNOSTIC =
  "Edit access was approved. Reconnect to open the live notebook room with editor access.";

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
