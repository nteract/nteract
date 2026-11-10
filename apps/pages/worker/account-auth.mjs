/** A person's own sign-ins and agent connections, from the Pages web app:
 *
 * - `POST /api/auth/logout-all` signs the account out of every browser and
 *   revokes every agent connection in this deployment.
 * - `GET /api/auth/grants` lists the account's connected agents.
 * - `POST /api/auth/grants/<handle>/revoke` disconnects one of them.
 *
 * Only a browser session cookie may call these. A bearer credential is
 * refused, so an agent can't list or end other connections, nor sign the
 * person out. Writes need this deployment's Origin, as POST /api/auth/logout
 * does (requireSameOrigin); the cookie is SameSite=Lax, and a cross-site GET
 * can't read the JSON. */
import {
  loadServerSession,
  readServerAppSession,
  revokeServerSessionsFor,
  serverSessionCookie,
} from "@cloud/oidc-session-store.ts";
import { withAdmissionReason } from "./admission-reasons.mjs";
import { logAuthEvent, sessionRowPrincipal } from "./auth-events.mjs";
import { HttpError, json, logFailure, requireSameOrigin } from "./auth.mjs";
import { oauthClientName } from "./oauth-clients.mjs";
import { listGrantsFor, revokeGrantFor, revokeGrantsFor } from "./oauth-store.mjs";

const LOGOUT_ALL = "/api/auth/logout-all";
const GRANTS = "/api/auth/grants";
const GRANT_REVOKE = /^\/api\/auth\/grants\/([A-Za-z0-9_-]{43})\/revoke$/;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const signInAgain = (reason) =>
  withAdmissionReason(new HttpError(401, "Sign in to Pages", "auth_required"), reason);
const iso = (secondsValue) =>
  Number.isSafeInteger(secondsValue) ? new Date(secondsValue * 1000).toISOString() : null;

/** The caller's principal from a browser session cookie. `fresh` also needs
 * the session's access window, as `authenticate` does; signing out
 * everywhere only needs a live session row, as signing out does. */
async function sessionPrincipal(request, env, { fresh }) {
  if (request.headers.has("authorization"))
    throw withAdmissionReason(
      new HttpError(403, "Manage sign-ins from Pages in your browser"),
      "credential_scope",
    );
  requireSameOrigin(request, env);
  if (!request.headers.has("cookie")) throw signInAgain("credential_missing");
  const now = nowSeconds();
  if (fresh) {
    const session = await readServerAppSession(env, request, now);
    if (typeof session?.principal !== "string") throw signInAgain("credential_expired");
    return session.principal;
  }
  const principal = sessionRowPrincipal(await loadServerSession(env, request, now));
  if (!principal) throw signInAgain("credential_expired");
  return principal;
}

function methodNotAllowed(method) {
  const response = json({ error: `Use ${method}` }, 405);
  response.headers.set("allow", method);
  return response;
}

async function signOutEverywhere(request, env) {
  const principal = await sessionPrincipal(request, env, { fresh: false });
  const origin = env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN?.trim() || new URL(request.url).origin;
  // Agents first: if this fails, the browser is still signed in and can try
  // again. The sessions go next, this one included.
  let agents = await revokeGrantsFor(env, principal);
  const sessions = await revokeServerSessionsFor(env, principal, origin);
  // A browser signed in elsewhere could approve an agent between those two
  // steps; a second pass revokes that grant. The sign-out stands if it fails.
  try {
    agents += await revokeGrantsFor(env, principal);
  } catch (error) {
    logFailure(error, "logout-all");
  }
  await logAuthEvent({ action: "sign_out", principal, credential: "oidc", scope: "all" });
  const response = json({ ok: true, sessions, agents });
  response.headers.set("set-cookie", serverSessionCookie("", 0));
  return response;
}

async function connectedAgents(request, env) {
  const principal = await sessionPrincipal(request, env, { fresh: true });
  const grants = await listGrantsFor(env, principal);
  return json({
    agents: grants.map((grant) => ({
      id: grant.handle,
      name: oauthClientName(grant.clientId),
      scope: grant.scope,
      created_at: iso(grant.createdAt),
      expires_at: iso(grant.expiresAt),
    })),
  });
}

async function disconnectAgent(request, env, handle) {
  const principal = await sessionPrincipal(request, env, { fresh: true });
  return json({ revoked: await revokeGrantFor(env, principal, handle) });
}

/** The response for one of these routes, or null for any other path. */
export async function handleAccountAuth(request, env) {
  const { pathname } = new URL(request.url);
  if (pathname === LOGOUT_ALL)
    return request.method === "POST" ? signOutEverywhere(request, env) : methodNotAllowed("POST");
  if (pathname === GRANTS)
    return request.method === "GET" ? connectedAgents(request, env) : methodNotAllowed("GET");
  const revoke = GRANT_REVOKE.exec(pathname);
  if (revoke)
    return request.method === "POST"
      ? disconnectAgent(request, env, revoke[1])
      : methodNotAllowed("POST");
  return null;
}
