/**
 * The writer a stored record names: `{ principal, displayName, driver,
 * agent? }`. `identity` is the authenticated account (`principal`) with the
 * labels its client presented; `agent` is `{ name?, model? }`, what the
 * writing client said about itself (worker/client-provenance.mjs), kept only
 * when it says something. A comment message's `author` and a source's
 * `producer.by` are this value, so the two never describe a writer
 * differently.
 */
export function authorOf(identity, agent) {
  return {
    principal: identity?.principal ?? "",
    displayName: identity?.displayName ?? "Collaborator",
    driver: identity?.driver ?? "Browser",
    ...(agent && Object.keys(agent).length && { agent: { ...agent } }),
  };
}
