import type { AuthenticatedConnection } from "./identity.ts";
import { normalizeInviteEmail } from "./sharing.ts";
import {
  readServerAppSession,
  serverOidcEnabled,
  type ServerSessionEnvironment,
} from "./oidc-session-store.ts";

export interface AppSessionEnvironment extends ServerSessionEnvironment {
  NOTEBOOK_CLOUD_APP_SESSION_SECRET?: string;
}

export interface CloudAppSession {
  cacheKey: string;
  displayName?: string;
  expiresAt: number;
  issuedAt: number;
  identityVerifiedAt?: number;
  verifiedEmailBinding?: string;
  principal: string;
  principalNamespace: string;
  provider: "oidc";
}

interface CloudAppSessionPayload {
  display_name?: string;
  exp: number;
  iat: number;
  identity_verified_at?: number;
  verified_email_binding?: string;
  ns: string;
  principal: string;
  provider: "oidc";
  sid?: string;
  v: 1;
}

export const NOTEBOOK_CLOUD_APP_SESSION_COOKIE_NAME = "__Host-nteract_cloud_app_session";
export const NOTEBOOK_CLOUD_APP_SESSION_DISPLAY_NAME_MAX_LENGTH = 128;
export const NOTEBOOK_CLOUD_APP_SESSION_MAX_AGE_SECONDS = 6 * 60 * 60;
export const NOTEBOOK_CLOUD_IDENTITY_PROOF_MAX_AGE_SECONDS = 6 * 60 * 60;
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
  const displayName = appSessionDisplayName(identity.metadata.displayName);
  const payload: CloudAppSessionPayload = {
    v: 1,
    provider: "oidc",
    principal: identity.principal,
    ns: identity.metadata.principalNamespace,
    iat: nowSeconds,
    exp: nowSeconds + NOTEBOOK_CLOUD_APP_SESSION_MAX_AGE_SECONDS,
    sid: crypto.randomUUID(),
    ...(await verifiedEmailProof(env, identity, nowSeconds)),
    ...(displayName ? { display_name: displayName } : {}),
  };
  const value = await signCloudAppSession(env, payload);
  return `${NOTEBOOK_CLOUD_APP_SESSION_COOKIE_NAME}=${value}; Path=/; Max-Age=${NOTEBOOK_CLOUD_APP_SESSION_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export async function appSessionRenewalCookie(
  env: AppSessionEnvironment,
  session: CloudAppSession | null | undefined,
  nowSeconds = currentEpochSeconds(),
): Promise<string | null> {
  if (serverOidcEnabled(env)) return null;
  if (!session || session.expiresAt <= nowSeconds) {
    return null;
  }
  const remainingSeconds = session.expiresAt - nowSeconds;
  if (remainingSeconds >= NOTEBOOK_CLOUD_APP_SESSION_MAX_AGE_SECONDS / 2) {
    return null;
  }

  const payload: CloudAppSessionPayload = {
    v: 1,
    provider: "oidc",
    principal: session.principal,
    ns: session.principalNamespace,
    iat: nowSeconds,
    exp: nowSeconds + NOTEBOOK_CLOUD_APP_SESSION_MAX_AGE_SECONDS,
    sid: crypto.randomUUID(),
    // Cookie renewal extends notebook access, never the age of identity proof.
    ...(session.identityVerifiedAt !== undefined && session.verifiedEmailBinding
      ? {
          identity_verified_at: session.identityVerifiedAt,
          verified_email_binding: session.verifiedEmailBinding,
        }
      : {}),
    ...(session.displayName ? { display_name: session.displayName } : {}),
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
  if (serverOidcEnabled(env)) return readServerAppSession(env, request, nowSeconds);
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
    cacheKey: await appSessionCacheKey(env, payload),
    principal: payload.principal,
    principalNamespace: payload.ns,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    ...(validIdentityProof(payload, nowSeconds)
      ? {
          identityVerifiedAt: payload.identity_verified_at,
          verifiedEmailBinding: payload.verified_email_binding,
        }
      : {}),
    ...(payload.display_name ? { displayName: payload.display_name } : {}),
  };
}

/** Server sessions project the same identity without putting tokens in cookies. */
export async function createServerAppSession(
  env: AppSessionEnvironment,
  identity: AuthenticatedConnection,
  cacheKey: string,
  expiresAt: number,
  nowSeconds: number,
): Promise<CloudAppSession> {
  const proof = await verifiedEmailProof(env, identity, nowSeconds);
  return {
    provider: "oidc",
    cacheKey,
    principal: identity.principal,
    principalNamespace: identity.metadata.principalNamespace,
    issuedAt: nowSeconds,
    expiresAt,
    ...(identity.metadata.displayName
      ? { displayName: appSessionDisplayName(identity.metadata.displayName) }
      : {}),
    ...(proof.identity_verified_at !== undefined
      ? {
          identityVerifiedAt: proof.identity_verified_at,
          verifiedEmailBinding: proof.verified_email_binding,
        }
      : {}),
  };
}

/** Stronger proof for profile-sensitive features, independent of notebook session renewal. */
export async function appSessionHasFreshVerifiedEmail(
  env: AppSessionEnvironment,
  identity: AuthenticatedConnection,
  email: string,
  nowSeconds = currentEpochSeconds(),
): Promise<boolean> {
  const { identityVerifiedAt, verifiedEmailBinding } = identity.metadata;
  if (
    identity.metadata.provider !== "app-session" ||
    !Number.isSafeInteger(identityVerifiedAt) ||
    identityVerifiedAt === undefined ||
    identityVerifiedAt <= 0 ||
    identityVerifiedAt > nowSeconds ||
    nowSeconds - identityVerifiedAt >= NOTEBOOK_CLOUD_IDENTITY_PROOF_MAX_AGE_SECONDS ||
    !verifiedEmailBinding
  )
    return false;
  try {
    const expected = await verifiedEmailBindingBytes(env, identity, email, identityVerifiedAt);
    const actual = base64UrlDecodeBytes(verifiedEmailBinding);
    return actual !== null && timingSafeBytesEqual(expected, actual);
  } catch {
    return false;
  }
}

async function verifiedEmailProof(
  env: AppSessionEnvironment,
  identity: AuthenticatedConnection,
  nowSeconds: number,
): Promise<Pick<CloudAppSessionPayload, "identity_verified_at" | "verified_email_binding">> {
  if (identity.metadata.emailVerified !== true || !identity.metadata.email) return {};
  let email: string;
  try {
    email = normalizeInviteEmail(identity.metadata.email);
  } catch {
    return {};
  }
  return {
    identity_verified_at: nowSeconds,
    verified_email_binding: base64UrlEncodeBytes(
      await verifiedEmailBindingBytes(env, identity, email, nowSeconds),
    ),
  };
}

function verifiedEmailBindingBytes(
  env: AppSessionEnvironment,
  identity: AuthenticatedConnection,
  email: string,
  verifiedAt: number,
): Promise<Uint8Array> {
  return hmacSha256(
    env,
    JSON.stringify([
      "app-session-verified-email:v1",
      "oidc",
      identity.metadata.principalNamespace,
      identity.principal,
      normalizeInviteEmail(email),
      verifiedAt,
    ]),
  );
}

function validIdentityProof(payload: CloudAppSessionPayload, nowSeconds: number): boolean {
  return (
    Number.isSafeInteger(payload.identity_verified_at) &&
    payload.identity_verified_at !== undefined &&
    payload.identity_verified_at > 0 &&
    payload.identity_verified_at <= payload.iat &&
    payload.identity_verified_at <= nowSeconds &&
    typeof payload.verified_email_binding === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(payload.verified_email_binding)
  );
}

async function signCloudAppSession(
  env: AppSessionEnvironment,
  payload: CloudAppSessionPayload,
): Promise<string> {
  const encodedPayload = base64UrlEncodeString(JSON.stringify(payload));
  const signature = await hmacSha256(env, encodedPayload);
  return `${encodedPayload}.${base64UrlEncodeBytes(signature)}`;
}

async function appSessionCacheKey(
  env: AppSessionEnvironment,
  payload: CloudAppSessionPayload,
): Promise<string> {
  const signature = await hmacSha256(
    env,
    [
      "app-session-cache:v1",
      payload.provider,
      payload.ns,
      payload.principal,
      String(payload.iat),
      String(payload.exp),
      payload.sid ?? "",
    ].join(":"),
  );
  return base64UrlEncodeBytes(signature);
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

function appSessionDisplayName(value: string | undefined): string | undefined {
  return value?.slice(0, NOTEBOOK_CLOUD_APP_SESSION_DISPLAY_NAME_MAX_LENGTH);
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
    (payload.sid === undefined || typeof payload.sid === "string") &&
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
