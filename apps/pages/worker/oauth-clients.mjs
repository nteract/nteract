/** Which OAuth clients may ask a person for access to `/mcp`, and what Pages
 * calls them.
 *
 * Two kinds of public client are admitted, both with PKCE and no secret:
 *
 * - A client Pages names itself: a fixed id with one exact callback.
 * - A client that names itself with a client ID metadata document: its id is
 *   an `https` URL, and the JSON document at that URL lists its callbacks.
 *   Admission proves only that the request names a callback the owner of that
 *   URL listed. A signed-in person still has to approve the consent screen,
 *   which shows the URL's host.
 *
 * Which documents are read is the deployment's choice. By default only the
 * document URLs in `CLIENT_NAMES` are: ChatGPT's and Claude's. With
 * `PAGES_OAUTH_ANY_CLIENT_DOCUMENT` set to "true", any `https` URL that passes
 * `metadataClientUrl` is, so anyone who can publish a document can ask. The
 * Worker checks how that URL's host is spelled, not where it resolves, so the
 * setting belongs only where outbound requests cannot reach a private
 * network (DEPLOYMENT.md, Outbound requests).
 *
 * There is no dynamic registration and no client secret. */

export const CHATGPT_CLIENT = "https://chatgpt.com/oauth/client.json";
// Codex publishes a distinct client metadata document with its loopback callback.
export const CODEX_CLIENT = "https://chatgpt.com/oauth/codex/client.json";
export const CHATGPT_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
export const KILO_REDIRECT = "http://127.0.0.1:19876/mcp/oauth/callback";

const LOCAL_TEST_CLIENT = "pages-local-e2e";
// The draft recommends reading at most 5 kilobytes of a metadata document.
const MAX_METADATA_BYTES = 5120;
const MAX_CLIENT_ID_LENGTH = 256;
const MAX_REDIRECT_URIS = 32;
const MAX_CACHED_CLIENTS = 64;
const MAX_METADATA_FETCHES = 16;
/** Mutable so tests can shorten them. `fetch` bounds one read of a metadata
 * document, headers and body. `wait` bounds how long a request waits for
 * another request's fetch of the same client id; `poll` is the interval of
 * its own timer. */
export const metadataFetchTimeouts = { fetch: 5000, wait: 10_000, poll: 5 };
// How long past its timeout a fetch still holds its client id. A fetch that
// never settles, because its request was dropped, frees the id after this.
const FETCH_HOLD_SLACK_MS = 1000;
// A driver label longer than this is refused elsewhere (auth.mjs driverLabel).
const MAX_DRIVER_LENGTH = 80;
// The IPv6 loopback literal is left out: a Content-Security-Policy source
// cannot name it, so the consent form could not be sent back to it.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
// Names that never belong to a public site: reserved for local networks,
// tests and other resolvers. A document host must not end in one.
const PRIVATE_SUFFIXES = new Set([
  "alt",
  "arpa",
  "corp",
  "home",
  "internal",
  "intranet",
  "invalid",
  "lan",
  "local",
  "localhost",
  "onion",
  "test",
]);
/** The client ids Pages recognizes, with their product names. A document URL
 * here is one Pages reads in every deployment; the document still lists the
 * callbacks. Where the deployment admits any client document, the table adds
 * nothing to admission and only names these clients: any other
 * metadata-document client is called by its host. */
const CLIENT_NAMES = new Map([
  ["pages-chatgpt", "ChatGPT"],
  [CHATGPT_CLIENT, "ChatGPT"],
  [CODEX_CLIENT, "Codex"],
  ["pages-kilo", "Kilo"],
  [LOCAL_TEST_CLIENT, "Local test client"],
  ["https://claude.ai/oauth/mcp-oauth-client-metadata", "Claude"],
  ["https://claude.ai/oauth/claude-code-client-metadata", "Claude Code"],
]);

/** A refusal an OAuth endpoint answers with: `error` is the OAuth error code. */
export class OAuthError extends Error {
  constructor(error, message, status = 400) {
    super(message);
    this.error = error;
    this.status = status;
  }
}

function publicHostname(hostname) {
  if (hostname.length > 253) return false;
  const labels = hostname.split(".");
  // The URL parser has already lowercased the host, encoded it as punycode and
  // rewritten every numeric form of an IPv4 address as dotted decimal, so an
  // alphabetic last label rules out IP literals. IPv6 literals have brackets.
  return (
    labels.length >= 2 &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
    /[a-z]/.test(labels.at(-1)) &&
    !PRIVATE_SUFFIXES.has(labels.at(-1))
  );
}

/** The URL of a client id that names a metadata document Pages will fetch, or
 * null. The id must already be in the form the URL parser writes, because it
 * is compared as a string with the document's own `client_id`: `https`, the
 * default port, a path, and no credentials, query, fragment or dot segments.
 * The host must be a public DNS name. `origin` is this deployment's public
 * origin: a document on the Pages host itself would pass as Pages. */
export function metadataClientUrl(clientId, origin) {
  if (typeof clientId !== "string" || clientId.length > MAX_CLIENT_ID_LENGTH) return null;
  let url;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (
    url.href !== clientId ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname === "/" ||
    /[?#]/.test(clientId) ||
    !publicHostname(url.hostname) ||
    (origin !== undefined && url.hostname === new URL(origin).hostname)
  )
    return null;
  return url;
}

/** Whether this deployment reads a metadata document from any `https` client
 * id, not only the ones in `CLIENT_NAMES`. Off unless the setting is exactly
 * "true". */
export function admitsAnyClientDocument(env) {
  return env?.PAGES_OAUTH_ANY_CLIENT_DOCUMENT === "true";
}

/** The URL of the metadata document this deployment reads for `clientId`, or
 * null when it admits no such client. */
export function admittedClientUrl(clientId, origin, env) {
  const url = metadataClientUrl(clientId, origin);
  return url && (CLIENT_NAMES.has(clientId) || admitsAnyClientDocument(env)) ? url : null;
}

/** The name a person knows a client by, in the account's "Connected agents"
 * list and wherever a stored grant is described. A metadata-document client
 * Pages has no name for is called by the host of its id, never by the name it
 * gives itself. */
export function oauthClientName(clientId) {
  return CLIENT_NAMES.get(clientId) ?? metadataClientUrl(clientId)?.hostname ?? "Unknown client";
}

/** The driver label for requests made with a grant, when the client sends
 * none of its own. */
export function oauthDriverName(clientId) {
  const name = clientId === LOCAL_TEST_CLIENT ? null : oauthClientName(clientId);
  return name && name !== "Unknown client" && name.length <= MAX_DRIVER_LENGTH ? name : "MCP";
}

/** The client id an auth event records: a recognized id in full, the host of
 * any other metadata-document id, or "unknown". A stranger chooses the rest of
 * such a URL, so it stays out of the log. */
export function loggedClientId(clientId) {
  if (clientId === undefined) return undefined;
  if (CLIENT_NAMES.has(clientId)) return clientId;
  return metadataClientUrl(clientId)?.hostname ?? "unknown";
}

/** A client Pages names itself, with its one exact callback, or null. */
export function namedClient(clientId, origin, env) {
  const named = (site, redirectUri) => ({
    id: clientId,
    name: CLIENT_NAMES.get(clientId),
    host: new URL(site).host,
    redirectUris: [redirectUri],
    named: true,
    known: true,
  });
  if (clientId === "pages-chatgpt") return named("https://chatgpt.com/", CHATGPT_REDIRECT);
  if (clientId === "pages-kilo") return named("https://kilo.ai/", KILO_REDIRECT);
  if (
    clientId === LOCAL_TEST_CLIENT &&
    env.PAGES_E2E_ONLY === "true" &&
    env.NOTEBOOK_CLOUD_LOCAL_OIDC === "true" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)
  )
    return named(origin, origin + "/oauth/test/callback");
  return null;
}

function redirectUrl(value) {
  if (typeof value !== "string" || !value || value.length > 2048 || value.includes("#"))
    return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // The consent page names the callback's origin and path in its
  // Content-Security-Policy. A path with a character that could end or extend
  // the policy (";", ",", a quote) is no callback at all.
  if (url.username || url.password || !/^[A-Za-z0-9._~%/+=@:-]*$/.test(url.pathname)) return null;
  if (url.protocol === "https:") return url;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) ? url : null;
}

/** Whether a callback is on the person's own computer, where any local
 * program can listen for it. */
export function loopbackRedirect(redirectUri) {
  return redirectUrl(redirectUri)?.protocol === "http:";
}

/** Whether `client` may be sent back to `redirectUri`. A callback is `https`
 * or loopback `http`, has a path a policy source can name, and must be one
 * the client lists, compared as a string.
 * The one exception is the port of a loopback callback (RFC 8252 section
 * 7.3): a native app binds whichever port is free, so its listed callback
 * matches on scheme, host, path and query alone. A metadata-document client
 * is never sent to the Pages hostname, on any port. The consent screen would
 * show a destination the person already trusts, and the browser would send
 * the Pages session cookie there: a cookie belongs to a hostname, not to a
 * port. That holds on a loopback origin too, where the callback would be
 * another program on the same computer (`loopbackNameClash`). */
export function redirectAllowed(client, redirectUri, origin) {
  if (client.named) return client.redirectUris.includes(redirectUri);
  const url = redirectUrl(redirectUri);
  if (!url || url.hostname === new URL(origin).hostname) return false;
  if (client.redirectUris.includes(redirectUri)) return true;
  if (url.protocol !== "http:") return false;
  return client.redirectUris.some((listed) => {
    const candidate = redirectUrl(listed);
    return (
      candidate?.protocol === "http:" &&
      candidate.hostname === url.hostname &&
      candidate.pathname === url.pathname &&
      candidate.search === url.search
    );
  });
}

/** The loopback name Pages is not using, when Pages runs on a loopback origin
 * and `redirectUri` is a callback on that origin's hostname; otherwise null.
 * `redirectAllowed` refuses such a callback. A local server reaches that
 * client by running under the other name, so the two do not share cookies. */
export function loopbackNameClash(redirectUri, origin) {
  const url = redirectUrl(redirectUri);
  const pages = new URL(origin);
  if (!url || pages.protocol !== "http:" || !LOOPBACK_HOSTS.has(pages.hostname)) return null;
  if (url.hostname !== pages.hostname) return null;
  return pages.hostname === "localhost" ? "127.0.0.1" : "localhost";
}

/** The `form-action` source for a validated callback. Chromium checks
 * `form-action` across the redirect that follows the consent form's POST, so
 * the consent page has to admit the callback it will be sent to. A policy
 * source cannot carry a query, so the policy matches the callback's origin
 * and path. A callback on the Pages origin needs no source beyond 'self'. */
export function formActionSource(redirectUri, origin) {
  const url = redirectUrl(redirectUri);
  if (!url || url.origin === new URL(origin).origin) return "";
  return url.origin + url.pathname;
}

function displayName(value) {
  // Control and format characters (bidirectional overrides, zero-width
  // joiners) could reorder or hide text beside the name on the consent screen.
  if (typeof value !== "string" || value.length > 128 || /[\p{Cc}\p{Cf}]/u.test(value)) return null;
  return value.trim() || null;
}

/** The client a fetched metadata document describes, or an `invalid_client`
 * refusal. The document must name the URL it was fetched from, list its
 * callbacks, and describe a public client using the authorization code flow.
 * `grant_types` and `response_types` default as RFC 7591 says when absent. */
export function clientFromMetadata(url, metadata) {
  const methods = metadata?.token_endpoint_auth_methods_supported;
  const declaredName = displayName(metadata?.client_name);
  const lists = (value, required) =>
    value === undefined || (Array.isArray(value) && value.includes(required));
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    metadata.client_id !== url.href ||
    !declaredName ||
    "client_secret" in metadata ||
    !Array.isArray(metadata.redirect_uris) ||
    !metadata.redirect_uris.length ||
    metadata.redirect_uris.length > MAX_REDIRECT_URIS ||
    metadata.redirect_uris.some((uri) => typeof uri !== "string") ||
    !lists(metadata.grant_types, "authorization_code") ||
    !lists(metadata.response_types, "code") ||
    // ChatGPT's document names a signed-assertion method first and lists
    // "none" among the methods it supports. Either form declares a client
    // that works without a secret.
    !(
      metadata.token_endpoint_auth_method === "none" ||
      (Array.isArray(methods) && methods.includes("none"))
    )
  )
    throw new OAuthError(
      "invalid_client",
      `The client information at ${url.hostname} does not describe a client Pages can connect.`,
    );
  const name = CLIENT_NAMES.get(url.href);
  return {
    id: url.href,
    name: name ?? url.hostname,
    host: url.host,
    // The document's own name for the client. The consent screen shows it as
    // a claim, and only for a client Pages has no name for.
    declaredName,
    redirectUris: metadata.redirect_uris,
    named: false,
    known: name !== undefined,
  };
}

/** A body's text, read up to `limit` bytes. A longer body is a RangeError.
 * When `signal` aborts, the read stops with the signal's reason, whether or
 * not the runtime ties the body to the signal that fetched it, and without
 * waiting for the body's cancellation to finish. */
export async function boundedText(body, limit, signal) {
  if (!body) return "";
  const reader = body.getReader();
  const aborted =
    signal &&
    new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  // Unobserved once the body has been read.
  aborted?.catch(() => {});
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await (aborted
        ? Promise.race([reader.read(), aborted])
        : reader.read());
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new RangeError("Body too large");
      chunks.push(value);
    }
  } catch (error) {
    await (aborted ? Promise.race([reader.cancel(), aborted]) : reader.cancel()).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** When a fetched document stops being fresh, in milliseconds: its max-age
 * less its age, capped at five minutes, or one minute when it names none.
 * Zero means do not keep it. */
function metadataFreshUntil(headers) {
  const directives = (headers.get("cache-control") ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase());
  if (directives.some((part) => /^(?:no-store|no-cache|private)(?:=|$)/.test(part))) return 0;
  const maxAges = directives.filter((part) => /^max-age(?:=|$)/.test(part));
  const seconds = maxAges.length ? maxAges[0].match(/^max-age=(?:"(\d+)"|(\d+))$/) : null;
  if (maxAges.length > 1 || (maxAges.length && !seconds)) return 0;
  const lifetime = Math.min(300, seconds ? Number(seconds[1] ?? seconds[2]) : 60);
  const ageHeader = headers.get("age");
  if (ageHeader !== null && !/^\d+$/.test(ageHeader)) return 0;
  const date = Date.parse(headers.get("date") ?? "");
  const age = Math.max(
    Number(ageHeader ?? 0),
    Number.isFinite(date) ? (Date.now() - date) / 1000 : 0,
    0,
  );
  return Date.now() + Math.max(0, lifetime - age) * 1000;
}

async function fetchClient(url) {
  let metadata, freshUntil;
  try {
    // The URL is one a stranger chose. Redirects are not followed, so the
    // request goes only to the host that was checked, and nothing but the
    // parsed document leaves this function.
    const signal = AbortSignal.timeout(metadataFetchTimeouts.fetch);
    const fetched = await fetch(url.href, {
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal,
    });
    if (
      fetched.status !== 200 ||
      !/^application\/(?:[a-z0-9.-]+\+)?json(?:;|$)/i.test(
        fetched.headers.get("content-type") ?? "",
      )
    ) {
      await fetched.body?.cancel();
      throw Error("Unusable metadata");
    }
    freshUntil = metadataFreshUntil(fetched.headers);
    metadata = JSON.parse(await boundedText(fetched.body, MAX_METADATA_BYTES, signal));
  } catch {
    throw new OAuthError(
      "temporarily_unavailable",
      `Pages could not read the client information at ${url.hostname}. Try again.`,
      503,
    );
  }
  return { client: clientFromMetadata(url, metadata), freshUntil };
}

// Validated documents, shared by every request in an isolate and keyed by
// client id. Only a document that passed validation is kept, and only while
// it is fresh. Both maps are bounded: a stranger chooses the keys.
const cachedClients = new Map();
// Client ids being fetched, each with the time its fetch stops holding it.
// This holds no promise: see `metadataClient`.
const fetchingClients = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const busy = (message) => new OAuthError("temporarily_unavailable", message, 503);

function keepClient(id, client, freshUntil) {
  const now = Date.now();
  if (freshUntil <= now) return;
  for (const [key, entry] of cachedClients) if (entry.freshUntil <= now) cachedClients.delete(key);
  // A Map keeps insertion order, so the first key is the oldest entry.
  if (cachedClients.size >= MAX_CACHED_CLIENTS)
    cachedClients.delete(cachedClients.keys().next().value);
  cachedClients.set(id, { client, freshUntil });
}

/** The client a metadata document describes. `url` comes from
 * `metadataClientUrl`.
 *
 * One request fetches a client id at a time, and no request awaits a promise
 * another request created: celld 0.6.3 would resume the waiter inside the
 * fetching request and drop its later work when that request responds
 * (isolate-setup.mjs). The request that starts a fetch awaits it. Another
 * request for the same id waits on its own timer until that fetch is over,
 * then reads the cache, or fetches for itself when nothing was kept (a failed
 * fetch, or a document that says not to store it). */
export async function metadataClient(url) {
  const id = url.href;
  const giveUp = Date.now() + metadataFetchTimeouts.wait;
  for (;;) {
    const now = Date.now();
    const cached = cachedClients.get(id);
    if (cached?.freshUntil > now) return cached.client;
    cachedClients.delete(id);
    const held = fetchingClients.get(id);
    if (held === undefined || now >= held.until) break;
    if (now >= giveUp) throw busy(`Pages is still reading ${url.hostname}. Try again.`);
    await sleep(metadataFetchTimeouts.poll);
  }
  // Claimed below in the same synchronous step as the check above.
  const now = Date.now();
  for (const [key, entry] of fetchingClients) if (now >= entry.until) fetchingClients.delete(key);
  if (fetchingClients.size >= MAX_METADATA_FETCHES)
    throw busy("Pages is checking too many clients at once. Try again.");
  const hold = { until: now + metadataFetchTimeouts.fetch + FETCH_HOLD_SLACK_MS };
  fetchingClients.set(id, hold);
  try {
    const { client, freshUntil } = await fetchClient(url);
    keepClient(id, client, freshUntil);
    return client;
  } finally {
    // A fetch that outlived its hold leaves a newer request's claim alone.
    if (fetchingClients.get(id) === hold) fetchingClients.delete(id);
  }
}
