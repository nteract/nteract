import { pagesPublicOrigin } from "../agent-guide.mjs";
import { serverOidcSessionStatus } from "@cloud/server-oidc.ts";
import { loadServerSession, readServerAppSession } from "@cloud/oidc-session-store.ts";
import {
  issueConsent,
  consumeConsent,
  issueAuthorizationCode,
  exchangeAuthorizationCode,
  rotateRefreshToken,
  revokeOAuthToken,
  OAuthStoreError,
} from "./oauth-store.mjs";

const CHATGPT_CLIENT = "https://chatgpt.com/oauth/client.json";
const CHATGPT_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const KILO_REDIRECT = "http://127.0.0.1:19876/mcp/oauth/callback";
const READ = "pages:read";
const WRITE = "pages:write";
const OFFLINE = "offline_access";
const MAX_INPUT_BYTES = 16_384;
// This single fixed, public metadata document is shared by all requests in an
// isolate. Never retain failed validation or use stale metadata after expiry.
const clientMetadataCache = { validUntil: 0, pending: null };
const routes = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/oauth/authorize",
  "/oauth/token",
  "/oauth/revoke",
]);
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
class OAuthError extends Error {
  constructor(error, message, status = 400) {
    super(message);
    this.error = error;
    this.status = status;
  }
}
function response(body, { status = 200, headers = {} } = {}) {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}
function json(body, status = 200) {
  return response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function html(title, body, status = 200, consentRedirect) {
  // Chromium checks form-action across a form POST's redirects too. Permit the
  // registered callback for this client only on the consent page, never a
  // caller-supplied URL or an entire external origin. Local fixtures use 'self'.
  const formAction =
    "'self'" +
    ([CHATGPT_REDIRECT, KILO_REDIRECT].includes(consentRedirect) ? " " + consentRedirect : "");
  return response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Pages</title><link rel="stylesheet" href="/app.css"></head><body><header class="app-header"><a class="brand" href="/">Pages</a></header><main class="agent-setup"><h1>${escape(title)}</h1>${body}</main></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": `default-src 'none'; style-src 'self'; base-uri 'none'; form-action ${formAction}; frame-ancestors 'none'`,
        "X-Frame-Options": "DENY",
        // Chromium sends Origin:null for form POSTs under no-referrer. Keep
        // same-origin consent requests verifiable without leaking cross-site.
        "Referrer-Policy": "same-origin",
      },
    },
  );
}
function redirect(authorization, issuer, fields) {
  const url = new URL(authorization.redirectUri);
  for (const [name, value] of Object.entries(fields)) url.searchParams.set(name, value);
  if (authorization.state !== undefined) url.searchParams.set("state", authorization.state);
  url.searchParams.set("iss", issuer);
  return response(null, { status: 303, headers: { Location: url.href } });
}
function methodResponse(allow) {
  return response(null, { status: 405, headers: { Allow: allow } });
}

export function oauthProtectedResourceMetadata(env) {
  const origin = pagesPublicOrigin(env);
  return {
    resource: origin + "/mcp",
    authorization_servers: [origin],
    scopes_supported: [READ, WRITE],
    bearer_methods_supported: ["header"],
    resource_name: "Pages",
    resource_documentation: origin + "/connect",
  };
}
export function oauthAuthorizationServerMetadata(env) {
  const origin = pagesPublicOrigin(env);
  return {
    issuer: origin,
    authorization_endpoint: origin + "/oauth/authorize",
    token_endpoint: origin + "/oauth/token",
    revocation_endpoint: origin + "/oauth/revoke",
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [READ, WRITE, OFFLINE],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    service_documentation: origin + "/connect",
  };
}
export function mcpAuthChallenge(env, original) {
  if (original.status !== 401) return original;
  const headers = new Headers(original.headers);
  // A scope hint here overrides the client's requested scopes in Kilo's MCP
  // SDK. Advertise capabilities in metadata and let consent enforce the request.
  headers.set(
    "WWW-Authenticate",
    `Bearer resource_metadata="${pagesPublicOrigin(env)}/.well-known/oauth-protected-resource/mcp"`,
  );
  headers.set("Cache-Control", "no-store");
  return new Response(original.body, {
    status: original.status,
    statusText: original.statusText,
    headers,
  });
}

// Only these explicit public clients and a loopback-only fixture are recognized.
// Arbitrary client URLs, redirects, dynamic registration, and metadata redirects
// are deliberately unsupported. Metadata never controls a network destination.
function knownClient(clientId, env) {
  if ([CHATGPT_CLIENT, "pages-chatgpt"].includes(clientId))
    return {
      id: clientId,
      name: "ChatGPT",
      site: "https://chatgpt.com/",
      redirectUri: CHATGPT_REDIRECT,
    };
  if (clientId === "pages-kilo")
    return {
      id: clientId,
      name: "Kilo",
      site: "https://kilo.ai/",
      redirectUri: KILO_REDIRECT,
    };
  const origin = pagesPublicOrigin(env);
  if (
    clientId === "pages-local-e2e" &&
    env.PAGES_E2E_ONLY === "true" &&
    env.NOTEBOOK_CLOUD_LOCAL_OIDC === "true" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)
  )
    return {
      id: clientId,
      name: "Local test client",
      site: origin,
      redirectUri: origin + "/oauth/test/callback",
    };
  throw new OAuthError("invalid_client", "This OAuth client is not supported.");
}
async function boundedText(body, limit = MAX_INPUT_BYTES) {
  if (!body) return "";
  const reader = body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new OAuthError("invalid_request", "The request is too large.");
      }
      chunks.push(value);
    }
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
async function verifyClientMetadata(client) {
  if (client.id !== CHATGPT_CLIENT) return;
  if (clientMetadataCache.validUntil > Date.now()) return;
  if (clientMetadataCache.pending) return clientMetadataCache.pending;
  clientMetadataCache.validUntil = 0;
  const pending = fetchAndVerifyClientMetadata().then((validUntil) => {
    clientMetadataCache.validUntil = validUntil;
  });
  clientMetadataCache.pending = pending;
  try {
    await pending;
  } finally {
    clientMetadataCache.pending = null;
  }
}
async function fetchAndVerifyClientMetadata() {
  let metadata, freshUntil;
  try {
    const fetched = await fetch(CHATGPT_CLIENT, {
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (
      !fetched.ok ||
      !/^application\/json(?:;|$)/i.test(fetched.headers.get("content-type") ?? "")
    ) {
      await fetched.body?.cancel();
      throw Error("Unusable metadata");
    }
    freshUntil = metadataFreshUntil(fetched.headers);
    metadata = JSON.parse(await boundedText(fetched.body));
  } catch {
    throw new OAuthError(
      "temporarily_unavailable",
      "ChatGPT's client information is temporarily unavailable. Try again.",
      503,
    );
  }
  const methods = metadata?.token_endpoint_auth_methods_supported;
  if (
    metadata?.client_id !== CHATGPT_CLIENT ||
    metadata?.client_name !== "ChatGPT" ||
    !Array.isArray(metadata?.redirect_uris) ||
    !metadata.redirect_uris.includes(CHATGPT_REDIRECT) ||
    !Array.isArray(metadata?.grant_types) ||
    !metadata.grant_types.includes("authorization_code") ||
    !Array.isArray(metadata?.response_types) ||
    !metadata.response_types.includes("code") ||
    !(
      metadata.token_endpoint_auth_method === "none" ||
      (Array.isArray(methods) && methods.includes("none"))
    )
  )
    throw new OAuthError(
      "invalid_client",
      "ChatGPT's client information does not match this connection.",
    );
  return freshUntil;
}
function single(params, name, { required = true, max = 2048 } = {}) {
  const values = params.getAll(name);
  if (
    values.length > 1 ||
    (required && (values.length !== 1 || !values[0])) ||
    (values[0]?.length ?? 0) > max
  )
    throw new OAuthError("invalid_request", `Invalid ${name}.`);
  return values[0];
}
function scopeFor(value) {
  const requested = new Set(value === undefined ? [READ] : value.split(" "));
  if (
    [...requested].some((scope) => ![READ, WRITE, OFFLINE].includes(scope)) ||
    (!requested.has(READ) && !requested.has(WRITE))
  )
    throw new OAuthError(
      "invalid_scope",
      "Request pages:read, optionally pages:write and offline_access.",
    );
  if (requested.has(WRITE)) requested.add(READ);
  return [READ, WRITE, OFFLINE].filter((scope) => requested.has(scope)).join(" ");
}
async function authorizationRequest(params, env, context) {
  for (const key of params.keys()) single(params, key, { required: false, max: MAX_INPUT_BYTES });
  const client = knownClient(single(params, "client_id"), env);
  const redirectUri = single(params, "redirect_uri");
  if (redirectUri !== client.redirectUri)
    throw new OAuthError("invalid_request", "The callback does not match this client.");
  const state = single(params, "state", { required: false, max: 1024 });
  if (state === "") throw new OAuthError("invalid_request", "State must not be empty.");
  await verifyClientMetadata(client);
  // Only validated client metadata, an exact registered callback, and a
  // single bounded state may receive OAuth errors. Other failures stay here.
  context.authorization = { redirectUri, ...(state === undefined ? {} : { state }) };
  if (single(params, "response_type") !== "code")
    throw new OAuthError("unsupported_response_type", "Use the authorization code flow.");
  const mode = single(params, "response_mode", { required: false });
  if (mode !== undefined && mode !== "query")
    throw new OAuthError("invalid_request", "Use query response mode.");
  const resource = single(params, "resource");
  if (resource !== pagesPublicOrigin(env) + "/mcp")
    throw new OAuthError("invalid_target", "Request this Pages MCP resource.");
  const codeChallenge = single(params, "code_challenge", { max: 43 });
  if (
    single(params, "code_challenge_method") !== "S256" ||
    !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)
  )
    throw new OAuthError("invalid_request", "An S256 PKCE challenge is required.");
  const scope = scopeFor(single(params, "scope", { required: false, max: 256 }));
  return {
    client,
    request: {
      clientId: client.id,
      redirectUri,
      resource,
      codeChallenge,
      scope,
      ...(state === undefined ? {} : { state }),
    },
  };
}
async function form(request) {
  if (
    !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers.get("content-type") ?? "")
  )
    throw new OAuthError("invalid_request", "Use an application/x-www-form-urlencoded request.");
  const params = new URLSearchParams(await boundedText(request.body));
  for (const key of params.keys()) single(params, key, { required: false, max: MAX_INPUT_BYTES });
  return params;
}
function publicClient(params, request, env) {
  if (
    request.headers.has("authorization") ||
    ["client_secret", "client_assertion", "client_assertion_type"].some((key) => params.has(key))
  )
    throw new OAuthError(
      "invalid_client",
      "This endpoint supports public clients with PKCE, without client credentials.",
    );
  return knownClient(single(params, "client_id"), env);
}
async function currentSession(request, env) {
  const refreshed = await serverOidcSessionStatus(request, env, async () => {});
  if (!refreshed.ok) return { response: refreshed };
  const now = Math.floor(Date.now() / 1000);
  const row = await loadServerSession(env, request, now);
  const session = row ? await readServerAppSession(env, request, now) : null;
  if (session && JSON.parse(row.session_json).principal !== session.principal)
    throw new OAuthError("access_denied", "Your sign-in changed. Start the connection again.", 403);
  return { row, session, cookie: refreshed.headers.get("set-cookie") };
}
function withSessionCookie(result, cookie) {
  if (cookie) result.headers.append("Set-Cookie", cookie);
  return result;
}
function consentIdentity(session) {
  return {
    principal: session.principal,
    displayName: session.displayName || session.principal,
    namespace: session.principalNamespace,
    emailProof: {
      provider: "app-session",
      principalNamespace: session.principalNamespace,
      identityVerifiedAt: session.identityVerifiedAt,
      verifiedEmailBinding: session.verifiedEmailBinding,
      verifiedEmailDomainBinding: session.verifiedEmailDomainBinding,
    },
  };
}
async function authorize(request, env, context) {
  if (!["GET", "POST"].includes(request.method)) return methodResponse("GET, POST");
  const origin = pagesPublicOrigin(env);
  // Consent is an authenticated browser action. Public OAuth client requests to
  // the token endpoint never use cookies and have a different trust boundary.
  if (
    request.method === "POST" &&
    (request.headers.get("origin") !== origin ||
      request.headers.get("sec-fetch-site") === "cross-site")
  )
    throw new OAuthError(
      "access_denied",
      "Approve this connection from the Pages consent screen.",
      403,
    );
  const auth =
    request.method === "GET"
      ? await authorizationRequest(new URL(request.url).searchParams, env, context)
      : null;
  const current = await currentSession(request, env);
  if (current.response) return current.response;
  context.cookie = current.cookie;
  if (!current.session) {
    if (request.method === "POST")
      return html(
        "Sign in again",
        "<p>Your sign-in expired. Return to the client and connect again.</p>",
        401,
      );
    const returnTo = "/oauth/authorize" + new URL(request.url).search;
    const login = "/api/auth/login?" + new URLSearchParams({ return_to: returnTo });
    return html(
      "Connect " + auth.client.name,
      `<p>Sign in to Pages to review this connection. Your client will receive access only after you approve it.</p><p><a class="primary setup-action" href="${escape(login)}">Sign In</a></p>`,
    );
  }
  const binding = { sessionId: current.row.id, principal: current.session.principal };
  if (request.method === "GET") {
    const consent = await issueConsent(env, {
      request: { ...auth.request, allowRefresh: true },
      ...binding,
    });
    const scopes = new Set(auth.request.scope.split(" "));
    const permissions = ["Read the Pages your account can access."];
    if (scopes.has(WRITE))
      permissions.push(
        "Create Pages, edit and comment, and delete Pages you own. Each Page's sharing permissions still apply.",
      );
    permissions.push(
      "Keep this connection active for up to 30 days, unless you disconnect or its access is revoked.",
    );
    return html(
      `Connect ${auth.client.name} to Pages`,
      `<p><strong>${escape(auth.client.name)}</strong> (${escape(new URL(auth.client.site).host)}) wants access to Pages at <strong>${escape(new URL(origin).host)}</strong>.</p><p>Signed in as <strong>${escape(current.session.displayName || "your Pages account")}</strong>.</p><ul>${permissions.map((permission) => `<li>${escape(permission)}</li>`).join("")}</ul><p>This connection uses a Pages access token. Your Anaconda password and API key are not shared with the client.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="consent_id" value="${escape(consent.consentId)}"><input type="hidden" name="csrf_token" value="${escape(consent.csrfToken)}"><button class="primary setup-action" name="decision" value="approve" type="submit">Allow access</button> <button name="decision" value="cancel" type="submit">Cancel</button></form>`,
      200,
      auth.client.redirectUri,
    );
  }
  const params = await form(request);
  if ([...params.keys()].some((key) => !["consent_id", "csrf_token", "decision"].includes(key)))
    throw new OAuthError("invalid_request", "Start the connection again from your client.");
  const decision = single(params, "decision");
  if (!["approve", "cancel"].includes(decision))
    throw new OAuthError("invalid_request", "Choose Allow access or Cancel.");
  const saved = await consumeConsent(env, {
    ...binding,
    consentId: single(params, "consent_id", { max: 256 }),
    csrfToken: single(params, "csrf_token", { max: 256 }),
  });
  if (!saved)
    throw new OAuthError(
      "access_denied",
      "This consent request expired or belongs to another sign-in. Start again.",
      403,
    );
  context.authorization = saved;
  if (decision === "cancel") return redirect(saved, origin, { error: "access_denied" });
  const { code } = await issueAuthorizationCode(env, {
    ...saved,
    identity: consentIdentity(current.session),
  });
  return redirect(saved, origin, { code });
}
async function token(request, env) {
  if (request.method !== "POST") return methodResponse("POST");
  const params = await form(request);
  const client = publicClient(params, request, env);
  const resource = single(params, "resource");
  if (resource !== pagesPublicOrigin(env) + "/mcp")
    throw new OAuthError("invalid_target", "Request this Pages MCP resource.");
  const grant = single(params, "grant_type");
  if (grant === "authorization_code") {
    const redirectUri = single(params, "redirect_uri");
    if (redirectUri !== client.redirectUri)
      throw new OAuthError("invalid_grant", "The authorization grant is invalid.");
    return json(
      await exchangeAuthorizationCode(env, {
        code: single(params, "code"),
        clientId: client.id,
        redirectUri,
        resource,
        codeVerifier: single(params, "code_verifier", { max: 128 }),
      }),
    );
  }
  if (grant === "refresh_token") {
    const scope = single(params, "scope", { required: false, max: 256 });
    return json(
      await rotateRefreshToken(env, {
        refreshToken: single(params, "refresh_token"),
        clientId: client.id,
        resource,
        ...(scope === undefined ? {} : { scope: scopeFor(scope) }),
      }),
    );
  }
  throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
}
async function revoke(request, env) {
  if (request.method !== "POST") return methodResponse("POST");
  const params = await form(request);
  const client = publicClient(params, request, env);
  await revokeOAuthToken(env, { token: single(params, "token"), clientId: client.id });
  return response(null);
}

export async function handleOAuth(request, env) {
  const url = new URL(request.url);
  if (!routes.has(url.pathname)) {
    return url.pathname.startsWith("/oauth/") || url.pathname.startsWith("/.well-known/oauth-")
      ? json({ error: "not_found" }, 404)
      : null;
  }
  const context = {};
  try {
    if (request.url.length > MAX_INPUT_BYTES)
      throw new OAuthError("invalid_request", "The request is too large.");
    if (url.pathname.startsWith("/.well-known/")) {
      if (!["GET", "HEAD"].includes(request.method)) return methodResponse("GET, HEAD");
      const result = json(
        url.pathname === "/.well-known/oauth-authorization-server"
          ? oauthAuthorizationServerMetadata(env)
          : oauthProtectedResourceMetadata(env),
      );
      result.headers.set("Access-Control-Allow-Origin", "*");
      return request.method === "HEAD" ? new Response(null, result) : result;
    }
    if (url.pathname === "/oauth/authorize")
      return withSessionCookie(await authorize(request, env, context), context.cookie);
    if (url.pathname === "/oauth/token") return await token(request, env);
    return await revoke(request, env);
  } catch (error) {
    const known = error instanceof OAuthError || error instanceof OAuthStoreError;
    const code = known ? error.error : "server_error";
    const message =
      error instanceof OAuthError
        ? error.message
        : known
          ? "The authorization grant is invalid or expired. Connect again."
          : "Pages authorization is temporarily unavailable.";
    const status = error instanceof OAuthError ? error.status : known ? 400 : 503;
    if (url.pathname === "/oauth/authorize" && context.authorization)
      return withSessionCookie(
        redirect(context.authorization, pagesPublicOrigin(env), {
          error: code,
          error_description: message,
        }),
        context.cookie,
      );
    return withSessionCookie(
      url.pathname === "/oauth/authorize"
        ? html(
            "Connection not completed",
            `<p>${escape(message)}</p><p><a href="/connect">Connection help</a></p>`,
            status,
          )
        : json({ error: code, error_description: message }, status),
      context.cookie,
    );
  }
}
