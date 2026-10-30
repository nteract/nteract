/** Host-owned Page grants. Document content and driver labels grant no access.
 * Capability checks use decide() in authz.mjs. Grant identity (pageGrant) and
 * deletion disclosure (pageRelation) use separate projections of the same
 * relation model. */
import {
  NO_ACTOR_CHAIN,
  decide,
  heldRelation,
  memberRow,
  pageObject,
  pageState,
  principalOf,
} from "./authz.mjs";

export { pageState };

export class AccessError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MEMBER_LIMIT = 100;
const roles = new Set(["viewer", "editor", "none"]);
const own = (value, key) => value && Object.hasOwn(value, key);
const revisionOf = (metadata) => metadata?.acl?.revision ?? 0;

export function validateAccessPrincipal(principal) {
  if (
    typeof principal !== "string" ||
    principal.length > 512 ||
    !/^[^\s:]+:[^\s]+$/u.test(principal) ||
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f]/u.test(principal)
  )
    throw new AccessError(400, "Invalid access principal");
  return principal;
}

/** Stable grant identity, independent of a particular credential's lifetime.
 * Trash retains every grant and generation: restoring a Page must not revive
 * or retire signing keys, so only the lifecycle overlay in decide() withholds
 * access while trashed.
 */
export function pageGrant(metadata, principal) {
  const revision = revisionOf(metadata);
  if (!metadata || pageState(metadata) === "deleted" || typeof principal !== "string")
    return { role: "none", revision, generation: 0 };
  if (principal === metadata.owner) return { role: "owner", revision, generation: 0 };
  const member = memberRow(metadata.acl?.members, principal);
  if (!member) return { role: "none", revision, generation: 0 };
  return { role: member.role, revision, generation: member.generation };
}

/** The decide() result for one identity on one Page record. */
export function pageDecision(metadata, identity, { now = Date.now() } = {}) {
  const principal = principalOf(identity);
  return decide(principal, NO_ACTOR_CHAIN, pageObject(metadata, principal.id), now);
}

/** The relation a principal holds on a Page record before the lifecycle
 * overlay: what deletion disclosure and the lifecycle owner check read. */
export function pageRelation(metadata, principal) {
  return heldRelation(pageObject(metadata, principal), principal);
}

/** decide() projected onto the access flags the host and viewer read. The
 * role is the decision's basis, so a read-only credential still reports the
 * role it holds. Grant revision and generation come from pageGrant.
 */
export function pageAccess(metadata, identity, options) {
  const grant = pageGrant(metadata, identity?.principal);
  const decision = pageDecision(metadata, identity, options);
  const can = (capability) => decision.capabilities.includes(capability);
  const role = decision.basis.relation ?? "none";
  if (pageState(metadata) === "trashed") {
    // Only someone who may restore a trashed Page sees it, read-only. Members
    // keep their grant generation for restore, but have no current role.
    return {
      ...grant,
      role,
      canRead: can("read"),
      canWrite: can("edit"),
      canComment: can("comment"),
      canManageAccess: can("share"),
      canDelete: can("trash"),
      canRestore: can("restore"),
      canPurge: can("purge"),
      trashed: true,
    };
  }
  return {
    ...grant,
    role,
    // Company viewing never creates a durable principal membership.
    ...(decision.basis.via === "organization" && { source: "domain" }),
    canRead: can("read"),
    canWrite: can("edit"),
    canComment: can("comment"),
    canManageAccess: can("share"),
    canDelete: can("trash"),
  };
}

/** Prepare one owner-authorized update without changing metadata or storage.
 * Removed principals keep a generation tombstone, so regrant cannot revive an
 * earlier signing key. Other control-plane fields (including invites) survive.
 */
export function proposeAccessUpdate(metadata, identity, input, options) {
  if (!pageAccess(metadata, identity, options).canManageAccess)
    throw new AccessError(403, "Only the Page owner can change access");
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new AccessError(400, "Invalid access update");
  const principal = validateAccessPrincipal(input.principal);
  if (principal === metadata.owner) throw new AccessError(400, "The Page owner cannot be changed");
  if (!["viewer", "editor", null].includes(input.role))
    throw new AccessError(400, "Access must be viewer, editor, or null to remove");
  if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0)
    throw new AccessError(400, "expected_revision is required");
  const revision = revisionOf(metadata);
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new AccessError(500, "Invalid stored access revision");
  if (input.expected_revision !== revision)
    throw new AccessError(409, "Page access changed; refresh and try again");
  const acl = metadata.acl ?? { revision: 0, members: {} };
  const members = acl.members ?? {};
  const previous = own(members, principal) ? members[principal] : undefined;
  const previousRole = previous?.role ?? "none";
  if (
    previous &&
    (!roles.has(previousRole) ||
      !Number.isSafeInteger(previous.generation) ||
      previous.generation < 1)
  )
    throw new AccessError(500, "Invalid stored member grant");
  const role = input.role ?? "none";
  if (role === previousRole && previous)
    return { acl, changed: false, principal, previousRole, role };
  const memberCount = Object.values(members).filter((member) => member.role !== "none").length;
  if (role !== "none" && previousRole === "none" && memberCount >= MEMBER_LIMIT)
    throw new AccessError(409, "This prototype permits 100 members per Page");
  const generation = (previous?.generation ?? 0) + 1;
  if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(revision + 1))
    throw new AccessError(409, "Page access revision limit reached");
  return {
    acl: {
      ...acl,
      revision: revision + 1,
      members: {
        ...members,
        [principal]: { ...previous, role, generation, changedAtRevision: revision + 1 },
      },
    },
    changed: true,
    principal,
    previousRole,
    role,
  };
}

/** Intersection used while the new host ACL is awaiting its durability barrier. */
export function restrictAccessDuringCommit(previous, proposed) {
  const ranks = { none: 0, viewer: 1, editor: 2, owner: 3 };
  const members = { ...previous.acl?.members };
  for (const principal of new Set([
    ...Object.keys(previous.acl?.members ?? {}),
    ...Object.keys(proposed.acl?.members ?? {}),
  ])) {
    const before = pageGrant(previous, principal),
      after = pageGrant(proposed, principal);
    if (
      ranks[after.role] < ranks[before.role] ||
      (after.role === "none" && own(proposed.acl?.members, principal))
    )
      members[principal] = proposed.acl.members[principal];
  }
  const beforeDomain = previous.acl?.domainView,
    afterDomain = proposed.acl?.domainView;
  const lostDomain =
    beforeDomain &&
    (!afterDomain ||
      beforeDomain.domain !== afterDomain.domain ||
      beforeDomain.namespace !== afterDomain.namespace);
  return {
    ...previous,
    acl: { ...previous.acl, members, ...(lostDomain && { domainView: null }) },
  };
}
