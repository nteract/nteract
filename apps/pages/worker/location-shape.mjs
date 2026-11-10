/**
 * The shape of location in a Catalog.
 *
 * In the current shape (LOCATION_SHAPE_VERSION 2) a Project's top-level
 * Pages are roots carrying its `space_id`, and its content document is a
 * `page/` entry marked `project_content` outside the tree
 * (catalog-location.mjs). This build reads and writes only that shape.
 *
 * `host/location/shape` records where a Catalog stands. Its states:
 *
 * - `unmigrated`: no record, or one from another version.
 * - `checking`: a check has started.
 * - `migrated`: the Catalog is recorded in the current shape.
 *
 * Events: `start` (a queued write begins a check) and `done`.
 * `locationShape` is the pure transition function; `migrateLocationShape`
 * runs it against storage as the first step of a queued Catalog write.
 *
 * Rollback: a build from before version 2 reads a version 2 record as
 * `unmigrated` and runs its own pass, which would misplace a Catalog's
 * Pages. Never roll back past version 2. Any future release that rewrites
 * location again must bump LOCATION_SHAPE_VERSION and add the check that
 * guards its own retired shape here.
 */
export const LOCATION_SHAPE_KEY = "host/location/shape";
export const LOCATION_SHAPE_VERSION = 2;
export const SHAPE_STATES = Object.freeze(["unmigrated", "checking", "migrated"]);

/**
 * The transition function. `state` is `{ name }` with one of SHAPE_STATES;
 * `event` is `{ type }`. Returns `{ state }`, or `{ state, rejected }` with
 * the state unchanged.
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
    default:
      return reject("unknown event");
  }
}

/** The state a stored record describes. A record from another version, an
 * unknown state, or none, is `unmigrated`; an interrupted check is too. */
export function shapeState(record) {
  if (
    !record ||
    record.version !== LOCATION_SHAPE_VERSION ||
    !SHAPE_STATES.includes(record.state) ||
    record.state === "checking"
  )
    return { name: "unmigrated" };
  return { name: record.state };
}

/** The record stored for `state`. It carries no clock. */
export function shapeRecord(state) {
  const { name, ...detail } = state;
  return { version: LOCATION_SHAPE_VERSION, state: name, ...detail };
}

/**
 * Record the current shape. Runs inside the Catalog's serial queue. A
 * `migrated` record costs one read.
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
  step({ type: "done" });
  await storage.put(LOCATION_SHAPE_KEY, shapeRecord(state));
  return state;
}
