/**
 * Space creation, which the owner's Catalog drives across the Space and the
 * home Page, as a pure transition function. Each state is persisted in the Catalog's journal
 * intent before the next effect runs, so a retry or restart resumes from the
 * last committed state. Effects are named here and run by the Catalog.
 *
 * Space creation:
 *
 *   reserved --space_recorded--> space_recorded --home_created--> home_created
 *            --committed--> ready
 *
 * Every effect is idempotent on the intent's Space ID and home Page ID, so a
 * lost response repeats the same effect from the same state.
 */

export const SPACE_CREATION_STATES = Object.freeze([
  "reserved",
  "space_recorded",
  "home_created",
  "ready",
]);
export const SPACE_CREATION_EVENTS = Object.freeze(["space_recorded", "home_created", "committed"]);

const creation = Object.freeze({
  reserved: { space_recorded: "space_recorded" },
  space_recorded: { home_created: "home_created" },
  home_created: { committed: "ready" },
  ready: {},
});
const creationEffect = Object.freeze({
  reserved: "create_space_record",
  space_recorded: "create_home_page",
  home_created: "commit_catalog",
  ready: null,
});

/** The effect a creation in `state` runs next, or null when it is done. */
export function spaceCreationEffect(state) {
  if (!Object.hasOwn(creationEffect, state)) throw new Error(`Unknown creation state ${state}`);
  return creationEffect[state];
}

/** `(state, event) -> { state, effect }`. An event that does not apply to
 * the state is a programming error, never a silent no-op. */
export function spaceCreationTransition(state, event) {
  const next = creation[state]?.[event];
  if (!next) throw new Error(`Space creation cannot take ${event} in ${state}`);
  return { state: next, effect: creationEffect[next] };
}
