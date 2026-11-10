import { createServerSession, ServerSessionGrantRejected } from "@cloud/server-oidc.ts";
import {
  openServerSecret,
  randomSecret,
  sealServerSecret,
  secretHash,
} from "@cloud/oidc-session-store.ts";
import { html } from "./oauth.mjs";
import { HttpError, json, requireSameOrigin } from "./auth.mjs";
import { logAuthEvent } from "./auth-events.mjs";
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

const COOKIE = "__Host-pages_kilo_pairing";
const TABLE = "kilo_pairings";
const FAILURES = new Set([
  "denied",
  "expired",
  "profile_refused",
  "profile_mismatch",
  "protocol_error",
]);
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

/** Resolves the configured Kilo origin and this deployment's public client. */
export function kiloSignIn(env, request) {
  if (!env?.PAGES_KILO_APP_URL) return null;
  try {
    const configuredUrl = String(env.PAGES_KILO_APP_URL);
    const app = new URL(configuredUrl);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(app.hostname);
    if (
      (app.protocol !== "https:" &&
        !(app.protocol === "http:" && local && env.NOTEBOOK_CLOUD_LOCAL_OIDC === "true")) ||
      configuredUrl.includes("?") ||
      configuredUrl.includes("#") ||
      app.username ||
      app.password ||
      app.pathname !== "/" ||
      app.search ||
      app.hash
    )
      throw new Error();
    const publicOrigin = new URL(env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN || request.url).origin;
    return {
      appUrl: app.origin,
      namespace: env.PAGES_KILO_PRINCIPAL_NAMESPACE?.trim() || "user:kilo",
      client: { id: "pages", name: "Pages", redirectOrigin: publicOrigin },
    };
  } catch {
    throw new Error("Kilo sign-in is misconfigured");
  }
}

/** Advances one pairing without I/O; callers persist the returned state before effects. */
export function pairingTransition(state, event) {
  const move = (next, effect) => ({ state: next, effect });
  if (state === "pending") {
    if (event === "kilo_pending") return move("pending", "wait");
    if (event === "kilo_approved") return move("approved", "persist_grant");
    if (event === "kilo_denied") return move("denied", "delete");
    if (event === "kilo_expired" || event === "deadline_passed") return move("expired", "delete");
  } else if (state === "approved") {
    if (event === "profile_read") return move("signed_in", "create_session");
    if (event === "profile_refused" || event === "profile_mismatch")
      return move("failed", "delete");
    if (event === "deadline_passed") return move("expired", "delete");
  }
  throw new Error("Invalid Kilo pairing transition");
}

/** Builds the host-session identity with no email proof. */
export function kiloIdentity(config, profile) {
  const principal = `${config.namespace}:${encodeURIComponent(profile.id)}`;
  return {
    principal,
    operator: "browser",
    actorLabel: `${principal}/browser`,
    scope: "owner",
    metadata: {
      provider: "oidc",
      transport: "host-session-cookie",
      principalNamespace: config.namespace,
      email: profile.email,
      emailVerified: false,
      ...(profile.name ? { displayName: profile.name } : {}),
    },
  };
}

/** Returns the refresh adapter for this configured Kilo origin. */
export function kiloSessionProvider(env, request) {
  const config = kiloSignIn(env, request);
  if (!config) return undefined;
  return {
    async refresh(bundle) {
      if (bundle?.kind !== "kilo" || bundle.appUrl !== config.appUrl)
        throw new ServerSessionGrantRejected();
      const refreshed = await refreshKiloTokens(fetch, {
        appUrl: config.appUrl,
        refreshToken: bundle.refreshToken,
      });
      if (refreshed.refused) throw new ServerSessionGrantRejected();
      const profile = await readKiloProfile(fetch, {
        appUrl: config.appUrl,
        token: refreshed.token,
      });
      if (profile.refused || profile.id !== bundle.userId) throw new ServerSessionGrantRejected();
      return {
        identity: kiloIdentity(config, profile),
        expiresAt: Math.floor(Date.now() / 1000) + refreshed.expiresInSeconds,
        bundle: { ...bundle, refreshToken: refreshed.refreshToken },
      };
    },
  };
}

function cookieSecret(request) {
  const value = request.headers.get("cookie") ?? "";
  for (const part of value.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=") || null;
  }
  return null;
}
function bindingCookie(secret, maxAge = 0) {
  return `${COOKIE}=${secret}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, maxAge)}`;
}
function codedFailure(reason, principal) {
  if (!FAILURES.has(reason)) reason = "protocol_error";
  void logAuthEvent({
    action: "sign_in.failed",
    ...(principal && { principal }),
    credential: "oidc",
    reason,
    phase: "browser",
    kind: "kilo",
    outcome: "failure_page",
  });
}
function responseJson(body, status = 200, cookies = []) {
  const response = json(body, status);
  for (const cookie of Array.isArray(cookies) ? cookies : [cookies])
    if (cookie) response.headers.append("Set-Cookie", cookie);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
function returnTo(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\r\n]/.test(value) ||
    value.startsWith("/api/auth/") ||
    value === "/sign-in"
  )
    return "/";
  return value;
}
function signInScript() {
  return `const status = document.querySelector('[role="status"]');
const startAgain = '<a href="/api/auth/login">Start again</a>';
const messages = { denied: 'Sign-in was denied. ', expired: 'Sign-in expired. ', failed: 'Sign-in could not be completed. ' };
async function poll() {
  try {
    const response = await fetch('/api/auth/pairing', { method: 'POST', credentials: 'same-origin', headers: { 'Origin': location.origin } });
    const result = await response.json();
    if (result.status === 'signed_in') { location.replace(result.return_to); return; }
    if (result.status in messages) { status.textContent = ''; status.insertAdjacentHTML('beforeend', messages[result.status] + startAgain); return; }
  } catch {}
  setTimeout(poll, 2000);
}
setTimeout(poll, 2000);`;
}

async function readRow(env, id) {
  await ready(env.DB);
  return env.DB.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).bind(id).first();
}
async function pruneExpired(env, now) {
  const result = await env.DB.prepare(
    `SELECT id, revision FROM ${TABLE} WHERE expires_at <= ? ORDER BY expires_at LIMIT 100`,
  )
    .bind(now)
    .all();
  for (const row of result.results ?? []) await deleteRow(env, row);
}
async function deleteRow(env, row) {
  return env.DB.prepare(`DELETE FROM ${TABLE} WHERE id = ? AND revision = ?`)
    .bind(row.id, row.revision)
    .run();
}
async function updateRow(env, row, changes) {
  return env.DB.prepare(
    `UPDATE ${TABLE} SET state = ?, sealed = ?, busy_until = ?, revision = revision + 1 WHERE id = ? AND revision = ?`,
  )
    .bind(changes.state, changes.sealed, changes.busyUntil, row.id, row.revision)
    .run();
}
async function logStartFailure(error) {
  if (!(error instanceof KiloUnavailable)) codedFailure("protocol_error");
}

/** Handles browser Kilo sign-in routes, returning null for unrelated requests or disabled deployments. */
export async function handleKiloSignIn(request, env) {
  const url = new URL(request.url);
  if (
    !["/api/auth/login", "/sign-in", "/api/auth/pairing", "/api/auth/kilo-pairing.js"].includes(
      url.pathname,
    )
  )
    return null;
  const config = kiloSignIn(env, request);
  if (!config) return null;
  const now = Math.floor(Date.now() / 1000);
  if (url.pathname === "/api/auth/kilo-pairing.js" && request.method === "GET")
    return new Response(signInScript(), {
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  if (url.pathname === "/api/auth/login" && request.method === "GET") {
    const publicOrigin = new URL(env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN || request.url).origin;
    if (
      (request.headers.get("origin") && request.headers.get("origin") !== publicOrigin) ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      return new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store" } });
    try {
      await ready(env.DB);
      await pruneExpired(env, now);
      const started = await startKiloPairing(fetch, {
        appUrl: config.appUrl,
        client: config.client,
        forwardedFor: request.headers.get("cf-connecting-ip") ?? undefined,
        userAgent: request.headers.get("user-agent") ?? undefined,
      });
      const secret = randomSecret();
      const id = await secretHash(secret);
      const expiresAt = now + started.expiresInSeconds;
      const sealed = await sealServerSecret(
        env,
        { deviceCode: started.deviceCode },
        `kilo-pairing:${id}`,
      );
      await env.DB.prepare(
        `INSERT INTO ${TABLE} (id,state,sealed,user_code,verification_url,return_to,expires_at) VALUES (?, 'pending', ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          sealed,
          started.userCode,
          started.verificationUrl,
          returnTo(url.searchParams.get("return_to")),
          expiresAt,
        )
        .run();
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/sign-in",
          "Set-Cookie": bindingCookie(secret, expiresAt - now),
          "Cache-Control": "no-store",
        },
      });
    } catch (error) {
      await logStartFailure(error);
      return html("Sign-in unavailable", "<p>Sign-in is temporarily unavailable.</p>", 503);
    }
  }
  if (url.pathname === "/sign-in" && request.method === "GET") {
    const secret = cookieSecret(request);
    const row = secret ? await readRow(env, await secretHash(secret)) : null;
    if (!row || row.expires_at <= now) {
      if (row) codedFailure("expired");
      return html(
        "Sign-in expired",
        '<p>This sign-in has expired.</p><p><a class="primary setup-action" href="/api/auth/login">Start again</a></p>',
      );
    }
    const safeCode = row.user_code.replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
    const safeUrl = new URL(row.verification_url);
    if (safeUrl.origin !== config.appUrl)
      return html("Sign-in failed", "<p>Sign-in could not be completed.</p>", 500);
    const page = html(
      "Sign in with Kilo",
      `<p>Pages uses your Kilo account.</p><h2 class="user-code">${safeCode}</h2><p class="setup-actions"><a class="primary setup-action" href="${safeUrl.href}" target="_blank" rel="noopener noreferrer">Approve in Kilo</a></p><p>This page continues by itself after approval.</p><p role="status" aria-live="polite">Waiting for approval.</p><script src="/api/auth/kilo-pairing.js" defer></script>`,
    );
    page.headers.set(
      "Content-Security-Policy",
      page.headers
        .get("Content-Security-Policy")
        .replace("script-src 'self';", "script-src 'self'; connect-src 'self';"),
    );
    return page;
  }
  if (url.pathname === "/api/auth/pairing" && request.method === "POST") {
    try {
      requireSameOrigin(request, env);
    } catch (error) {
      if (error instanceof HttpError)
        return responseJson({ error: "origin_rejected" }, error.status);
      return responseJson({ error: "origin_rejected" }, 403);
    }
    const secret = cookieSecret(request);
    const row = secret ? await readRow(env, await secretHash(secret)) : null;
    if (!row || row.expires_at <= now) {
      if (row) codedFailure("expired");
      return responseJson({ status: "expired" }, 200, bindingCookie("", 0));
    }
    const busyUntil = now + (row.state === "pending" ? 2 : 30);
    const claim = await env.DB.prepare(
      `UPDATE ${TABLE} SET busy_until = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND busy_until <= ?`,
    )
      .bind(busyUntil, row.id, row.revision, now)
      .run();
    if (!claim.meta?.changes) return responseJson({ status: "pending" });
    const claimed = { ...row, revision: row.revision + 1, busy_until: busyUntil };
    let grant;
    if (row.state === "pending") {
      const pending = await openServerSecret(env, row.sealed, `kilo-pairing:${row.id}`);
      try {
        const exchanged = await exchangeKiloDeviceCode(fetch, {
          appUrl: config.appUrl,
          deviceCode: pending.deviceCode,
        });
        if (exchanged.status === "pending") return responseJson({ status: "pending" });
        if (exchanged.status === "denied" || exchanged.status === "expired") {
          const result = pairingTransition(
            "pending",
            exchanged.status === "denied" ? "kilo_denied" : "kilo_expired",
          );
          await deleteRow(env, claimed);
          codedFailure(exchanged.status);
          return responseJson({ status: result.state }, 200, bindingCookie("", 0));
        }
        const result = pairingTransition("pending", "kilo_approved");
        grant = {
          token: exchanged.token,
          refreshToken: exchanged.refreshToken,
          tokenExpiresAt: now + exchanged.expiresInSeconds,
          userId: exchanged.userId,
        };
        const sealed = await sealServerSecret(env, grant, `kilo-pairing:${row.id}`);
        const approvedLease = now + 30;
        const saved = await updateRow(env, claimed, {
          state: result.state,
          sealed,
          busyUntil: approvedLease,
        });
        if (!saved.meta?.changes) return responseJson({ status: "pending" });
        Object.assign(claimed, {
          state: "approved",
          sealed,
          busy_until: approvedLease,
          revision: claimed.revision + 1,
        });
      } catch (error) {
        if (error instanceof KiloUnavailable) {
          await env.DB.prepare(
            `UPDATE ${TABLE} SET busy_until = ?, revision = revision + 1 WHERE id = ? AND revision = ?`,
          )
            .bind(now, claimed.id, claimed.revision)
            .run();
          return responseJson({ status: "pending" });
        }
        if (error instanceof KiloProtocolError) {
          await deleteRow(env, claimed);
          codedFailure("protocol_error");
          return responseJson({ status: "failed" }, 200, bindingCookie("", 0));
        }
        throw error;
      }
    }
    if (!grant) grant = await openServerSecret(env, claimed.sealed, `kilo-pairing:${claimed.id}`);
    let profile;
    try {
      profile = await readKiloProfile(fetch, { appUrl: config.appUrl, token: grant.token });
    } catch (error) {
      if (error instanceof KiloUnavailable) {
        await env.DB.prepare(
          `UPDATE ${TABLE} SET busy_until = ?, revision = revision + 1 WHERE id = ? AND revision = ?`,
        )
          .bind(now, claimed.id, claimed.revision)
          .run();
        return responseJson({ status: "pending" });
      }
      if (error instanceof KiloProtocolError) {
        await deleteRow(env, claimed);
        codedFailure("protocol_error", `${config.namespace}:${encodeURIComponent(grant.userId)}`);
        return responseJson({ status: "failed" }, 200, bindingCookie("", 0));
      }
      throw error;
    }
    const principal = `${config.namespace}:${encodeURIComponent(grant.userId)}`;
    if (profile.refused || profile.id !== grant.userId) {
      const reason = profile.refused ? "profile_refused" : "profile_mismatch";
      const result = pairingTransition(
        "approved",
        profile.refused ? "profile_refused" : "profile_mismatch",
      );
      await deleteRow(env, claimed);
      codedFailure(reason, principal);
      return responseJson({ status: result.state }, 200, bindingCookie("", 0));
    }
    pairingTransition("approved", "profile_read");
    const identity = kiloIdentity(config, profile);
    const sessionCookie = await createServerSession(
      request,
      env,
      {
        identity,
        expiresAt: grant.tokenExpiresAt,
        bundle: {
          kind: "kilo",
          appUrl: config.appUrl,
          userId: grant.userId,
          refreshToken: grant.refreshToken,
        },
      },
      {
        onAuthEvent: (event) => {
          if (event.type === "sign_in")
            void logAuthEvent({
              action: "sign_in.succeeded",
              principal: event.principal,
              credential: "oidc",
            });
        },
      },
    );
    await deleteRow(env, claimed);
    return responseJson({ status: "signed_in", return_to: row.return_to }, 200, [
      sessionCookie,
      bindingCookie("", 0),
    ]);
  }
  return null;
}
