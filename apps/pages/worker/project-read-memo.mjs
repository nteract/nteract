/**
 * `list_projects` answers from Project hosts, remembered for a short while.
 *
 * A listing with member or opened hints reads every candidate Project's host
 * with the caller's credentials (`/internal/space/read`). The Catalog keeps
 * each successful answer for PROJECT_READ_TTL_MS, keyed by Project and by the
 * caller's access basis (`accessBasis`): the parts of a credential that can
 * change a Project's decision, so one credential's answer never serves
 * another that might read less. Only a 200 answer is kept; a refusal, a 5xx
 * or a thrown error is not.
 *
 * A Project's answers are dropped (`evicted`) when this Catalog hears of a
 * change to it: a discovery hint added or removed, or a create, update,
 * delete, access change or `get_project` (which can claim an invitation)
 * that this Catalog handles. A read that was in flight when that happened
 * isn't kept. A member removed some other way may still see the Project in
 * the list until its answer expires; opening it is checked by the Project.
 *
 * Per-Project state: `{ generation, answers }`, `answers` mapping an access
 * basis to `{ body, until }`. Events: `answered` (keep a read's body if no
 * eviction happened since it started, at `generation`), `evicted` (drop all,
 * move the generation on) and `expired` (drop answers past `until`).
 */

/** How long a Project host's answer serves later listings. */
export const PROJECT_READ_TTL_MS = 30_000;

export const emptyProjectReads = Object.freeze({ generation: 0, answers: new Map() });

/** One step for one Project: `{ project, kept? }`, or `{ project, rejected }`
 * with the state unchanged. */
export function projectReadMemo(project, event) {
  switch (event.type) {
    case "answered": {
      if (event.generation !== project.generation) return { project, kept: false };
      const answers = new Map(project.answers);
      answers.set(event.basis, { body: event.body, until: event.now + PROJECT_READ_TTL_MS });
      return { project: { generation: project.generation, answers }, kept: true };
    }
    case "evicted":
      return { project: { generation: project.generation + 1, answers: new Map() } };
    case "expired": {
      const answers = new Map(
        [...project.answers].filter(([, answer]) => answer.until > event.now),
      );
      return {
        project:
          answers.size === project.answers.size
            ? project
            : { generation: project.generation, answers },
      };
    }
    default:
      return { project, rejected: "unknown event" };
  }
}

/** The parts of `identity` a Project's read decision depends on besides its
 * principal (authz.mjs principalOf): write permission and the organization
 * and email-domain evidence. A Catalog serves one principal, so the
 * principal itself is implied. Expiry times are left out: an answer lasts
 * PROJECT_READ_TTL_MS at most. */
export function accessBasis(identity) {
  const domain = identity?.domainAccess;
  const organizations = Array.isArray(identity?.organizations) ? identity.organizations : [];
  return JSON.stringify([
    !!identity?.canWrite,
    identity?.namespace ?? null,
    domain ? [domain.namespace ?? null, domain.domain ?? null] : null,
    organizations.map((lease) => [lease?.namespace ?? null, lease?.id ?? null]).sort(),
  ]);
}

/** The memo for one Catalog. Bodies go in and come out as copies, so no
 * caller shares an object with another. */
export function projectReads() {
  const projects = new Map();
  const step = (spaceId, event) => {
    const result = projectReadMemo(projects.get(spaceId) ?? emptyProjectReads, event);
    if (result.rejected) throw new Error(`Project read memo: ${result.rejected}`);
    if (result.project.answers.size === 0 && result.project.generation === 0)
      projects.delete(spaceId);
    else projects.set(spaceId, result.project);
    return result;
  };
  return {
    /** A kept answer for `spaceId` and `basis` at `now`, or null. */
    lookup(spaceId, basis, now) {
      if (!projects.has(spaceId)) return null;
      const answer = step(spaceId, { type: "expired", now }).project.answers.get(basis);
      return answer ? structuredClone(answer.body) : null;
    },
    /** Call before reading `spaceId`'s host; pass the result to `answered`. */
    begin(spaceId) {
      return (projects.get(spaceId) ?? emptyProjectReads).generation;
    },
    answered(spaceId, generation, basis, body, now) {
      return step(spaceId, {
        type: "answered",
        generation,
        basis,
        body: structuredClone(body),
        now,
      }).kept;
    },
    evict(spaceId) {
      if (typeof spaceId === "string") step(spaceId, { type: "evicted" });
    },
    /** Whether any answer for `spaceId` is kept, for tests. */
    holds(spaceId) {
      return (projects.get(spaceId)?.answers.size ?? 0) > 0;
    },
  };
}
