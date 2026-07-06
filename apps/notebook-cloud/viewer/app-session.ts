// Browser client for the first-party app-session cookie.
//
// OIDC tokens remain the durable browser credential, but the cloud shell uses a
// same-origin session cookie to let the Worker bootstrap authenticated pages. The
// callback path gets one bounded retry so a temporary POST failure does not send
// the user to `/n` before the cookie has had a second chance to establish.

import type { CloudPrototypeAuthState } from "./collaborator-auth";
import type { CloudOidcTokenState } from "./oidc-auth";

export const CLOUD_APP_SESSION_ENDPOINT = "/api/auth/session";

export interface CloudAppSession {
  provider: "oidc";
  expires_at: number;
  cache_key: string;
}

export interface CloudAppSessionStatus {
  ok: true;
  session: CloudAppSession | null;
}

const CLOUD_APP_SESSION_EXPIRY_SKEW_SECONDS = 60;
const CLOUD_APP_SESSION_RENEWAL_SKEW_SECONDS = 30 * 60;
const CLOUD_APP_SESSION_POST_RETRY_DELAY_MS = 250;
const CLOUD_APP_SESSION_POST_TIMEOUT_MS = 10_000;

export interface CloudAppSessionRequestOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface CloudAppSessionRetryDeps extends CloudAppSessionRequestOptions {
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  timeoutSignal?: (timeoutMs: number) => AbortSignal;
}

export async function establishCloudAppSession(authState: CloudPrototypeAuthState): Promise<void> {
  if (authState.mode !== "oidc" || !authState.token) {
    return;
  }
  await establishCloudAppSessionWithToken(authState.token);
}

export async function establishCloudAppSessionWithToken(
  token: string,
  opts: CloudAppSessionRequestOptions = {},
): Promise<void> {
  const response = await (opts.fetchImpl ?? fetch)(CLOUD_APP_SESSION_ENDPOINT, {
    credentials: "same-origin",
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    signal: opts.signal,
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

export async function establishCloudAppSessionFromOidcTokenWithRetry(
  token: CloudOidcTokenState,
  deps: CloudAppSessionRetryDeps = {},
): Promise<void> {
  try {
    await establishCloudAppSessionWithToken(token.accessToken, {
      fetchImpl: deps.fetchImpl,
      signal: appSessionPostAttemptSignal(deps),
    });
    return;
  } catch {
    const sleep = deps.sleep ?? defaultSleep;
    await sleep(deps.retryDelayMs ?? CLOUD_APP_SESSION_POST_RETRY_DELAY_MS);
  }
  await establishCloudAppSessionWithToken(token.accessToken, {
    fetchImpl: deps.fetchImpl,
    signal: appSessionPostAttemptSignal(deps),
  });
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
    typeof candidate.cache_key === "string" &&
    Object.keys(candidate).every(
      (key) => key === "provider" || key === "expires_at" || key === "cache_key",
    )
  );
}

export function cloudAppSessionIsFresh(
  session: CloudAppSession | null | undefined,
  nowSeconds = currentEpochSeconds(),
): boolean {
  return Boolean(
    session && session.expires_at > nowSeconds + CLOUD_APP_SESSION_EXPIRY_SKEW_SECONDS,
  );
}

export function cloudAppSessionNeedsRenewal(
  session: CloudAppSession | null | undefined,
  nowSeconds = currentEpochSeconds(),
): boolean {
  return !session || session.expires_at <= nowSeconds + CLOUD_APP_SESSION_RENEWAL_SKEW_SECONDS;
}

function currentEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function appSessionPostAttemptSignal(deps: CloudAppSessionRetryDeps): AbortSignal {
  const timeoutSignal = deps.timeoutSignal ?? defaultAppSessionTimeoutSignal;
  const signal = timeoutSignal(deps.timeoutMs ?? CLOUD_APP_SESSION_POST_TIMEOUT_MS);
  if (!deps.signal) {
    return signal;
  }
  return AbortSignal.any([deps.signal, signal]);
}

function defaultAppSessionTimeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
