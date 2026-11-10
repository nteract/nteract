/** Browser sign-in with a Kilo account, by device pairing.
 *
 * Kilo doesn't send a browser back after it approves a pairing, so Pages asks:
 * the sign-in page polls this Worker, and the Worker polls Kilo. The pairing
 * is bound to one browser by an HttpOnly cookie whose hash is the row id, and
 * the device code never leaves the Worker.
 *
 * A pairing is `pending` until Kilo approves it and `approved` until its
 * session exists. `approved` is stored because Kilo answers `approved` once:
 * the grant is in the row before the profile is read, so a request that dies
 * there is resumed by the next poll and the device code is never exchanged
 * again. Every write names the row's revision, so a late request can't undo a
 * newer step.
 *
 * Two limits come from Kilo's protocol and are not closed here. Whoever opens
 * the approval link decides who gets signed in: a person talked into
 * approving a link someone else started signs that other browser in as
 * themselves, and Kilo's approval page, which names this site and asks for a
 * confirmation, is the only guard. And an exchange whose answer is lost after
 * Kilo consumed the device code can't be repeated: the next poll reads
 * `expired`, and the person starts again.
 *
 * Kilo's token is a full API credential for that person. Pages calls only the
 * profile and refresh routes with it. The one-hour token lives in the pairing
 * row, sealed, until the session exists; the session keeps the refresh token,
 * sealed. Kilo gives no sign that an email address is verified, so these
 * identities carry no email at all: inviting by email, company-domain view
 * and email quota rules stay off for them. */
import { createServerSession, ServerSessionGrantRejected } from "@cloud/server-oidc.ts";
import {
  cookieValue,
  openServerSecret,
  randomSecret,
  sealServerSecret,
  secretHash,
} from "@cloud/oidc-session-store.ts";
import { html } from "./oauth.mjs";
import { json, requireSameOrigin } from "./auth.mjs";
import { recordOidcEvent } from "./auth-events.mjs";
import { migrateSchema } from "./catalog-index.mjs";
import { isolateSetup } from "./isolate-setup.mjs";
import {
  exchangeKiloDeviceCode,
  KiloProtocolError,
  KiloUnavailable,
  readKiloProfile,
  refreshKiloTokens,
  startKiloPairing,
} from "./kilo-pairing-client.mjs";

const PAIRING_COOKIE = "__Host-pages_kilo_pairing";
const LOGIN_PATH = "/api/auth/login";
const PAGE_PATH = "/sign-in";
const POLL_PATH = "/api/auth/pairing";
const SCRIPT_PATH = "/api/auth/kilo-pairing.js";
// How often the page asks, and how soon after a "not yet" Kilo is asked again.
const POLL_SECONDS = 2;
// How long one request owns a pairing while it talks to Kilo. It outlasts the
// client's timeouts for an exchange and a profile read together, so a slow
// answer can't let a second request exchange the same device code.
const CLAIM_SECONDS = 30;

const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: "pairings",
    statements: Object.freeze([
      `CREATE TABLE IF NOT EXISTS kilo_pairings (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('pending', 'approved')),
        sealed TEXT NOT NULL,
        user_code TEXT NOT NULL,
        verification_url TEXT NOT NULL,
        return_to TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        busy_until INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 0
      )`,
    ]),
  }),
]);
const ready = isolateSetup((db) =>
  migrateSchema(db, { table: "kilo_pairing_schema", migrations: MIGRATIONS }),
);

/** This deployment's Kilo sign-in settings, or null when it doesn't use Kilo.
 * `PAGES_KILO_APP_URL` turns it on and must be a bare `https:` origin; a
 * loopback `http:` origin is accepted only beside the local test issuer flag.
 * A set but unusable value throws, so a misconfigured deployment fails loudly
 * and never falls back to another sign-in. */
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
  if (
    (app.protocol !== "https:" && !loopback) ||
    String(configured).replace(/\/$/, "") !== app.origin ||
    app.username ||
    app.password
  )
    throw new Error("Kilo sign-in is misconfigured");
  const origin = new URL(env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN || request.url).origin;
  return {
    appUrl: app.origin,
    origin,
    namespace: env.PAGES_KILO_PRINCIPAL_NAMESPACE?.trim() || "user:kilo",
    // What Kilo's approval page shows the person.
    client: { id: "pages", name: "Pages", redirectOrigin: origin },
  };
}

const TRANSITIONS = {
  pending: {
    kilo_pending: { state: "pending", effect: "wait" },
    kilo_approved: { state: "approved", effect: "persist_grant" },
    kilo_denied: { state: "denied", effect: "delete" },
    kilo_expired: { state: "expired", effect: "delete" },
    kilo_protocol_error: { state: "failed", effect: "delete" },
    deadline_passed: { state: "expired", effect: "delete" },
  },
  approved: {
    profile_read: { state: "signed_in", effect: "create_session" },
    profile_refused: { state: "failed", effect: "delete" },
    profile_mismatch: { state: "failed", effect: "delete" },
    kilo_protocol_error: { state: "failed", effect: "delete" },
    deadline_passed: { state: "expired", effect: "delete" },
  },
};

/** The next state of a pairing and the one effect the caller owes for it.
 * `pending` and `approved` are stored; `signed_in`, `denied`, `expired` and
 * `failed` end the pairing and its row. An event that can't happen in a state
 * throws. */
export function pairingTransition(state, event) {
  const next = Object.hasOwn(TRANSITIONS, state) && TRANSITIONS[state][event];
  if (!next) throw new Error("Invalid Kilo pairing transition");
  return { ...next };
}

/** The identity a Kilo account stands for: its id and, when it has one, its
 * name. The email address is left out, because Kilo doesn't say whether it
 * was confirmed and nothing here may act on an unconfirmed one. */
export function kiloIdentity(config, profile) {
  const principal = `${config.namespace}:${encodeURIComponent(profile.id)}`;
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
      ...(profile.name ? { displayName: profile.name } : {}),
    },
  };
}

/** What a session keeps to renew itself. The one-hour token is not in it.
 * The name is, so a renewal that can't read the profile still has an identity
 * to return with the refresh token Kilo just issued. */
const sessionBundle = (config, { id, name }, refreshToken) => ({
  kind: "kilo",
  appUrl: config.appUrl,
  userId: id,
  ...(name ? { name } : {}),
  refreshToken,
});

/** Renews Kilo sessions for `serverOidcSessionStatus`, or undefined when this
 * deployment doesn't use Kilo. A bundle from another sign-in method or another
 * Kilo origin, a refresh Kilo refuses, and a profile for another person each
 * end the session. A refresh Kilo can't answer propagates, and the session
 * code keeps the row and asks again. Once Kilo has rotated the refresh token,
 * the new one is always returned: a profile that can't be read then leaves
 * the stored name in place, because failing would discard the only refresh
 * token Kilo still accepts. */
export function kiloSessionProvider(env, request) {
  const config = kiloSignIn(env, request);
  if (!config) return undefined;
  return {
    async refresh(bundle) {
      if (
        bundle?.kind !== "kilo" ||
        bundle.appUrl !== config.appUrl ||
        typeof bundle.userId !== "string" ||
        typeof bundle.refreshToken !== "string"
      )
        throw new ServerSessionGrantRejected();
      const refreshed = await refreshKiloTokens(fetch, {
        appUrl: config.appUrl,
        refreshToken: bundle.refreshToken,
      });
      if (refreshed.refused) throw new ServerSessionGrantRejected();
      let account = { id: bundle.userId, name: bundle.name };
      try {
        const profile = await readKiloProfile(fetch, {
          appUrl: config.appUrl,
          token: refreshed.token,
        });
        if (profile.refused || profile.id !== bundle.userId) throw new ServerSessionGrantRejected();
        account = profile;
      } catch (error) {
        if (!(error instanceof KiloUnavailable) && !(error instanceof KiloProtocolError))
          throw error;
      }
      return {
        identity: kiloIdentity(config, account),
        expiresAt: Math.floor(Date.now() / 1000) + Math.floor(refreshed.expiresInSeconds),
        bundle: sessionBundle(config, account, refreshed.refreshToken),
      };
    },
  };
}

const pairingCookie = (secret, maxAge) =>
  `${PAIRING_COOKIE}=${secret}; Path=/; Max-Age=${Math.max(0, maxAge)}; HttpOnly; Secure; SameSite=Lax`;
const clearedCookie = () => pairingCookie("", 0);
const sealBinding = (id) => `kilo-pairing:${id}`;

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
    url.pathname === PAGE_PATH ||
    url.pathname.startsWith("/api/auth/")
  )
    return "/";
  return url.pathname + url.search + url.hash;
}

/** The pairing this browser's cookie names, or null. Two cookies of the name,
 * or one that isn't a pairing secret, name nothing. */
async function findPairing(request, env) {
  const secret = cookieValue(request, PAIRING_COOKIE);
  if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
  return env.DB.prepare("SELECT * FROM kilo_pairings WHERE id = ?")
    .bind(await secretHash(secret))
    .first();
}

/** One fenced write of a pairing's state. Returns the row as stored, or null
 * when another request moved it first. Where to land afterwards is not part of
 * the state: `beginPairing` sets it without the fence, so a second click never
 * invalidates the request that holds the claim. */
async function writePairing(env, row, changes) {
  const next = { ...row, ...changes, revision: row.revision + 1 };
  const result = await env.DB.prepare(
    `UPDATE kilo_pairings SET state = ?, sealed = ?, busy_until = ?, revision = ?
     WHERE id = ? AND revision = ?`,
  )
    .bind(next.state, next.sealed, next.busy_until, next.revision, row.id, row.revision)
    .run();
  return result.meta?.changes === 1 ? next : null;
}

const deletePairing = (env, row) =>
  env.DB.prepare("DELETE FROM kilo_pairings WHERE id = ? AND revision = ?")
    .bind(row.id, row.revision)
    .run();

const signInFailed = (reason) =>
  recordOidcEvent({
    type: "sign_in_failed",
    reason,
    phase: "pairing",
    kind: "kilo",
    outcome: "failure_page",
  });

const noStore = (response) => {
  response.headers.set("Cache-Control", "no-store");
  return response;
};

/** A poll's answer. A terminal status clears the pairing cookie. */
function pollAnswer(status, { returnTo, sessionCookie } = {}) {
  const response = noStore(json(returnTo ? { status, return_to: returnTo } : { status }));
  if (sessionCookie) response.headers.append("Set-Cookie", sessionCookie);
  if (status !== "pending") response.headers.append("Set-Cookie", clearedCookie());
  return response;
}

/** Ends a pairing: its row goes, the audit log gets a coded reason, and the
 * page is told the terminal state. */
async function endPairing(env, row, state, reason) {
  await deletePairing(env, row);
  signInFailed(reason);
  return pollAnswer(state);
}

/** `GET /api/auth/login`: starts a pairing and sends the browser to the
 * sign-in page. A browser that already holds a live pairing keeps it, so
 * repeated clicks don't spend Kilo's limit on pending pairings per address. */
async function beginPairing(request, env, config, now) {
  const url = new URL(request.url);
  const supplied = request.headers.get("origin");
  if (
    (supplied && supplied !== config.origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return noStore(new Response("Start sign-in from this Pages site.", { status: 403 }));
  const returnTo = safeReturnTo(url.searchParams.get("return_to"), config.origin);
  const toPage = (cookie) =>
    noStore(
      new Response(null, {
        status: 303,
        headers: { Location: PAGE_PATH, ...(cookie ? { "Set-Cookie": cookie } : {}) },
      }),
    );
  try {
    const live = await findPairing(request, env);
    if (live && live.expires_at > now) {
      // The newest click says where to land.
      await env.DB.prepare("UPDATE kilo_pairings SET return_to = ? WHERE id = ?")
        .bind(returnTo, live.id)
        .run();
      return toPage();
    }
    // A row a request is working on is that request's to finish or end.
    await env.DB.prepare(
      `DELETE FROM kilo_pairings WHERE id IN
       (SELECT id FROM kilo_pairings WHERE expires_at <= ? AND busy_until <= ?
        ORDER BY expires_at LIMIT 100)`,
    )
      .bind(now, now)
      .run();
    const started = await startKiloPairing(fetch, {
      appUrl: config.appUrl,
      client: config.client,
      // Kilo limits pending pairings per address; without the person's own,
      // everyone would share this Worker's.
      forwardedFor: request.headers.get("cf-connecting-ip") ?? undefined,
      userAgent: request.headers.get("user-agent") ?? undefined,
    });
    const secret = randomSecret();
    const id = await secretHash(secret);
    const lifetime = Math.floor(started.expiresInSeconds);
    await env.DB.prepare(
      `INSERT INTO kilo_pairings (id, state, sealed, user_code, verification_url, return_to, expires_at)
       VALUES (?, 'pending', ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        await sealServerSecret(env, { deviceCode: started.deviceCode }, sealBinding(id)),
        started.userCode,
        started.verificationUrl,
        returnTo,
        now + lifetime,
      )
      .run();
    return toPage(pairingCookie(secret, lifetime));
  } catch (error) {
    signInFailed(error instanceof KiloUnavailable ? "provider_unavailable" : "start_failed");
    return noStore(
      html(
        "Sign-in is unavailable",
        `<p>Pages couldn't reach Kilo to start signing you in. Try again in a moment.</p><p class="setup-actions"><a class="primary setup-action" href="${LOGIN_PATH}">Try again</a></p>`,
        503,
      ),
    );
  }
}

const escapeHtml = (value) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

/** `GET /sign-in`: the code to approve and the link to Kilo. Without a live
 * pairing it offers a fresh start and never redirects to one, so a reload
 * can't start pairing after pairing. */
async function signInPage(request, env, config, now) {
  const row = await findPairing(request, env);
  // The link is the one Kilo returned, on the configured Kilo origin only.
  const approval = row && new URL(row.verification_url);
  if (!row || row.expires_at <= now || approval.origin !== config.appUrl)
    return noStore(
      html(
        "Sign-in isn't active",
        `<p>This sign-in has expired or already finished.</p><p class="setup-actions"><a class="primary setup-action" href="${LOGIN_PATH}">Sign in</a></p>`,
      ),
    );
  const page = noStore(
    html(
      "Sign in with Kilo",
      `<p>Pages uses your Kilo account. Approve this sign-in in Kilo, and check that Kilo shows the same code.</p><p class="pairing-code"><strong>${escapeHtml(row.user_code)}</strong></p><p class="setup-actions"><a class="primary setup-action" href="${escapeHtml(approval.href)}" target="_blank" rel="noopener noreferrer">Approve in Kilo</a></p><p role="status">Waiting for approval. This page continues by itself.</p><script src="${SCRIPT_PATH}" defer></script>`,
    ),
  );
  // The page's script polls this origin; html()'s policy allows no connections.
  page.headers.set(
    "Content-Security-Policy",
    `${page.headers.get("Content-Security-Policy")}; connect-src 'self'`,
  );
  return page;
}

// Served from its own route because html()'s policy allows no inline script.
const PAGE_SCRIPT = `const status = document.querySelector('[role="status"]');
const ENDED = {
  denied: "Sign-in was denied in Kilo.",
  expired: "This sign-in expired.",
  failed: "Pages couldn't finish signing you in.",
};
function end(message) {
  const again = document.createElement("a");
  again.href = "${LOGIN_PATH}";
  again.textContent = "Start again";
  status.replaceChildren(message + " ", again);
}
async function poll() {
  let result = null;
  try {
    const response = await fetch("${POLL_PATH}", { method: "POST", credentials: "same-origin" });
    if (response.status >= 400 && response.status < 500) return end(ENDED.failed);
    result = await response.json();
  } catch {}
  if (result && result.status === "signed_in") {
    const path = String(result.return_to || "/");
    return location.replace(/^\\/(?![\\/\\\\])/.test(path) ? path : "/");
  }
  if (result && Object.hasOwn(ENDED, result.status)) return end(ENDED[result.status]);
  setTimeout(poll, ${POLL_SECONDS * 1000});
}
setTimeout(poll, ${POLL_SECONDS * 1000});
`;

/** `POST /api/auth/pairing`: one step of this browser's pairing. Answers
 * `pending`, or a terminal `signed_in`, `denied`, `expired` or `failed`. No
 * answer carries a code, a token, or anything about the account. */
async function advancePairing(request, env, config, now) {
  requireSameOrigin(request, env);
  const found = await findPairing(request, env);
  if (!found) return pollAnswer("expired");
  // One request at a time works on a pairing; the rest are told to keep
  // waiting, even past the deadline: the owner may hold an approval it is
  // about to store.
  if (found.busy_until > now) return pollAnswer("pending");
  if (found.expires_at <= now)
    return endPairing(
      env,
      found,
      pairingTransition(found.state, "deadline_passed").state,
      "expired",
    );
  let row = await writePairing(env, found, { busy_until: now + CLAIM_SECONDS });
  if (!row) return pollAnswer("pending");
  try {
    if (row.state === "pending") {
      const { deviceCode } = await openServerSecret(env, row.sealed, sealBinding(row.id));
      const answer = await exchangeKiloDeviceCode(fetch, { appUrl: config.appUrl, deviceCode });
      const next = pairingTransition("pending", `kilo_${answer.status}`);
      if (next.effect === "wait") {
        await writePairing(env, row, { busy_until: now + POLL_SECONDS });
        return pollAnswer("pending");
      }
      if (next.effect === "delete") return endPairing(env, row, next.state, answer.status);
      // Kilo has consumed the device code. Store the grant before using it.
      const grant = {
        token: answer.token,
        refreshToken: answer.refreshToken,
        tokenExpiresAt: now + Math.floor(answer.expiresInSeconds),
        userId: answer.userId,
      };
      const stored = await writePairing(env, row, {
        state: next.state,
        sealed: await sealServerSecret(env, grant, sealBinding(row.id)),
      });
      // This write loses only when the claim lapsed and another request took
      // the row. The grant can't be stored and the device code is spent, so
      // this request has nothing left to do; the row is the other request's.
      if (!stored) return pollAnswer("failed");
      row = stored;
    }
    const grant = await openServerSecret(env, row.sealed, sealBinding(row.id));
    const profile = await readKiloProfile(fetch, { appUrl: config.appUrl, token: grant.token });
    const event = profile.refused
      ? "profile_refused"
      : profile.id !== grant.userId
        ? "profile_mismatch"
        : "profile_read";
    const next = pairingTransition("approved", event);
    if (next.effect === "delete") return endPairing(env, row, next.state, event);
    // The pairing goes before the session is made, and only the request that
    // removes it makes one. A request that dies in between costs the person a
    // second sign-in; the other order could make two sessions that share one
    // refresh token.
    const ended = await env.DB.prepare(
      "DELETE FROM kilo_pairings WHERE id = ? AND revision = ? RETURNING return_to",
    )
      .bind(row.id, row.revision)
      .first();
    if (!ended) return pollAnswer("pending");
    const sessionCookie = await createServerSession(
      request,
      env,
      {
        identity: kiloIdentity(config, profile),
        expiresAt: grant.tokenExpiresAt,
        bundle: sessionBundle(config, profile, grant.refreshToken),
      },
      { onAuthEvent: recordOidcEvent },
    );
    return pollAnswer(next.state, { returnTo: ended.return_to, sessionCookie });
  } catch (error) {
    if (error instanceof KiloUnavailable) {
      // Let the next poll ask Kilo again without waiting out this claim.
      await writePairing(env, row, { busy_until: now });
      return pollAnswer("pending");
    }
    if (!(error instanceof KiloProtocolError)) throw error;
    const event = "kilo_protocol_error";
    return endPairing(env, row, pairingTransition(row.state, event).state, event);
  }
}

/** Kilo sign-in's routes. Returns null for any other path, and for every path
 * when this deployment doesn't use Kilo, so the caller's own routes answer. */
export async function handleKiloSignIn(request, env) {
  const { pathname } = new URL(request.url);
  if (![LOGIN_PATH, PAGE_PATH, POLL_PATH, SCRIPT_PATH].includes(pathname)) return null;
  const config = kiloSignIn(env, request);
  if (!config) return null;
  const now = Math.floor(Date.now() / 1000);
  const route = `${request.method} ${pathname}`;
  if (route === `GET ${SCRIPT_PATH}`)
    return noStore(
      new Response(PAGE_SCRIPT, {
        headers: {
          "Content-Type": "text/javascript; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        },
      }),
    );
  // Every other route reads or writes the pairing table.
  await ready(env.DB);
  if (route === `GET ${LOGIN_PATH}`) return beginPairing(request, env, config, now);
  if (route === `GET ${PAGE_PATH}`) return signInPage(request, env, config, now);
  if (route === `POST ${POLL_PATH}`) return advancePairing(request, env, config, now);
  return noStore(new Response(null, { status: 405 }));
}
