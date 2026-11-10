/**
 * Quota rule values and limits, shared by the Worker's resolver
 * (page-quota.mjs) and the operator script (scripts/quota-rules.mjs), so a
 * rule the script writes is the rule the Worker matches.
 *
 * The script runs under plain `node`, which has no tsconfig path aliases, so
 * this module imports sharing.ts by relative path and imports nothing that
 * needs the Worker runtime.
 */
import { normalizeInviteEmail } from "../../../../../../apps/notebook-cloud/src/sharing.ts";

/** The largest limit any rule or default can set. Catalog scans that read
 * every entry stay bounded by it. */
export const MAX_PAGE_QUOTA = 10_000;
/** The most rules one snapshot reads. A larger table resolves every account
 * to the default until it is trimmed. */
export const QUOTA_RULE_LIMIT = 1000;
export const RULE_KINDS = Object.freeze(["email", "domain"]);

export function validPageLimit(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_PAGE_QUOTA;
}

const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const validDomain = (domain) => domain.length <= 253 && DOMAIN.test(domain);

/** The domain of a normalized email, or null when it isn't a valid domain. */
export function emailDomain(email) {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  return validDomain(domain) ? domain : null;
}

/** A rule's match value in the form the resolver compares, or null when it
 * can never match: emails as invite emails normalize them, domains lowercased
 * ASCII. */
export function normalizeRuleMatch(kind, value) {
  if (typeof value !== "string") return null;
  if (kind === "email") {
    try {
      const email = normalizeInviteEmail(value);
      return emailDomain(email) ? email : null;
    } catch {
      return null;
    }
  }
  if (kind === "domain") {
    const domain = value.trim().toLowerCase();
    return validDomain(domain) ? domain : null;
  }
  return null;
}
