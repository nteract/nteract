import { defineMachine } from "../shared/machine.mjs";

/**
 * Whether one account's D1 rows are complete enough to choose a listing's
 * candidates. A listing reads D1 only in `ready`; in any other state the
 * account's own Catalog entries serve it. A missing D1 row hides a Page from a
 * D1 listing and can end its walk early with no cursor, so D1 serves only
 * while it holds every entry the Catalog has written.
 *
 * States:
 * - `unsynced`: no reconcile pass has completed under this epoch. D1's account
 *   marker (`pages_catalog_accounts`) names another epoch, or none.
 * - `behind`: a pass completed under this epoch, but the Catalog has recorded
 *   a write since (`host/index/dirty`) that D1 may not hold.
 * - `ready`: a pass completed under this epoch with no write recorded since.
 *
 * A Catalog write that adds a listable entry (a creation, a Project's home
 * Page, a Trash, restore or purge projection) writes the entry's D1 rows
 * first (catalog-index.mjs `indexOwnedEntries`) and marks the account dirty
 * only when that write fails. A new discovery entry marks it unless its Page
 * host's report is already in D1, and so does a stale owner row a listing
 * met. Every mark lands before its entry, so `ready` never outlives a write
 * D1 misses. Title and content updates to an existing entry reach D1 from
 * the Page host and don't mark it: a stale snapshot misorders a row in an
 * unfiltered walk but doesn't drop it.
 *
 * The state is a function of two persisted facts, D1's account marker and the
 * Catalog's dirty token (`accountIndexState`). The events say how those facts
 * change:
 * - `marked`: the Catalog recorded a write.
 * - `epoch`: the configured epoch changed.
 * - `completed`: a pass reached its end. `verified` is false when a Page host
 *   check was unavailable: the pass recorded nothing. A verified pass has
 *   already recorded its epoch in D1's account marker. `unchanged` says the
 *   dirty token, read after that, still equals the token the pass started
 *   from, so no write landed while it ran. A write that landed puts a synced
 *   account behind whether or not the pass was verified.
 *
 * Effects: `clear` deletes the dirty token the pass started from. It runs with
 * no I/O between reading the token for `unchanged` and deleting it, so it
 * never drops a newer mark.
 */
export const accountIndexMachine = defineMachine({
  name: "account-index",
  states: ["unsynced", "behind", "ready"],
  events: ["marked", "epoch", "completed"],
  initial: "unsynced",
  cases: {
    "unsynced/completed": ["clean", "written-meanwhile", "unverified", "unverified-written"],
    "behind/completed": ["clean", "written-meanwhile", "unverified", "unverified-written"],
    "ready/completed": ["clean", "written-meanwhile", "unverified", "unverified-written"],
  },
  validate: {
    events: {
      marked: () => {},
      epoch: () => {},
      completed: (event) => {
        if (typeof event.verified !== "boolean") throw Error("verified must be a boolean");
        if (typeof event.unchanged !== "boolean") throw Error("unchanged must be a boolean");
      },
    },
    effects: { clear: () => {} },
  },
  transition(state, event) {
    // A write can't make D1 synced; it can only put a synced D1 behind.
    const marked = { name: state.name === "unsynced" ? "unsynced" : "behind" };
    switch (event.type) {
      case "marked":
        return { state: marked, effects: [] };
      case "epoch":
        return { state: { name: "unsynced" }, effects: [] };
      case "completed":
        // An unverified pass records nothing; only a write that landed while
        // it ran changes a fact.
        if (!event.verified) return { state: event.unchanged ? state : marked, effects: [] };
        if (!event.unchanged) return { state: { name: "behind" }, effects: [] };
        return { state: { name: "ready" }, effects: [{ type: "clear" }] };
    }
  },
});

/** The state the persisted facts give: `current` is whether D1's account
 * marker names this epoch, and `dirty` is the Catalog's dirty token, or
 * undefined. */
export function accountIndexState({ current, dirty }) {
  if (!current) return { name: "unsynced" };
  return { name: dirty === undefined ? "ready" : "behind" };
}
