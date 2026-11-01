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
 * - `blocked`: the pass found an entry it can't move: a Project whose home
 *   Page is still pending, or a chain that would nest past MAX_DEPTH once it
 *   sits under the home Page. Nothing was written. Location writes answer
 *   `503 location_migration_required`; reads keep working. The next queued
 *   write tries again, so finishing the Project's creation or trashing the
 *   deepest Page clears it.
 *
 * Events: `start` (a queued write begins a pass), `batch` (one batch of
 * entries committed, more remain), `done` (the last batch, or nothing to do)
 * and `block` (the plan found an obstacle). `locationShape` is the pure
 * transition function; `migrateLocationShape` runs it against storage as the
 * first step of a queued Catalog write.
 *
 * The plan reparents every non-home root with `space_id`, in `page/` and
 * `trash/`, under its Project's home Page and drops `space_id`. Positions
 * keep, except that a key already held by an active sibling under the home
 * Page is repaired the way a move repairs ties: the first holder keeps it. A
 * trashed root whose Project is gone becomes a Your items root and records
 * the Project as `restore_space_id`. Entries commit in batches of
 * STORAGE_KEYS_PER_CALL keys, each one storage transaction that also writes
 * the state record, so a crash leaves whole batches and the state that
 * describes them.
 *
 * Rolling back to a build that writes the older shape and then rolling
 * forward again leaves new roots this pass doesn't revisit while the record
 * says `migrated`. Bump LOCATION_SHAPE_VERSION in that release; every Catalog
 * then runs the pass again on its next write.
 */
import { generateNKeysBetween } from "fractional-indexing";
import { MAX_DEPTH, subtreeOf, validPositionKey } from "../model/location.mjs";
import { STORAGE_KEYS_PER_CALL } from "./actor-authorship.mjs";
import { listAll } from "./catalog.mjs";
import { locationEntries } from "./catalog-location.mjs";

export const LOCATION_SHAPE_KEY = "host/location/shape";
export const LOCATION_SHAPE_VERSION = 1;
export const SHAPE_STATES = Object.freeze(["unmigrated", "migrating", "migrated", "blocked"]);
/** Why a pass can block. */
export const SHAPE_BLOCKS = Object.freeze([
  "home_pending",
  "home_missing",
  "nesting_depth_exceeded",
]);
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

/**
 * Plan the migration of `entries` (the location map from locationEntries,
 * with `home` flags) given `spaces`, this Catalog's `space/<id>` records by
 * Project ID. Pure. Returns `{ ok: true, writes }`, where each write is
 * `{ page_id, state, parent_id, position, space_id, restore_space_id }` (the
 * entry's new location fields; `space_id` is always null, meaning drop it),
 * or `{ ok: false, reason, page_id, space_id }` when the Catalog can't be
 * migrated yet.
 */
export function planLocationShape(entries, spaces = new Map()) {
  const map = entries instanceof Map ? entries : new Map(Object.entries(entries ?? {}));
  const spaceMap = spaces instanceof Map ? spaces : new Map(Object.entries(spaces ?? {}));
  const legacy = [...map.values()].filter(
    (entry) => entry.parent_id === null && entry.space_id && entry.home !== true,
  );
  if (!legacy.length) return { ok: true, writes: [] };

  const homes = new Map();
  for (const entry of map.values())
    if (entry.home === true && entry.space_id && !homes.has(entry.space_id))
      homes.set(entry.space_id, entry);
  const homeOf = (spaceId) => {
    const flagged = homes.get(spaceId);
    if (flagged) return flagged;
    const recorded = spaceMap.get(spaceId)?.home_page_id;
    return recorded ? map.get(recorded) : undefined;
  };

  const writes = [];
  // Active siblings each home Page gains, for tie repair.
  const joining = new Map();
  for (const entry of legacy) {
    const home = homeOf(entry.space_id);
    const block = (reason) => ({
      ok: false,
      reason,
      page_id: entry.page_id,
      space_id: entry.space_id,
    });
    if (!home || home.state === "trashed") {
      if (entry.state !== "trashed") return block("home_missing");
      // The Project is gone: a Your items root that remembers its Project.
      writes.push({
        page_id: entry.page_id,
        state: entry.state,
        parent_id: null,
        position: entry.position,
        space_id: null,
        restore_space_id: entry.space_id,
      });
      continue;
    }
    if (home.state !== "active") return block("home_pending");
    // The home Page is at depth 1, this root moves to depth 2, and its
    // deepest descendant (trashed ones included: a restore puts them back
    // without a depth check) must stay within MAX_DEPTH.
    const height = Math.max(...subtreeOf(map, entry.page_id).map((member) => member.depth));
    if (2 + height > MAX_DEPTH) return block("nesting_depth_exceeded");
    writes.push({
      page_id: entry.page_id,
      state: entry.state,
      parent_id: home.page_id,
      position: entry.position,
      space_id: null,
      ...(entry.state === "trashed" && { restore_space_id: entry.space_id }),
    });
    if (entry.state !== "trashed") {
      if (!joining.has(home.page_id)) joining.set(home.page_id, []);
      joining.get(home.page_id).push(writes.at(-1));
    }
  }

  // Keys that tie with an active sibling already under the home Page are
  // repaired: in (position, page_id) order the first holder keeps its key and
  // the rest get fresh keys between the kept neighbours.
  for (const [homeId, arrivals] of joining) {
    const present = [...map.values()].filter(
      (entry) =>
        entry.parent_id === homeId && entry.state !== "trashed" && validPositionKey(entry.position),
    );
    const rekeyed = repairTies([
      ...present.map((entry) => ({ page_id: entry.page_id, position: entry.position })),
      ...arrivals
        .filter((write) => validPositionKey(write.position))
        .map((write) => ({ page_id: write.page_id, position: write.position })),
    ]);
    for (const [pageId, position] of Object.entries(rekeyed)) {
      const arrival = arrivals.find((write) => write.page_id === pageId);
      if (arrival) arrival.position = position;
      else {
        const sibling = map.get(pageId);
        writes.push({
          page_id: pageId,
          state: sibling.state,
          parent_id: homeId,
          position,
          space_id: null,
        });
      }
    }
  }
  return { ok: true, writes };
}

/** New keys (`{ page_id: key }`) for every sibling after the first in each
 * run of equal keys, in (position, page_id) order. */
function repairTies(siblings) {
  const sorted = [...siblings].sort(
    (a, b) =>
      (a.position < b.position ? -1 : a.position > b.position ? 1 : 0) ||
      (a.page_id < b.page_id ? -1 : a.page_id > b.page_id ? 1 : 0),
  );
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
        const { space_id: _space, ...rest } = current;
        puts[key] = {
          ...rest,
          parent_id: write.parent_id,
          position: write.position,
          ...(write.restore_space_id && { restore_space_id: write.restore_space_id }),
        };
      }
      await target.put(puts);
    });
  }
  logShape("catalog.location_migrated", { entries: plan.writes.length });
  return state;
}
