// Local development API keys: a bearer credential a script or coding agent can
// send to a local `npm run dev` server, which has no identity-provider account service
// to check a real key against.
//
// A key stands for the one account the loopback issuer signs in
// (`dev@localhost`), so it names the same principal as a browser session on
// that server and sees the same Pages.
//
// The key is stateless: `pdk1.<payload>.<signature>`, where the payload is the
// scope and expiry and the signature is an HMAC under the server's own session
// secret. No table holds it, so there is nothing to migrate, and a restart
// keeps every key valid. Each key ends at its expiry; changing
// NOTEBOOK_CLOUD_APP_SESSION_SECRET (or deleting `dist/.dev.vars`) ends them
// all.
//
// Everything here is off unless `localDevKeysEnabled(env)`, and a deployment
// build refuses the LOCAL_OIDC variable it depends on
// (scripts/cloudflare-stage.mjs).
import { isLoopbackHostname, localDevKeysEnabled } from "../identity-provider.mjs";

/** A refusal with the HTTP status and code the caller answers with. A plain
 * Error, not auth.mjs's LocalApiKeyError: auth.mjs imports this module. */
export class LocalApiKeyError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = "LocalApiKeyError";
    this.status = status;
    this.code = code;
  }
}

/** What `Authorization: Bearer` carries first. Neither `pages_` (an OAuth
 * grant) nor `pu1.` (an upload capability), and never JWT-shaped. */
export const LOCAL_API_KEY_PREFIX = "pdk1.";

/** The loopback issuer's first user (`DEV_USERS` in notebook-cloud
 * dev-oidc.ts). Its `sub` is the email, as the cookie session's principal
 * shows: `<namespace>:dev%40localhost`. */
const LOCAL_DEV_SUBJECT = "dev@localhost";
const LOCAL_DEV_NAME = "Local Developer";

export const LOCAL_API_KEY_SCOPES = Object.freeze(["editor", "viewer"]);
export const LOCAL_API_KEY_DEFAULT_DAYS = 30;
export const LOCAL_API_KEY_MAX_DAYS = 365;

/** The header a mint request must carry. A browser page on another origin
 * can't add it without a CORS preflight, which this server never answers. */
export const LOCAL_API_KEY_HEADER = "x-pages-dev";

const DAY_MS = 86_400_000;
const SIGNING_LABEL = "pages-local-api-key.v1.";
const utf8 = new TextEncoder();

export const isLocalApiKey = (token) =>
  typeof token === "string" && token.startsWith(LOCAL_API_KEY_PREFIX);

const base64url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

// Null for text that is not base64url.
function fromBase64url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function signingKey(env, usage) {
  const secret = env.NOTEBOOK_CLOUD_APP_SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error("Local API keys need the session secret");
  return crypto.subtle.importKey(
    "raw",
    utf8.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

const signed = (payload) => utf8.encode(SIGNING_LABEL + payload);

/** The principal a local key stands for, the same string the cookie session
 * of the loopback issuer's first user has. */
export const localDevPrincipal = (env) =>
  `${env.NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE.trim()}:${encodeURIComponent(LOCAL_DEV_SUBJECT)}`;

/** A new key for `scope`, valid for `days` from `now`. Throws an LocalApiKeyError for
 * a scope or lifetime it doesn't take. */
export async function mintLocalApiKey(env, { scope = "editor", days } = {}, now = Date.now()) {
  if (!LOCAL_API_KEY_SCOPES.includes(scope))
    throw new LocalApiKeyError(400, "scope is editor or viewer", "invalid_arguments");
  const lifetime = days === undefined ? LOCAL_API_KEY_DEFAULT_DAYS : days;
  if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > LOCAL_API_KEY_MAX_DAYS)
    throw new LocalApiKeyError(
      400,
      `days is a whole number from 1 to ${LOCAL_API_KEY_MAX_DAYS}`,
      "invalid_arguments",
    );
  const expiresAt = Math.floor((now + lifetime * DAY_MS) / 1000) * 1000;
  const payload = base64url(utf8.encode(JSON.stringify({ s: scope, e: expiresAt })));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(env, "sign"),
    signed(payload),
  );
  return {
    key: `${LOCAL_API_KEY_PREFIX}${payload}.${base64url(new Uint8Array(signature))}`,
    scope,
    expiresAt,
  };
}

/** The scope and expiry a key carries, or null when it isn't one this server
 * signed or has expired at `now`. */
export async function readLocalApiKey(env, token, now = Date.now()) {
  if (!isLocalApiKey(token)) return null;
  const [payload, signature, ...extra] = token.slice(LOCAL_API_KEY_PREFIX.length).split(".");
  if (!payload || !signature || extra.length) return null;
  const given = fromBase64url(signature);
  const body = fromBase64url(payload);
  if (!given || !body) return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await signingKey(env, "verify"),
    given,
    signed(payload),
  );
  if (!valid) return null;
  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  if (!LOCAL_API_KEY_SCOPES.includes(claims?.s) || !Number.isFinite(claims.e) || claims.e <= now)
    return null;
  return { scope: claims.s, expiresAt: claims.e };
}

const refused = (message) => new LocalApiKeyError(401, message, "invalid_api_key");

/** The identity a local key stands for, in the shape `authenticate` returns
 * for a provider's API key. Throws 401 `invalid_api_key` for anything else. */
export async function localApiKeyIdentity(env, request, token, now = Date.now()) {
  // Two independent conditions, each enough to refuse: the server's own
  // configuration, and the host this request arrived on. A key sent through a
  // tunnel or proxy to a loopback-configured server is refused too.
  if (!localDevKeysEnabled(env) || !isLoopbackHostname(new URL(request.url).hostname))
    throw refused("Local development keys are accepted only by a local dev server");
  const key = await readLocalApiKey(env, token, now);
  if (!key)
    throw refused(
      "This local development key is invalid or expired. Mint a new one with POST /dev/api-key",
    );
  return {
    principal: localDevPrincipal(env),
    displayName: LOCAL_DEV_NAME,
    scope: key.scope,
    namespace: env.NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE.trim(),
    // The loopback issuer signs this address in as verified, so a key holds
    // the same email evidence as the cookie session: invitations, company
    // domain leases and quota rules resolve alike.
    verifiedEmail: LOCAL_DEV_SUBJECT,
    expiresAt: key.expiresAt,
  };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const failure = (error) => json({ error: error.message, code: error.code }, error.status);

/** `POST /dev/api-key`, or null for any other path. Mounted by the gateway
 * beside the loopback issuer, under the same loopback-host check.
 *
 * Any process on this machine can already sign in as the dev user, so the
 * endpoint grants nothing new. It still refuses a browser's cross-site request
 * and requires a header a cross-origin page can't send without a preflight. */
export async function handleLocalApiKeyRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== "/dev/api-key") return null;
  if (!localDevKeysEnabled(env) || !isLoopbackHostname(url.hostname)) return null;
  try {
    if (request.method !== "POST")
      throw new LocalApiKeyError(405, "Use POST", "method_not_allowed");
    const origin = request.headers.get("origin");
    if (
      (origin && origin !== new URL(env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN).origin) ||
      request.headers.get("sec-fetch-site") === "cross-site" ||
      !request.headers.has(LOCAL_API_KEY_HEADER)
    )
      throw new LocalApiKeyError(
        403,
        "Send X-Pages-Dev: 1 from a script, not from a web page",
        "access_denied",
      );
    let options = {};
    const text = await request.text();
    if (text.trim()) {
      try {
        options = JSON.parse(text);
      } catch {
        throw new LocalApiKeyError(400, "The body must be JSON", "invalid_arguments");
      }
      if (!options || typeof options !== "object" || Array.isArray(options))
        throw new LocalApiKeyError(400, "The body must be a JSON object", "invalid_arguments");
      for (const name of Object.keys(options))
        if (!["scope", "days"].includes(name))
          throw new LocalApiKeyError(
            400,
            `${name.slice(0, 64)} is not an argument`,
            "invalid_arguments",
          );
    }
    const minted = await mintLocalApiKey(env, options);
    return json({
      key: minted.key,
      scope: minted.scope,
      expires_at: new Date(minted.expiresAt).toISOString(),
      principal: localDevPrincipal(env),
    });
  } catch (error) {
    if (error instanceof LocalApiKeyError) return failure(error);
    throw error;
  }
}
