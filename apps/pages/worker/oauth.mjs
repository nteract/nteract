import { pagesPublicOrigin } from "../agent-guide.mjs";
import { identityProvider } from "../identity-provider.mjs";
import { FAVICON_LINK } from "../shared/favicon.mjs";
import { PRODUCT_NAME, tabTitle } from "../shared/product.mjs";
import { STYLESHEET, THEME_SCRIPT } from "../shared/shell-assets.mjs";
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
import { logAuthEvent, recordOidcEvent } from "./auth-events.mjs";
import {
  OAuthError,
  boundedText,
  formActionSource,
  loopbackRedirect,
  metadataClient,
  metadataClientUrl,
  namedClient,
  loopbackNameClash,
  redirectAllowed,
} from "./oauth-clients.mjs";

const READ = "pages:read";
const WRITE = "pages:write";
const SHARE = "pages:share";
const OFFLINE = "offline_access";
const GRANT_TYPES = ["authorization_code", "refresh_token"];
const MAX_INPUT_BYTES = 16_384;
/** Every path handleOAuth answers. The live tunnels admit exactly these
 * (scripts/deployment/routes.mjs oauthPaths). */
export const OAUTH_ROUTES = new Set([
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
/** A Pages-styled HTML document. `body` is trusted markup; escape any input in
 * it. `formTarget` is one more place the page's forms may be sent. Only the
 * consent page passes it, as `formActionSource()` wrote it for the callback
 * validated for that request. */
export function html(title, body, status = 200, formTarget = "") {
  // img-src admits data: only, for the inlined tab icon (shared/favicon.mjs).
  const formAction = "'self'" + (formTarget && " " + formTarget);
  return response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(tabTitle(title))}</title>${FAVICON_LINK}<script src="${THEME_SCRIPT}"></script><link rel="stylesheet" href="${STYLESHEET}"></head><body><header class="app-header"><a class="brand" href="/">${escape(PRODUCT_NAME)}</a></header><main class="agent-setup"><h1>${escape(title)}</h1>${body}</main></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; base-uri 'none'; form-action ${formAction}; frame-ancestors 'none'`,
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
    scopes_supported: [READ, WRITE, SHARE],
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
    scopes_supported: [READ, WRITE, SHARE, OFFLINE],
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

/** The client a token or revocation request names. A metadata-document id is
 * checked for its form and for the deployment's admission as it is now, so a
 * grant issued to a client the deployment has since stopped admitting gets
 * `invalid_client`. These endpoints never fetch: the code or grant a request
 * presents was issued to one client id and matches no other. */
function requestClient(clientId, env) {
  const origin = pagesPublicOrigin(env);
  const client = namedClient(clientId, origin, env);
  if (client) return client;
  if (metadataClientUrl(clientId, origin)) return { id: clientId, named: false };
  throw new OAuthError("invalid_client", "This OAuth client is not supported.");
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
    [...requested].some((scope) => ![READ, WRITE, SHARE, OFFLINE].includes(scope)) ||
    (!requested.has(READ) && !requested.has(WRITE))
  )
    throw new OAuthError(
      "invalid_scope",
      "Request pages:read, optionally pages:write, pages:share and offline_access.",
    );
  if (requested.has(WRITE)) requested.add(READ);
  return [READ, WRITE, SHARE, OFFLINE].filter((scope) => requested.has(scope)).join(" ");
}
function authorizationRequest(params, env, context, client) {
  const redirectUri = single(params, "redirect_uri");
  const origin = pagesPublicOrigin(env);
  if (!redirectAllowed(client, redirectUri, origin)) {
    // On a local server the usual cause is a native client that listens on
    // the loopback name Pages itself uses. Say which name to run Pages on.
    const other = client.named ? null : loopbackNameClash(redirectUri, origin);
    throw new OAuthError(
      "invalid_request",
      other
        ? `This client listens on ${new URL(origin).hostname}, the name this local Pages server uses, so your browser would send it your Pages session. Run Pages on ${other} to connect it.`
        : "The callback does not match this client.",
    );
  }
  const state = single(params, "state", { required: false, max: 1024 });
  if (state === "") throw new OAuthError("invalid_request", "State must not be empty.");
  // Before anyone has chosen, an OAuth error is sent only to the exact callback
  // of a client Pages names, with a single bounded state. A callback from a
  // metadata document is one a stranger listed, so its failures stay on a
  // Pages page: the browser goes there only after Allow access or Cancel.
  if (client.named)
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
    clientId: client.id,
    redirectUri,
    resource,
    codeChallenge,
    scope,
    ...(state === undefined ? {} : { state }),
  };
}
async function form(request) {
  if (
    !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers.get("content-type") ?? "")
  )
    throw new OAuthError("invalid_request", "Use an application/x-www-form-urlencoded request.");
  let text;
  try {
    text = await boundedText(request.body, MAX_INPUT_BYTES);
  } catch (error) {
    if (error instanceof RangeError)
      throw new OAuthError("invalid_request", "The request is too large.");
    throw error;
  }
  const params = new URLSearchParams(text);
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
  return requestClient(single(params, "client_id"), env);
}
async function currentSession(request, env) {
  const refreshed = await serverOidcSessionStatus(request, env, async () => {}, {
    onAuthEvent: recordOidcEvent,
  });
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
function signInPage(request, name) {
  const returnTo = "/oauth/authorize" + new URL(request.url).search;
  const login = "/api/auth/login?" + new URLSearchParams({ return_to: returnTo });
  return html(
    "Connect " + name,
    `<p>Sign in to Pages to review this connection. Your client will receive access only after you approve it.</p><p><a class="primary setup-action" href="${escape(login)}">Sign in</a></p>`,
  );
}
/** Who is asking and where the browser goes next, as markup for the consent
 * screen. Both hosts come from validated values: the client id and the
 * callback checked for this request. A client Pages has no name for is headed
 * by the host of its id; the name its document gives is shown as a claim. */
function consentParties(client, redirectUri, origin) {
  const pages = `<strong>${escape(new URL(origin).host)}</strong>`;
  const host = `<strong>${escape(client.host)}</strong>`;
  const parts = [
    client.known
      ? `<p><strong>${escape(client.name)}</strong> (${escape(client.host)}) wants access to Pages at ${pages}.</p>`
      : `<p>${host} wants access to Pages at ${pages}.</p><p>Pages does not know this app.${client.declaredName === client.name ? "" : ` It calls itself \u201c${escape(client.declaredName)}\u201d.`} Allow access only if you trust ${host}.</p>`,
  ];
  const callback = new URL(redirectUri);
  if (callback.origin === new URL(origin).origin) return parts[0];
  parts.push(
    loopbackRedirect(redirectUri)
      ? `<p>Your browser will return to an app on this computer, at <strong>${escape(callback.host)}</strong>. Pages cannot tell which app is listening there. Allow access only if you started this connection yourself.</p>`
      : `<p>Your browser will return to <strong>${escape(callback.host)}</strong>.</p>`,
  );
  return parts.join("");
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
  let auth = null,
    current;
  if (request.method === "GET") {
    const params = new URL(request.url).searchParams;
    for (const key of params.keys()) single(params, key, { required: false, max: MAX_INPUT_BYTES });
    const clientId = single(params, "client_id");
    let client = namedClient(clientId, origin, env);
    if (!client) {
      const url = metadataClientUrl(clientId, origin);
      if (!url) throw new OAuthError("invalid_client", "This OAuth client is not supported.");
      // A stranger chose this URL, so Pages fetches a document only for a
      // signed-in person. Until
      // then the request is unchecked and names no client.
      current = await currentSession(request, env);
      if (current.response) return current.response;
      context.cookie = current.cookie;
      if (!current.session) return signInPage(request, "an app");
      client = await metadataClient(url, env);
    }
    auth = { client, request: authorizationRequest(params, env, context, client) };
  }
  current ??= await currentSession(request, env);
  if (current.response) return current.response;
  context.cookie = current.cookie;
  if (!current.session) {
    if (request.method === "POST")
      return html(
        "Sign in again",
        "<p>Your sign-in expired. Return to the client and connect again.</p>",
        401,
      );
    return signInPage(request, auth.client.name);
  }
  const binding = { sessionId: current.row.id, principal: current.session.principal };
  if (request.method === "GET") {
    const consent = await issueConsent(env, {
      request: { ...auth.request, allowRefresh: true },
      ...binding,
    });
    const scopes = new Set(auth.request.scope.split(" "));
    const permissions = ["Read the Pages your account can access."];
    if (scopes.has(SHARE))
      permissions.push(
        "View and manage sharing for Pages and Projects you own. Project members can access every Page in the Project.",
      );
    if (scopes.has(WRITE))
      permissions.push(
        "Create Pages, edit and comment, and delete Pages you own. Each Page's sharing permissions still apply.",
      );
    permissions.push(
      "Keep this connection active for up to 30 days, unless you disconnect or its access is revoked.",
    );
    return html(
      `Connect ${auth.client.name} to Pages`,
      `${consentParties(auth.client, auth.request.redirectUri, origin)}<p>Signed in as <strong>${escape(current.session.displayName || "your Pages account")}</strong>.</p><ul>${permissions.map((permission) => `<li>${escape(permission)}</li>`).join("")}</ul><p>This connection uses a Pages access token. Your ${escape(identityProvider(env).label)} password and API key are not shared with the client.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="consent_id" value="${escape(consent.consentId)}"><input type="hidden" name="csrf_token" value="${escape(consent.csrfToken)}"><button class="primary setup-action" name="decision" value="approve" type="submit">Allow access</button> <button name="decision" value="cancel" type="submit">Cancel</button></form>`,
      200,
      formActionSource(auth.request.redirectUri, origin),
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
  const audit = {
    principal: current.session.principal,
    credential: "oauth",
    clientId: saved.clientId,
    scope: saved.scope,
  };
  if (decision === "cancel") {
    await logAuthEvent({ action: "oauth.consent_denied", ...audit });
    return redirect(saved, origin, { error: "access_denied" });
  }
  let code;
  try {
    // The approving session must still exist when the code is written: a
    // sign-out everywhere after the session check above leaves no code.
    ({ code } = await issueAuthorizationCode(
      env,
      { ...saved, identity: consentIdentity(current.session) },
      { sessionId: current.row.id },
    ));
  } catch (error) {
    if (error instanceof OAuthStoreError && error.error === "access_denied")
      throw new OAuthError("access_denied", "Your sign-in ended. Sign in and start again.", 403);
    throw error;
  }
  await logAuthEvent({ action: "oauth.consent_granted", ...audit });
  await logAuthEvent({ action: "oauth.code_issued", ...audit });
  return redirect(saved, origin, { code });
}
async function token(request, env, context) {
  if (request.method !== "POST") return methodResponse("POST");
  const params = await form(request);
  const client = publicClient(params, request, env);
  context.clientId = client.id;
  const resource = single(params, "resource");
  if (resource !== pagesPublicOrigin(env) + "/mcp")
    throw new OAuthError("invalid_target", "Request this Pages MCP resource.");
  const grant = single(params, "grant_type");
  if (GRANT_TYPES.includes(grant)) context.grantType = grant;
  if (grant === "authorization_code") {
    const redirectUri = single(params, "redirect_uri");
    // A named client has one callback. A metadata-document client's code is
    // bound in the store to the callback it was issued for.
    if (client.named && !client.redirectUris.includes(redirectUri))
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
  if (!OAUTH_ROUTES.has(url.pathname)) {
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
    if (url.pathname === "/oauth/token") return await token(request, env, context);
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
    // A refused token request is the only failure here without its own
    // grant event. The code is a fixed OAuth error name, never a message.
    if (url.pathname === "/oauth/token")
      await logAuthEvent({
        action: "oauth.token_refused",
        credential: "oauth",
        clientId: context.clientId,
        grantType: context.grantType,
        reason: code,
      });
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
