// Host-owned options only. The host offers a company domain only when the
// owner's own verified email proves it; the viewer never derives a choice from
// an email or provider, and the server remains the authorization authority.
//
// domainProof reports each host-allowed domain as verified, expired or missing.
// An expired proof keeps the company choice visible but disabled, with a way
// to sign in again. A missing proof (a personal account) shows nothing.
//
// A stored company audience the owner cannot currently prove still applies to
// readers. It stays visible with `unverified: true` so the owner can see it
// and switch to Restricted; choosing it again needs fresh proof.
const domainName = (domain) => typeof domain === "string" && !!domain;
/** The roles a link audience grants, weakest first. */
const LINK_ROLES = ["viewer", "commenter", "editor"];

export function domainSharingProjection(value) {
  if (!value?.access?.canManageAccess || !Array.isArray(value.domainOptions)) return null;
  const verified = [...new Set(value.domainOptions.filter(domainName))];
  const proof =
    value.domainProof && typeof value.domainProof === "object" && !Array.isArray(value.domainProof)
      ? value.domainProof
      : {};
  const expired = Object.keys(proof).filter(
    (domain) => domainName(domain) && proof[domain] === "expired" && !verified.includes(domain),
  );
  const stored = value.domainView?.domain;
  // Only the host's explicit flag surfaces a stored domain outside the offered
  // options; the host projects domainView only for host-allowed domains.
  const unverified = domainName(stored) && value.domainViewOwnerVerified === false;
  const choices = [...verified, ...expired];
  if (unverified && !choices.includes(stored)) choices.push(stored);
  if (!choices.length) return null;
  const selected = choices.includes(stored) ? stored : "";
  return {
    selected,
    // The stored grant's role; a grant without one is a viewer grant.
    role: selected
      ? LINK_ROLES.includes(value.domainView.role)
        ? value.domainView.role
        : "viewer"
      : null,
    unverified,
    // The domain whose proof a fresh sign-in with the same account restores.
    expired: expired.includes(stored) ? stored : (expired[0] ?? null),
    options: [
      { value: "", label: "Restricted", disabled: false },
      ...choices.map((domain) => ({
        value: domain,
        label: `Anyone at ${domain} with the link`,
        disabled: !verified.includes(domain),
      })),
    ],
  };
}

// Organizations follow the same host-owned rules. organizationOptions are the
// organizations the owner proves membership in now; organizationProof reports
// each option and the stored grant as verified, expired or missing. A stored
// grant the owner can't prove now stays visible, flagged and withdrawable.
// An option's value is its listing audience key, `org:<encoded id>`, which no
// domain can equal.
const organizationValue = (id) => `org:${encodeURIComponent(id)}`;
const organizationEntry = (value) =>
  typeof value?.id === "string" && !!value.id && typeof value.name === "string" && !!value.name;

export function organizationSharingProjection(value) {
  if (!value?.access?.canManageAccess || !Array.isArray(value.organizationOptions)) return null;
  const verified = [];
  for (const option of value.organizationOptions)
    if (organizationEntry(option) && !verified.some(({ id }) => id === option.id))
      verified.push({ id: option.id, name: option.name });
  const proof =
    value.organizationProof &&
    typeof value.organizationProof === "object" &&
    !Array.isArray(value.organizationProof)
      ? value.organizationProof
      : {};
  const stored =
    organizationEntry(value.organizationAccess) &&
    LINK_ROLES.includes(value.organizationAccess.role)
      ? {
          id: value.organizationAccess.id,
          name: value.organizationAccess.name,
          role: value.organizationAccess.role,
        }
      : null;
  const unverified = !!stored && value.organizationAccessOwnerVerified === false;
  const choices = [...verified];
  if (stored && !choices.some(({ id }) => id === stored.id))
    choices.push({ id: stored.id, name: stored.name });
  if (!choices.length) return null;
  return {
    selected: stored ? organizationValue(stored.id) : "",
    stored,
    unverified,
    // Only the stored grant's lapsed proof is something signing in restores.
    expired: unverified && proof[stored.id] === "expired" ? stored.name : null,
    options: choices.map(({ id, name }) => ({
      value: organizationValue(id),
      label: `Anyone in ${name} with the link`,
      disabled: !verified.some((option) => option.id === id),
      id,
    })),
  };
}

/**
 * The owner's one "Link access" control: Restricted, then each organization,
 * then each company domain. A Page has one link audience at a time, so while
 * one kind is stored the other kind's options are disabled; choosing
 * Restricted clears whichever is stored. `organization` is the stored
 * organization grant, `domain` the stored company domain, `role` the stored
 * audience's role (null when Restricted), and `expired` names the audience
 * whose proof a fresh sign-in restores. `narrowOnly` is true for a stored
 * company domain the owner can't prove now: the host still lets the owner
 * lower its role (or choose Restricted), never raise it.
 */
export function linkAccessProjection(value) {
  const domain = domainSharingProjection(value);
  const organization = organizationSharingProjection(value);
  if (!domain && !organization) return null;
  const storedDomain = domain?.selected || null;
  const stored = organization?.stored ?? null;
  return {
    selected: organization?.selected || storedDomain || "",
    organization: stored,
    domain: storedDomain,
    role: stored?.role ?? domain?.role ?? null,
    unverified: stored ? organization.unverified : !!domain?.unverified,
    narrowOnly: !stored && !!storedDomain && !!domain?.unverified,
    expired: organization?.expired
      ? { kind: "organization", name: organization.expired }
      : domain?.expired && !stored
        ? { kind: "domain", name: domain.expired }
        : null,
    options: [
      { value: "", label: "Restricted", disabled: false },
      ...(organization?.options ?? []).map((option) => ({
        ...option,
        kind: "organization",
        disabled: option.disabled || !!storedDomain,
      })),
      ...(domain?.options.slice(1) ?? []).map((option) => ({
        ...option,
        kind: "domain",
        disabled: option.disabled || !!stored,
      })),
    ],
  };
}
