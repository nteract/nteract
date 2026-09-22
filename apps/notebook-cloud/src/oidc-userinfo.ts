import { normalizeInviteEmail } from "./sharing.ts";

export interface OidcUserInfo {
  sub: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  preferred_username?: string;
  picture?: string;
  email?: string;
  email_verified?: boolean;
}

export class OidcUserInfoError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 503 = 503,
  ) {
    super(message);
    this.name = "OidcUserInfoError";
  }
}

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 256;
const FETCH_TIMEOUT_MS = 5_000;
const RESPONSE_MAX_BYTES = 16 * 1024;
const cache = new Map<string, { expiresAt: number; ready: Promise<OidcUserInfo> }>();

/** Called only after JWT signature, issuer, audience, client, and lifetime verification. */
export async function loadOidcUserInfo(input: {
  token: string;
  endpoint: string;
  subject: string;
  expiresAt: number;
  cacheScope: string;
}): Promise<OidcUserInfo> {
  if (!Number.isFinite(input.expiresAt) || input.expiresAt <= Date.now()) {
    throw new OidcUserInfoError("OIDC access token is expired", 401);
  }
  // Cache identity includes the token and verified provider configuration, but
  // neither the cache key nor its resolved value retains the bearer credential.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([input.cacheScope, input.endpoint, input.token])),
  );
  const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.ready;

  for (const [entryKey, entry] of cache) {
    if (entry.expiresAt <= Date.now()) cache.delete(entryKey);
  }
  while (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  const ready = fetchUserInfo(input).catch((error: unknown) => {
    if (cache.get(key)?.ready === ready) cache.delete(key);
    throw error;
  });
  cache.set(key, { expiresAt: Math.min(Date.now() + CACHE_TTL_MS, input.expiresAt), ready });
  return ready;
}

async function fetchUserInfo(input: {
  token: string;
  endpoint: string;
  subject: string;
  expiresAt: number;
}): Promise<OidcUserInfo> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new OidcUserInfoError("OIDC UserInfo request timed out"));
    }, FETCH_TIMEOUT_MS);
  });
  const request = async () => {
    const fetchProfile = (method: "GET" | "POST") =>
      fetch(input.endpoint, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${input.token}`,
          "User-Agent": "nteract-notebook-cloud/1.0",
        },
        // Reject redirects explicitly; never forward this bearer token elsewhere.
        redirect: "manual",
        signal: controller.signal,
      });
    let response = await fetchProfile("POST");
    // Keep compatibility with POST-only providers. Retry only when the same
    // endpoint explicitly allows GET, within the original request deadline.
    if (
      response.status === 405 &&
      response.headers
        .get("allow")
        ?.split(",")
        .some((method) => method.trim().toUpperCase() === "GET")
    ) {
      void response.body?.cancel().catch(() => {});
      response = await fetchProfile("GET");
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new OidcUserInfoError(
        "OIDC UserInfo request failed",
        response.status === 401 || response.status === 403 ? 401 : 503,
      );
    }
    const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (type !== "application/json") {
      void response.body?.cancel().catch(() => {});
      throw new OidcUserInfoError("OIDC UserInfo response must be JSON");
    }
    const profile = parseUserInfo(
      await readBoundedBody(response, controller.signal),
      input.subject,
    );
    if (input.expiresAt <= Date.now())
      throw new OidcUserInfoError("OIDC access token is expired", 401);
    return profile;
  };
  try {
    return await Promise.race([request(), timeout]);
  } catch (error) {
    if (error instanceof OidcUserInfoError) throw error;
    // Do not surface provider bodies, bearer tokens, or fetch error URLs in logs.
    throw new OidcUserInfoError("OIDC UserInfo request failed");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new OidcUserInfoError("OIDC UserInfo response is empty");
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_MAX_BYTES)
        throw new OidcUserInfoError("OIDC UserInfo response is too large");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

function parseUserInfo(body: string, subject: string): OidcUserInfo {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new OidcUserInfoError("OIDC UserInfo response is invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OidcUserInfoError("OIDC UserInfo response is invalid");
  }
  const claims = value as Record<string, unknown>;
  if (claims.sub !== subject) throw new OidcUserInfoError("OIDC UserInfo subject is invalid", 401);
  const profile: OidcUserInfo = { sub: subject };
  for (const field of [
    "name",
    "given_name",
    "family_name",
    "preferred_username",
    "picture",
    "email",
  ] as const) {
    const claim = claims[field];
    if (claim === undefined) continue;
    const limit = field === "picture" ? 2048 : field === "email" ? 320 : 256;
    if (
      typeof claim !== "string" ||
      claim.length > limit ||
      Array.from(claim).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    ) {
      throw new OidcUserInfoError("OIDC UserInfo profile claim is invalid");
    }
    if (claim.trim()) profile[field] = claim.trim();
  }
  if (claims.email_verified !== undefined && typeof claims.email_verified !== "boolean") {
    throw new OidcUserInfoError("OIDC UserInfo email verification claim is invalid");
  }
  if (profile.email) {
    try {
      normalizeInviteEmail(profile.email);
    } catch {
      throw new OidcUserInfoError("OIDC UserInfo email is invalid");
    }
    profile.email_verified = claims.email_verified === true;
  }
  if (profile.picture) {
    let picture: URL;
    try {
      picture = new URL(profile.picture);
    } catch {
      throw new OidcUserInfoError("OIDC UserInfo picture is invalid");
    }
    if (picture.protocol !== "https:" || picture.username || picture.password) {
      throw new OidcUserInfoError("OIDC UserInfo picture is invalid");
    }
  }
  return profile;
}
