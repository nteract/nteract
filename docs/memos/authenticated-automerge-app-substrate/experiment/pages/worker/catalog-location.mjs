/**
 * Location in the owner's Catalog.
 *
 * The owner's Catalog is the only record of where its Pages live. Page
 * objects store no location. Each owned entry (`page/<id>` while active or
 * pending, `trash/<id>` in Trash) stores:
 * - `parent_id`: another owned Page, or null for a root. A Project's
 *   top-level Pages are roots. On a trashed entry it is the restore hint:
 *   the parent the Page had when it was trashed;
 * - `position`: a fractional key among its siblings. Roots without
 *   `space_id` are the siblings of Your items; roots sharing a `space_id` are
 *   the siblings of that Project's top level;
 * - `space_id`: only on a root, naming the Project whose top level holds it;
 * - `restore_space_id`: only on a trashed entry that isn't a root. It is the
 *   Project the Page was in when it was trashed, for a restore whose parent
 *   is gone by then.
 *
 * A Project's content document has a `page/<id>` entry too (its title, quota
 * slot and index row live there), marked `project_content: <space_id>` and
 * without location fields. It is not a Page in the tree: the scan returns it
 * in `contents`, never in `entries`, so it can't be listed, moved, trashed or
 * given children. The Project's `space/<id>` record names it as
 * `document_id`.
 *
 * A Page's Project is derived by walking parents to the root with
 * model/location.mjs. Nothing else stores it. Every location write runs in
 * the Catalog's serial queue; these helpers read storage and never write.
 */
import { deriveLocation, positionAmong, siblingsOf, validPositionKey } from "../model/location.mjs";
import { HttpError } from "./auth.mjs";
import { listAll } from "./catalog.mjs";
import { HOME_REMOVAL_STATE_KEY, hasLegacyHomeShape } from "./home-removal-migration.mjs";
import { LOCATION_SHAPE_KEY, MIGRATION_REQUIRED, shapeState } from "./location-shape.mjs";

/** Location entries by Page ID, for model/location.mjs. Reservation slots
 * are placeholders for a pending Trash or restore and are skipped: the Page's
 * real entry stays where it is until the Page applies the request. */
export async function locationEntries(storage) {
  return (await locationScan(storage)).entries;
}

/** Location entries, plus Project content documents and the number of keys
 * under each prefix that the scan read: `{ entries, contents, counts }`.
 * `contents` maps each content document ID to `{ space_id, state }`. A Page
 * listing uses the counts to check the Catalog's stored counts
 * (catalog-counts.mjs).
 *
 * A Catalog not recorded in the current shape is checked for the retired
 * one (home-removal-migration.mjs); while it holds that, every read refuses
 * with `503 location_migration_required` rather than misread it.
 */
export async function locationScan(storage) {
  // Fence the whole scan against migration progress: the stored migration
  // state and shape record are read before and after the rows, and any
  // change (an apply that started, advanced or finished meanwhile) refuses
  // rather than mix rows from two shapes. /internal/location runs outside
  // the Catalog's serial queue, so this is its only fence.
  const before = await migrationFence(storage);
  if (before.removal && before.removal.phase !== "done") throw migrationRequired();
  const raw = [];
  const counts = {};
  for (const [prefix, state] of [
    ["page/", "active"],
    ["trash/", "trashed"],
  ]) {
    const listed = await listAll(storage, prefix);
    counts[prefix] = listed.size;
    for (const entry of listed.values()) {
      if (!entry?.page_id || entry.reservation) continue;
      raw.push({ entry, state: entry.pending ? "pending" : state });
    }
  }
  const after = await migrationFence(storage);
  if (after.key !== before.key) throw migrationRequired();
  await requireCurrentShape(
    storage,
    raw.map(({ entry }) => entry),
    before,
  );
  const contents = new Map();
  const entries = new Map();
  for (const { entry, state } of raw) {
    if (typeof entry.project_content === "string") {
      contents.set(entry.page_id, { space_id: entry.project_content, state });
      continue;
    }
    const root = entry.parent_id === null || entry.parent_id === undefined;
    entries.set(entry.page_id, {
      page_id: entry.page_id,
      state,
      parent_id: entry.parent_id ?? null,
      position: entry.position,
      ...(root && entry.space_id && { space_id: entry.space_id }),
      ...(entry.restore_space_id && { restore_space_id: entry.restore_space_id }),
    });
  }
  return { entries, contents, counts };
}

/**
 * Refuse (503) unless this Catalog's stored location is in the current
 * shape: no home-removal apply unfinished or failed, and either a migrated
 * shape record or no retired marker. `entries` are the stored `page/` and
 * `trash/` values when the caller already listed them.
 */
export async function requireCurrentShape(storage, entries, fence) {
  const { removal, shape } = fence ?? (await migrationFence(storage));
  if (removal && removal.phase !== "done") throw migrationRequired();
  if (shapeState(shape).name === "migrated") return;
  const stored = entries ?? [
    ...(await listAll(storage, "page/")).values(),
    ...(await listAll(storage, "trash/")).values(),
  ];
  if (hasLegacyHomeShape(stored, (await listAll(storage, "space/")).values()))
    throw migrationRequired();
}

/** The stored migration state and shape record, and a key that changes
 * whenever either does. */
async function migrationFence(storage) {
  const removal = await storage.get(HOME_REMOVAL_STATE_KEY);
  const shape = await storage.get(LOCATION_SHAPE_KEY);
  return { removal, shape, key: JSON.stringify([removal ?? null, shape ?? null]) };
}

/** The refusal while a Catalog holds the retired shape. */
export const migrationRequired = () =>
  Object.assign(
    new HttpError(
      503,
      "This account's Projects need a one-time migration before Pages can be read or changed. The account owner runs it.",
      MIGRATION_REQUIRED,
    ),
    { details: { reason: "home_removal_required" } },
  );

/** The Project a Page is in, or null for Your items. A trashed Page whose
 * parent chain is broken uses the Project it recorded when it was trashed. */
export function projectOf(entries, pageId) {
  const derived = deriveLocation(entries, pageId);
  if (derived.ok) return derived.space_id;
  return entries.get(pageId)?.restore_space_id ?? null;
}

/** What the internal location route answers for one Page or content
 * document: IDs only. `ancestors` is nearest first; `complete` says it
 * reaches a root. `content: true` marks a Project's content document, whose
 * Project is `space_id`. */
export function locationAnswer(entries, pageId, contents = new Map()) {
  const content = contents.get(pageId);
  if (content)
    return {
      page_id: pageId,
      state: content.state,
      parent_id: null,
      ancestors: [],
      complete: true,
      space_id: content.space_id,
      content: true,
    };
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
  };
}

/** Active children of `parentId`, in sibling order. */
export const childrenOf = (entries, parentId) =>
  siblingsOf(entries, parentId, undefined)
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
  };
}

/** The receipt fields a create or restore reports for its Page. */
export function receiptLocation(entries, pageId) {
  const { position: _position, ...location } = publicLocation(entries, pageId);
  return location;
}

/** Siblings a new Page joins: children of `parentId`, or for null the roots
 * of Project `spaceId` (Your items when null). An entry whose stored key
 * isn't a fractional key can't anchor a new one and is skipped. */
const siblingsAt = (entries, parentId, excludeId, spaceId = null) =>
  siblingsOf(entries, parentId, excludeId, spaceId).filter((entry) =>
    validPositionKey(entry.position),
  );

/** A key after every sibling, and the siblings' new keys when ties had to be
 * repaired (`{ page_id: key }`). */
export function appendPosition(entries, parentId, excludeId, spaceId = null) {
  const placed = positionAmong(siblingsAt(entries, parentId, excludeId, spaceId), "last");
  return { position: placed.position, rekeyed: placed.rekeyed };
}

/** Whether Project `spaceId` is live in this Catalog: recorded and not
 * still being created. */
export async function projectLive(storage, spaceId) {
  const space = await storage.get(`space/${spaceId}`);
  return !!space && !space.pending;
}

/** Whether an owned Page can hold children: created, not in Trash, and not
 * leaving for Trash. */
export async function parentActive(storage, parentId) {
  if (await storage.get(`trash/${parentId}`)) return false;
  const parent = await storage.get(`page/${parentId}`);
  // A Project content document is not a Page in the tree: no children.
  return !!parent && !parent.pending && !parent.reservation && !parent.project_content;
}

/** The stored location fields of `entry`, unchanged: an entry this Catalog
 * keeps where it is. */
const storedLocation = (entry) =>
  Object.fromEntries(
    ["parent_id", "position", "space_id", "project_content"]
      .filter((field) => field in entry)
      .map((field) => [field, entry[field]]),
  );

/**
 * Where a restore puts a Page: under its recorded parent while that parent
 * is active, otherwise at the top level of its Project while the Project
 * exists, otherwise at the top level of Your items. Returns the entry's
 * location fields, `{ parent_id, position, space_id? }`, and `rekeyed`
 * siblings. An already active Page, or a Project content document, keeps its
 * stored fields.
 */
export async function restoreTarget(storage, pageId) {
  const { entries, contents } = await locationScan(storage);
  if (contents.has(pageId)) {
    const stored = await storage.get(`page/${pageId}`);
    return { location: stored ? storedLocation(stored) : {}, rekeyed: {} };
  }
  const entry = entries.get(pageId);
  if (!entry) return { location: {}, rekeyed: {} };
  const keep = {
    parent_id: entry.parent_id,
    position: entry.position,
    ...(entry.space_id && { space_id: entry.space_id }),
  };
  if (entry.state !== "trashed") return { location: keep, rekeyed: {} };
  const placeUnder = (parentId, spaceId = null) => {
    const root = parentId === null && spaceId ? { space_id: spaceId } : {};
    // A sibling created while this Page was in Trash may hold its old key.
    const taken =
      entry.parent_id !== parentId ||
      (parentId === null && (entry.space_id ?? null) !== spaceId) ||
      siblingsOf(entries, parentId, pageId, spaceId).some(
        (sibling) => sibling.position === entry.position,
      );
    if (!taken)
      return { location: { parent_id: parentId, position: entry.position, ...root }, rekeyed: {} };
    const { position, rekeyed } = appendPosition(entries, parentId, pageId, spaceId);
    return { location: { parent_id: parentId, position, ...root }, rekeyed };
  };
  if (entry.parent_id && (await parentActive(storage, entry.parent_id)))
    return placeUnder(entry.parent_id);
  let spaceId = entry.parent_id ? projectOf(entries, pageId) : (entry.space_id ?? null);
  if (spaceId && !(await projectLive(storage, spaceId))) spaceId = null;
  return placeUnder(null, spaceId);
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

/** Puts that set each trashed Page's `restore_space_id` to `spaceId`, or
 * drop it when `spaceId` is null: a move carries trashed sub-pages to a new
 * container, and a later restore whose parent is gone lands there. */
export async function movedTrashEntries(storage, pageIds, spaceId) {
  const puts = {};
  for (const pageId of pageIds) {
    const entry = await storage.get(`trash/${pageId}`);
    if (!entry || entry.reservation) continue;
    const { restore_space_id: _old, ...kept } = entry;
    puts[`trash/${pageId}`] = spaceId ? { ...kept, restore_space_id: spaceId } : kept;
  }
  return puts;
}
