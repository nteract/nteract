/**
 * The writer a stored record names: `{ principal, displayName, driver,
 * agent? }`. `identity` is the authenticated account (`principal`) with the
 * labels its client presented; `agent` is `{ name?, model? }`, what the
 * writing client said about itself (worker/client-provenance.mjs), kept only
 * when it says something. A comment message's `author`, a source's
 * `producer.by` and a host edit's writer record (worker/host-writers.mjs) are
 * this value, so they never describe a writer differently.
 */
export function authorOf(identity, agent) {
  return {
    principal: identity?.principal ?? "",
    displayName: identity?.displayName ?? "Collaborator",
    driver: identity?.driver ?? "Browser",
    ...(agent && Object.keys(agent).length && { agent: { ...agent } }),
  };
}

/**
 * The longest attribution labels a stored writer keeps, in UTF-16 code units.
 * They are the bounds those values already have where they enter: an agent's
 * name and model (shared/client-provenance.mjs), a driver label
 * (worker/auth.mjs and worker/oauth-clients.mjs), and a display name as the
 * Kilo exchange keeps it (worker/kilo-exchange.mjs). The account principal is
 * the authenticated identity and is stored whole.
 */
export const WRITER_LIMITS = Object.freeze({
  displayName: 200,
  driver: 80,
  agentName: 80,
  agentModel: 120,
});

/**
 * `by` with its display name cut to WRITER_LIMITS.displayName. A display name
 * comes from the identity provider, not from the request, so a long one is
 * cut as the Kilo exchange cuts one, never refused: refusing would lock the
 * account out of writing. Cutting never leaves half a surrogate pair. The
 * driver and agent labels are refused at the request's edge when over their
 * bounds.
 */
export function boundedWriter(by) {
  if (!by || typeof by !== "object" || Array.isArray(by) || typeof by.displayName !== "string")
    return by;
  let displayName = by.displayName.slice(0, WRITER_LIMITS.displayName);
  if (/[\ud800-\udbff]$/.test(displayName)) displayName = displayName.slice(0, -1);
  return { ...by, displayName };
}
