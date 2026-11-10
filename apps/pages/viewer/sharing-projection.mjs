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
  return {
    selected: choices.includes(stored) ? stored : "",
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
