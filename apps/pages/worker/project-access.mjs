import { projectObject } from "./authz.mjs";
import { projectPolicyUnavailable } from "./policy.mjs";

// Leases are transient and never stored in a Page record. Revocations and Page
// moves push immediately via `/internal/project-access-changed`; this 60 s
// lease is the fail-closed backstop if a push is missed. A failed refresh
// grants nothing inherited to its caller and leaves the host's snapshot as it
// was; direct grants remain independently effective.
export const PROJECT_ACCESS_LEASE_MS = 60_000;

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
/** The Page's Project snapshot, or null when the Page settles outside any
 * Project the owner holds: Your items, a broken parent chain, or a Project
 * that is gone. A read that could not finish, or a placement that changed
 * while it was read, is no answer: it throws project_policy_unavailable, and
 * the caller grants nothing inherited and says to try again. */
export async function resolveProjectAccess(env, metadata, now = Date.now()) {
  if (!metadata?.owner || !env.CATALOGS || !env.PROJECTS) return null;
  const location = await placement(env, metadata);
  if (!location.complete || !location.space_id) return null;
  const policy = await read(() =>
    env.PROJECTS.getByName(location.space_id).fetch(
      new Request("https://pages.internal/internal/space/policy", {
        method: "POST",
        body: JSON.stringify({ space_id: location.space_id, owner: metadata.owner }),
      }),
    ),
  );
  // The Project answers 404 for one that is deleted or isn't this owner's.
  if (policy.status === 404) return null;
  if (!policy.ok) throw projectPolicyUnavailable();
  const record = await policy.json();
  if (record.owner !== metadata.owner) return null;
  // A move out of an empty Project can precede a new membership. Never
  // combine that old placement with the newly granted ACL.
  const current = await placement(env, metadata);
  if (!current.complete || current.space_id !== location.space_id) throw projectPolicyUnavailable();
  return {
    ...projectObject(record),
    location: JSON.stringify(current),
    members: record.acl?.members,
    valid_until: now + PROJECT_ACCESS_LEASE_MS,
  };
}

/** The owner Catalog's location answer for the Page. A Page the Catalog has
 * no entry for (404) is in no Project. */
async function placement(env, metadata) {
  const response = await read(() =>
    env.CATALOGS.getByName(metadata.owner).fetch(
      new Request("https://pages.internal/internal/location", {
        method: "POST",
        body: JSON.stringify({ page_id: metadata.pageId }),
      }),
    ),
  );
  if (response.status === 404) return { complete: true, space_id: null };
  if (!response.ok) throw projectPolicyUnavailable();
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw projectPolicyUnavailable();
  }
  return payload;
}

/** One internal fetch; a thrown fetch is an unfinished read. */
async function read(fetch) {
  try {
    return await fetch();
  } catch {
    throw projectPolicyUnavailable();
  }
}
