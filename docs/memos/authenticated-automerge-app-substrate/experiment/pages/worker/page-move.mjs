/**
 * move_page, which the owner's Catalog drives across every Page in the moved
 * subtree, as a pure transition function.
 *
 * The Catalog plans the move before it changes anything: the root Page first,
 * then each descendant whose Project changes, top-down. Each plan step names
 * one Page, the placement it moves to and the placement epoch the Catalog
 * observed for it (the step's fence). The plan and the state below are stored
 * in the Catalog's journal intent, and the state is persisted after every
 * step, so a retry or restart resumes at the step it stopped on.
 *
 *   placing(0) --placed--> placing(1) --placed--> … --placed--> placed
 *              --committed--> ready
 *   placing(0) --refused--> released
 *
 * Effects, which the Catalog runs:
 * - `place_page`: ask the step's Page to take its new placement at the fenced
 *   epoch. The Page applies it once, replays it for the same intent key, or
 *   answers with its current placement when the fence no longer matches.
 * - `commit_catalog`: store the receipt, clear the pending-move marker and
 *   mark the catalog index dirty.
 * - `release_intent`: delete the intent. Only the root's refusal releases a
 *   move, and the root is always the first step, so nothing has changed yet.
 *
 * A descendant that refuses or has gone missing is skipped: its subtree's
 * root has already moved, so the move rolls forward.
 */

export const PAGE_MOVE_STATES = Object.freeze(["placing", "placed", "ready", "released"]);
export const PAGE_MOVE_EVENTS = Object.freeze(["placed", "refused", "committed"]);

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

function validState(state) {
  check(
    state && typeof state === "object" && PAGE_MOVE_STATES.includes(state.name),
    "A move state needs a known name",
  );
  check(Number.isSafeInteger(state.total) && state.total >= 1, "A move plans at least one Page");
  if (state.name === "placing")
    check(
      Number.isSafeInteger(state.cursor) && state.cursor >= 0 && state.cursor < state.total,
      "A placing move points at a plan step",
    );
  return state;
}

/** The effect a move in `state` runs next, or null when it is done. */
export function pageMoveEffect(state) {
  validState(state);
  if (state.name === "placing") return { type: "place_page", index: state.cursor };
  if (state.name === "placed") return { type: "commit_catalog" };
  return null;
}

/** `(state, event) -> { state, effect }`. An event that does not apply to
 * the state is a programming error, never a silent no-op. */
export function pageMoveTransition(state, event) {
  validState(state);
  const type = event?.type;
  check(PAGE_MOVE_EVENTS.includes(type), `Unknown move event ${type}`);
  const refuse = () => {
    throw new Error(`A move cannot take ${type} in ${state.name}`);
  };
  if (state.name === "placing") {
    if (type === "committed") refuse();
    if (type === "refused" && state.cursor === 0) {
      return { state: { name: "released", total: state.total }, effect: { type: "release_intent" } };
    }
    // A later step's refusal is a skip: the root has already moved.
    const cursor = state.cursor + 1;
    const next =
      cursor === state.total
        ? { name: "placed", total: state.total }
        : { name: "placing", cursor, total: state.total };
    return { state: next, effect: pageMoveEffect(next) };
  }
  if (state.name === "placed" && type === "committed") {
    const next = { name: "ready", total: state.total };
    return { state: next, effect: null };
  }
  return refuse();
}

/** A new move's first state over a plan of `total` steps. */
export const pageMoveStart = (total) => validState({ name: "placing", cursor: 0, total });
