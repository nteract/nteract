import { withCloudPrototypeAuthHeaders, type CloudPrototypeAuthState } from "./collaborator-auth";

export const CLOUD_CONNECTION_SIGN_IN_DIAGNOSTIC = "Sign in again to open this notebook.";
export const CLOUD_CONNECTION_NO_ACCESS_DIAGNOSTIC =
  "This account does not have access to this notebook. Ask the owner to share it, or refresh sign-in if an invite was just accepted.";

export interface DiagnoseCloudConnectionAccessOptions {
  accessRequestsEndpoint: string;
  authState: CloudPrototypeAuthState;
  fetchImpl?: typeof fetch;
}

export async function diagnoseCloudConnectionAccess({
  accessRequestsEndpoint,
  authState,
  fetchImpl = fetch,
}: DiagnoseCloudConnectionAccessOptions): Promise<string | null> {
  if (authState.mode !== "dev" && authState.mode !== "oidc") {
    return null;
  }

  try {
    const response = await fetchImpl(
      accessRequestsEndpoint,
      withCloudPrototypeAuthHeaders(
        {
          cache: "no-store",
          headers: { Accept: "application/json" },
        },
        authState,
      ),
    );
    if (response.ok) {
      return null;
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
