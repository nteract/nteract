/** A host-owned, last-observed title projection. Owned listings avoid opening documents; shared references are checked by the host.
 *
 * Keys: `page/<id>` holds active (or pending) owned Pages, `trash/<id>` holds
 * owned Pages in Trash, `shared/<id>` caches Pages shared with this account,
 * `space/<id>` holds Spaces this account owns and `host/deleted/<id>`
 * tombstones permanent deletions. Owned entries are the only record of each
 * Page's location (catalog-location.mjs). Trashed entries use a
 * separate prefix so they never consume active listing or quota slots, and so
 * builds that predate Trash do not list them. `host/count/active` and
 * `host/count/trash` count the keys under `page/` and `trash/`; see
 * countedStorage.
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

/** Where each counted prefix keeps its count. */
export const COUNT_KEYS = Object.freeze({
  "page/": "host/count/active",
  "trash/": "host/count/trash",
});
const COUNTED = Object.keys(COUNT_KEYS);
const countedPrefix = (key) =>
  typeof key === "string" ? COUNTED.find((prefix) => key.startsWith(prefix)) : undefined;
const countEntries = (counts) =>
  Object.fromEntries(COUNTED.map((prefix) => [COUNT_KEYS[prefix], counts[prefix]]));

/**
 * The Catalog's storage, keeping `host/count/active` and `host/count/trash`
 * equal to the number of keys under `page/` and `trash/`. Pending creations
 * and Trash or restore reservations are keys too, so the counts are at least
 * what countCapacity counts; capacityFor relies on that.
 *
 * Every write that adds or removes such a key writes the new counts with it:
 * a put adds them to the same multi-key put, and a delete and its count put
 * run in one transaction (inside a transaction, which has no nested one, they
 * join it). The counts are held in memory once read, and each write adjusts them
 * synchronously before it is issued, so writes running concurrently in one
 * request (a settle pass) never lose an update. A failed write or transaction
 * drops the memory copy; the next write reads storage again.
 *
 * Until the counts are first stored (capacityFor or verifyCounts does that),
 * writes leave them absent. A build without this wrapper writes keys without
 * counts; verifyCounts, which every Page listing runs, repairs that.
 */
export function countedStorage(storage, state = { counts: undefined }) {
  const load = async () => {
    if (state.counts !== undefined) return state.counts;
    const active = await storage.get(COUNT_KEYS["page/"]);
    const trash = await storage.get(COUNT_KEYS["trash/"]);
    const loaded =
      Number.isSafeInteger(active) && Number.isSafeInteger(trash)
        ? { "page/": active, "trash/": trash }
        : null;
    if (state.counts === undefined) state.counts = loaded;
    return state.counts;
  };
  const delta = async (keys, adding) => {
    const change = { "page/": 0, "trash/": 0 };
    let changed = false;
    for (const key of new Set(keys)) {
      const prefix = countedPrefix(key);
      if (!prefix) continue;
      const exists = (await storage.get(key)) !== undefined;
      if (exists === adding) continue;
      change[prefix] += adding ? 1 : -1;
      changed = true;
    }
    return changed ? change : null;
  };
  // Synchronous from here to the write, so concurrent writes adjust in turn.
  const adjusted = (change) => {
    if (!change || !state.counts) return null;
    for (const prefix of COUNTED)
      state.counts[prefix] = Math.max(0, state.counts[prefix] + change[prefix]);
    return countEntries(state.counts);
  };
  const guarded = async (write) => {
    try {
      return await write;
    } catch (error) {
      state.counts = undefined;
      throw error;
    }
  };
  const put = async (keyOrEntries, valueOrOptions, options) => {
    const single = typeof keyOrEntries === "string";
    const keys = single ? [keyOrEntries] : Object.keys(keyOrEntries);
    if (!keys.some(countedPrefix)) return storage.put(keyOrEntries, valueOrOptions, options);
    await load();
    const counts = adjusted(await delta(keys, true));
    if (!counts) return storage.put(keyOrEntries, valueOrOptions, options);
    const entries = single ? { [keyOrEntries]: valueOrOptions } : { ...keyOrEntries };
    return guarded(storage.put({ ...entries, ...counts }, single ? options : valueOrOptions));
  };
  const remove = async (keyOrKeys, options) => {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    if (!keys.some(countedPrefix)) return storage.delete(keyOrKeys, options);
    await load();
    const counts = adjusted(await delta(keys, false));
    if (!counts) return storage.delete(keyOrKeys, options);
    const both = async (target) =>
      (await Promise.all([target.delete(keyOrKeys, options), target.put(counts)]))[0];
    return guarded(
      typeof storage.transaction === "function" ? storage.transaction(both) : both(storage),
    );
  };
  const write = async (counts) => {
    state.counts = counts;
    await guarded(storage.put(countEntries(counts)));
    return counts;
  };
  const extra = {
    put,
    delete: remove,
    /** The stored counts, or null before they are first stored. */
    counts: load,
    /** Count every key under both prefixes and store the result. Callers run
     * it between the steps of the Catalog's serial queue, never beside
     * another write. */
    rebuildCounts: async () =>
      write({
        "page/": (await listAll(storage, "page/")).size,
        "trash/": (await listAll(storage, "trash/")).size,
      }),
    /** Store `counts`, read by a full scan, if they differ from the stored
     * ones. Returns true when stored counts existed and disagreed. */
    verifyCounts: async (counts) => {
      const stored = await load();
      if (stored && COUNTED.every((prefix) => stored[prefix] === counts[prefix])) return false;
      await write({ ...counts });
      return stored !== null;
    },
    ...(typeof storage.transaction === "function" && {
      transaction: (run) =>
        guarded(storage.transaction((transaction) => run(countedStorage(transaction, state)))),
    }),
  };
  return new Proxy(storage, {
    get(target, name) {
      if (Object.hasOwn(extra, name)) return extra[name];
      const value = Reflect.get(target, name, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

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
 * that decided it. `storage` is countedStorage. Its stored count covers every
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
  // these timestamps, so an older index write cannot win over it. Location
  // stays this Catalog's: the entry keeps its parent and position.
  const { restore_space_id: restoreSpaceId, ...kept } = entry;
  const base = {
    ...kept,
    page_id: pageId,
    title: catalogTitle(current.title ?? entry.title),
    created_at: entry.created_at ?? current.trashed_at ?? now,
    updated_at: entry.updated_at && entry.updated_at > now ? entry.updated_at : now,
    lifecycle_revision: current.revision ?? 0,
  };
  if (current.state === "trashed") {
    // A sub-page records its Project, which a restore needs if its parent
    // is gone by then. A root carries its own space_id.
    const spaceId =
      restoreSpaceId ?? (base.parent_id ? projectOf(await locationEntries(storage), pageId) : null);
    await storage.put(`trash/${pageId}`, {
      ...base,
      ...trashFields({ ...current, page_id: pageId }),
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
