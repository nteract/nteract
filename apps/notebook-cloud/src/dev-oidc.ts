// Dev-only mount for the @nteract/local-oidc issuer.
//
// The worker serves the issuer under the fixed `/dev/oidc/*` mount only when
// `NOTEBOOK_CLOUD_LOCAL_OIDC === "true"`. When the flag is off, or when the
// request path is outside that fixed mount, the handler returns null and the
// request falls through to the ordinary 404 or real route handler. Turning the
// flag on stands up a full OIDC provider that auto-grants a fixed dev user,
// letting a local cloud shell run the real OIDC verification and renewal paths
// without a live IdP. `NOTEBOOK_CLOUD_LOCAL_OIDC_DELAY_MS` is intentionally
// dev-gated here so local e2e can simulate a hung issuer without adding any
// production route surface.
//
// The issuer is built lazily on first request and cached for the worker's boot,
// keyed by its resolved issuer URL. That URL is NOTEBOOK_CLOUD_OIDC_ISSUER when
// set, so the token `iss` claim is exactly what the worker's OIDC verifier and
// the viewer's auth config point at; it falls back to the request origin plus
// the mount path when unconfigured. Requests are still accepted only at the
// fixed mount, then mapped to the configured issuer URL path before they reach
// the issuer. The var is preferred rather than the raw request origin because
// wrangler dev serves the worker under its configured route host, so the request
// origin is not the loopback origin the browser and verifier use. Its RS256 key
// is ephemeral (see packages/local-oidc), so a worker restart rotates the key
// and invalidates every previously issued token.

import { createLocalOidcIssuer, type LocalOidcIssuer } from "@nteract/local-oidc";
import type { Env } from "./cloudflare-types.ts";

export const NOTEBOOK_CLOUD_LOCAL_OIDC_MOUNT_PATH = "/dev/oidc";
export const NOTEBOOK_CLOUD_LOCAL_OIDC_CLIENT_ID = "local-oidc-client";
export const NOTEBOOK_CLOUD_LOCAL_OIDC_DEFAULT_TTL_SECONDS = 300;

const DEV_USER = {
  email: "dev@localhost",
  givenName: "Local",
  familyName: "Developer",
} as const;

// One issuer instance per resolved issuer URL, held for the worker's boot. Every
// restart starts with an empty cache and a fresh signing key.
const issuersByUrl = new Map<string, LocalOidcIssuer>();

export function localOidcEnabled(env: Env): boolean {
  return env.NOTEBOOK_CLOUD_LOCAL_OIDC === "true";
}

/**
 * Serve a `/dev/oidc/*` request from the mounted issuer, or return null when the
 * flag is off or the path is outside the mount so the caller falls through to
 * its normal not-found handling.
 */
export async function handleLocalOidcRequest(request: Request, env: Env): Promise<Response | null> {
  if (!localOidcEnabled(env)) {
    return null;
  }
  const url = new URL(request.url);
  if (!isLocalOidcMountPath(url.pathname)) {
    return null;
  }
  // Delay only the token endpoint: discovery and authorize stay fast so a
  // sign-in reaches the callback, then the code exchange hangs - the
  // production shape a slow issuer produces and the one the callback's
  // timeout recovery exists for.
  if (url.pathname.endsWith("/token")) {
    await delayLocalOidcRequest(env);
  }
  const issuerUrl = localOidcIssuerUrl(env, request);
  return localOidcIssuer(env, issuerUrl).handle(requestForIssuerPath(request, url, issuerUrl));
}

function localOidcIssuerUrl(env: Env, request: Request): string {
  return (
    env.NOTEBOOK_CLOUD_OIDC_ISSUER?.trim() ||
    `${new URL(request.url).origin}${NOTEBOOK_CLOUD_LOCAL_OIDC_MOUNT_PATH}`
  );
}

function localOidcIssuer(env: Env, issuerUrl: string): LocalOidcIssuer {
  const cached = issuersByUrl.get(issuerUrl);
  if (cached) {
    return cached;
  }
  const issuer = createLocalOidcIssuer({
    issuerUrl,
    clientId: env.NOTEBOOK_CLOUD_OIDC_CLIENT_ID?.trim() || NOTEBOOK_CLOUD_LOCAL_OIDC_CLIENT_ID,
    defaultTokenTtlSeconds: localOidcTtlSeconds(env),
    users: [DEV_USER],
  });
  issuersByUrl.set(issuerUrl, issuer);
  return issuer;
}

function isLocalOidcMountPath(pathname: string): boolean {
  return (
    pathname === NOTEBOOK_CLOUD_LOCAL_OIDC_MOUNT_PATH ||
    pathname.startsWith(`${NOTEBOOK_CLOUD_LOCAL_OIDC_MOUNT_PATH}/`)
  );
}

// The issuer routes by the pathname of its configured issuer URL, but requests
// are only ever accepted at the fixed mount; translate the mount-relative path
// onto the issuer's path so both agree. Identity under the default config,
// where the issuer URL's path IS the mount path.
function requestForIssuerPath(request: Request, url: URL, issuerUrl: string): Request {
  const rewritten = new URL(url);
  const issuerPath = new URL(issuerUrl).pathname.replace(/\/+$/, "");
  const suffix =
    url.pathname === NOTEBOOK_CLOUD_LOCAL_OIDC_MOUNT_PATH
      ? ""
      : url.pathname.slice(NOTEBOOK_CLOUD_LOCAL_OIDC_MOUNT_PATH.length);
  rewritten.pathname = `${issuerPath}${suffix}` || "/";
  return new Request(rewritten, request);
}

function localOidcTtlSeconds(env: Env): number {
  const raw = env.NOTEBOOK_CLOUD_LOCAL_OIDC_TTL_SECONDS?.trim();
  if (!raw) {
    return NOTEBOOK_CLOUD_LOCAL_OIDC_DEFAULT_TTL_SECONDS;
  }
  const parsed = Number(raw);
  // The minted token must outlive the verifier's 60s expiry skew, otherwise a
  // freshly rotated token reads as already expired. Ignore a nonsensical value
  // and keep the safe default rather than mint tokens that never verify.
  if (!Number.isInteger(parsed) || parsed < 120) {
    return NOTEBOOK_CLOUD_LOCAL_OIDC_DEFAULT_TTL_SECONDS;
  }
  return parsed;
}

function localOidcDelayMs(env: Env): number {
  const raw = env.NOTEBOOK_CLOUD_LOCAL_OIDC_DELAY_MS?.trim();
  if (!raw) {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return parsed;
}

function delayLocalOidcRequest(env: Env): Promise<void> {
  const delayMs = localOidcDelayMs(env);
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
