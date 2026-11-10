/** What Pages asks of Kilo's web app to sign a person in: one page to send the
 * browser to, and one server-to-server call that trades the code Kilo sends
 * back for the person it names.
 *
 * This file is the whole of that contract. Kilo allows a fixed list of Pages
 * origins and redirects only to `KILO_CALLBACK_PATH` on one of them, so it
 * never receives or trusts a path. Its code is signed, short lived and bound
 * to the origin and `state` it was minted for; it is not single use, so the
 * exchange sends both back. The answer is identity only: Pages is never given
 * a Kilo API token.
 *
 * The module holds no state and logs nothing. Error messages are fixed text,
 * so a code, a secret or a response body can't reach a log through them. */

/** Where Pages sends a browser to sign in. Kilo checks its own session there. */
export const KILO_ENTER_PATH = "/pages-auth";
/** Where Kilo sends the browser back, on the Pages origin it was given. */
export const KILO_CALLBACK_PATH = "/api/auth/kilo/callback";
/** Where Pages trades a code for the person it names. */
export const KILO_EXCHANGE_PATH = "/api/pages-auth/exchange";

const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ID_LENGTH = 255;
const MAX_NAME_LENGTH = 200;

/** Kilo didn't answer, or answered 429 or 5xx. Signing in again may work. */
export class KiloUnavailable extends Error {
  constructor() {
    super("Kilo is temporarily unavailable");
    this.name = "KiloUnavailable";
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

/** The URL that starts a sign-in at Kilo. `origin` is this Pages site, which
 * Kilo checks against its list; `state` comes back unchanged on the callback. */
export function kiloEnterUrl(appUrl, { origin, state }) {
  const url = new URL(KILO_ENTER_PATH, appUrl);
  url.search = new URLSearchParams({ origin, state }).toString();
  return url.href;
}

async function readLimited(response) {
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
        // Whether or not the stream lets go, the answer is over the limit.
        try {
          await reader.cancel();
        } catch {}
        throw new KiloProtocolError();
      }
      chunks.push(value);
    }
  } catch (error) {
    // A body over the limit is Kilo's answer and is refused as one. A body
    // that stalls or breaks off is the network's.
    if (error instanceof KiloProtocolError) throw error;
    throw new KiloUnavailable();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const discard = async (response) => {
  try {
    await response.body?.cancel();
  } catch {}
};

/** Trades a sign-in code for the person it names.
 *
 * `secret` proves the call comes from this Pages deployment. `origin` and
 * `state` must be the ones the sign-in started with: Kilo's code is good only
 * for them, which is what makes a code copied out of a browser useless.
 *
 * Returns `{ id, name }`, with `name` null when the account has none, or
 * `{ refused }` when Kilo turned the call down: `"client"` for a 401, which
 * means it didn't accept this deployment's secret or origin; `"account"` for
 * a 403, which means the account is gone or blocked; and `"code"` for any
 * other 4xx, which means the code is forged, stale, or for another sign-in.
 * A refusal is its status, whatever its body holds. Throws `KiloUnavailable`
 * or `KiloProtocolError` otherwise. */
export async function exchangeKiloCode(
  fetcher,
  { appUrl, secret, code, origin, state, timeoutMs = DEFAULT_TIMEOUT_MS },
) {
  let response;
  try {
    response = await fetcher(new URL(KILO_EXCHANGE_PATH, appUrl), {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ code, origin, state }),
      // Inspected, never followed: the secret stays at the configured origin.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new KiloUnavailable();
  }
  const { status } = response;
  if (status === 429 || status >= 500) {
    await discard(response);
    throw new KiloUnavailable();
  }
  if (status >= 400) {
    await discard(response);
    return { refused: status === 401 ? "client" : status === 403 ? "account" : "code" };
  }
  if (status !== 200) {
    await discard(response);
    throw new KiloProtocolError();
  }
  let user;
  try {
    user = JSON.parse(new TextDecoder().decode(await readLimited(response)))?.user;
  } catch (error) {
    if (error instanceof KiloUnavailable) throw error;
    throw new KiloProtocolError();
  }
  const id = user?.id;
  if (typeof id !== "string" || !id || id.length > MAX_ID_LENGTH || id !== id.trim())
    throw new KiloProtocolError();
  const name = typeof user.name === "string" ? user.name.trim().slice(0, MAX_NAME_LENGTH) : "";
  return { id, name: name || null };
}
