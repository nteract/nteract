import type { CloudPrototypeAuthState } from "./collaborator-auth";
import type { CloudOidcTokenState } from "./oidc-auth";

export const CLOUD_APP_SESSION_ENDPOINT = "/api/auth/session";

export interface CloudAppSession {
  provider: "oidc";
  expires_at: number;
}

export interface CloudAppSessionStatus {
  ok: true;
  session: CloudAppSession | null;
}

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

export async function readCloudAppSessionStatus(input?: {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<CloudAppSessionStatus> {
  const response = await (input?.fetchImpl ?? fetch)(CLOUD_APP_SESSION_ENDPOINT, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal: input?.signal,
  });
  if (!response.ok) {
    throw new Error(`Unable to read app session: ${response.status}`);
  }

  const body = (await response.json()) as unknown;
  if (!isCloudAppSessionStatus(body)) {
    throw new Error("Unable to read app session: response shape was invalid");
  }
  return body;
}

export function isCloudAppSessionStatus(value: unknown): value is CloudAppSessionStatus {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CloudAppSessionStatus>;
  return (
    candidate.ok === true &&
    Object.keys(candidate).every((key) => key === "ok" || key === "session") &&
    (candidate.session === null ||
      candidate.session === undefined ||
      isCloudAppSession(candidate.session))
  );
}

export function isCloudAppSession(value: unknown): value is CloudAppSession {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CloudAppSession>;
  return (
    candidate.provider === "oidc" &&
    Number.isFinite(candidate.expires_at) &&
    Object.keys(candidate).every((key) => key === "provider" || key === "expires_at")
  );
}
