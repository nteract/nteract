import {
  appSessionHasFreshVerifiedEmailDomain,
  NOTEBOOK_CLOUD_IDENTITY_PROOF_MAX_AGE_SECONDS,
} from "@cloud/app-session.ts";
import { normalizeInviteEmail } from "@cloud/sharing.ts";
import { companyDomainValid, identityProvider } from "../identity-provider.mjs";
import { domainViewRole } from "./authz.mjs";

/**
 * The company domains this deployment allows, read from
 * PAGES_COMPANY_VIEW_DOMAINS: a comma-separated list, with spaces around each
 * entry ignored. Deliberately an allowlist, never a caller-provided domain or
 * a consumer provider blocklist. Every entry must be a valid hostname
 * (`companyDomainValid`) and one the identity provider's reviewed list names.
 * One entry that fails either check turns company sharing off for the whole
 * deployment.
 */
export function companyViewDomains(env) {
  const configured = env.PAGES_COMPANY_VIEW_DOMAINS;
  if (
    typeof configured !== "string" ||
    !configured.trim() ||
    !env.NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE?.trim()
  )
    return [];
  const values = [...new Set(configured.split(",").map((value) => value.trim()))];
  const reviewed = identityProvider(env).companyDomains;
  return values.every((value) => companyDomainValid(value) && reviewed.includes(value))
    ? values
    : [];
}

/** The Page's company domain grant, `{ domain, namespace, role }`, when this
 * deployment allows the domain, the grant is for its account namespace and
 * names a role; else null. A grant stored without a role is a viewer grant. */
export function configuredDomainView(metadata, env) {
  const value = metadata?.acl?.domainView;
  const role = domainViewRole(value);
  return value &&
    role &&
    companyViewDomains(env).includes(value.domain) &&
    value.namespace === env.NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE?.trim()
    ? { domain: value.domain, namespace: value.namespace, role }
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
    } else if (identity.credentialKind === "upload-capability") {
      // An upload capability carries the lease its issuer held, signed by the
      // Page (asset-uploads.mjs), and holds it no longer than the issuer did.
      const evidence = identity.domainEvidence;
      if (evidence?.domain === domain && evidence.expiresAt > now)
        leases.push({
          domain,
          namespace,
          expiresAt: Math.min(identity.expiresAt, evidence.expiresAt),
        });
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
