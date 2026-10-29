// Host-owned options only. The host offers a company domain only when the
// owner's own verified email proves it; the viewer never derives a choice from
// an email or provider, and the server remains the authorization authority.
//
// A stored company audience the owner cannot currently prove still applies to
// readers. It stays visible with `unverified: true` so the owner can see it
// and switch to Restricted; choosing it again needs fresh proof.
export function domainSharingProjection(value) {
  if (!value?.access?.canManageAccess || !Array.isArray(value.domainOptions)) return null;
  const domains = [
    ...new Set(value.domainOptions.filter((domain) => typeof domain === "string" && domain)),
  ];
  const stored = value.domainView?.domain;
  // Only the host's explicit flag surfaces a stored domain outside the offered
  // options; the host projects domainView only for host-allowed domains.
  const unverified =
    typeof stored === "string" && !!stored && value.domainViewOwnerVerified === false;
  if (!domains.length && !unverified) return null;
  const choices = unverified && !domains.includes(stored) ? [...domains, stored] : domains;
  return {
    selected: choices.includes(stored) ? stored : "",
    unverified,
    options: [
      { value: "", label: "Restricted" },
      ...choices.map((domain) => ({ value: domain, label: `Anyone at ${domain} with the link` })),
    ],
  };
}
