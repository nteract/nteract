/** Host-owned Page grants. Document content and driver labels grant no access. */
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

/** Stable grant identity, independent of a particular credential's lifetime. */
export function pageGrant(metadata, principal) {
  const revision = revisionOf(metadata);
  if (!metadata || metadata.deleted || typeof principal !== "string")
    return { role: "none", revision, generation: 0 };
  if (principal === metadata.owner) return { role: "owner", revision, generation: 0 };
  const members = metadata.acl?.members;
  const member = own(members, principal) ? members[principal] : undefined;
  if (
    !member ||
    !roles.has(member.role) ||
    !Number.isSafeInteger(member.generation) ||
    member.generation < 1
  )
    return { role: "none", revision, generation: 0 };
  return { role: member.role, revision, generation: member.generation };
}

export function pageAccess(metadata, identity, { now = Date.now() } = {}) {
  const grant = pageGrant(metadata, identity?.principal);
  const authenticated = Number.isFinite(identity?.expiresAt) && identity.expiresAt > now;
  const domain = metadata?.acl?.domainView;
  const evidence = identity?.domainAccess;
  // Explicit grants, invalid member rows and removal tombstones all take
  // precedence. Domain viewing never creates a durable principal membership.
  const domainViewer =
    authenticated &&
    !metadata?.deleted &&
    grant.role === "none" &&
    !own(metadata?.acl?.members, identity.principal) &&
    domain &&
    evidence &&
    domain.domain === evidence.domain &&
    domain.namespace === evidence.namespace &&
    identity.namespace === evidence.namespace &&
    Number.isFinite(evidence.expiresAt) &&
    evidence.expiresAt > now;
  const role = authenticated ? (domainViewer ? "viewer" : grant.role) : "none";
  const canRead = role !== "none";
  const canWrite = !!identity?.canWrite && (role === "owner" || role === "editor");
  const canManageAccess = canWrite && role === "owner";
  return {
    ...grant,
    role,
    ...(domainViewer && { source: "domain" }),
    canRead,
    canWrite,
    canComment: canWrite,
    canManageAccess,
    canDelete: canManageAccess,
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
