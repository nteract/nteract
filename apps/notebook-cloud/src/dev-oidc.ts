// Dev-only mount for the @nteract/local-oidc issuer.
//
// The worker serves the issuer under `/dev/oidc/*` only when
// `NOTEBOOK_CLOUD_LOCAL_OIDC === "true"`. When the flag is off, the handler
// returns null and the request falls through to the ordinary 404, so production
// (which never sets the flag) exposes nothing new. Turning the flag on stands up
// a full OIDC provider that auto-grants a fixed dev user, letting a local cloud
// shell run the real OIDC verification and renewal paths without a live IdP.
//
// The issuer is built lazily on first request and cached for the worker's boot,
// keyed by its resolved issuer URL. That URL is NOTEBOOK_CLOUD_OIDC_ISSUER when
// set, so the token `iss` claim is exactly what the worker's OIDC verifier and
// the viewer's auth config point at; it falls back to the request origin plus
// the mount path when unconfigured. The var is preferred rather than the raw
// request origin because wrangler dev serves the worker under its configured
// route host, so the request origin is not the loopback origin the browser and
// verifier use. Its RS256 key is ephemeral (see packages/local-oidc), so a
// worker restart rotates the key and invalidates every previously issued token.

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
export function handleLocalOidcRequest(request: Request, env: Env): Promise<Response | null> {
  if (!localOidcEnabled(env)) {
    return Promise.resolve(null);
  }
  return localOidcIssuer(env, request).handle(request);
}

function localOidcIssuer(env: Env, request: Request): LocalOidcIssuer {
  const issuerUrl =
    env.NOTEBOOK_CLOUD_OIDC_ISSUER?.trim() ||
    `${new URL(request.url).origin}${NOTEBOOK_CLOUD_LOCAL_OIDC_MOUNT_PATH}`;
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
