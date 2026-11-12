/** Opened-Project hints: the Projects a person opened through an
 * organization grant, kept in their own Catalog so the Project list can offer
 * them. An organization has no member list to send discovery hints to, so a
 * person's own open is the only time Pages learns they may read the Project.
 *
 * `project-opened/<space_id>` holds `{ space_id, owner, at }`, apart from
 * member hints (`project-discovery/<space_id>`), and neither kind ever
 * touches the other. An opened hint is only a candidate: the list reads the
 * Project with the person's credential before showing it, so a hint for a
 * Project they can no longer read, or one that is gone, stays hidden until it
 * ages out.
 *
 * Writing one runs inside the Project host's read and outside the Catalog's
 * queue, so it does storage operations only and never awaits another host:
 * a fetch here would hold the person's open for as long as that host takes,
 * and a list it read could be stale by the time it acts on it. */

/** The most opened hints one Catalog keeps. A person can open any number of
 * organization Projects, so the hints need a bound, and 200 is more than a
 * list a person reads while keeping the list's re-check of each one cheap. */
export const OPENED_PROJECT_HINTS = 200;
/** An opened hint younger than this is not written again on a re-open. */
export const OPENED_PROJECT_REFRESH_MS = 24 * 60 * 60 * 1000;

const PREFIX = "project-opened/";

/** Record that the person whose Catalog `storage` is opened `space_id`, owned
 * by `owner`, at `now`, then trim to the newest `OPENED_PROJECT_HINTS` by
 * `at`. Trimming to the bound, not counting down from a size read earlier,
 * means two writes that race can at worst both trim, and the next write
 * corrects any overshoot. */
export async function recordOpenedProject(storage, { space_id, owner }, now = Date.now()) {
  const key = `${PREFIX}${space_id}`;
  const known = await storage.get(key);
  if (known?.owner === owner && known.at > now - OPENED_PROJECT_REFRESH_MS) return;
  await storage.put(key, { space_id, owner, at: now });
  const hints = await storage.list({ prefix: PREFIX });
  if (hints.size <= OPENED_PROJECT_HINTS) return;
  const oldest = [...hints]
    .sort(([, a], [, b]) => (a?.at ?? 0) - (b?.at ?? 0))
    .slice(0, hints.size - OPENED_PROJECT_HINTS);
  for (const [name] of oldest) await storage.delete(name);
}

/** Every opened hint in `storage`, as `{ space_id, owner }` candidates. */
export async function openedProjects(storage) {
  return [...(await storage.list({ prefix: PREFIX })).values()];
}
