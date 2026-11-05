import { projectObject } from "./authz.mjs";

// Leases are transient and never stored in a Page record. A failed refresh
// grants nothing inherited; direct grants remain independently effective.
export const PROJECT_ACCESS_LEASE_MS = 15_000;
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
    members: record.acl?.members,
    valid_until: now + PROJECT_ACCESS_LEASE_MS,
  };
}
