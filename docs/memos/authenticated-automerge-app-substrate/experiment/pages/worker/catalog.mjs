/** A host-owned, last-observed title projection. Owned listings avoid opening documents; shared references are checked by the host.
 *
 * Keys: `page/<id>` holds active (or pending) owned Pages, `trash/<id>` holds
 * owned Pages in Trash, `shared/<id>` caches Pages shared with this account,
 * `space/<id>` holds Spaces this account owns and `host/deleted/<id>`
 * tombstones permanent deletions. Owned entries are the only record of each
 * Page's location (catalog-location.mjs). Trashed entries use a
 * separate prefix so they never consume active listing or quota slots, and so
 * builds that predate Trash do not list them. `host/count/active` and
 * `host/count/trash` count the keys under `page/` and `trash/`
 * (catalog-counts.mjs).
 *
 * Callers see Projects. Storage keeps the Space name so a rollback build reads
 * the same records: `space/<id>` entries, `space_id` placement fields and the
 * journal intents that name them.
 */
import { markCatalogIndexDirty } from "./catalog-index.mjs";
import { RETRY_LIFETIME_MS } from "./operation-journal.mjs";
import { operationIntent } from "./operation-intent.mjs";
import { locationEntries, projectOf, rekeyedEntries, restoreTarget } from "./catalog-location.mjs";

/** Every entry under `prefix`, read in pages. An account's limit is set per
 * account (page-quota.mjs), so no fixed page size covers a whole prefix. */
export async function listAll(storage, prefix, pageSize = 500) {
  const all = new Map();
  let startAfter;
  for (;;) {
    const page = await storage.list({ prefix, limit: pageSize, ...(startAfter && { startAfter }) });
    for (const [key, value] of page) all.set(key, value);
    if (page.size < pageSize) return all;
    const last = [...page.keys()].at(-1);
    if (startAfter !== undefined && !(last > startAfter))
      throw new Error("Catalog storage did not advance past startAfter");
    startAfter = last;
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** A title as listings store, order and show it: at most 500 UTF-16 code
 * units, cut on a code point boundary, with any lone surrogate replaced by
 * U+FFFD. D1 stores text as UTF-8, which has no lone surrogates, so this is
 * the form that reads back the same from D1 and from Catalog entries. */
export function catalogTitle(title) {
  if (typeof title !== "string") return "Untitled";
  let cut = title.slice(0, 500);
  // A surrogate pair split at the limit drops its first half.
  if (/[\uD800-\uDBFF]$/.test(cut) && /^[\uDC00-\uDFFF]/.test(title.slice(500)))
    cut = cut.slice(0, -1);
  return cut.replace(LONE_SURROGATE, "\uFFFD");
}
/** A trash time in `Date#toISOString`'s format, the one format listings
 * compare, or null. Another date string or a number is converted, so a Trash
 * key never sorts by its spelling. The Catalog writes this into a `trash/`
 * entry from the host's report, as the index does into its Page row. */
export function trashTime(value) {
  const ms = typeof value === "string" ? Date.parse(value) : value;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
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
  const trash = await listAll(storage, "trash/");
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
/** `placement` records the parent (and a root's Project) a restore returns
 * the Page to, so the leaf guard sees a pending restore. */
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
/** Count the reservation slot at `slotKey`, if there is one, as countCapacity
 * would: a stale one is released, and a forwarded one past its lifetime is
 * read against its Page. Capacity checks read stored counts and leave other
 * Pages' slots alone, so a caller that would act on a slot counts it first. */
export async function countSlot(storage, slotKey, { now = Date.now(), current } = {}) {
  const entry = await storage.get(slotKey);
  if (!entry?.reservation) return;
  await runSlot(
    storage,
    slotKey,
    entry,
    { type: "count", expired: !(entry.expires_at > now) },
    current,
  );
}
export async function countCapacity(storage, prefix, { now = Date.now(), current } = {}) {
  const entries = await listAll(storage, prefix);
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
/**
 * Whether `prefix` has room for one more entry within `limit`, and the count
 * that decided it. `storage` is countedStorage (catalog-counts.mjs). Its stored count covers every
 * key, reservations included, so a count below the limit answers at once. At
 * or above the limit, or before the count is first stored, countCapacity
 * counts exactly (removing stale reservations as it goes) and the stored
 * counts are rebuilt from what remains. `slotKey` names the caller's own
 * reservation slot; it is counted first, as a full count would, so a stale
 * one never reads as taken.
 */
export async function capacityFor(
  storage,
  prefix,
  limit,
  { now = Date.now(), current, slotKey } = {},
) {
  if (slotKey) await countSlot(storage, slotKey, { now, current });
  const stored = await storage.counts();
  if (stored && stored[prefix] < limit) return { room: true, count: stored[prefix] };
  const count = await countCapacity(storage, prefix, { now, current });
  await storage.rebuildCounts();
  return { room: count < limit, count };
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
 *
 * `marked` says the caller already marked the Page for the index
 * (catalog-index.mjs `markPagesForIndex`), so the account isn't marked
 * dirty. `now` is the observation time; pass the one the caller's D1 rows
 * carry (`lifecycleIndexItem`), so both sources hold the same `updated_at`.
 */
export async function projectLifecycle(storage, pageId, current, options = {}) {
  // One transaction: a crash leaves the Page in the listing it was in or the
  // one it moves to, never both and never neither. Storage without
  // transactions writes in order.
  if (typeof storage.transaction !== "function")
    return projectEntries(storage, pageId, current, options);
  return storage.transaction((transaction) =>
    projectEntries(transaction, pageId, current, options),
  );
}

/** This Page's own entry, `page/` or `trash/`, without reservations. */
async function knownEntries(storage, pageId) {
  const [active, trashed] = await Promise.all([
    storage.get(`page/${pageId}`),
    storage.get(`trash/${pageId}`),
  ]);
  return [active, trashed].filter((entry) => entry && !entry.reservation);
}

/** The fields a projection of `current` writes to the Page's entry, from the
 * entry it had. Location fields stay as they were. */
function projectedBase(entry, pageId, current, now) {
  return {
    ...entry,
    page_id: pageId,
    title: catalogTitle(current.title ?? entry.title),
    created_at: entry.created_at ?? trashTime(current.trashed_at) ?? now,
    updated_at: entry.updated_at && entry.updated_at > now ? entry.updated_at : now,
    lifecycle_revision: current.revision ?? 0,
  };
}

/** What D1 should hold once `projectLifecycle(storage, pageId, current,
 * { now })` lands: `{ entry, state }` for catalog-index.mjs
 * `indexOwnedEntries`, or null when the projection changes nothing because
 * the Catalog already holds a newer revision. */
export async function lifecycleIndexItem(storage, pageId, current, now) {
  if (current.state === "deleted")
    return {
      entry: { page_id: pageId, lifecycle_revision: current.revision ?? 0 },
      state: "deleted",
    };
  if (current.state !== "active" && current.state !== "trashed") return null;
  const known = await knownEntries(storage, pageId);
  if (known.some((entry) => (entry.lifecycle_revision ?? 0) > (current.revision ?? 0))) return null;
  const entry = projectedBase(known[0] ?? { page_id: pageId }, pageId, current, now);
  return current.state === "trashed"
    ? { entry: { ...entry, trashed_at: trashTime(current.trashed_at) }, state: "trashed" }
    : { entry, state: "active" };
}

async function projectEntries(storage, pageId, current, { marked = false, now } = {}) {
  // Every projection changes which listing holds the Page. Unless the caller
  // marked the Page, the D1 index reconciles from these entries.
  if (!marked) await markCatalogIndexDirty(storage);
  if (current.state === "deleted") {
    await storage.put(`host/deleted/${pageId}`, true);
    await storage.delete(`page/${pageId}`);
    await storage.delete(`trash/${pageId}`);
    return;
  }
  const known = await knownEntries(storage, pageId);
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
  // Each transition is a newer observation: owner reconciliation compares
  // these timestamps, so an older index write cannot win over it. Location
  // stays this Catalog's: the entry keeps its parent and position.
  const { restore_space_id: restoreSpaceId, ...kept } = entry;
  const base = projectedBase(kept, pageId, current, now ?? new Date().toISOString());
  if (current.state === "trashed") {
    // A sub-page records its Project, which a restore needs if its parent
    // is gone by then. A root carries its own space_id.
    const spaceId =
      restoreSpaceId ?? (base.parent_id ? projectOf(await locationEntries(storage), pageId) : null);
    await storage.put(`trash/${pageId}`, {
      ...base,
      ...trashFields({ ...current, page_id: pageId, trashed_at: trashTime(current.trashed_at) }),
      ...(spaceId && { restore_space_id: spaceId }),
    });
    await storage.delete(`page/${pageId}`);
  } else if (current.state === "active") {
    // An active Page has an active parent: a restore whose parent is in
    // Trash or gone returns to the top level.
    const { location, rekeyed } = await restoreTarget(storage, pageId);
    const { space_id: _space, home: _home, ...rest } = base;
    await storage.put({
      ...(await rekeyedEntries(storage, rekeyed)),
      [`page/${pageId}`]: { ...rest, ...location },
    });
    await storage.delete(`trash/${pageId}`);
  } else throw new TypeError("Unknown Page lifecycle state");
}

/** Owned entries under `prefix` by Page ID, without reservations or pending
 * creations. */
export async function catalogEntries(storage, prefix) {
  const entries = new Map();
  for (const entry of (await listAll(storage, prefix)).values())
    if (entry?.page_id && !entry.pending && !entry.reservation) entries.set(entry.page_id, entry);
  return entries;
}
