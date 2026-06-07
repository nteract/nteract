import type { CloudPrototypeAuthState } from "./collaborator-auth";
import type { CloudOidcTokenState } from "./oidc-auth";

export const CLOUD_APP_SESSION_ENDPOINT = "/api/auth/session";

export async function establishCloudAppSession(authState: CloudPrototypeAuthState): Promise<void> {
  if (authState.mode !== "oidc" || !authState.token) {
    return;
  }
  await establishCloudAppSessionWithToken(authState.token);
}

export async function establishCloudAppSessionWithToken(token: string): Promise<void> {
  const response = await fetch(CLOUD_APP_SESSION_ENDPOINT, {
    credentials: "same-origin",
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Unable to establish app session: ${response.status}`);
  }
}

export async function establishCloudAppSessionFromOidcToken(
  token: CloudOidcTokenState,
): Promise<void> {
  await establishCloudAppSessionWithToken(token.accessToken);
}

export async function clearCloudAppSession(): Promise<void> {
  await fetch(CLOUD_APP_SESSION_ENDPOINT, {
    credentials: "same-origin",
    method: "DELETE",
    headers: { Accept: "application/json" },
  });
}
