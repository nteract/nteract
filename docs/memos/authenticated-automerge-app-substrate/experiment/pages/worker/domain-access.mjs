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

/** Project verified evidence into a short-lived, host-only authorization lease. */
export async function domainAccessForIdentity(env, identity, now = Date.now()) {
  const namespace = env.NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE?.trim();
  if (
    identity.namespace !== namespace ||
    !identity.principal.startsWith(`${namespace}:`) ||
    !Number.isFinite(identity.expiresAt) ||
    identity.expiresAt <= now
  )
    return undefined;
  for (const domain of companyViewDomains(env)) {
    if (identity.credentialKind === "api-key" && identity.verifiedEmail) {
      let email;
      try {
        email = normalizeInviteEmail(identity.verifiedEmail);
      } catch {
        continue;
      }
      if (email.slice(email.lastIndexOf("@") + 1) === domain)
        return { domain, namespace, expiresAt: identity.expiresAt };
    }
    if (
      ["oidc", "oauth"].includes(identity.credentialKind) &&
      identity.emailProof &&
      (await appSessionHasFreshVerifiedEmailDomain(
        env,
        { principal: identity.principal, metadata: identity.emailProof },
        domain,
        Math.floor(now / 1000),
      ))
    ) {
      return {
        domain,
        namespace,
        expiresAt: Math.min(
          identity.expiresAt,
          (identity.emailProof.identityVerifiedAt + NOTEBOOK_CLOUD_IDENTITY_PROOF_MAX_AGE_SECONDS) *
            1000,
        ),
      };
    }
  }
  return undefined;
}
