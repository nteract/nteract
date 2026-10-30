/** A host-owned, last-observed title projection. Owned listings avoid opening documents; shared references are checked by the host.
 *
 * Keys: `page/<id>` holds active (or pending) owned Pages, `trash/<id>` holds
 * owned Pages in Trash, `shared/<id>` caches Pages shared with this account,
 * `space/<id>` holds Spaces this account owns and `host/deleted/<id>`
 * tombstones permanent deletions. Owned entries copy their Page's placement
 * (space_id, parent_id, position, placement_epoch, home); entries written
 * before Spaces have none and are Your items. Trashed entries use a
 * separate prefix so they never consume active listing or quota slots, and so
 * builds that predate Trash do not list them.
 */
import { markCatalogIndexDirty } from "./catalog-index.mjs";
import { RETRY_LIFETIME_MS } from "./operation-journal.mjs";
import { placementEntry } from "./spaces.mjs";

export const CATALOG_LIMIT = 100;
export const TRASH_LIMIT = 100;

export function catalogTitle(title) {
  return typeof title === "string" ? title.slice(0, 500) : "Untitled";
}
export const trashFields = (entry) => ({
  state: "trashed",
  trashed_at: entry.trashed_at,
  trashed_by: entry.trashed_by,
  trash_root_id: entry.trash_root_id ?? entry.page_id,
});
/** A build without Trash can permanently delete a trashed Page. It writes the
 * owner's tombstone but leaves the `trash/` entry; drop such entries before
 * listing Trash. */
export async function pruneTombstonedTrash(storage) {
  const trash = await storage.list({ prefix: "trash/", limit: TRASH_LIMIT });
  for (const [key, entry] of trash)
    if (await storage.get(`host/deleted/${entry.page_id}`)) await storage.delete(key);
}
export async function refreshCatalogTitle(storage, { page_id, title, observed_at }) {
  const key = `page/${page_id}`;
  const entry = await storage.get(key);
  // A late title update must never resurrect a deleted page or overwrite a
  // more recently observed projection. Ownership lives in the Page, not here.
  if (!entry || entry.pending || (entry.updated_at && entry.updated_at > observed_at)) return;
  if (entry.title !== title) await storage.put(key, { ...entry, title, updated_at: observed_at });
}

/** Pending trash and restore requests hold a hidden destination slot: a
 * `trash/<id>` or `page/<id>` placeholder that counts toward capacity. A
 * placeholder lasts for one retry lifetime and only while its intent is still
 * pending; anything else is stale and is removed when capacity is counted.
 */
export function lifecycleSlotKey(operation, pageId) {
  if (operation === "delete_page") return `trash/${pageId}`;
  if (operation === "restore_page") return `page/${pageId}`;
}
/** `placement` records where a restore returns the Page (its Space and
 * recorded parent), so placement checks see a pending restore. */
export function lifecycleSlot(operation, pageId, intentKey, now = Date.now(), placement) {
  const key = lifecycleSlotKey(operation, pageId);
  return key
    ? {
        [key]: {
          page_id: pageId,
          pending: true,
          reservation: operation,
          intent: intentKey,
          expires_at: now + RETRY_LIFETIME_MS,
          ...(placement && { space_id: placement.space_id, parent_id: placement.parent_id }),
        },
      }
    : {};
}
/** A slot is live while its intent is pending and either within its retry
 * lifetime or already forwarded to the Page. A forwarded request may have been
 * applied, so its slot never simply expires.
 */
async function liveReservation(storage, entry, now) {
  if (!entry?.reservation) return false;
  const intent = await storage.get(entry.intent);
  return intent?.pending === true && (entry.expires_at > now || intent.forwarded === true);
}
/** Entries that count toward a prefix's capacity. Stale slots are removed. A
 * forwarded slot past its lifetime is reconciled against the Page's current
 * lifecycle state: it becomes the real entry if a transition happened since
 * the request was reserved, and is released otherwise. `current(pageId)`
 * reads that state; without an answer the slot keeps counting.
 */
export async function countCapacity(storage, prefix, { now = Date.now(), current } = {}) {
  const entries = await storage.list({ prefix, limit: CATALOG_LIMIT });
  let count = 0;
  for (const [key, entry] of entries) {
    if (!entry.reservation) {
      count++;
      continue;
    }
    const intent = await storage.get(entry.intent);
    if (intent?.pending !== true || (entry.expires_at <= now && !intent.forwarded)) {
      await storage.delete(key);
      continue;
    }
    if (entry.expires_at > now) {
      count++;
      continue;
    }
    const state = await current?.(entry.page_id).catch(() => undefined);
    if (!state) {
      count++;
      continue;
    }
    if (state.state === "missing")
      await projectLifecycle(storage, entry.page_id, { state: "deleted" });
    else if ((state.revision ?? 0) !== intent.expectedRevision)
      await projectLifecycle(storage, entry.page_id, state);
    else {
      await storage.delete(key);
      continue;
    }
    const settled = await storage.get(key);
    if (settled && !settled.reservation) count++;
  }
  return count;
}
/** Whether a resumed intent still holds its destination slot. A real entry
 * already at the destination needs no slot.
 */
export async function holdsLifecycleSlot(storage, operation, pageId, intentKey, now = Date.now()) {
  const key = lifecycleSlotKey(operation, pageId);
  if (!key) return true;
  const entry = await storage.get(key);
  if (entry && !entry.reservation) return true;
  return entry?.intent === intentKey && (await liveReservation(storage, entry, now));
}
export async function releaseLifecycleSlot(storage, operation, pageId, intentKey) {
  const key = lifecycleSlotKey(operation, pageId);
  if (key && (await storage.get(key))?.intent === intentKey) await storage.delete(key);
}
/** The lifecycle revision this account last observed for an owned Page. */
export async function observedLifecycleRevision(storage, pageId) {
  for (const key of [`page/${pageId}`, `trash/${pageId}`]) {
    const entry = await storage.get(key);
    if (entry && !entry.reservation) return entry.lifecycle_revision ?? 0;
  }
  return 0;
}

/** Project the Page's current lifecycle state into the owner's index. The
 * Page record stays authoritative. A retry may replay an older receipt, so
 * this always uses the Page's current state and ignores older revisions.
 */
export async function projectLifecycle(storage, pageId, current) {
  // Every projection changes which listing holds the Page; the D1 index
  // reconciles from these entries.
  await markCatalogIndexDirty(storage);
  if (current.state === "deleted") {
    await storage.put(`host/deleted/${pageId}`, true);
    await storage.delete(`page/${pageId}`);
    await storage.delete(`trash/${pageId}`);
    return;
  }
  const [active, trashed] = await Promise.all([
    storage.get(`page/${pageId}`),
    storage.get(`trash/${pageId}`),
  ]);
  const known = [active, trashed].filter((entry) => entry && !entry.reservation);
  if (known.some((entry) => (entry.lifecycle_revision ?? 0) > (current.revision ?? 0))) return;
  const {
    pending: _pending,
    reservation: _reservation,
    state: _state,
    trashed_at: _at,
    trashed_by: _by,
    trash_root_id: _root,
    ...entry
  } = known[0] ?? { page_id: pageId };
  const now = new Date().toISOString();
  // Each transition is a newer observation: owner reconciliation compares
  // these timestamps, so an older index write cannot win over it.
  const base = {
    ...entry,
    page_id: pageId,
    title: catalogTitle(current.title ?? entry.title),
    created_at: entry.created_at ?? current.trashed_at ?? now,
    updated_at: entry.updated_at && entry.updated_at > now ? entry.updated_at : now,
    lifecycle_revision: current.revision ?? 0,
    // A restore can return a Page whose parent is gone to the top level.
    ...(Number.isSafeInteger(current.placement_epoch) && placementEntry(current)),
  };
  if (current.state === "trashed") {
    await storage.put(`trash/${pageId}`, {
      ...base,
      ...trashFields({ ...current, page_id: pageId }),
    });
    await storage.delete(`page/${pageId}`);
  } else if (current.state === "active") {
    await storage.put(`page/${pageId}`, base);
    await storage.delete(`trash/${pageId}`);
  } else throw new TypeError("Unknown Page lifecycle state");
}

/** Owned entries under `prefix` by Page ID, without reservations or pending
 * creations. An account holds at most CATALOG_LIMIT active and TRASH_LIMIT
 * trashed Pages, plus their reservation slots. */
export async function catalogEntries(storage, prefix) {
  const entries = new Map();
  for (const entry of (await storage.list({ prefix, limit: 1000 })).values())
    if (entry?.page_id && !entry.pending && !entry.reservation) entries.set(entry.page_id, entry);
  return entries;
}
