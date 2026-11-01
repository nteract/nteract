/**
 * Location in the owner's Catalog.
 *
 * The owner's Catalog is the only record of where its Pages live. Page
 * objects store no location. Each owned entry (`page/<id>` while active or
 * pending, `trash/<id>` in Trash) stores:
 * - `parent_id`: another owned Page, or null for a root. A Project's
 *   top-level Pages are children of its home Page. On a trashed entry it is
 *   the restore hint: the parent the Page had when it was trashed;
 * - `position`: a fractional key among its siblings. Roots without
 *   `space_id` are the siblings of Your items; a home Page is alone;
 * - `space_id` and `home: true`: only on a Project's home Page, the one root
 *   a Project has. location-shape.mjs migrates Catalogs written before this
 *   shape, where every Project top-level Page was a root with `space_id`;
 * - `restore_space_id`: only on a trashed entry that isn't a root. It is the
 *   Project the Page was in when it was trashed, for a restore whose parent
 *   is gone by then.
 *
 * A Page's Project is derived by walking parents to the root with
 * model/location.mjs. Nothing else stores it. Every location write runs in
 * the Catalog's serial queue; these helpers read storage and never write.
 */
import { deriveLocation, positionAmong, siblingsOf, validPositionKey } from "../model/location.mjs";
import { listAll } from "./catalog.mjs";

/** Location entries by Page ID, for model/location.mjs. Reservation slots
 * are placeholders for a pending Trash or restore and are skipped: the Page's
 * real entry stays where it is until the Page applies the request. */
export async function locationEntries(storage) {
  return (await locationScan(storage)).entries;
}

/** Location entries, plus the number of keys under each prefix that the
 * scan read: `{ entries, counts }`. A Page listing uses the counts to check
 * the Catalog's stored counts (catalog-counts.mjs). */
export async function locationScan(storage) {
  const entries = new Map();
  const counts = {};
  for (const [prefix, state] of [
    ["page/", "active"],
    ["trash/", "trashed"],
  ]) {
    const listed = await listAll(storage, prefix);
    counts[prefix] = listed.size;
    for (const entry of listed.values()) {
      if (!entry?.page_id || entry.reservation) continue;
      entries.set(entry.page_id, {
        page_id: entry.page_id,
        state: entry.pending ? "pending" : state,
        parent_id: entry.parent_id ?? null,
        position: entry.position,
        ...(entry.space_id && { space_id: entry.space_id }),
        ...(entry.home && { home: true }),
        ...(entry.restore_space_id && { restore_space_id: entry.restore_space_id }),
      });
    }
  }
  return { entries, counts };
}

/** The Project a Page is in, or null for Your items. A trashed Page whose
 * parent chain is broken uses the Project it recorded when it was trashed. */
export function projectOf(entries, pageId) {
  const derived = deriveLocation(entries, pageId);
  if (derived.ok) return derived.space_id;
  return entries.get(pageId)?.restore_space_id ?? null;
}

/** What the internal location route answers for one Page: IDs only.
 * `ancestors` is nearest first; `complete` says it reaches a root. */
export function locationAnswer(entries, pageId) {
  const entry = entries.get(pageId);
  if (!entry) return null;
  const derived = deriveLocation(entries, pageId);
  return {
    page_id: pageId,
    state: entry.state,
    parent_id: entry.parent_id,
    ancestors: derived.ok ? derived.ancestors : [],
    complete: derived.ok,
    space_id: projectOf(entries, pageId),
    home: entry.home === true,
  };
}

/** Active children of `parentId`, in sibling order. */
export const childrenOf = (entries, parentId) =>
  siblingsOf(entries, parentId)
    .filter((entry) => entry.state === "active")
    .map((entry) => entry.page_id);

/** A Page's location as tools show it: nothing for a root in Your items. */
export function publicLocation(entries, pageId) {
  const entry = entries.get(pageId);
  const spaceId = projectOf(entries, pageId);
  if (!entry || (!spaceId && !entry.parent_id)) return {};
  return {
    space_id: spaceId,
    parent_id: entry.parent_id,
    position: entry.position,
    ...(entry.home && { home: true }),
  };
}

/** The receipt fields a create or restore reports for its Page. */
export function receiptLocation(entries, pageId) {
  const { position: _position, ...location } = publicLocation(entries, pageId);
  return location;
}

/** Siblings a new Page joins: children of `parentId`, or the roots of Your
 * items for null. The model keeps home Pages out of the root sibling set. An
 * entry whose stored key isn't a fractional key can't anchor a new one and is
 * skipped. */
const siblingsAt = (entries, parentId, excludeId) =>
  siblingsOf(entries, parentId, excludeId).filter((entry) => validPositionKey(entry.position));

/** A key after every sibling, and the siblings' new keys when ties had to be
 * repaired (`{ page_id: key }`). */
export function appendPosition(entries, parentId, excludeId) {
  const placed = positionAmong(siblingsAt(entries, parentId, excludeId), "last");
  return { position: placed.position, rekeyed: placed.rekeyed };
}

/** The live home Page of Project `spaceId`: active (not pending, not in
 * Trash) and flagged `home`, or undefined. */
export function homeEntry(entries, spaceId) {
  for (const entry of entries.values())
    if (entry.home === true && entry.space_id === spaceId && entry.state === "active") return entry;
  return undefined;
}

/** Whether an owned Page can hold children: created, not in Trash, and not
 * leaving for Trash. */
export async function parentActive(storage, parentId) {
  if (await storage.get(`trash/${parentId}`)) return false;
  const parent = await storage.get(`page/${parentId}`);
  return !!parent && !parent.pending && !parent.reservation;
}

/**
 * Where a restore puts a Page: under its recorded parent while that parent
 * is active, otherwise at the top level of its Project (under its home Page)
 * while the Project exists, otherwise at the top level of Your items.
 * Returns the entry's location fields, `{ parent_id, position }`, and
 * `rekeyed` siblings. An already active Page keeps its place.
 *
 * A trashed root with `space_id` is an entry from before the home Page was
 * the Project's only root; its Project is that `space_id`, and it returns
 * under the home Page like any other.
 */
export async function restoreTarget(storage, pageId) {
  const entries = await locationEntries(storage);
  const entry = entries.get(pageId);
  if (!entry) return { location: {}, rekeyed: {} };
  const keep = {
    parent_id: entry.parent_id,
    position: entry.position,
    ...(entry.space_id && { space_id: entry.space_id }),
    ...(entry.home && { home: true }),
  };
  if (entry.state !== "trashed") return { location: keep, rekeyed: {} };
  const placeUnder = (parentId) => {
    // A sibling created while this Page was in Trash may hold its old key.
    const taken =
      entry.parent_id !== parentId ||
      siblingsOf(entries, parentId, pageId).some((sibling) => sibling.position === entry.position);
    if (!taken) return { location: { parent_id: parentId, position: entry.position }, rekeyed: {} };
    const { position, rekeyed } = appendPosition(entries, parentId, pageId);
    return { location: { parent_id: parentId, position }, rekeyed };
  };
  if (entry.parent_id && (await parentActive(storage, entry.parent_id)))
    return placeUnder(entry.parent_id);
  let spaceId = entry.parent_id ? projectOf(entries, pageId) : (entry.space_id ?? null);
  if (spaceId) {
    const space = await storage.get(`space/${spaceId}`);
    if (!space || space.pending) spaceId = null;
  }
  const home = spaceId ? homeEntry(entries, spaceId) : undefined;
  if (home) return placeUnder(home.page_id);
  return placeUnder(null);
}

/** Puts that give `rekeyed` siblings their new keys, keeping the rest of
 * each stored entry. */
export async function rekeyedEntries(storage, rekeyed) {
  const puts = {};
  for (const [pageId, position] of Object.entries(rekeyed)) {
    const entry = await storage.get(`page/${pageId}`);
    if (entry && !entry.reservation) puts[`page/${pageId}`] = { ...entry, position };
  }
  return puts;
}
