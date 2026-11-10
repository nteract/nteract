/** Kilo's device pairing, token refresh and profile endpoints, called from the
 * Worker.
 *
 * Two rules keep the credential Pages receives short-lived. The exchange
 * always sends `supportsRefresh`, so Kilo answers with a one-hour token and a
 * rotating refresh token; an approval without a refresh token is refused. And
 * the legacy poll secret Kilo also returns from a start is never read, stored
 * or returned: polling with it yields a token that lasts for years.
 *
 * The module holds no state and logs nothing. Each call takes the `fetch` to
 * use and Kilo's app URL. Error messages are fixed text, so a token, code or
 * response body can't reach a log through them. */

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
// Kilo's refreshable tokens last an hour. A longer one is the kind Kilo issues
// without `supportsRefresh`, which this module never accepts.
const MAX_TOKEN_SECONDS = 7200;

/** Kilo didn't answer, or answered 429 or 5xx. The same call may work later;
 * `retryAfterSeconds` is set when Kilo said how much later. */
export class KiloUnavailable extends Error {
  constructor(retryAfterSeconds) {
    super("Kilo is temporarily unavailable");
    this.name = "KiloUnavailable";
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Kilo answered with something this module doesn't accept: an unexpected
 * status, a redirect, a body over the limit, or a missing or malformed field. */
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

async function request(
  fetcher,
  appUrl,
  path,
  { method = "GET", body, token, forwardedFor, userAgent, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const base = baseUrl(appUrl);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new TypeError("timeoutMs must be positive");
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
      // Inspected, never followed: a credential stays at the configured origin.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  } catch {
    throw new KiloUnavailable();
  }
  const retryHeader = response.headers.get("retry-after");
  const retryAfterSeconds =
    retryHeader !== null && /^\d+(?:\.\d+)?$/.test(retryHeader) ? Number(retryHeader) : undefined;
  const unavailable = response.status === 429 || response.status >= 500;
  if (unavailable || (response.status >= 300 && response.status < 400)) {
    try {
      await response.body?.cancel();
    } catch {}
    throw unavailable ? new KiloUnavailable(retryAfterSeconds) : new KiloProtocolError();
  }
  const bytes = await readLimited(response);
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

/** Asks Kilo for a pairing that names `client` on its approval page.
 * `forwardedFor` is the address of the person signing in: Kilo limits pending
 * pairings per address, so without it every person shares the Worker's.
 * Returns the secret `deviceCode` to exchange, and the `userCode` and
 * `verificationUrl` to show the person. The URL is on `appUrl`'s origin and
 * carries that user code, or the answer is refused. */
export async function startKiloPairing(
  fetch,
  { appUrl, client, forwardedFor, userAgent, timeoutMs } = {},
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
    timeoutMs,
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

/** Asks whether the person has answered a pairing. `approved` comes once per
 * device code: Kilo consumes the code with that answer, and a later call
 * reads `expired`. Store the result before calling again. */
export async function exchangeKiloDeviceCode(fetch, { appUrl, deviceCode, timeoutMs } = {}) {
  const result = await request(fetch, appUrl, "/api/device-auth/token", {
    method: "POST",
    body: { deviceCode, supportsRefresh: true },
    timeoutMs,
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
    data.expiresIn <= MAX_TOKEN_SECONDS &&
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

/** Trades a refresh token for a new token and a new refresh token. Kilo
 * retires the old refresh token with this call, and treats a later use of it
 * as theft, so a caller exchanges each one once and stores the answer.
 * `refused` names why Kilo ended the grant; signing in again is the only way
 * forward. */
export async function refreshKiloTokens(fetch, { appUrl, refreshToken, timeoutMs } = {}) {
  const result = await request(fetch, appUrl, "/api/auth/native/refresh", {
    method: "POST",
    body: { refreshToken },
    timeoutMs,
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
    !positive(data.expiresIn) ||
    data.expiresIn > MAX_TOKEN_SECONDS
  )
    throw new KiloProtocolError();
  return { token: data.token, refreshToken: data.refreshToken, expiresInSeconds: data.expiresIn };
}

/** Who a token belongs to, and the organizations they are in. `refused` means
 * Kilo no longer accepts the token. `name` is null when the account has none.
 * Nothing here says the email address was verified. */
export async function readKiloProfile(fetch, { appUrl, token, timeoutMs } = {}) {
  const result = await request(fetch, appUrl, "/api/profile", { token, timeoutMs });
  if (result.status === 401 || result.status === 403) return { refused: true };
  const data = expectStatus(result, 200);
  if (
    !object(data) ||
    !object(data.user) ||
    ![data.user.id, data.user.email].every(nonempty) ||
    !(data.user.name == null || typeof data.user.name === "string") ||
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
    name: data.user.name || null,
    organizations: (data.organizations ?? []).map(({ id, name, role }) => ({ id, name, role })),
  };
}
