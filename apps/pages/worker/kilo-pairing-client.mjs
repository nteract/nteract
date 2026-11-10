/** Server-side client for Kilo device pairing and profile endpoints.
 * The legacy poll secret is never used, and `supportsRefresh` is always sent. */

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export class KiloUnavailable extends Error {
  constructor(retryAfterSeconds) {
    super("Kilo is temporarily unavailable");
    this.name = "KiloUnavailable";
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class KiloProtocolError extends Error {
  constructor() {
    super("Kilo returned an invalid response");
    this.name = "KiloProtocolError";
  }
}

function baseUrl(appUrl) {
  let url;
  try {
    url = new URL(appUrl);
  } catch {
    throw new TypeError("appUrl must be an allowed origin");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("appUrl must be an allowed origin");
  }
  return url;
}

function timeoutMs(options) {
  const value = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) throw new TypeError("timeoutMs must be positive");
  return value;
}

async function request(
  fetcher,
  appUrl,
  path,
  { method = "GET", body, token, forwardedFor, userAgent, timeout } = {},
) {
  const base = baseUrl(appUrl);
  const headers = new Headers({ accept: "application/json" });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  if (forwardedFor !== undefined) headers.set("x-forwarded-for", forwardedFor);
  if (userAgent !== undefined) headers.set("user-agent", userAgent);
  let response;
  try {
    response = await fetcher(new URL(path, base), {
      method,
      headers,
      redirect: "manual",
      credentials: "omit",
      signal: AbortSignal.timeout(timeout ?? DEFAULT_TIMEOUT_MS),
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  } catch {
    throw new KiloUnavailable();
  }
  const retryHeader = response.headers.get("retry-after");
  const retryAfterSeconds =
    retryHeader !== null && /^\d+(?:\.\d+)?$/.test(retryHeader) ? Number(retryHeader) : undefined;
  if (response.status === 429 || response.status >= 500) {
    try {
      await response.body?.cancel();
    } catch {}
    throw new KiloUnavailable(retryAfterSeconds);
  }
  const bytes = await readLimited(response);
  if (response.status >= 300 && response.status < 400) throw new KiloProtocolError();
  let data;
  if (bytes.length) {
    try {
      data = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new KiloProtocolError();
    }
  }
  return { status: response.status, data };
}

async function readLimited(response) {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    try {
      await response.body?.cancel();
    } catch {}
    throw new KiloProtocolError();
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new KiloProtocolError();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof KiloProtocolError) throw error;
    throw new KiloProtocolError();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value) => typeof value === "string" && value.length > 0;
const positive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
function expectStatus(result, status) {
  if (result.status !== status) throw new KiloProtocolError();
  return result.data;
}

export async function startKiloPairing(
  fetch,
  { appUrl, client, forwardedFor, userAgent, timeoutMs: timeout } = {},
) {
  const base = baseUrl(appUrl);
  if (
    !object(client) ||
    ![client.id, client.name, client.redirectOrigin].every(
      (v) => typeof v === "string" && v.length >= 1 && v.length <= 200,
    )
  ) {
    throw new TypeError("client fields must be 1 to 200 characters");
  }
  let redirect;
  try {
    redirect = new URL(client.redirectOrigin);
  } catch {
    throw new TypeError("redirectOrigin must be an origin");
  }
  if (
    redirect.origin !== client.redirectOrigin ||
    redirect.pathname !== "/" ||
    redirect.search ||
    redirect.hash
  ) {
    throw new TypeError("redirectOrigin must be a bare origin");
  }
  const result = await request(fetch, appUrl, "/api/device-auth/codes", {
    method: "POST",
    body: {
      requesting_client: {
        client_id: client.id,
        client_name: client.name,
        redirect_origin: client.redirectOrigin,
      },
    },
    forwardedFor,
    userAgent,
    timeout: timeoutMs({ timeoutMs: timeout }),
  });
  const data = expectStatus(result, 200);
  if (
    !object(data) ||
    !nonempty(data.device_code) ||
    !nonempty(data.user_code) ||
    !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(data.user_code) ||
    !positive(data.expiresIn) ||
    !object(data.requestingClient) ||
    data.requestingClient.clientId !== client.id ||
    data.requestingClient.redirectOrigin !== client.redirectOrigin ||
    !nonempty(data.requestingClient.clientName)
  ) {
    throw new KiloProtocolError();
  }
  let verification;
  try {
    verification = new URL(data.verificationUrl);
  } catch {
    throw new KiloProtocolError();
  }
  if (
    verification.origin !== base.origin ||
    verification.pathname !== "/device-auth" ||
    verification.searchParams.get("code") !== data.user_code
  ) {
    throw new KiloProtocolError();
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl: verification.href,
    expiresInSeconds: Math.min(data.expiresIn, 900),
  };
}

export async function exchangeKiloDeviceCode(
  fetch,
  { appUrl, deviceCode, timeoutMs: timeout } = {},
) {
  const result = await request(fetch, appUrl, "/api/device-auth/token", {
    method: "POST",
    body: { deviceCode, supportsRefresh: true },
    timeout: timeoutMs({ timeoutMs: timeout }),
  });
  const data = result.data;
  if (result.status === 202 && object(data) && data.status === "pending")
    return { status: "pending" };
  if (result.status === 403 && object(data) && data.status === "denied")
    return { status: "denied" };
  if (result.status === 410 && object(data) && data.status === "expired")
    return { status: "expired" };
  if (
    result.status === 200 &&
    object(data) &&
    data.status === "approved" &&
    nonempty(data.token) &&
    nonempty(data.refreshToken) &&
    positive(data.expiresIn) &&
    data.expiresIn <= 7200 &&
    nonempty(data.userId) &&
    nonempty(data.userEmail)
  ) {
    return {
      status: "approved",
      token: data.token,
      refreshToken: data.refreshToken,
      expiresInSeconds: data.expiresIn,
      userId: data.userId,
      userEmail: data.userEmail,
    };
  }
  throw new KiloProtocolError();
}

export async function refreshKiloTokens(fetch, { appUrl, refreshToken, timeoutMs: timeout } = {}) {
  const result = await request(fetch, appUrl, "/api/auth/native/refresh", {
    method: "POST",
    body: { refreshToken },
    timeout: timeoutMs({ timeoutMs: timeout }),
  });
  if (
    result.status === 401 &&
    object(result.data) &&
    ["INVALID_REFRESH_TOKEN", "SESSION_REVOKED", "USER_BLOCKED"].includes(result.data.error)
  ) {
    return { refused: result.data.error };
  }
  const data = expectStatus(result, 200);
  if (
    !object(data) ||
    !nonempty(data.token) ||
    !nonempty(data.refreshToken) ||
    !positive(data.expiresIn)
  )
    throw new KiloProtocolError();
  return { token: data.token, refreshToken: data.refreshToken, expiresInSeconds: data.expiresIn };
}

export async function readKiloProfile(fetch, { appUrl, token, timeoutMs: timeout } = {}) {
  const result = await request(fetch, appUrl, "/api/profile", {
    token,
    timeout: timeoutMs({ timeoutMs: timeout }),
  });
  if (result.status === 401 || result.status === 403) return { refused: true };
  const data = expectStatus(result, 200);
  if (
    !object(data) ||
    !object(data.user) ||
    ![data.user.id, data.user.email, data.user.name].every(nonempty) ||
    !Array.isArray(data.organizations ?? []) ||
    !(data.organizations ?? []).every(
      (org) => object(org) && [org.id, org.name, org.role].every(nonempty),
    )
  ) {
    throw new KiloProtocolError();
  }
  return {
    id: data.user.id,
    email: data.user.email,
    name: data.user.name,
    organizations: data.organizations ?? [],
  };
}
