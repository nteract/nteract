/** A token Kilo mints for one of its agents, presented to Pages as
 * `Authorization: Bearer <token>`.
 *
 * Kilo signs the token with a key Pages never holds, binds it to this
 * deployment's audience and gives it a few minutes of life. Pages can't check
 * it, so it asks Kilo: the same server-to-server exchange the browser
 * sign-in uses (kilo-exchange.mjs), with the token in place of a code. Kilo's
 * answer is the person, and the identity built from it is the one the browser
 * sign-in builds (kilo-config.mjs).
 *
 * Which bearer is a Kilo token is decided from its unverified claims: a JWT
 * whose `aud` is this deployment's audience and whose `tokenPurpose` is
 * `delegated-workload`. Those claims choose the check and never become
 * identity. Every other bearer, and every bearer on a deployment without Kilo
 * sign-in, is left to the paths in auth.mjs.
 *
 * A token Kilo accepted is leased in this isolate (kilo-token-lease.mjs) until
 * its own `exp` less a clock allowance, for no longer than its own lifetime
 * from the exchange and never longer than `MAX_LEASE_MS`; `iat` and `exp`
 * are read only after Kilo accepted it. A token Kilo accepted that gets no
 * lease still authorizes its own request. An account Kilo blocks keeps
 * working here until its lease ends. Only Kilo's explicit refusal of a token
 * is kept for repeats of it (`REMEMBER_REFUSAL_MS`); any other answer is a
 * retryable 503 and is never kept. A
 * bounded number of exchanges run at once and a bounded number of tokens is
 * kept, so tokens nobody has seen can't crowd out tokens in use: past either
 * bound a new token gets 503 `sign_in_unavailable` without an exchange.
 *
 * The token is sent to Kilo's exchange and nowhere else. It is never logged,
 * stored or put in an error; the lease is keyed by its SHA-256. Errors carry
 * fixed text only. */
import { withAdmissionReason } from "./admission-reasons.mjs";
import { logAuthEvent } from "./auth-events.mjs";
import { kiloIdentity, kiloSignIn } from "./kilo-config.mjs";
import { exchangeKiloToken, KiloProtocolError, KiloUnavailable } from "./kilo-exchange.mjs";
import { kiloTokenLease, leaseEnd } from "./kilo-token-lease.mjs";

/** The `tokenPurpose` Kilo gives a token minted for an agent. */
export const KILO_TOKEN_PURPOSE = "delegated-workload";
/** The longest token Kilo mints. A longer bearer is not a Kilo token. */
export const MAX_KILO_TOKEN_LENGTH = 4096;
const JWT = /^[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/;

/** How long Kilo's refusal of a token answers repeats of it without an
 * exchange: an invalid token can't become valid, and an account Kilo blocks
 * is asked about again soon. Nothing else Kilo answers is kept. */
export const REMEMBER_REFUSAL_MS = Object.freeze({
  invalid_kilo_token: 5 * 60 * 1000,
  account_unavailable: 30 * 1000,
});

/** How long the identity of a request whose token Kilo accepted but Pages
 * doesn't lease stays valid, from Kilo's answer. The token isn't kept: the
 * next request exchanges it again. */
export const UNLEASED_VALIDITY_MS = 30 * 1000;

// One request waits at most this long, past the exchange's own 10 s timeout,
// so a waiter can still use an answer that comes in just in time.
const lease = kiloTokenLease({
  holdMs: 15_000,
  busy: (reason) => unavailable(reason),
  rememberFor: (failure) => REMEMBER_REFUSAL_MS[failure?.code] ?? 0,
});

/** The claims of a JWT, read without checking its signature, or null for a
 * bearer that isn't a JWT with a JSON object payload. Never throws. */
export function unverifiedClaims(token) {
  if (typeof token !== "string" || token.length > MAX_KILO_TOKEN_LENGTH) return null;
  const match = JWT.exec(token);
  if (!match) return null;
  try {
    const text = atob(match[1].replaceAll("-", "+").replaceAll("_", "/"));
    const claims = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(text, (char) => char.charCodeAt(0)),
      ),
    );
    return claims && typeof claims === "object" && !Array.isArray(claims) ? claims : null;
  } catch {
    return null;
  }
}

/** This deployment's Kilo settings and the token's unverified claims when
 * `token` is a Kilo agent token minted for this deployment, or null. A
 * deployment without Kilo sign-in reads no claims. */
export function kiloToken(env, request, token) {
  if (!env?.PAGES_KILO_APP_URL) return null;
  const claims = unverifiedClaims(token);
  if (claims?.tokenPurpose !== KILO_TOKEN_PURPOSE || typeof claims.aud !== "string") return null;
  const config = kiloSignIn(env, request);
  if (!config || claims.aud !== config.audience) return null;
  return { config, claims };
}

const unavailable = (reason) => {
  void logAuthEvent({ action: "kilo_token.refused", credential: "kilo-token", reason });
  return withAdmissionReason(
    Object.assign(new Error("Kilo sign-in is unavailable. Retry the request."), {
      status: 503,
      code: "sign_in_unavailable",
      retryable: true,
    }),
    "credential_unverified",
  );
};

const refused = (status, code, message, reason) => {
  void logAuthEvent({ action: "kilo_token.refused", credential: "kilo-token", reason });
  return withAdmissionReason(
    Object.assign(new Error(message), { status, code }),
    "credential_invalid",
  );
};

async function digest(text) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The Kilo account `token` names, as `{ id, name, organizations,
 * verifiedAt, until }`, where `verifiedAt` is when the exchange was sent and `until` is
 * when this request's identity stops being valid: the end of the isolate's
 * lease, or `UNLEASED_VALIDITY_MS` after Kilo answered when there is no
 * lease. Throws a coded error when Kilo
 * refuses it (401 `invalid_kilo_token`, 403 `account_unavailable`) or can't
 * answer (503 `sign_in_unavailable`, retryable). */
export async function kiloTokenAccount({ config, claims }, token) {
  const key = await digest(`${config.appUrl}\u0000${config.audience}\u0000${token}`);
  return lease.resolve(key, async () => {
    const sentAt = Date.now();
    let answer;
    try {
      answer = await exchangeKiloToken(fetch, {
        appUrl: config.appUrl,
        secret: config.secret,
        token,
        audience: config.audience,
      });
    } catch (error) {
      if (error instanceof KiloUnavailable) throw unavailable("kilo_unavailable");
      if (error instanceof KiloProtocolError) throw unavailable("kilo_protocol_error");
      throw unavailable("exchange_failed");
    }
    if (answer.refused === "client") throw unavailable("exchange_refused_client");
    if (answer.refused === "account")
      throw refused(
        403,
        "account_unavailable",
        "This Kilo account can't use Pages",
        "exchange_refused_account",
      );
    if (answer.refused === "token")
      throw refused(
        401,
        "invalid_kilo_token",
        "Kilo did not accept this token. Mint a new Kilo token for this Pages deployment and send it as Authorization: Bearer",
        "exchange_refused_token",
      );
    if (answer.refused) throw unavailable("kilo_protocol_error");
    const settledAt = Date.now();
    // How long the isolate keeps the token, possibly not at all, and how long
    // the identity this request carries is valid: Kilo accepted the token,
    // so it authorizes its own request either way.
    const until = leaseEnd(claims, { sentAt, settledAt });
    const value = Object.freeze({
      id: answer.id,
      name: answer.name,
      // What the exchange said about the account's organizations, and when
      // it was sent: the evidence auth.mjs records (kilo-membership.mjs).
      organizations: answer.organizations,
      verifiedAt: sentAt,
      until: until ?? settledAt + UNLEASED_VALIDITY_MS,
    });
    void logAuthEvent({
      action: "kilo_token.accepted",
      credential: "kilo-token",
      principal: kiloIdentity(config, answer).principal,
      organizations: answer.organizations.length,
    });
    return { value, until };
  });
}
