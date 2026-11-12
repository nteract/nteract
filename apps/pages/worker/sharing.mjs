import { appSessionHasFreshVerifiedEmail } from "@cloud/app-session.ts";
import { MEMBER_ROLES, pageAccess, proposeAccessUpdate } from "./access.mjs";
import { HttpError } from "./auth.mjs";
import { inviteEmail } from "./invite-email.mjs";
import { fingerprint, operationKey } from "./mutations.mjs";
import { companyDomainProof, companyViewDomains, configuredDomainView } from "./domain-access.mjs";
import { organizationLeases, organizationProof } from "./kilo-membership.mjs";
import { configuredOrganizationAccess } from "./organization-access.mjs";

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
 *
 * Organizations follow the same rules: organizationOptions are the
 * organizations the owner proves membership in now, organizationProof gives
 * the proof state of each option and of the stored grant, and a stored
 * organizationAccess the owner cannot prove now is flagged with
 * organizationAccessOwnerVerified: false.
 */
/** The owner's organization sharing state for a Page or Project record
 * (`acl.organizationAccess` on either): the organizations `identity` proves
 * membership in now, the proof state of each and of the stored grant, the
 * stored grant, and whether the owner can prove it now. */
export async function organizationSharing(metadata, identity, env, now = Date.now()) {
  const organizationOptions = (await organizationLeases(env, identity, now)).map(
    ({ id, name }) => ({ id, name }),
  );
  const organization = configuredOrganizationAccess(metadata, env);
  const proof = await organizationProof(
    env,
    identity,
    [
      ...new Set([
        ...organizationOptions.map(({ id }) => id),
        ...(organization ? [organization.id] : []),
      ]),
    ],
    now,
  );
  return {
    organizationOptions,
    organizationProof: proof,
    organizationAccess: organization
      ? { id: organization.id, name: organization.name, role: organization.role }
      : null,
    ...(organization && {
      organizationAccessOwnerVerified: proof[organization.id] === "verified",
    }),
  };
}

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
    ...(await organizationSharing(metadata, identity, env, now)),
    members: Object.entries(acl.members ?? {})
      .filter(([, member]) => roleValid(member.role))
      .map(([principal, member]) => ({ principal, ...member })),
    invites: Object.values(acl.invites ?? {}).filter((invite) => invite.expiresAt > now),
  };
}
function checkedEmail(value) {
  const email = inviteEmail(value);
  if (!email) throw new HttpError(400, "Enter a valid email address");
  return email;
}
export async function invitationMatches(identity, invite, env, now = Date.now()) {
  if (invite.expiresAt <= now || !identity.namespace || invite.namespace !== identity.namespace)
    return false;
  // A provider's address an invitation can't name matches no invitation; it
  // is the caller's credential, not input to refuse.
  if (identity.verifiedEmail) {
    const email = inviteEmail(identity.verifiedEmail);
    return email !== null && email === invite.email;
  }
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
/** A Page has one link audience at a time. Replacing one is two changes the
 * owner makes, never a side effect of the other. */
const audienceSet = (current) =>
  new HttpError(
    409,
    `This Page is shared with ${current}. Choose Restricted to turn that off first`,
    "link_audience_set",
  );

/** The organization grant `set_organization_access` asks for, or null to
 * withdraw it. Choosing an organization, or a new role for the one already
 * set, needs the caller's own current membership in it; withdrawing needs
 * nothing, so an owner can always stop sharing. */
async function organizationGrant(acl, identity, args, env, now) {
  const id = args.organization_id;
  if (id === null) return null;
  if (typeof id !== "string" || !id) throw new HttpError(400, "Choose an organization");
  if (!roleValid(args.role)) throw new HttpError(400, "Choose Can view, Can comment or Can edit");
  if (acl.domainView) throw audienceSet(`everyone at ${acl.domainView.domain}`);
  const lease = (await organizationLeases(env, identity, now)).find((value) => value.id === id);
  if (!lease) {
    const proof = (await organizationProof(env, identity, [id], now))[id];
    throw new HttpError(
      403,
      proof === "expired"
        ? "Your organization membership was last confirmed too long ago. Sign in again with the same account to share with this organization"
        : "Share only with an organization you belong to",
      "organization_proof_required",
    );
  }
  return { id, name: lease.name, namespace: lease.namespace, role: args.role };
}

export async function proposeSharingMutation(metadata, identity, args, now = Date.now(), env = {}) {
  if (!pageAccess(metadata, identity, { now }).canManageAccess)
    throw new HttpError(403, "Only the owner can manage sharing");
  const key = (await operationKey(args, identity, "page-access")).replace("host/operation/", "");
  const digest = await fingerprint("page_access", args, identity);
  const previous = metadata.acl?.receipts?.[key];
  if (previous) {
    if (previous.fingerprint !== digest)
      throw new HttpError(409, "This nonce was used for a different request", "nonce_conflict");
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
    if (args.domain !== null && acl.organizationAccess)
      throw audienceSet(acl.organizationAccess.name || "an organization");
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
  } else if (args.action === "set_organization_access") {
    acl.organizationAccess = await organizationGrant(acl, identity, args, env, now);
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
