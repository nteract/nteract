/** What Pages asks of Kilo's web app to sign a person in: one page to send the
 * browser to, and one server-to-server call that trades the code Kilo sends
 * back, or a token Kilo minted for an agent, for the person it names.
 *
 * This file is the whole of that contract. Kilo keeps a fixed list of Pages
 * deployments, each under a name it calls an audience, and holds the address
 * of each one. Pages sends its audience and Kilo redirects only to
 * `KILO_CALLBACK_PATH` at the address it holds, so it never receives or trusts
 * an address or a path. Its code is signed, short lived and bound to the
 * audience and `state` it was minted for; it is not single use, so the
 * exchange sends both back. The answer is identity only: Pages is never given
 * a Kilo API token.
 *
 * That identity is the account's id, its name, and `verified_email`: the
 * account's primary address, which Kilo sends only when it holds proof the
 * account controls it. Pages reads it as the address an invitation can be
 * claimed with. It is optional, so an address Pages can't use as an
 * invitation address (inviteEmail in invite-email.mjs) is treated as absent
 * and the sign-in goes ahead without one: an optional field never locks a
 * person out. The rest of the answer, `organizations` included, is not read.
 *
 * The module holds no state and logs nothing. Error messages are fixed text,
 * so a code, a secret, an address or a response body can't reach a log
 * through them. */
import { inviteEmail } from "./invite-email.mjs";

/** Where Pages sends a browser to sign in. Kilo checks its own session there. */
export const KILO_ENTER_PATH = "/pages-auth";
/** Where Kilo sends the browser back, on the Pages site the audience names. */
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

/** The URL that starts a sign-in at Kilo. `audience` is Kilo's name for this
 * Pages deployment, which it checks against its list; `state` comes back
 * unchanged on the callback. */
export function kiloEnterUrl(appUrl, { audience, state }) {
  const url = new URL(KILO_ENTER_PATH, appUrl);
  url.search = new URLSearchParams({ audience, state }).toString();
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
 * `secret` proves the call comes from this Pages deployment. `audience` and
 * `state` must be the ones the sign-in started with: Kilo's code is good only
 * for them, which is what makes a code copied out of a browser useless.
 *
 * Returns `{ id, name, verifiedEmail }`, with `name` null when the account
 * has none and `verifiedEmail`, normalized as an invitation stores it, left
 * out when Kilo sent no usable address; or `{ refused }` when Kilo turned the
 * call down: `"client"` for a 401, which
 * means it didn't accept this deployment's secret or audience; `"account"` for
 * a 403, which means the account is gone or blocked; and `"code"` for any
 * other 4xx, which means the code is forged, stale, or for another sign-in.
 * A refusal is its status, whatever its body holds. Throws `KiloUnavailable`
 * or `KiloProtocolError` otherwise. */
export function exchangeKiloCode(
  fetcher,
  { appUrl, secret, code, audience, state, timeoutMs = DEFAULT_TIMEOUT_MS },
) {
  return exchange(fetcher, { appUrl, secret, body: { code, audience, state }, timeoutMs }, "code");
}

/** Trades a token Kilo minted for an agent for the person it names, at the
 * same endpoint as `exchangeKiloCode`. Kilo signs the token with a key Pages
 * doesn't hold and binds it to `audience`, so this call is the only check of
 * it.
 *
 * Returns `{ id, name, verifiedEmail }` as the code exchange does, or `{ refused }` only for
 * an answer that says what is wrong: `"token"` for a 400 whose `error` is
 * `invalid_token` (forged, expired, or for another deployment), `"account"`
 * for a 403 whose `error` is `account_unavailable`, and `"client"` for any
 * 401. A refusal of the token is kept by the caller, so any other 4xx, such
 * as `invalid_request` or a 404 while Kilo deploys, throws
 * `KiloProtocolError` and is never read as one. Kilo's body is read, within
 * the size limit, only to pick among these. */
export function exchangeKiloToken(
  fetcher,
  { appUrl, secret, token, audience, timeoutMs = DEFAULT_TIMEOUT_MS },
) {
  return exchange(fetcher, { appUrl, secret, body: { token, audience }, timeoutMs }, "token");
}

/** The token exchange's 4xx: a refusal Kilo named, or `KiloProtocolError`. */
async function tokenRefusal(response) {
  const { status } = response;
  if (status === 401) {
    await discard(response);
    return { refused: "client" };
  }
  if (status !== 400 && status !== 403) {
    await discard(response);
    throw new KiloProtocolError();
  }
  let error;
  try {
    error = JSON.parse(new TextDecoder().decode(await readLimited(response)))?.error;
  } catch (failure) {
    if (failure instanceof KiloUnavailable) throw failure;
    throw new KiloProtocolError();
  }
  if (status === 400 && error === "invalid_token") return { refused: "token" };
  if (status === 403 && error === "account_unavailable") return { refused: "account" };
  throw new KiloProtocolError();
}

async function exchange(fetcher, { appUrl, secret, body, timeoutMs }, credential) {
  let response;
  try {
    response = await fetcher(new URL(KILO_EXCHANGE_PATH, appUrl), {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
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
  if (status >= 400 && credential === "token") return tokenRefusal(response);
  if (status >= 400) {
    await discard(response);
    return { refused: status === 401 ? "client" : status === 403 ? "account" : credential };
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
  // Optional: a value that isn't a usable invitation address reads as no
  // address, never as a malformed answer.
  const verifiedEmail = inviteEmail(user.verified_email);
  return { id, name: name || null, ...(verifiedEmail && { verifiedEmail }) };
}
