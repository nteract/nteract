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
 * A listing also needs no Page index mark pending (`pageIndexMarkMachine`
 * below). A Catalog write that adds a listable entry for one Page marks
 * that Page, not the account: a creation, a Project's home Page, a
 * Trash, restore or purge projection, and a new entry a Page host projects,
 * including a discovery. The next listing settles each mark from the Page's
 * current entries, so one write never restarts a pass. The account is marked
 * dirty for what a per-Page mark can't name: an owner row a listing found
 * stale, a capacity check's projection, and every write while the index is
 * off. Every mark lands before its entry, so a listing never reads D1 while
 * it misses a write. Title and content updates to an existing entry reach D1
 * from the Page host and don't mark anything: a stale snapshot misorders a
 * row in an unfiltered walk but doesn't drop it.
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

/**
 * One Page's index mark (`host/index/page/<id>`, catalog-index.mjs): a token
 * a Catalog write stores before it writes the Page's entry, saying D1 may not
 * hold that entry yet. While any mark is pending, listings read the Catalog
 * entries; the account index is otherwise unaffected.
 *
 * States:
 * - `settled`: no mark is stored.
 * - `pending`: a mark with `token` is stored.
 *
 * Events:
 * - `marked`: a write stored a new mark with `token`.
 * - `checked`: a writer settled the mark it read (`token`). `outcome` is
 *   `indexed` when D1 now holds the Page's current entry (the write's own D1
 *   rows landed, or a listing wrote or found them), `refused` when the Page
 *   host refused this account the shared Page the entry names, and
 *   `unavailable` when the host check didn't answer.
 *
 * A check whose token is no longer the stored one changes nothing: a newer
 * write marked the Page again, and its entry may not be in D1 yet.
 *
 * Effects: `clear` deletes the mark, and `forget_entry` deletes the refused
 * shared entry, as a reconcile pass does. The interpreter reads the stored
 * token and runs both with no I/O between that read and the deletes, so a
 * mark stored meanwhile always survives.
 */
export const pageIndexMarkMachine = defineMachine({
  name: "page-index-mark",
  states: ["settled", "pending"],
  events: ["marked", "checked"],
  initial: "settled",
  cases: {
    "settled/checked": ["indexed", "refused", "unavailable"],
    "pending/checked": [
      "indexed",
      "indexed-superseded",
      "refused",
      "refused-superseded",
      "unavailable",
    ],
  },
  validate: {
    states: {
      settled: () => {},
      pending: (state) => {
        if (typeof state.token !== "string" || !state.token) throw Error("token must be a string");
      },
    },
    events: {
      marked: (event) => {
        if (typeof event.token !== "string" || !event.token) throw Error("token must be a string");
      },
      checked: (event) => {
        if (typeof event.token !== "string" || !event.token) throw Error("token must be a string");
        if (!["indexed", "refused", "unavailable"].includes(event.outcome))
          throw Error("outcome must be indexed, refused or unavailable");
      },
    },
    effects: { clear: () => {}, forget_entry: () => {} },
  },
  transition(state, event) {
    if (event.type === "marked")
      return { state: { name: "pending", token: event.token }, effects: [] };
    // A check settles only the mark it read.
    if (state.name !== "pending" || state.token !== event.token || event.outcome === "unavailable")
      return { state, effects: [] };
    return {
      state: { name: "settled" },
      effects:
        event.outcome === "refused"
          ? [{ type: "forget_entry" }, { type: "clear" }]
          : [{ type: "clear" }],
    };
  },
});

/** The state a stored mark value gives. */
export function pageIndexMarkState(token) {
  return typeof token === "string" && token ? { name: "pending", token } : { name: "settled" };
}

/**
 * Whether this account's first pages may try D1 (`host/index/unavailable-until`,
 * catalog-index.mjs). A walk that began on D1 restarts from its first page
 * when D1 can't serve one of its later pages (index.mjs `listPages`). If that
 * restart could pin D1 again, a D1 that serves first pages and fails later
 * ones would restart the walk forever. So a refusal starts a cooldown, and
 * while it lasts no listing opens D1 except a page of a walk that began
 * there (`opensIndex`): first pages read the Catalog entries, whose walks
 * never need D1. Each walk restarts at most once per cooldown.
 *
 * States:
 * - `open`: no cooldown, or one that has passed. Listings open D1, and first
 *   pages read it when the account index is ready.
 * - `cooling`: a refusal at `until` - `cooldownMs` or later. Only walks that
 *   began on D1 open it; first pages read the Catalog.
 *
 * Events:
 * - `refused`: D1 couldn't serve a page of a walk that began there, at `now`.
 * - `expired`: `now` is past the cooldown's end.
 *
 * Effects: `store` persists `until`. A passed cooldown reads as `open`
 * (`indexCooldownState`), so expiry needs no write.
 */
export const indexCooldownMachine = defineMachine({
  name: "index-cooldown",
  states: ["open", "cooling"],
  events: ["refused", "expired"],
  initial: "open",
  cases: { "cooling/refused": ["later", "earlier"], "cooling/expired": ["passed", "early"] },
  validate: {
    states: {
      open: () => {},
      cooling: (state) => {
        if (!Number.isFinite(state.until)) throw Error("until must be a time");
      },
    },
    events: {
      refused: (event) => {
        if (!Number.isFinite(event.now)) throw Error("now must be a time");
        if (!(event.cooldownMs > 0)) throw Error("cooldownMs must be positive");
      },
      expired: (event) => {
        if (!Number.isFinite(event.now)) throw Error("now must be a time");
      },
    },
    effects: {
      store: (effect) => {
        if (!Number.isFinite(effect.until)) throw Error("until must be a time");
      },
    },
  },
  transition(state, event) {
    if (event.type === "refused") {
      // A later refusal extends the cooldown; an earlier one never shortens it.
      const until = Math.max(event.now + event.cooldownMs, state.until ?? 0);
      return { state: { name: "cooling", until }, effects: [{ type: "store", until }] };
    }
    if (state.name === "cooling" && event.now >= state.until)
      return { state: { name: "open" }, effects: [] };
    return { state, effects: [] };
  },
});

/** The state a stored cooldown end gives at `now`. */
export function indexCooldownState(until, now) {
  return Number.isFinite(until) && now < until ? { name: "cooling", until } : { name: "open" };
}

/**
 * Whether a listing opens D1, from the source its cursor names (`pinned`:
 * "index", "catalog", or null for a first page or an earlier build's cursor)
 * and the cooldown's state. Opening D1 advances the account's pass and
 * settles Page marks, whichever source serves. A walk that began on D1
 * always opens it, and restarts if D1 can't serve it. Any other listing
 * skips D1 while it is cooling, so a failing D1 costs those listings nothing
 * and a restarted walk lands on the Catalog. Which source serves is decided
 * after: D1 only for a walk that began there, or for a first page while the
 * account index is `ready`.
 */
export function opensIndex({ pinned, cooldown }) {
  return pinned === "index" || cooldown.name === "open";
}
