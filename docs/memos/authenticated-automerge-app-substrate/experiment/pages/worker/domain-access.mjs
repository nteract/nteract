import {
  appSessionHasFreshVerifiedEmailDomain,
  NOTEBOOK_CLOUD_IDENTITY_PROOF_MAX_AGE_SECONDS,
} from "@cloud/app-session.ts";
import { normalizeInviteEmail } from "@cloud/sharing.ts";

// Deliberately a company allowlist, never a caller-provided domain or a consumer
// provider blocklist. This deployment can enable only the reviewed company.
export function companyViewDomains(env) {
  const configured = env.PAGES_COMPANY_VIEW_DOMAINS;
  if (
    typeof configured !== "string" ||
    !configured.trim() ||
    !env.NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE?.trim()
  )
    return [];
  const values = [...new Set(configured.split(",").map((value) => value.trim().toLowerCase()))];
  return values.every((value) => value === "anaconda.com") ? values : [];
}

export function configuredDomainView(metadata, env) {
  const value = metadata?.acl?.domainView;
  return value &&
    companyViewDomains(env).includes(value.domain) &&
    value.namespace === env.NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE?.trim()
    ? { domain: value.domain, namespace: value.namespace }
    : null;
}

/**
 * Every host-allowed company domain this identity proves with fresh verified
 * email evidence, each as a short-lived, host-only lease. The same evidence
 * gates reading a company-shared Page and an owner offering or choosing that
 * company audience.
 */
export async function verifiedCompanyDomains(env, identity, now = Date.now()) {
  const namespace = env.NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE?.trim();
  if (
    !identity ||
    identity.namespace !== namespace ||
    typeof identity.principal !== "string" ||
    !identity.principal.startsWith(`${namespace}:`) ||
    !Number.isFinite(identity.expiresAt) ||
    identity.expiresAt <= now
  )
    return [];
  const leases = [];
  for (const domain of companyViewDomains(env)) {
    if (identity.credentialKind === "api-key" && identity.verifiedEmail) {
      let email;
      try {
        email = normalizeInviteEmail(identity.verifiedEmail);
      } catch {
        continue;
      }
      if (email.slice(email.lastIndexOf("@") + 1) === domain)
        leases.push({ domain, namespace, expiresAt: identity.expiresAt });
    } else if (
      ["oidc", "oauth"].includes(identity.credentialKind) &&
      identity.emailProof &&
      (await appSessionHasFreshVerifiedEmailDomain(
        env,
        { principal: identity.principal, metadata: identity.emailProof },
        domain,
        Math.floor(now / 1000),
      ))
    ) {
      leases.push({
        domain,
        namespace,
        expiresAt: Math.min(
          identity.expiresAt,
          (identity.emailProof.identityVerifiedAt + NOTEBOOK_CLOUD_IDENTITY_PROOF_MAX_AGE_SECONDS) *
            1000,
        ),
      });
    }
  }
  return leases;
}

/**
 * Bounded, PII-free proof state for each host-allowed company domain:
 * "verified" (fresh proof), "expired" (browser/OAuth proof that bound this
 * domain but is past its freshness window), or "missing" (no proof for it).
 * Only "verified" authorizes anything; "expired" tells an owner that signing in
 * again with the same account restores it.
 */
export async function companyDomainProof(env, identity, now = Date.now()) {
  const verified = new Set(
    (await verifiedCompanyDomains(env, identity, now)).map(({ domain }) => domain),
  );
  const namespace = env.NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE?.trim();
  const verifiedAt = identity?.emailProof?.identityVerifiedAt;
  const mayHaveExpired =
    !!identity &&
    identity.namespace === namespace &&
    typeof identity.principal === "string" &&
    identity.principal.startsWith(`${namespace}:`) &&
    ["oidc", "oauth"].includes(identity.credentialKind) &&
    Number.isSafeInteger(verifiedAt) &&
    verifiedAt > 0 &&
    verifiedAt * 1000 <= now;
  const proof = {};
  for (const domain of companyViewDomains(env)) {
    if (verified.has(domain)) proof[domain] = "verified";
    else if (
      mayHaveExpired &&
      // Evaluated at its own verification time, the binding shows which domain
      // this stale proof covered. It authorizes nothing by itself.
      (await appSessionHasFreshVerifiedEmailDomain(
        env,
        { principal: identity.principal, metadata: identity.emailProof },
        domain,
        verifiedAt,
      ))
    )
      proof[domain] = "expired";
    else proof[domain] = "missing";
  }
  return proof;
}

/** Project verified evidence into a short-lived, host-only authorization lease. */
export async function domainAccessForIdentity(env, identity, now = Date.now()) {
  return (await verifiedCompanyDomains(env, identity, now))[0];
}
