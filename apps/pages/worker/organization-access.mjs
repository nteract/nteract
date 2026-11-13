/** A Page shared with an organization, and the audience keys that name a
 * Page's link audience in the listing index.
 *
 * `acl.organizationAccess` is `{ id, name, namespace, role }` or absent: the
 * one organization whose members may open the Page by link, with `role`
 * (viewer, commenter or editor). `name` is the organization's name when the
 * owner chose it, kept for display once the owner can no longer prove
 * membership. Nobody becomes a member through it: a reader's access comes
 * from a membership lease (kilo-membership.mjs) matching `id` in the same
 * `namespace`, and ends with that lease.
 *
 * A Page has at most one link audience: a company domain (`acl.domainView`)
 * or an organization, never both. */
import { identityProvider } from "../identity-provider.mjs";
import { MEMBER_ROLES } from "./access.mjs";
import { configuredDomainView } from "./domain-access.mjs";
import { kiloPrincipalNamespace } from "./kilo-config.mjs";

/** The listing index's audience key for an organization. A company domain is
 * its own key; a domain never holds a colon, so the two can't collide. */
export const organizationAudienceKey = (id) => `org:${encodeURIComponent(id)}`;

/** The Page's organization grant when this deployment's provider reports
 * organizations and the grant is for its account namespace, else null. */
export function configuredOrganizationAccess(metadata, env) {
  const value = metadata?.acl?.organizationAccess;
  return value &&
    identityProvider(env).organizations &&
    typeof value.id === "string" &&
    value.id &&
    typeof value.name === "string" &&
    MEMBER_ROLES.includes(value.role) &&
    value.namespace === kiloPrincipalNamespace(env)
    ? { id: value.id, name: value.name, namespace: value.namespace, role: value.role }
    : null;
}

/** The Page's link audience as the listing index keys it, with the role it
 * grants: `{ key, role }`, or null when it has none. */
export function pageAudience(metadata, env) {
  const organization = configuredOrganizationAccess(metadata, env);
  if (organization)
    return { key: organizationAudienceKey(organization.id), role: organization.role };
  const domain = configuredDomainView(metadata, env);
  return domain ? { key: domain.domain, role: domain.role } : null;
}

/** The audience key a reader opened the Page through, from its access
 * (`pageAccess`): its company domain, or the Page's organization grant. Null
 * for an owner, a member or a Project member. */
export function openedAudienceKey(metadata, identity, access) {
  if (access.source === "organization")
    return organizationAudienceKey(metadata.acl.organizationAccess.id);
  if (access.source === "domain") return identity?.domainAccess?.domain ?? null;
  return null;
}

/** Every audience key `identity` holds a current lease for: its company
 * domain and each of its organizations. */
export function identityAudienceKeys(identity, now = Date.now()) {
  const keys = [];
  const domain = identity?.domainAccess;
  if (domain?.expiresAt > now) keys.push(domain.domain);
  for (const lease of identity?.organizations ?? [])
    if (lease.expiresAt > now) keys.push(organizationAudienceKey(lease.id));
  return keys;
}
