import { normalizeInviteEmail } from "@cloud/sharing.ts";
import { appSessionHasFreshVerifiedEmail } from "@cloud/app-session.ts";
import { MEMBER_ROLES, pageAccess, proposeAccessUpdate } from "./access.mjs";
import { HttpError } from "./auth.mjs";
import { fingerprint, mutationKey } from "./mutations.mjs";
import { companyDomainProof, companyViewDomains, configuredDomainView } from "./domain-access.mjs";

const lifetime = 7 * 24 * 60 * 60 * 1000;
const roleValid = (role) => MEMBER_ROLES.includes(role);
const stronger = (a, b) => (MEMBER_ROLES.indexOf(a) >= MEMBER_ROLES.indexOf(b) ? a : b);
/**
 * domainOptions are the host-allowed company domains the requesting owner
 * proves right now; domainProof gives each host-allowed domain's bounded proof
 * state so an owner whose proof expired can be told to sign in again. A stored
 * domainView the owner cannot currently prove stays in effect for readers and
 * is flagged with domainViewOwnerVerified: false, so the owner can see it and
 * switch to Restricted.
 */
export async function sharingProjection(metadata, identity, env = {}, now = Date.now()) {
  const access = pageAccess(metadata, identity, { now });
  if (!access.canRead) throw new HttpError(403, "You no longer have access to this Page");
  if (!access.canManageAccess) return { access };
  const acl = metadata.acl ?? {};
  const domainProof = await companyDomainProof(env, identity, now);
  const domainOptions = Object.keys(domainProof).filter(
    (domain) => domainProof[domain] === "verified",
  );
  const domainView = configuredDomainView(metadata, env);
  return {
    access,
    owner: { principal: metadata.owner, displayName: metadata.ownerName },
    domainOptions,
    domainProof,
    domainView,
    ...(domainView && { domainViewOwnerVerified: domainOptions.includes(domainView.domain) }),
    members: Object.entries(acl.members ?? {})
      .filter(([, member]) => roleValid(member.role))
      .map(([principal, member]) => ({ principal, ...member })),
    invites: Object.values(acl.invites ?? {}).filter((invite) => invite.expiresAt > now),
  };
}
function checkedEmail(value) {
  if (typeof value !== "string" || value.length > 254)
    throw new HttpError(400, "Enter a valid email address");
  try {
    return normalizeInviteEmail(value);
  } catch {
    throw new HttpError(400, "Enter a valid email address");
  }
}
export async function invitationMatches(identity, invite, env, now = Date.now()) {
  if (invite.expiresAt <= now || !identity.namespace || invite.namespace !== identity.namespace)
    return false;
  if (identity.verifiedEmail) return checkedEmail(identity.verifiedEmail) === invite.email;
  if (!identity.emailProof) return false;
  return appSessionHasFreshVerifiedEmail(
    env,
    { principal: identity.principal, metadata: identity.emailProof },
    invite.email,
    Math.floor(now / 1000),
  );
}
/** Invites are proof-gated admission requests, never email ACL rows. */
export async function claimInvitation(metadata, identity, env, now = Date.now()) {
  if (metadata.deleted || identity.principal === metadata.owner) return null;
  for (const invite of Object.values(metadata.acl?.invites ?? {})) {
    if (!(await invitationMatches(identity, invite, env, now))) continue;
    // A stale invite must not downgrade a grant made explicitly in the meantime.
    const previous = metadata.acl?.members?.[identity.principal];
    if (previous?.changedAtRevision > (invite.issuedRevision ?? 0)) continue;
    // An invitation never lowers a grant the member already holds.
    const role = roleValid(previous?.role) ? stronger(previous.role, invite.role) : invite.role;
    const result = proposeAccessUpdate(
      metadata,
      { principal: metadata.owner, canWrite: true, expiresAt: now + 1000 },
      {
        principal: identity.principal,
        role,
        expected_revision: metadata.acl?.revision ?? 0,
      },
      { now },
    );
    const acl = structuredClone(result.acl);
    delete acl.invites[invite.id];
    if (!result.changed) acl.revision++;
    acl.members[identity.principal] = {
      ...acl.members[identity.principal],
      displayName: identity.displayName,
      email: invite.email,
    };
    return { ...metadata, acl };
  }
  return null;
}
export async function proposeSharingMutation(metadata, identity, args, now = Date.now(), env = {}) {
  if (!pageAccess(metadata, identity, { now }).canManageAccess)
    throw new HttpError(403, "Only the owner can manage sharing");
  const key = mutationKey(args).replace("host/operation/", "");
  const digest = await fingerprint("page_access", args, identity);
  const previous = metadata.acl?.receipts?.[key];
  if (previous) {
    if (previous.fingerprint !== digest)
      throw new HttpError(
        409,
        "idempotency_key was used for a different request",
        "idempotency_conflict",
      );
    return { metadata, receipt: previous.receipt, replay: true };
  }
  if (
    !Number.isSafeInteger(args.expected_revision) ||
    args.expected_revision !== (metadata.acl?.revision ?? 0)
  )
    throw new HttpError(409, "Sharing changed; reload access before editing");
  let acl = structuredClone(metadata.acl ?? { revision: 0, members: {}, invites: {} });
  acl.invites = Object.fromEntries(
    Object.entries(acl.invites ?? {}).filter(([, invite]) => invite.expiresAt > now),
  );
  if (args.action === "set_domain_view") {
    if (args.domain !== null && !companyViewDomains(env).includes(args.domain))
      throw new HttpError(400, "Choose a supported company domain");
    if (args.role !== undefined && args.role !== "viewer")
      throw new HttpError(400, "Company domain access is view-only");
    // Only someone who proves the company email may present a Page to that
    // company. Restricted needs no proof, so an owner can always withdraw.
    if (args.domain !== null) {
      const proof = (await companyDomainProof(env, identity, now))[args.domain];
      if (proof !== "verified")
        throw new HttpError(
          403,
          proof === "expired"
            ? `Your ${args.domain} email verification expired. Sign in again with the same account to share with ${args.domain}`
            : `Sign in with a verified ${args.domain} email to share with ${args.domain}`,
          "company_email_proof_required",
        );
    }
    acl.domainView =
      args.domain === null
        ? null
        : {
            domain: args.domain,
            namespace: env.NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE.trim(),
          };
    acl.revision++;
  } else if (args.action === "set_role") {
    const update = proposeAccessUpdate(metadata, identity, args, { now });
    acl = structuredClone(update.acl);
    if (!update.changed) {
      acl.revision++;
      acl.members[args.principal] = {
        ...acl.members[args.principal],
        changedAtRevision: acl.revision,
      };
    }
    // Removing a member also cancels any pending invitation for that same email.
    if (args.role === null) {
      const email = metadata.acl?.members?.[args.principal]?.email;
      acl = structuredClone(acl);
      for (const [id, invite] of Object.entries(acl.invites ?? {}))
        if (email && invite.email === email) delete acl.invites[id];
    }
  } else if (args.action === "invite") {
    const email = checkedEmail(args.email);
    if (!roleValid(args.role)) throw new HttpError(400, "Choose Can view, Can comment or Can edit");
    if (!identity.namespace) throw new HttpError(400, "Sign in again before inviting people");
    const member = Object.entries(acl.members).find(
      ([, value]) => value.email === email && value.role !== "none",
    );
    if (member) {
      const update = proposeAccessUpdate(
        metadata,
        identity,
        { ...args, principal: member[0] },
        { now },
      );
      acl = structuredClone(update.acl);
      if (!update.changed) {
        acl.revision++;
        acl.members[member[0]].changedAtRevision = acl.revision;
      }
    } else {
      const existing = Object.values(acl.invites).find(
        (value) => value.email === email && value.namespace === identity.namespace,
      );
      if (!existing && Object.keys(acl.invites).length >= 100)
        throw new HttpError(409, "This Page has too many invitations");
      const id = existing?.id ?? crypto.randomUUID();
      acl.invites[id] = {
        id,
        email,
        role: args.role,
        namespace: identity.namespace,
        expiresAt: now + lifetime,
        issuedRevision: acl.revision + 1,
      };
      acl.revision++;
    }
  } else if (args.action === "revoke_invite") {
    if (typeof args.invite_id !== "string" || !Object.hasOwn(acl.invites, args.invite_id))
      throw new HttpError(404, "Invitation not found");
    delete acl.invites[args.invite_id];
    acl.revision++;
  } else throw new HttpError(400, "Unknown sharing action");
  acl.invites = Object.fromEntries(
    Object.entries(acl.invites ?? {}).filter(([, invite]) => invite.expiresAt > now),
  );
  const receipt = { revision: acl.revision };
  // A bounded retry window must never prevent the owner from revoking access.
  // Evicted requests still carry an old expected_revision and cannot reapply.
  const receipts = { ...acl.receipts, [key]: { fingerprint: digest, receipt } };
  const oldestFirst = Object.keys(receipts).sort(
    (a, b) => receipts[a].receipt.revision - receipts[b].receipt.revision,
  );
  for (const oldKey of oldestFirst.slice(0, Math.max(0, oldestFirst.length - 256)))
    delete receipts[oldKey];
  acl = { ...acl, receipts };
  return { metadata: { ...metadata, acl }, receipt, replay: false };
}
