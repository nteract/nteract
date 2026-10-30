/**
 * The access rules as they stood before decide(), frozen for the equivalence
 * test in authz-equivalence.test.mjs. Nothing outside tests imports this file.
 * Keep it byte-for-byte with the behavior it pins; a deliberate access change
 * updates the equivalence test's expectations, not this reference.
 */
const roles = new Set(["viewer", "editor", "none"]);
const own = (value, key) => value && Object.hasOwn(value, key);
const revisionOf = (metadata) => metadata?.acl?.revision ?? 0;

export function legacyPageState(metadata) {
  if (!metadata) return "missing";
  if (!metadata.deleted) return "active";
  return metadata.trash && !metadata.purged ? "trashed" : "deleted";
}

export function legacyPageGrant(metadata, principal) {
  const revision = revisionOf(metadata);
  if (!metadata || legacyPageState(metadata) === "deleted" || typeof principal !== "string")
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

export function legacyPageAccess(metadata, identity, { now = Date.now() } = {}) {
  const grant = legacyPageGrant(metadata, identity?.principal);
  const authenticated = Number.isFinite(identity?.expiresAt) && identity.expiresAt > now;
  if (legacyPageState(metadata) === "trashed") {
    const owner = authenticated && grant.role === "owner";
    const canRestore = owner && !!identity?.canWrite;
    return {
      ...grant,
      role: owner ? "owner" : "none",
      canRead: owner,
      canWrite: false,
      canComment: false,
      canManageAccess: false,
      canDelete: false,
      canRestore,
      canPurge: canRestore,
      trashed: true,
    };
  }
  const domain = metadata?.acl?.domainView;
  const evidence = identity?.domainAccess;
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

/** DocumentPolicy.leaseExpiresAt after its account() check passed. */
export function legacyLeaseExpiresAt(metadata, identity, options) {
  return legacyPageAccess(metadata, identity, options).source === "domain"
    ? Math.min(identity.expiresAt, identity.domainAccess.expiresAt)
    : identity.expiresAt;
}

/** Page.disclosesDeletion. */
export function legacyDisclosesDeletion(metadata, principal) {
  if (principal === metadata?.owner) return true;
  const members = metadata?.acl?.members;
  const member = members && Object.hasOwn(members, principal) ? members[principal] : undefined;
  return (
    ["viewer", "editor"].includes(member?.role) &&
    Number.isSafeInteger(member.generation) &&
    member.generation >= 1
  );
}

/** Space read check and create-replay owner check. */
export const legacySpaceOwner = (record, principal) => record.owner === principal;
