import type { AuthenticatedConnection } from "./identity.ts";

export interface AppSessionEnvironment {
  NOTEBOOK_CLOUD_APP_SESSION_SECRET?: string;
}

export interface CloudAppSession {
  displayName?: string;
  expiresAt: number;
  issuedAt: number;
  principal: string;
  principalNamespace: string;
  provider: "oidc";
}

interface CloudAppSessionPayload {
  display_name?: string;
  exp: number;
  iat: number;
  ns: string;
  principal: string;
  provider: "oidc";
  v: 1;
}

export const NOTEBOOK_CLOUD_APP_SESSION_COOKIE_NAME = "__Host-nteract_cloud_app_session";
export const NOTEBOOK_CLOUD_APP_SESSION_MAX_AGE_SECONDS = 6 * 60 * 60;
export const NOTEBOOK_CLOUD_APP_SESSION_SECRET_MIN_LENGTH = 32;

const SESSION_SIGNING_ALGORITHM = { name: "HMAC", hash: "SHA-256" };

export function appSessionConfigured(env: AppSessionEnvironment): boolean {
  return appSessionSecret(env) !== null;
}

export async function createCloudAppSessionCookie(
  env: AppSessionEnvironment,
  identity: AuthenticatedConnection,
  nowSeconds = currentEpochSeconds(),
): Promise<string> {
  if (identity.metadata.provider !== "oidc") {
    throw new Error("app sessions require OIDC identity");
  }
  const payload: CloudAppSessionPayload = {
    v: 1,
    provider: "oidc",
    principal: identity.principal,
    ns: identity.metadata.principalNamespace,
    iat: nowSeconds,
    exp: nowSeconds + NOTEBOOK_CLOUD_APP_SESSION_MAX_AGE_SECONDS,
    ...(identity.metadata.displayName ? { display_name: identity.metadata.displayName } : {}),
  };
  const value = await signCloudAppSession(env, payload);
  return `${NOTEBOOK_CLOUD_APP_SESSION_COOKIE_NAME}=${value}; Path=/; Max-Age=${NOTEBOOK_CLOUD_APP_SESSION_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCloudAppSessionCookie(): string {
  return `${NOTEBOOK_CLOUD_APP_SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export async function readCloudAppSession(
  env: AppSessionEnvironment,
  request: Request,
  nowSeconds = currentEpochSeconds(),
): Promise<CloudAppSession | null> {
  const value = cookieValue(request.headers.get("Cookie"), NOTEBOOK_CLOUD_APP_SESSION_COOKIE_NAME);
  if (!value) {
    return null;
  }

  const payload = await verifyCloudAppSession(env, value);
  if (!payload || payload.exp <= nowSeconds || payload.iat > nowSeconds + 60) {
    return null;
  }

  return {
    provider: payload.provider,
    principal: payload.principal,
    principalNamespace: payload.ns,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    ...(payload.display_name ? { displayName: payload.display_name } : {}),
  };
}

async function signCloudAppSession(
  env: AppSessionEnvironment,
  payload: CloudAppSessionPayload,
): Promise<string> {
  const encodedPayload = base64UrlEncodeString(JSON.stringify(payload));
  const signature = await hmacSha256(env, encodedPayload);
  return `${encodedPayload}.${base64UrlEncodeBytes(signature)}`;
}

async function verifyCloudAppSession(
  env: AppSessionEnvironment,
  value: string,
): Promise<CloudAppSessionPayload | null> {
  const [encodedPayload, encodedSignature, extra] = value.split(".");
  if (!encodedPayload || !encodedSignature || extra !== undefined) {
    return null;
  }

  const expected = await hmacSha256(env, encodedPayload).catch(() => null);
  const actual = base64UrlDecodeBytes(encodedSignature);
  if (!expected || !actual || !timingSafeBytesEqual(expected, actual)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecodeString(encodedPayload));
  } catch {
    return null;
  }
  if (!isCloudAppSessionPayload(parsed)) {
    return null;
  }
  return parsed;
}

async function hmacSha256(env: AppSessionEnvironment, value: string): Promise<Uint8Array> {
  const secret = appSessionSecret(env);
  if (!secret) {
    throw new Error("app session signing is not configured");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    SESSION_SIGNING_ALGORITHM,
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    SESSION_SIGNING_ALGORITHM,
    key,
    new TextEncoder().encode(value),
  );
  return new Uint8Array(signature);
}

function appSessionSecret(env: AppSessionEnvironment): string | null {
  const secret = env.NOTEBOOK_CLOUD_APP_SESSION_SECRET?.trim();
  if (!secret || secret.length < NOTEBOOK_CLOUD_APP_SESSION_SECRET_MIN_LENGTH) {
    return null;
  }
  return secret;
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) {
    return null;
  }
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.split("=");
    if (rawName?.trim() === name) {
      return rawValue.join("=").trim() || null;
    }
  }
  return null;
}

function isCloudAppSessionPayload(value: unknown): value is CloudAppSessionPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const payload = value as Partial<CloudAppSessionPayload>;
  return (
    payload.v === 1 &&
    payload.provider === "oidc" &&
    typeof payload.principal === "string" &&
    typeof payload.ns === "string" &&
    Number.isFinite(payload.iat) &&
    Number.isFinite(payload.exp) &&
    (payload.display_name === undefined || typeof payload.display_name === "string")
  );
}

function timingSafeBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.byteLength ^ right.byteLength;
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function base64UrlEncodeString(value: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecodeString(value: string): string {
  return new TextDecoder().decode(base64UrlDecodeBytes(value) ?? new Uint8Array());
}

function base64UrlDecodeBytes(value: string): Uint8Array | null {
  try {
    const padded = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function currentEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
