import { projectObject } from "./authz.mjs";

// Leases are transient and never stored in a Page record. A failed refresh
// grants nothing inherited; direct grants remain independently effective.
export const PROJECT_ACCESS_LEASE_MS = 15_000;

export const PROJECT_ACCESS_EMPTY = Object.freeze({
  name: "unavailable",
  snapshot: null,
  fence: null,
});

/** ACL revisions belong to one owner's Project. An unavailable snapshot keeps
 * its revision fence, but never keeps its grant. Other placements supersede
 * only the state observed when their resolution started. */
export function projectAccessStep(state, { observed, owner, snapshot }) {
  const sameProject = snapshot && state.fence?.owner === owner && state.fence.id === snapshot.id;
  const sameLocation = sameProject && state.fence.location === snapshot.location;
  if (sameProject && snapshot.revision < state.fence.revision) return state;
  if (
    state !== observed &&
    (!sameLocation || state.name === "unavailable" || snapshot.revision <= state.fence.revision)
  )
    return state;
  return {
    name: snapshot ? "available" : "unavailable",
    snapshot,
    fence: snapshot
      ? { owner, id: snapshot.id, location: snapshot.location, revision: snapshot.revision }
      : state.fence,
  };
}
export async function resolveProjectAccess(env, metadata, now = Date.now()) {
  if (!metadata?.owner || !env.CATALOGS || !env.PROJECTS) return null;
  const response = await env.CATALOGS.getByName(metadata.owner).fetch(
    new Request("https://pages.internal/internal/location", {
      method: "POST",
      body: JSON.stringify({ page_id: metadata.pageId }),
    }),
  );
  if (!response.ok) return null;
  const location = await response.json();
  if (!location.complete || !location.space_id) return null;
  const policy = await env.PROJECTS.getByName(location.space_id).fetch(
    new Request("https://pages.internal/internal/space/policy", {
      method: "POST",
      body: JSON.stringify({ space_id: location.space_id, owner: metadata.owner }),
    }),
  );
  if (!policy.ok) return null;
  const record = await policy.json();
  if (record.owner !== metadata.owner) return null;
  // A move out of an empty Project can precede a new membership. Never
  // combine that old placement with the newly granted ACL.
  const checked = await env.CATALOGS.getByName(metadata.owner).fetch(
    new Request("https://pages.internal/internal/location", {
      method: "POST",
      body: JSON.stringify({ page_id: metadata.pageId }),
    }),
  );
  if (!checked.ok) return null;
  const current = await checked.json();
  if (!current.complete || current.space_id !== location.space_id) return null;
  return {
    ...projectObject(record),
    location: JSON.stringify(current),
    members: record.acl?.members,
    valid_until: now + PROJECT_ACCESS_LEASE_MS,
  };
}
