// Creating a Page in a Project from where you are: the Project's "New Page"
// row, "New sub-page" in the page menu, or the picker's "In <Project>".
// Each is one create_page with a placement, then
// opening the new Page.
//
//   preparing ──prepared──▶ writing ──written──▶ opening ──opened──▶ done
//       │                    │    │                 │
//       │ cancel      cancel │    │ failed          │ failed
//       ▼                    ▼    ▼                 ▼
//   cancelled ◀──failed── writingDetached        failed
//                             │ written
//                             ▼
//                           done (refresh only)
//
// Like create() in main.jsx this is a cancellable draft: a navigation or an
// account change (`cancel`) before the write leaves nothing written. Once
// create_page is in flight it can't be taken back, so `cancel` there moves to
// `writingDetached`: the answer still lands (the list refreshes) but the new
// Page doesn't open over wherever the person went. In `opening` the Page
// exists; `cancel` just ends the run without opening it.
//
// `done`, `failed` and `cancelled` end a run. A run that ends anywhere but
// `done` keeps its `attempt` ({ retry_token, idempotency_key }), and
// `replayAttempt()` hands it to the next try for the same placement, so a
// create whose answer was lost lands once. That covers a failed open (the
// replay answers with the same Page) and a write that failed after a cancel
// detached it. A replayed run still starts in `preparing`, with the attempt
// in hand instead of listing, so a cancel before its write writes nothing.
// A write the server says can't be replayed (`retry_expired`,
// `idempotency_conflict`) spends the attempt and refreshes the list, which
// shows the Page if the lost write landed.
//
// State: `{ name, placement, attempt, receipt?, cause? }`
//   placement  { project_id } for a Project's top level, or { parent_id }
//   cause      the Error a failed step threw, for failureMessage()
//
// Events:
//   { type: "prepared", attempt }   list_* answered with a retry_token
//   { type: "written", receipt }    create_page answered
//   { type: "opened" }              the new Page is open
//   { type: "failed", error }       the current step threw `error`
//   { type: "cancel" }              navigation or account change
//
// Effects, run by the driver after the transition, in order:
//   { type: "prepare", attempt }              fetch a retry_token, or reuse
//                                             the replayed attempt
//   { type: "write", placement, attempt }     create_page
//   { type: "open", pageId }                  open the new Page
//   { type: "refresh" }                       list Pages again
//
// `pageCreations()` below holds what outlives one run: the one-at-a-time
// guard and the attempts to replay, per placement, for one account.

export const STATES = Object.freeze([
  "preparing",
  "writing",
  "writingDetached",
  "opening",
  "done",
  "failed",
  "cancelled",
]);
export const EVENTS = Object.freeze(["prepared", "written", "opened", "failed", "cancel"]);
/** States that end a run. */
export const FINAL = Object.freeze(["done", "failed", "cancelled"]);
/** States with a step in flight that can fail. */
const RUNNING = Object.freeze(["preparing", "writing", "writingDetached", "opening"]);

/** create_page's placement arguments. */
export function placementArguments(placement) {
  if (placement?.parent_id) return { parent_id: placement.parent_id };
  if (placement?.project_id) return { project_id: placement.project_id };
  throw new TypeError("A Page created here needs a Project or a parent Page");
}

/** One key per placement, for the attempts map. */
export function placementKey(placement) {
  const args = placementArguments(placement);
  return args.parent_id ? `parent:${args.parent_id}` : `project:${args.project_id}`;
}

/** Whether the server refused to replay this attempt: its retry window
 * closed, or its key went with a different request. Replaying it again can
 * only fail the same way. */
export function attemptSpent(error) {
  return (
    (error?.status === 410 && error?.code === "retry_expired") ||
    error?.code === "idempotency_conflict"
  );
}

/** A run's first state and effects. `attempt` replays an earlier request. */
export function start(placement, attempt = null) {
  placementArguments(placement);
  return {
    state: { name: "preparing", placement, attempt },
    effects: [{ type: "prepare", attempt }],
  };
}

/** The attempt the next try for the same placement replays: any run that
 * didn't reach `done` may have written, so its key must be reused. */
export function replayAttempt(state) {
  return state.name === "done" ? null : (state.attempt ?? null);
}

const stay = (state) => ({ state, effects: [] });
const failure = (error) =>
  error instanceof Error ? error : new Error("Couldn't create the Page. Try again.");

/** The next state and its effects. Pure: an event that changes nothing
 * returns the same state object and no effects. */
export function transition(state, event) {
  switch (event?.type) {
    case "prepared":
      if (state.name !== "preparing") return stay(state);
      return {
        state: { ...state, name: "writing", attempt: event.attempt },
        effects: [{ type: "write", placement: state.placement, attempt: event.attempt }],
      };
    case "written":
      if (state.name === "writingDetached")
        return {
          state: { ...state, name: "done", receipt: event.receipt },
          effects: [{ type: "refresh" }],
        };
      if (state.name !== "writing") return stay(state);
      return {
        state: { ...state, name: "opening", receipt: event.receipt },
        effects: [{ type: "open", pageId: event.receipt.page_id }, { type: "refresh" }],
      };
    case "opened":
      if (state.name !== "opening") return stay(state);
      return { state: { ...state, name: "done" }, effects: [] };
    case "failed": {
      if (!RUNNING.includes(state.name)) return stay(state);
      const cause = failure(event.error);
      const spent = attemptSpent(cause);
      return {
        state: {
          ...state,
          // A detached run's person went elsewhere; it ends quietly.
          name: state.name === "writingDetached" ? "cancelled" : "failed",
          cause,
          attempt: spent ? null : state.attempt,
        },
        effects: spent ? [{ type: "refresh" }] : [],
      };
    }
    case "cancel":
      if (state.name === "preparing")
        return { state: { ...state, name: "cancelled" }, effects: [] };
      if (state.name === "writing")
        return { state: { ...state, name: "writingDetached" }, effects: [] };
      if (state.name === "opening") return { state: { ...state, name: "done" }, effects: [] };
      return stay(state);
    default:
      return stay(state);
  }
}

/**
 * Run one creation to its end and return the final state. `current()` is
 * true while the navigation and account that started it still hold; it is
 * read after each answer, so a late answer never opens a Page over wherever
 * the person went. `call` is the tool caller; `open(pageId)` opens the new
 * Page (a navigation of its own); `refresh()` lists Pages again.
 */
export async function runPageCreation({ placement, attempt = null, call, open, refresh, current }) {
  let { state, effects } = start(placement, attempt);
  const apply = (event) => {
    const next = transition(state, event);
    state = next.state;
    effects.push(...next.effects);
  };
  while (effects.length) {
    const effect = effects.shift();
    if (effect.type === "refresh") {
      void Promise.resolve()
        .then(refresh)
        .catch(() => {});
      continue;
    }
    // Before the prepare nothing is written; before the open the new Page
    // stays closed. `write` needs no check here: only `prepared` emits it, in
    // the same step that consumed the prepare answer checked below.
    if (effect.type !== "write" && !current()) {
      apply({ type: "cancel" });
      continue;
    }
    let event;
    try {
      if (effect.type === "prepare") {
        let prepared = effect.attempt;
        if (!prepared) {
          const listed = await call("list_pages", { limit: 1 });
          prepared = {
            retry_token: listed.retry_token,
            idempotency_key: crypto.randomUUID(),
          };
        }
        event = { type: "prepared", attempt: prepared };
      } else if (effect.type === "write") {
        const receipt = await call("create_page", {
          title: "Untitled",
          ...placementArguments(effect.placement),
          ...effect.attempt,
        });
        event = { type: "written", receipt };
      } else if (effect.type === "open") {
        await open(effect.pageId);
        event = { type: "opened" };
      }
    } catch (error) {
      event = { type: "failed", error };
    }
    // open() navigates by itself, so only the other answers check the
    // navigation they started on.
    if (effect.type !== "open" && !current()) apply({ type: "cancel" });
    apply(event);
  }
  return state;
}

/**
 * What outlives one run, for one tab:
 *
 * - One creation at a time. `exclusive(task)` runs `task` unless another
 *   creation (placed or not) is pending, and answers `{ busy: true }` then.
 * - Attempts to replay, keyed by placement, for one account. `create()`
 *   replays the attempt for its placement, keeps the run's replay attempt,
 *   and deletes it once the run reaches `done` or the server spends it.
 *   `account(principal)` clears every attempt when the account changes or
 *   signs out (null); a run that finishes under an earlier account keeps
 *   nothing.
 *
 * `run` is the single-run driver, injected for tests.
 */
export function pageCreations({ run = runPageCreation } = {}) {
  let pending = false;
  let owner = null;
  const attempts = new Map();
  const account = (principal) => {
    if ((principal ?? null) === owner) return;
    attempts.clear();
    owner = principal ?? null;
  };
  async function exclusive(task) {
    if (pending) return { busy: true };
    pending = true;
    try {
      return { busy: false, value: await task() };
    } finally {
      pending = false;
    }
  }
  return {
    get pending() {
      return pending;
    },
    account,
    exclusive,
    /** The attempt `create()` would replay for this account and placement. */
    attempt(principal, placement) {
      return principal === owner ? (attempts.get(placementKey(placement)) ?? null) : null;
    },
    /** Run one placed creation for `principal`. Answers the run's final
     * state, or null when another creation is pending. */
    async create({ principal, placement, ...deps }) {
      if (!principal) throw new TypeError("A placed creation needs a signed-in account");
      const key = placementKey(placement);
      const result = await exclusive(async () => {
        account(principal);
        const state = await run({ placement, attempt: attempts.get(key) ?? null, ...deps });
        if (owner !== principal) return state;
        const next = replayAttempt(state);
        if (next) attempts.set(key, next);
        else attempts.delete(key);
        return state;
      });
      return result.busy ? null : result.value;
    },
  };
}
