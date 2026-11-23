/** Browser sign-in with a Tailscale login, read from the identity headers
 * Tailscale Serve adds (tailscale-config.mjs says what they prove and what
 * the deployment must do for that to hold).
 *
 * `GET /api/auth/login` reads the headers on the request itself and starts a
 * Pages session for the login they name. There is no redirect, no stored
 * transaction and no callback: the request that asks to sign in already
 * carries its proof, so `/oidc` answers 404 on these deployments.
 *
 * The session holds only the login in its sealed bundle. It renews on a
 * request whose headers still name that login, and every browser request
 * through Serve carries them. A renewal ends the session when the request
 * names another login, or when the login has left `PAGES_TAILSCALE_LOGINS`;
 * the browser then signs in again, and a login no longer listed is refused
 * there. One without headers (not through Serve) keeps the row and is
 * retried, so it can't end a session that someone on the tailnet is still
 * using. */
import { createServerSession, ServerSessionGrantRejected } from "@nteract/session";
import { browserSessionOptions } from "./browser-account.mjs";
import { recordOidcEvent } from "./auth-events.mjs";
import { html } from "./oauth.mjs";
import { tailscaleIdentity, tailscaleRequester, tailscaleSignIn } from "./tailscale-config.mjs";

const LOGIN_PATH = "/api/auth/login";
const CALLBACK_PATH = "/oidc";
/** How long a session's proof lasts before a request renews it. A login
 * removed from the list keeps its session at most this long. */
export const TAILSCALE_PROOF_SECONDS = 60 * 60;

const noStore = (response) => {
  response.headers.set("Cache-Control", "no-store");
  return response;
};

/** A same-origin path to land on after sign-in, or `/`. The URL parser decides
 * what the browser would open, so a value it reads as another origin is
 * refused, and so is one whose normalized path starts with two slashes. */
function safeReturnTo(value, origin) {
  if (typeof value !== "string" || !value.startsWith("/") || /[\\\t\r\n]/.test(value)) return "/";
  let url;
  try {
    url = new URL(value, origin);
  } catch {
    return "/";
  }
  if (
    url.origin !== origin ||
    url.pathname.startsWith("//") ||
    url.pathname === CALLBACK_PATH ||
    url.pathname.startsWith("/api/auth/")
  )
    return "/";
  return url.pathname + url.search + url.hash;
}

const REFUSALS = {
  missing: {
    status: 401,
    body: "<p>Pages signs you in with your Tailscale account. Open this site from a device on the tailnet, at its Tailscale address.</p>",
  },
  malformed: {
    status: 400,
    body: "<p>Tailscale sent an account Pages can't read.</p>",
  },
  not_allowed: {
    status: 403,
    body: "<p>Your Tailscale account doesn't have access to this Pages site. Ask its owner to add it.</p>",
  },
};

/** Tells the person why they weren't signed in. The audit log gets the coded
 * reason; the page names no account. */
function signInRefused(reason, returnTo) {
  recordOidcEvent({
    type: "sign_in_failed",
    reason,
    phase: "tailscale",
    kind: "tailscale",
    outcome: "failure_page",
  });
  const { status, body } = REFUSALS[reason];
  const retry = `${LOGIN_PATH}?return_to=${encodeURIComponent(returnTo)}`;
  return noStore(
    html(
      "Sign-in didn't finish",
      `${body}<p class="setup-actions"><a class="primary setup-action" href="${retry}">Try again</a></p>`,
      status,
    ),
  );
}

/** The grant a requester stands for, with the login as the only bundle. */
function grantFor(config, requester) {
  return {
    identity: tailscaleIdentity(config, requester),
    expiresAt: Math.floor(Date.now() / 1000) + TAILSCALE_PROOF_SECONDS,
    bundle: { kind: "tailscale", login: requester.login },
  };
}

/** `GET /api/auth/login`: starts a session for the login Serve names. */
async function signIn(request, env, config) {
  const supplied = request.headers.get("origin");
  if (
    (supplied && supplied !== config.origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return noStore(new Response("Start sign-in from this Pages site.", { status: 403 }));
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("return_to"), config.origin);
  const requester = tailscaleRequester(config, request);
  if (requester.refused) return signInRefused(requester.refused, returnTo);
  const cookie = await createServerSession(
    request,
    env,
    grantFor(config, requester),
    browserSessionOptions,
  );
  return noStore(
    new Response(null, { status: 303, headers: { Location: returnTo, "Set-Cookie": cookie } }),
  );
}

/** Serve sent no usable headers with a renewal. The session row stays, and
 * the next request that carries them renews it. */
class TailscaleRequesterUnknown extends Error {
  constructor() {
    super("The request carries no Tailscale login");
    this.name = "TailscaleRequesterUnknown";
  }
}

/** The provider `serverOidcSessionStatus` needs for a deployment that signs in
 * with Tailscale, or undefined when this one doesn't. It renews from the
 * headers of the request it was made for. */
export function tailscaleSessionProvider(env, request) {
  const config = tailscaleSignIn(env, request);
  if (!config) return undefined;
  return {
    async refresh(bundle) {
      if (bundle?.kind !== "tailscale" || typeof bundle.login !== "string")
        throw new ServerSessionGrantRejected();
      const requester = tailscaleRequester(config, request);
      if (requester.refused === "missing" || requester.refused === "malformed")
        throw new TailscaleRequesterUnknown();
      if (requester.refused || requester.login !== bundle.login)
        throw new ServerSessionGrantRejected();
      return grantFor(config, requester);
    },
  };
}

/** Tailscale sign-in's routes. Returns null for any other path, and for every
 * path when this deployment doesn't use Tailscale, so the caller's own routes
 * answer. */
export async function handleTailscaleSignIn(request, env) {
  const { pathname } = new URL(request.url);
  if (pathname !== LOGIN_PATH && pathname !== CALLBACK_PATH) return null;
  const config = tailscaleSignIn(env, request);
  if (!config) return null;
  if (pathname === CALLBACK_PATH) return noStore(new Response(null, { status: 404 }));
  if (request.method !== "GET") return noStore(new Response(null, { status: 405 }));
  return signIn(request, env, config);
}
