/** Browser sign-in with a Kilo account, by a redirect through Kilo's web app.
 *
 * `GET /api/auth/login` stores where the person was going under a one-time
 * `state`, sets an HttpOnly cookie that binds the sign-in to this browser,
 * and sends the browser to Kilo. Kilo checks its own session and sends the
 * browser back to `KILO_CALLBACK_PATH` with a code and the same `state`. The
 * callback takes the stored row, trades the code for the person it names,
 * and starts a Pages session.
 *
 * The first callback that names a `state` takes its row, and a session follows
 * only if that callback also carries the cookie the sign-in started with. A
 * link to Kilo's page or to the callback that is opened in another browser
 * therefore signs nobody in, and it ends that sign-in: a code that reached the
 * wrong browser can't be carried back to the right one. Kilo never sees the
 * landing path, so it can't be made to send a person anywhere but the fixed
 * callback.
 *
 * A sign-in has one stored step. The callback removes the row before it calls
 * Kilo, and nothing is kept afterwards, so a request that dies or a Kilo that
 * doesn't answer is not resumed: the person starts again, which costs one
 * redirect while they are signed in at Kilo.
 *
 * Pages is given identity only: an account id and a name. It holds no Kilo
 * token, so a session has nothing to renew with. It ends after
 * `SESSION_SECONDS` and the browser signs in again; that is also how long a
 * person Kilo has blocked can keep a session here. Kilo gives no email
 * address, so inviting by email, company-domain view and email quota rules
 * stay off for these identities. */
import { createServerSession, ServerSessionGrantRejected } from "@cloud/server-oidc.ts";
import {
  cookieValue,
  randomSecret,
  readServerAppSession,
  secretHash,
} from "@cloud/oidc-session-store.ts";
import { recordOidcEvent } from "./auth-events.mjs";
import { migrateSchema } from "./catalog-index.mjs";
import { isolateSetup } from "./isolate-setup.mjs";
import {
  exchangeKiloCode,
  KILO_CALLBACK_PATH,
  kiloEnterUrl,
  KiloProtocolError,
  KiloUnavailable,
} from "./kilo-exchange.mjs";
import { html } from "./oauth.mjs";

const BINDING_COOKIE = "__Host-pages_kilo_handoff";
const LOGIN_PATH = "/api/auth/login";
// How long a person has to get through Kilo's page, sign-in included.
const HANDOFF_SECONDS = 600;
// How long a session lasts before the browser signs in again.
const SESSION_SECONDS = 8 * 60 * 60;
const MIN_SECRET_LENGTH = 32;
const MAX_CODE_LENGTH = 2048;
// The shape `randomSecret` gives a state and a binding.
const SECRET = /^[A-Za-z0-9_-]{43}$/;
// A name Kilo can hold for a deployment, such as `pages-dev`.
const AUDIENCE = /^\S{1,200}$/;

const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: "handoffs",
    statements: Object.freeze([
      `CREATE TABLE IF NOT EXISTS kilo_handoffs (
        state_hash TEXT PRIMARY KEY,
        binding_hash TEXT NOT NULL,
        return_to TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )`,
    ]),
  }),
]);
const ready = isolateSetup((db) =>
  migrateSchema(db, { table: "kilo_handoff_schema", migrations: MIGRATIONS }),
);

/** This deployment's Kilo sign-in settings, or null when it doesn't use Kilo.
 * `PAGES_KILO_APP_URL` turns it on and must be a bare `https:` origin; a
 * loopback `http:` origin is accepted only beside the local test issuer flag.
 * `PAGES_KILO_AUDIENCE` is the name Kilo holds this deployment under, and
 * `PAGES_KILO_EXCHANGE_SECRET` is what Kilo checks at the code exchange. A
 * set but unusable value, or a missing audience or secret, throws, so a
 * misconfigured deployment fails loudly and never falls back to another
 * sign-in. */
export function kiloSignIn(env, request) {
  const configured = env?.PAGES_KILO_APP_URL;
  if (!configured) return null;
  let app;
  try {
    app = new URL(String(configured));
  } catch {
    throw new Error("Kilo sign-in is misconfigured");
  }
  const loopback =
    app.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(app.hostname) &&
    env.NOTEBOOK_CLOUD_LOCAL_OIDC === "true";
  const audience = env.PAGES_KILO_AUDIENCE;
  const secret = env.PAGES_KILO_EXCHANGE_SECRET;
  if (
    (app.protocol !== "https:" && !loopback) ||
    String(configured).replace(/\/$/, "") !== app.origin ||
    app.username ||
    app.password ||
    typeof audience !== "string" ||
    !AUDIENCE.test(audience) ||
    typeof secret !== "string" ||
    secret.length < MIN_SECRET_LENGTH
  )
    throw new Error("Kilo sign-in is misconfigured");
  return {
    appUrl: app.origin,
    audience,
    origin: new URL(env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN || request.url).origin,
    namespace: env.PAGES_KILO_PRINCIPAL_NAMESPACE?.trim() || "user:kilo",
    secret,
  };
}

/** The identity a Kilo account stands for: its id and, when it has one, its
 * name. */
export function kiloIdentity(config, account) {
  const principal = `${config.namespace}:${encodeURIComponent(account.id)}`;
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
      ...(account.name ? { displayName: account.name } : {}),
    },
  };
}

/** The provider `serverOidcSessionStatus` needs for a deployment that signs
 * in with Kilo, or undefined when this one doesn't. A Kilo session can't be
 * renewed: the status check ends it as it reaches its expiry, and the browser
 * signs in again through Kilo. */
export function kiloSessionProvider(env, request) {
  if (!kiloSignIn(env, request)) return undefined;
  return {
    async refresh() {
      throw new ServerSessionGrantRejected();
    },
  };
}

const noStore = (response) => {
  response.headers.set("Cache-Control", "no-store");
  return response;
};

/** A same-origin path to land on after sign-in, or `/`. The URL parser decides
 * what the browser would open, so a value it reads as another origin, such as
 * one hiding a second slash behind a tab, is refused. So is one whose
 * normalized path starts with two slashes, as `/a/..//host` does: handed back
 * to a browser, that path is another origin. */
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
    url.pathname.startsWith("/api/auth/")
  )
    return "/";
  return url.pathname + url.search + url.hash;
}

/** The secret this browser's binding cookie holds, or null. Two cookies of
 * the name, or a value that isn't a binding, hold nothing. */
function bindingOf(request) {
  const value = cookieValue(request, BINDING_COOKIE);
  return value && SECRET.test(value) ? value : null;
}

/** `GET /api/auth/login`: stores the landing path under a new `state` and
 * sends the browser to Kilo. A browser that already has a binding keeps it,
 * so a sign-in started in a second tab doesn't break the one in the first. */
async function beginHandoff(request, env, config) {
  const supplied = request.headers.get("origin");
  if (
    (supplied && supplied !== config.origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return noStore(new Response("Start sign-in from this Pages site.", { status: 403 }));
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("return_to"), config.origin);
  const state = randomSecret();
  const binding = bindingOf(request) ?? randomSecret();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM kilo_handoffs WHERE expires_at <= ?").bind(now),
    env.DB.prepare(
      "INSERT INTO kilo_handoffs (state_hash, binding_hash, return_to, expires_at) VALUES (?, ?, ?, ?)",
    ).bind(await secretHash(state), await secretHash(binding), returnTo, now + HANDOFF_SECONDS),
  ]);
  return noStore(
    new Response(null, {
      status: 302,
      headers: {
        Location: kiloEnterUrl(config.appUrl, { audience: config.audience, state }),
        "Set-Cookie": `${BINDING_COOKIE}=${binding}; Path=/; Max-Age=${HANDOFF_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
      },
    }),
  );
}

/** Tells the person a sign-in didn't finish and offers another. The audit log
 * gets the coded reason; the page says nothing about the account. */
function signInFailed(status, reason, returnTo = "/") {
  recordOidcEvent({
    type: "sign_in_failed",
    reason,
    phase: "handoff",
    kind: "kilo",
    outcome: "failure_page",
  });
  const retry = `${LOGIN_PATH}?return_to=${encodeURIComponent(returnTo)}`;
  const response = html(
    "Sign-in didn't finish",
    `<p>Pages couldn't finish signing you in with Kilo.</p><p class="setup-actions"><a class="primary setup-action" href="${retry}">Try again</a></p>`,
    status,
  );
  // This page's address holds the code and state Kilo sent.
  response.headers.set("Referrer-Policy", "no-referrer");
  return noStore(response);
}

/** `GET` on the callback: finishes the sign-in Kilo sent back. */
async function completeHandoff(request, env, config) {
  const params = new URL(request.url).searchParams;
  const state = params.get("state");
  const code = params.get("code");
  if (params.has("error")) return signInFailed(400, "provider_error");
  if (
    !state ||
    !SECRET.test(state) ||
    !code ||
    code.length > MAX_CODE_LENGTH ||
    params.getAll("state").length !== 1 ||
    params.getAll("code").length !== 1
  )
    return signInFailed(400, "callback_malformed");
  const now = Math.floor(Date.now() / 1000);
  // One statement takes the row, whichever browser the callback reached, so a
  // state is good for one callback and of two that carry it one goes on.
  const row = await env.DB.prepare(
    "DELETE FROM kilo_handoffs WHERE state_hash = ? RETURNING binding_hash, return_to, expires_at",
  )
    .bind(await secretHash(state))
    .first();
  if (!row) {
    // A repeated redirect or a restored tab delivers a callback whose sign-in
    // already finished. If this browser has a session, that sign-in worked.
    let session = null;
    try {
      session = await readServerAppSession(env, request, now);
    } catch {}
    if (session) return noStore(new Response(null, { status: 303, headers: { Location: "/" } }));
    return signInFailed(400, "handoff_missing");
  }
  if (row.expires_at <= now) return signInFailed(400, "handoff_expired");
  const binding = bindingOf(request);
  if (!binding || (await secretHash(binding)) !== row.binding_hash)
    return signInFailed(400, "binding_mismatch");
  const returnTo = safeReturnTo(row.return_to, config.origin);
  let account;
  try {
    account = await exchangeKiloCode(fetch, {
      appUrl: config.appUrl,
      secret: config.secret,
      code,
      audience: config.audience,
      state,
    });
  } catch (error) {
    if (error instanceof KiloUnavailable) return signInFailed(503, "kilo_unavailable", returnTo);
    if (error instanceof KiloProtocolError)
      return signInFailed(502, "kilo_protocol_error", returnTo);
    throw error;
  }
  if (account.refused === "client") return signInFailed(503, "exchange_refused_client", returnTo);
  if (account.refused === "account") return signInFailed(403, "exchange_refused_account", returnTo);
  if (account.refused) return signInFailed(400, "exchange_refused_code", returnTo);
  const sessionCookie = await createServerSession(
    request,
    env,
    {
      identity: kiloIdentity(config, account),
      expiresAt: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
      bundle: { kind: "kilo-handoff", appUrl: config.appUrl, userId: account.id },
    },
    { onAuthEvent: recordOidcEvent },
  );
  return noStore(
    new Response(null, {
      status: 303,
      headers: { Location: returnTo, "Set-Cookie": sessionCookie },
    }),
  );
}

/** Kilo sign-in's routes. Returns null for any other path, and for every path
 * when this deployment doesn't use Kilo, so the caller's own routes answer. */
export async function handleKiloSignIn(request, env) {
  const { pathname } = new URL(request.url);
  if (pathname !== LOGIN_PATH && pathname !== KILO_CALLBACK_PATH) return null;
  const config = kiloSignIn(env, request);
  if (!config) return null;
  if (request.method !== "GET") return noStore(new Response(null, { status: 405 }));
  await ready(env.DB);
  return pathname === LOGIN_PATH
    ? beginHandoff(request, env, config)
    : completeHandoff(request, env, config);
}
