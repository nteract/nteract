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
import { operationIntent } from "./operation-intent.mjs";
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
 * The operation-intent machine (operation-intent.mjs) owns these rules.
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
/** The operation-intent state stored under `intentKey` for a request that
 * moves `pageId` by `operation`, with the slot it holds. A forwarded intent's
 * fields that live in memory for one request start false. */
export async function intentState(storage, intentKey, operation, pageId) {
  const row = await storage.get(intentKey);
  if (!row) return { name: "absent" };
  if (!row.pending)
    return {
      name: row.receipt?.superseded ? "superseded" : "completed",
      operation,
      receipt: row.receipt ?? {},
    };
  const slotKey = lifecycleSlotKey(operation, pageId);
  const entry = slotKey && (await storage.get(slotKey));
  const slot = !slotKey
    ? "none"
    : !entry
      ? "lapsed"
      : !entry.reservation
        ? "entry"
        : entry.intent === intentKey
          ? "live"
          : "lapsed";
  return {
    name: row.forwarded ? "forwarded" : "reserved",
    operation,
    pageId,
    ...(row.expectedRevision !== undefined && { expectedRevision: row.expectedRevision }),
    slot,
    ...(row.forwarded && { retarget: false, replayOnly: false }),
  };
}
/** The newest lifecycle revision among this Page's own entries. A
 * projection never replaces it with an older observation. */
export async function knownRevision(storage, pageId) {
  let known;
  for (const key of [`page/${pageId}`, `trash/${pageId}`]) {
    const entry = await storage.get(key);
    if (entry && !entry.reservation) known = Math.max(known ?? 0, entry.lifecycle_revision ?? 0);
  }
  return known;
}
/** The Page's lifecycle state read through `read`, as a machine event. A
 * failed read, or no reader, is unavailable. */
async function lifecycleEvent(storage, pageId, read) {
  let current;
  try {
    current = await read?.(pageId);
  } catch {
    current = undefined;
  }
  if (!current) return { type: "lifecycle", unavailable: true };
  const known = current.state === "missing" ? undefined : await knownRevision(storage, pageId);
  return { type: "lifecycle", current, ...(known !== undefined && { known }) };
}
/** Run one capacity count or placement check (`event`) over the slot `entry`
 * stored at `slotKey`. The operation-intent machine decides; this runs its
 * effects and reads the Page through `read(pageId)` when it asks. Returns the
 * machine's last result. */
export async function runSlot(storage, slotKey, entry, event, read) {
  const { reservation: operation, page_id: pageId, intent: intentKey } = entry;
  let state = await intentState(storage, intentKey, operation, pageId);
  for (;;) {
    const result = operationIntent.step(state, event);
    if (result.rejected) throw new Error(`Slot ${slotKey} can't take ${event.type}`);
    let next;
    for (const effect of result.effects) {
      if (effect.type === "release_slot") await storage.delete(slotKey);
      else if (effect.type === "project") await projectLifecycle(storage, pageId, effect.current);
      else if (effect.type === "read_lifecycle") next = await lifecycleEvent(storage, pageId, read);
      else throw new Error(`A slot check can't run ${effect.type}`);
    }
    if (!next) return result;
    state = result.state;
    event = next;
  }
}
/** Entries that count toward a prefix's capacity. Each reservation is a
 * `count` for its intent: a stale or never-forwarded expired slot is removed,
 * and a forwarded one past its lifetime is read against the Page, which
 * settles it into the real entry or releases it. `current(pageId)` reads that
 * state; without an answer the slot keeps counting.
 */
export async function countCapacity(storage, prefix, { now = Date.now(), current } = {}) {
  const entries = await storage.list({ prefix, limit: CATALOG_LIMIT });
  let count = 0;
  for (const [key, entry] of entries) {
    if (!entry.reservation) {
      count++;
      continue;
    }
    const event = { type: "count", expired: !(entry.expires_at > now) };
    const { response } = await runSlot(storage, key, entry, event, current);
    if (response.counted) count++;
  }
  return count;
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
  // One transaction: a crash leaves the Page in the listing it was in or the
  // one it moves to, never both and never neither. Storage without
  // transactions writes in order.
  if (typeof storage.transaction !== "function") return projectEntries(storage, pageId, current);
  return storage.transaction((transaction) => projectEntries(transaction, pageId, current));
}

async function projectEntries(storage, pageId, current) {
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
