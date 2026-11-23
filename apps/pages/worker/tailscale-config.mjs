/** A deployment's Tailscale sign-in settings, and the Pages identity a
 * Tailscale login stands for. The browser sign-in (tailscale-signin.mjs)
 * reads them here.
 *
 * Tailscale Serve proxies tailnet traffic to a service on the same machine
 * and adds `Tailscale-User-Login` and `Tailscale-User-Name` to each request.
 * It removes those headers when a client sends them, so behind Serve they
 * name the person whose tailnet device made the request. Nothing else
 * vouches for them: anything that reaches the Pages listener directly can
 * write them. A deployment that turns this on must therefore listen only on
 * loopback, with Serve as its one way in. Requests from tagged devices carry
 * no user headers and can't sign in this way.
 *
 * `PAGES_TAILSCALE_LOGINS` turns it on. It lists the Tailscale logins that
 * may sign in, comma-separated, and a login not on it is refused even when
 * Tailscale's own access rules let the request through: sharing the machine
 * with someone shouldn't also hand them a Pages account. */

/** The principal namespace Tailscale logins sign in under on this deployment. */
export const tailscalePrincipalNamespace = (env) =>
  env?.PAGES_TAILSCALE_PRINCIPAL_NAMESPACE?.trim() || "user:tailscale";

export const TAILSCALE_LOGIN_HEADER = "tailscale-user-login";
export const TAILSCALE_NAME_HEADER = "tailscale-user-name";

const MAX_LOGINS = 64;
const MAX_LOGIN_LENGTH = 256;
const MAX_NAME_LENGTH = 256;
// A login is one token: no whitespace, no comma (two header copies would
// join with one), and no control characters.
const LOGIN = /^[^\s,\p{Cc}]+$/u;
// An address a mail system could deliver to. Tailscale logins from GitHub or
// passkey accounts (`name@github`, `name@passkey`) have no dot after the @
// and are not addresses.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

// The longest principal a session or OAuth grant can store
// (@nteract/session checkedProviderGrant, oauth-store.mjs).
const MAX_PRINCIPAL_LENGTH = 512;

/** The logins in `value`, lower-cased and without repeats, or throws when
 * the list is empty, holds something that can't be a login, or names a login
 * whose principal in `namespace` would be too long to store. */
function allowedLogins(value, namespace) {
  const logins = String(value)
    .split(",")
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean);
  if (
    !logins.length ||
    logins.length > MAX_LOGINS ||
    logins.some(
      (login) =>
        login.length > MAX_LOGIN_LENGTH ||
        !LOGIN.test(login) ||
        tailscalePrincipal(namespace, login).length > MAX_PRINCIPAL_LENGTH,
    )
  )
    throw new Error("Tailscale sign-in is misconfigured");
  return Object.freeze([...new Set(logins)]);
}

/** This deployment's Tailscale sign-in settings, or null when it doesn't use
 * Tailscale. The public origin must be `https:`, as Serve's always is; a
 * loopback `http:` origin is accepted only beside the local test issuer flag.
 * A set but unusable value throws, and so does a deployment that also names
 * Kilo, so a misconfigured deployment fails loudly and never falls back to
 * another sign-in. */
export function tailscaleSignIn(env, request) {
  const configured = env?.PAGES_TAILSCALE_LOGINS;
  if (!configured) return null;
  if (env.PAGES_KILO_APP_URL) throw new Error("Tailscale sign-in is misconfigured");
  const namespace = tailscalePrincipalNamespace(env);
  const logins = allowedLogins(configured, namespace);
  let origin;
  try {
    origin = new URL(env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN || request.url);
  } catch {
    throw new Error("Tailscale sign-in is misconfigured");
  }
  const local = env.NOTEBOOK_CLOUD_LOCAL_OIDC === "true" && LOOPBACK.includes(origin.hostname);
  if (origin.protocol !== "https:" && !(local && origin.protocol === "http:"))
    throw new Error("Tailscale sign-in is misconfigured");
  return { origin: origin.origin, logins, namespace };
}

/** Whether `principal` may use a credential this deployment issued earlier,
 * such as an OAuth grant. True on a deployment that doesn't use Tailscale.
 * On one that does, only the principal of a login still on the list passes,
 * so taking a login off the list also cuts off the agents it connected. */
export function tailscalePrincipalAllowed(env, request, principal) {
  const config = tailscaleSignIn(env, request);
  if (!config) return true;
  return config.logins.some((login) => tailscalePrincipal(config.namespace, login) === principal);
}

/** Decodes RFC 2047 "Q" encoded words, which Tailscale uses for a name with
 * characters outside ASCII (`=?utf-8?q?Ferris_B=C3=BCller?=`). Whitespace
 * between two encoded words is dropped, as the RFC says. Returns null when an
 * encoded word isn't UTF-8 Q encoding or doesn't decode. */
export function decodeEncodedWords(value) {
  const WORD = /=\?([^?]+)\?([qQ])\?([^?]*)\?=/g;
  if (!value.includes("=?")) return value;
  let failed = false;
  const decoded = value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(WORD, (_, charset, _encoding, text) => {
      if (charset.toLowerCase() !== "utf-8") {
        failed = true;
        return "";
      }
      const bytes = [];
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === "_") bytes.push(0x20);
        else if (char === "=") {
          const hex = text.slice(i + 1, i + 3);
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
            failed = true;
            return "";
          }
          bytes.push(parseInt(hex, 16));
          i += 2;
        } else bytes.push(char.charCodeAt(0));
      }
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
      } catch {
        failed = true;
        return "";
      }
    });
  return failed ? null : decoded;
}

/** Who Serve says made `request`: `{ login, name }`, or `{ refused }` with
 * `missing` (no login header: not through Serve, or a tagged device),
 * `malformed`, or `not_allowed` (a login this deployment doesn't list). */
export function tailscaleRequester(config, request) {
  const raw = request.headers.get(TAILSCALE_LOGIN_HEADER);
  if (raw === null || raw === "") return { refused: "missing" };
  const login = raw.trim().toLowerCase();
  if (!login || login.length > MAX_LOGIN_LENGTH || !LOGIN.test(login))
    return { refused: "malformed" };
  if (!config.logins.includes(login)) return { refused: "not_allowed" };
  const header = request.headers.get(TAILSCALE_NAME_HEADER);
  const decoded = header ? decodeEncodedWords(header) : null;
  // Control and format characters (bidi overrides) never reach a display
  // name; the cut counts code points so it can't split a surrogate pair.
  const name =
    decoded && !/[\p{Cc}\p{Cf}]/u.test(decoded)
      ? Array.from(decoded.trim()).slice(0, MAX_NAME_LENGTH).join("")
      : "";
  return { login, name: name || login };
}

/** The principal a Tailscale login stands for in `namespace`. */
export const tailscalePrincipal = (namespace, login) => `${namespace}:${encodeURIComponent(login)}`;

/** The identity an allowed Tailscale login stands for. A login shaped like an
 * address is marked verified: the deployment's owner put that exact address
 * on the list, and Serve vouches that the request came from it. The session
 * then carries the signed email proof (app-session.ts), so the person can
 * claim a Page invitation sent to it. */
export function tailscaleIdentity(config, requester) {
  const principal = tailscalePrincipal(config.namespace, requester.login);
  return {
    principal,
    operator: "browser",
    actorLabel: `${principal}/browser`,
    scope: "owner",
    metadata: {
      // The session label every server session carries (app-session.ts).
      provider: "oidc",
      transport: "host-session-cookie",
      principalNamespace: config.namespace,
      displayName: requester.name,
      ...(EMAIL.test(requester.login) ? { email: requester.login, emailVerified: true } : {}),
    },
  };
}
