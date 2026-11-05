/**
 * The shape of location in a Catalog.
 *
 * In the current shape (LOCATION_SHAPE_VERSION 2) a Project's top-level
 * Pages are roots carrying its `space_id`, and its content document is a
 * `page/` entry marked `project_content` outside the tree
 * (catalog-location.mjs). Catalogs written by older builds may still hold
 * the retired separate-root shape; home-removal-migration.mjs, an
 * owner-run one-shot migration, converts them. This module never converts
 * anything: it only records that a Catalog is in the current shape.
 *
 * `host/location/shape` records where a Catalog stands. Its states:
 *
 * - `unmigrated`: no record, or one from another version. Nothing checked.
 * - `checking`: a check has started.
 * - `migrated`: the Catalog holds only the current shape. Location writes
 *   run.
 * - `blocked`: the Catalog still holds the retired shape (`reason`
 *   `home_removal_required`). Nothing was written. Location reads and writes
 *   answer `503 location_migration_required` until the owner applies the
 *   migration; the next queued write checks again.
 *
 * Events: `start` (a queued write begins a check), `done` (current shape)
 * and `block` (retired shape found). `locationShape` is the pure transition
 * function; `migrateLocationShape` runs it against storage as the first step
 * of a queued Catalog write.
 *
 * Rollback: a build from before version 2 reads a version 2 record as
 * `unmigrated` and runs its own pass, which would misplace a migrated
 * Catalog's Pages. Never roll back past this build after a Catalog is
 * migrated; restore from `host/home-removal/before/` first. Any future
 * release that rewrites location again must bump LOCATION_SHAPE_VERSION.
 */
import { listAll } from "./catalog.mjs";
import { HOME_REMOVAL_STATE_KEY, hasLegacyHomeShape } from "./home-removal-migration.mjs";

export const LOCATION_SHAPE_KEY = "host/location/shape";
export const LOCATION_SHAPE_VERSION = 2;
export const SHAPE_STATES = Object.freeze(["unmigrated", "checking", "migrated", "blocked"]);
/** Why a check can block. */
export const SHAPE_BLOCKS = Object.freeze(["home_removal_required"]);
/** The code location reads and writes answer with while a Catalog is blocked. */
export const MIGRATION_REQUIRED = "location_migration_required";

/**
 * The transition function. `state` is `{ name, ... }` with one of
 * SHAPE_STATES; `event` is `{ type }` plus a block's `reason`. Returns
 * `{ state }`, or `{ state, rejected }` with the state unchanged.
 */
export function locationShape(state, event) {
  const reject = (rejected) => ({ state, rejected });
  switch (event.type) {
    case "start":
      if (state.name === "migrated") return reject("already migrated");
      if (state.name === "checking") return reject("a check is running");
      return { state: { name: "checking" } };
    case "done":
      if (state.name !== "checking") return reject("no check is running");
      return { state: { name: "migrated" } };
    case "block":
      if (state.name !== "checking") return reject("no check is running");
      if (!SHAPE_BLOCKS.includes(event.reason)) return reject("unknown block reason");
      return { state: { name: "blocked", reason: event.reason } };
    default:
      return reject("unknown event");
  }
}

/** The state a stored record describes. A record from another version, or
 * none, is `unmigrated`; an interrupted check is `unmigrated` too. */
export function shapeState(record) {
  if (!record || record.version !== LOCATION_SHAPE_VERSION || !SHAPE_STATES.includes(record.state))
    return { name: "unmigrated" };
  if (record.state === "blocked") return { name: "blocked", reason: record.reason };
  if (record.state === "checking") return { name: "unmigrated" };
  return { name: record.state };
}

/** The record stored for `state`. It carries no clock. */
export function shapeRecord(state) {
  const { name, ...detail } = state;
  return { version: LOCATION_SHAPE_VERSION, state: name, ...detail };
}

/** Whether `storage` still holds the retired shape, or a home-removal apply
 * that hasn't finished (its partly rewritten tree must never be stamped). */
export async function holdsRetiredShape(storage) {
  const removal = await storage.get(HOME_REMOVAL_STATE_KEY);
  if (removal && removal.phase !== "done") return true;
  const entries = [
    ...(await listAll(storage, "page/")).values(),
    ...(await listAll(storage, "trash/")).values(),
  ];
  return hasLegacyHomeShape(entries, (await listAll(storage, "space/")).values());
}

/**
 * Check `storage` and record the result. Runs inside the Catalog's serial
 * queue. A `migrated` record costs one read. A blocked Catalog is checked
 * again, so the write after an applied migration proceeds.
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
  step(
    (await holdsRetiredShape(storage))
      ? { type: "block", reason: "home_removal_required" }
      : { type: "done" },
  );
  await storage.put(LOCATION_SHAPE_KEY, shapeRecord(state));
  return state;
}
