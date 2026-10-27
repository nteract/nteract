// Host-owned options only. Neither an owner's email nor their sign-in provider
// supplies a domain choice; the server remains the authorization authority.
export function domainSharingProjection(value) {
  if (!value?.access?.canManageAccess || !Array.isArray(value.domainOptions)) return null;
  const domains = [
    ...new Set(value.domainOptions.filter((domain) => typeof domain === "string" && domain)),
  ];
  if (!domains.length) return null;
  return {
    selected: domains.includes(value.domainView?.domain) ? value.domainView.domain : "",
    options: [
      { value: "", label: "Restricted" },
      ...domains.map((domain) => ({ value: domain, label: `Anyone at ${domain} with the link` })),
    ],
  };
}
