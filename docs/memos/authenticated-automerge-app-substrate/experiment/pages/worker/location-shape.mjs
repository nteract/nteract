/**
 * The shape of location in a Catalog, and the lazy migration to it.
 *
 * In the current shape a Project has one root: its home Page, the only entry
 * with `space_id`. The Project's top-level Pages are the home Page's children.
 * Catalogs written before this shape hold every Project top-level Page as a
 * root with `space_id`. Reads derive a Page's Project from its root in both
 * shapes; location writes (create, trash, restore) assume the current one.
 *
 * `host/location/shape` records where a Catalog stands, versioned by
 * LOCATION_SHAPE_VERSION. Its states:
 *
 * - `unmigrated`: no record, or one from an older version. Nothing has been
 *   checked yet.
 * - `migrating`: a pass has started. Some entries may already be in the
 *   current shape; a rerun plans what remains and continues.
 * - `migrated`: every entry is in the current shape. Location writes run.
 * - `blocked`: the pass found an entry it can't place, named by `reason`,
 *   `page_id` and `space_id`. Nothing was written. Location writes answer
 *   `503 location_migration_required` with those three fields; reads keep
 *   working. The next queued write tries again.
 *
 * Events: `start` (a queued write begins a pass), `batch` (one batch of
 * entries committed, more remain), `done` (the last batch, or nothing to do)
 * and `block` (the plan found an obstacle). `locationShape` is the pure
 * transition function; `migrateLocationShape` runs it against storage as the
 * first step of a queued Catalog write.
 *
 * The plan:
 * - Home Pages come first: a root with `space_id` flagged `home`, or the one
 *   its Project record names as `home_page_id`. The latter gains the flag.
 * - Every other root with `space_id`, in `page/` and `trash/`, moves under
 *   its Project's home Page and drops `space_id`. A chain of MAX_DEPTH, the
 *   deepest the older shape allowed, lands at MAX_TREE_DEPTH, which the model
 *   holds; only a chain already past that blocks (`nesting_depth_exceeded`).
 *   A home Page still pending blocks too (`home_pending`); the older shape
 *   never placed a Page in a pending Project, so this is defensive.
 * - A root whose Project has no home Page at all (its record and flagged home
 *   are gone) becomes a Your items root, with `restore_space_id` when it is
 *   in Trash. Nothing else can hold it.
 * - Positions keep. Then, as its own step, every destination's active
 *   siblings get distinct keys the way a move repairs ties: the first holder
 *   in (position, page_id) order keeps its key. This step runs whether or not
 *   roots remain to move, so a pass cut between batches finishes the repair
 *   on its rerun instead of declaring `migrated` over a tie.
 *
 * Entries commit in batches of STORAGE_KEYS_PER_CALL keys, each one storage
 * transaction that also writes the state record, so a crash leaves whole
 * batches and the state that describes them.
 *
 * Rolling back to a build that writes the older shape and then rolling
 * forward again leaves new roots this pass doesn't revisit while the record
 * says `migrated`. Bump LOCATION_SHAPE_VERSION in that release; every Catalog
 * then runs the pass again on its next write.
 */
import { generateNKeysBetween } from "fractional-indexing";
import { MAX_TREE_DEPTH, childIndex, subtreeOf, validPositionKey } from "../model/location.mjs";
import { STORAGE_KEYS_PER_CALL } from "./actor-authorship.mjs";
import { listAll } from "./catalog.mjs";
import { locationEntries } from "./catalog-location.mjs";

export const LOCATION_SHAPE_KEY = "host/location/shape";
export const LOCATION_SHAPE_VERSION = 1;
export const SHAPE_STATES = Object.freeze(["unmigrated", "migrating", "migrated", "blocked"]);
/** Why a pass can block. */
export const SHAPE_BLOCKS = Object.freeze(["home_pending", "nesting_depth_exceeded"]);
/** The code location writes answer with while a Catalog isn't `migrated`. */
export const MIGRATION_REQUIRED = "location_migration_required";

/**
 * The transition function. `state` is `{ name, ... }` with one of
 * SHAPE_STATES; `event` is `{ type }` plus the block's `reason`, `page_id`
 * and `space_id`. Returns `{ state }`, or `{ state, rejected }` with the
 * state unchanged.
 */
export function locationShape(state, event) {
  const reject = (rejected) => ({ state, rejected });
  switch (event.type) {
    case "start":
      if (state.name === "migrated") return reject("already migrated");
      return { state: { name: "migrating" } };
    case "batch":
      if (state.name !== "migrating") return reject("no pass is running");
      return { state: { name: "migrating" } };
    case "done":
      if (state.name !== "migrating") return reject("no pass is running");
      return { state: { name: "migrated" } };
    case "block":
      if (state.name !== "migrating") return reject("no pass is running");
      if (!SHAPE_BLOCKS.includes(event.reason)) return reject("unknown block reason");
      return {
        state: {
          name: "blocked",
          reason: event.reason,
          page_id: event.page_id ?? null,
          space_id: event.space_id ?? null,
        },
      };
    default:
      return reject("unknown event");
  }
}

/** The state a stored record describes. A record from another version, or
 * none, is `unmigrated`. */
export function shapeState(record) {
  if (!record || record.version !== LOCATION_SHAPE_VERSION || !SHAPE_STATES.includes(record.state))
    return { name: "unmigrated" };
  if (record.state === "blocked")
    return {
      name: "blocked",
      reason: record.reason,
      page_id: record.page_id ?? null,
      space_id: record.space_id ?? null,
    };
  return { name: record.state };
}

/** The record stored for `state`. It carries no clock: two Catalogs that
 * reach the same state hold the same bytes, so a replayed write compares
 * equal to the first. */
export function shapeRecord(state) {
  const { name, ...detail } = state;
  return { version: LOCATION_SHAPE_VERSION, state: name, ...detail };
}

const byOrder = (a, b) =>
  (a.position < b.position ? -1 : a.position > b.position ? 1 : 0) ||
  (a.page_id < b.page_id ? -1 : a.page_id > b.page_id ? 1 : 0);

/**
 * Plan the migration of `entries` (the location map from locationEntries,
 * with `home` flags) given `spaces`, this Catalog's `space/<id>` records by
 * Project ID. Pure. Returns `{ ok: true, writes }` or
 * `{ ok: false, reason, page_id, space_id }` when the Catalog can't be
 * migrated yet.
 *
 * Each write names one entry's new location fields:
 * `{ page_id, state, parent_id, position, space_id, home?, restore_space_id? }`.
 * `space_id` null means drop it; `home: true` flags a home Page the Project
 * record named but the entry didn't carry.
 */
export function planLocationShape(entries, spaces = new Map()) {
  const map = entries instanceof Map ? entries : new Map(Object.entries(entries ?? {}));
  const spaceMap = spaces instanceof Map ? spaces : new Map(Object.entries(spaces ?? {}));
  const writes = [];
  const writeFor = new Map();
  const write = (fields) => {
    writes.push(fields);
    writeFor.set(fields.page_id, fields);
    return fields;
  };

  // Canonical home Pages, one per Project: the root its Project record names
  // as home_page_id, else the flagged root. A named home without the flag
  // gains it. Any other flagged root is a duplicate home the model reports;
  // it moves under the canonical one like any other root.
  const homes = new Map();
  for (const [spaceId, space] of spaceMap) {
    const named = space?.home_page_id ? map.get(space.home_page_id) : undefined;
    if (!named || named.parent_id !== null || named.space_id !== spaceId) continue;
    homes.set(spaceId, named);
    if (named.home !== true)
      write({
        page_id: named.page_id,
        state: named.state,
        parent_id: null,
        position: named.position,
        space_id: spaceId,
        home: true,
      });
  }
  for (const entry of map.values())
    if (
      entry.home === true &&
      entry.parent_id === null &&
      entry.space_id &&
      !homes.has(entry.space_id)
    )
      homes.set(entry.space_id, entry);
  const isHome = (entry) => homes.get(entry.space_id)?.page_id === entry.page_id;

  // Every other root with space_id moves under its home Page. One child
  // index serves every root's height check, so planning a Catalog of many
  // roots stays linear in its entries.
  const legacy = [...map.values()].filter(
    (entry) => entry.parent_id === null && entry.space_id && !isHome(entry),
  );
  const children = legacy.length ? childIndex(map) : undefined;
  for (const entry of legacy) {
    const home = homes.get(entry.space_id);
    const block = (reason) => ({
      ok: false,
      reason,
      page_id: entry.page_id,
      space_id: entry.space_id,
    });
    if (!home) {
      // No home Page anywhere: a Your items root that remembers its Project
      // while in Trash.
      write({
        page_id: entry.page_id,
        state: entry.state,
        parent_id: null,
        position: entry.position,
        space_id: null,
        ...(entry.state === "trashed" && { restore_space_id: entry.space_id }),
      });
      continue;
    }
    if (home.state !== "active") return block("home_pending");
    // The home Page is at depth 1 and this root moves to depth 2. Its deepest
    // descendant (trashed ones included: a restore puts them back without a
    // depth check) must fit the depth the model holds.
    const height = Math.max(
      ...subtreeOf(map, entry.page_id, children).map((member) => member.depth),
    );
    if (2 + height > MAX_TREE_DEPTH) return block("nesting_depth_exceeded");
    write({
      page_id: entry.page_id,
      state: entry.state,
      parent_id: home.page_id,
      position: entry.position,
      space_id: null,
      ...(entry.state === "trashed" && { restore_space_id: entry.space_id }),
    });
  }

  // Distinct keys at every destination: each home Page's active children and
  // the active roots of Your items, as they will stand after the moves above.
  const located = (entry) => {
    const moved = writeFor.get(entry.page_id);
    return moved
      ? { page_id: entry.page_id, parent_id: moved.parent_id, position: moved.position }
      : { page_id: entry.page_id, parent_id: entry.parent_id, position: entry.position };
  };
  const destinations = new Map([[null, []]]);
  for (const home of homes.values()) destinations.set(home.page_id, []);
  for (const entry of map.values()) {
    if (entry.state === "trashed" || !validPositionKey(entry.position) || isHome(entry)) continue;
    const place = located(entry);
    const siblings = destinations.get(place.parent_id);
    if (siblings) siblings.push(place);
  }
  for (const [parentId, siblings] of destinations)
    for (const [pageId, position] of Object.entries(repairTies(siblings))) {
      const moved = writeFor.get(pageId);
      if (moved) moved.position = position;
      else {
        const sibling = map.get(pageId);
        write({
          page_id: pageId,
          state: sibling.state,
          parent_id: parentId,
          position,
          space_id: null,
        });
      }
    }
  return { ok: true, writes };
}

/** New keys (`{ page_id: key }`) for every sibling after the first in each
 * run of equal keys, in (position, page_id) order. */
function repairTies(siblings) {
  const sorted = [...siblings].sort(byOrder);
  const kept = sorted.map((entry, i) => i === 0 || sorted[i - 1].position !== entry.position);
  const rekeyed = {};
  for (let i = 0; i < sorted.length; ) {
    if (kept[i]) {
      i++;
      continue;
    }
    let end = i;
    while (end < sorted.length && !kept[end]) end++;
    const lower = sorted[i - 1].position;
    const upper = end < sorted.length ? sorted[end].position : null;
    const keys = generateNKeysBetween(lower, upper, end - i);
    for (let j = i; j < end; j++) rekeyed[sorted[j].page_id] = keys[j - i];
    i = end;
  }
  return rekeyed;
}

/** One structured line for a blocked or finished pass. */
function logShape(event, detail) {
  console.warn(JSON.stringify({ service: "nteract-pages-native", event, ...detail }));
}

const transact = (storage, work) =>
  typeof storage.transaction === "function" ? storage.transaction(work) : work(storage);

/** The stored entry with one write applied. `space_id` and `home` are the
 * write's alone: a root that moves under a home Page loses both. */
function applyWrite(current, write) {
  const { space_id: _space, home: _home, ...rest } = current;
  return {
    ...rest,
    parent_id: write.parent_id,
    position: write.position,
    ...(write.space_id && { space_id: write.space_id }),
    ...(write.home && { home: true }),
    ...(write.restore_space_id && { restore_space_id: write.restore_space_id }),
  };
}

/**
 * Bring `storage` to the current shape, from whatever state its record
 * holds, and return the resulting state. Runs inside the Catalog's serial
 * queue, so nothing else writes location while it does. A `migrated` record
 * costs one read. Entries commit in batches of STORAGE_KEYS_PER_CALL keys,
 * the state record included, each batch one transaction.
 */
export async function migrateLocationShape(storage) {
  let state = shapeState(await storage.get(LOCATION_SHAPE_KEY));
  if (state.name === "migrated") return state;
  const step = (event) => {
    const result = locationShape(state, event);
    if (result.rejected) throw new Error(`Location shape: ${result.rejected}`);
    state = result.state;
  };
  step({ type: "start" });
  const entries = await locationEntries(storage);
  const spaces = new Map();
  for (const space of (await listAll(storage, "space/")).values())
    if (space?.space_id) spaces.set(space.space_id, space);
  const plan = planLocationShape(entries, spaces);
  if (!plan.ok) {
    step({ type: "block", ...plan });
    await storage.put(LOCATION_SHAPE_KEY, shapeRecord(state));
    logShape("catalog.location_migration_blocked", {
      reason: plan.reason,
      page_id: plan.page_id,
      space_id: plan.space_id,
    });
    return state;
  }
  if (!plan.writes.length) {
    step({ type: "done" });
    await storage.put(LOCATION_SHAPE_KEY, shapeRecord(state));
    return state;
  }
  const perBatch = STORAGE_KEYS_PER_CALL - 1;
  for (let at = 0; at < plan.writes.length; at += perBatch) {
    const batch = plan.writes.slice(at, at + perBatch);
    const last = at + perBatch >= plan.writes.length;
    step({ type: last ? "done" : "batch" });
    const record = shapeRecord(state);
    await transact(storage, async (target) => {
      const puts = { [LOCATION_SHAPE_KEY]: record };
      for (const write of batch) {
        const key = `${write.state === "trashed" ? "trash/" : "page/"}${write.page_id}`;
        const current = await target.get(key);
        if (!current || current.reservation) continue;
        puts[key] = applyWrite(current, write);
      }
      await target.put(puts);
    });
  }
  const orphaned = plan.writes.filter((write) => write.parent_id === null && !write.home).length;
  logShape("catalog.location_migrated", { entries: plan.writes.length, orphaned });
  return state;
}
