// Creating a Page in a Project from where you are: the home Page's "+ New
// Page" row, "New sub-page" in the ⋯ menu, and the picker's "In <Project>".
// Each is one create_page with a placement, then opening the new Page.
//
//   preparing ──prepared──▶ writing ──written──▶ opening ──opened──▶ done
//       │                      │                    │
//       │ cancel               │ failed             │ failed
//       ▼                      ▼                    ▼
//   cancelled               failed ◀────────────────┘
//
// Like create() in main.jsx this is a cancellable draft: a navigation or an
// account change (`cancel`) before the write leaves nothing written. Once
// create_page is in flight it can't be taken back, so `cancel` there marks
// the run `detached`: the answer still lands (the list refreshes) but the
// new Page doesn't open over wherever the person went. In `opening` the Page
// exists; `cancel` just ends the run without opening it.
//
// `done`, `failed` and `cancelled` end a run. A run that ends anywhere but
// `done` keeps its `attempt` ({ retry_token, idempotency_key }), and
// `replayAttempt()` hands it to the next try for the same placement, so a
// create whose answer was lost lands once. That covers a failed open (the
// replay answers with the same Page) and a write that failed after a cancel
// detached it. A replayed run still starts in `preparing`, with the attempt
// in hand instead of listing, so a cancel before its write writes nothing.
//
// State: `{ name, placement, attempt, detached, receipt?, error? }`
//   placement  { project_id } for a Project's top level, or { parent_id }
//
// Events:
//   { type: "prepared", attempt }   list_* answered with a retry_token
//   { type: "written", receipt }    create_page answered
//   { type: "opened" }              the new Page is open
//   { type: "failed", message }     the current step failed
//   { type: "cancel" }              navigation or account change
//
// Effects, run by the driver after the transition, in order:
//   { type: "prepare", attempt }              fetch a retry_token, or reuse
//                                             the replayed attempt
//   { type: "write", placement, attempt }     create_page
//   { type: "open", pageId }                  open the new Page
//   { type: "refresh" }                       list Pages again

import { retryKey } from "../model/retry-key.mjs";

export const STATES = Object.freeze([
  "preparing",
  "writing",
  "opening",
  "done",
  "failed",
  "cancelled",
]);
export const EVENTS = Object.freeze(["prepared", "written", "opened", "failed", "cancel"]);
/** States that end a run. */
export const FINAL = Object.freeze(["done", "failed", "cancelled"]);

/** create_page's placement arguments. */
export function placementArguments(placement) {
  if (placement?.parent_id) return { parent_id: placement.parent_id };
  if (placement?.project_id) return { project_id: placement.project_id };
  throw new TypeError("A Page created here needs a Project or a parent Page");
}

/** A run's first state and effects. `attempt` replays an earlier request. */
export function start(placement, attempt = null) {
  placementArguments(placement);
  return {
    state: { name: "preparing", placement, attempt, detached: false },
    effects: [{ type: "prepare", attempt }],
  };
}

/** The attempt the next try for the same placement replays: any run that
 * didn't reach `done` may have written, so its key must be reused. */
export function replayAttempt(state) {
  return state.name === "done" ? null : (state.attempt ?? null);
}

const stay = (state) => ({ state, effects: [] });

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
      if (state.name !== "writing") return stay(state);
      if (state.detached)
        return {
          state: { ...state, name: "done", receipt: event.receipt },
          effects: [{ type: "refresh" }],
        };
      return {
        state: { ...state, name: "opening", receipt: event.receipt },
        effects: [{ type: "open", pageId: event.receipt.page_id }, { type: "refresh" }],
      };
    case "opened":
      if (state.name !== "opening") return stay(state);
      return { state: { ...state, name: "done" }, effects: [] };
    case "failed": {
      if (!["preparing", "writing", "opening"].includes(state.name)) return stay(state);
      if (state.detached) return { state: { ...state, name: "cancelled" }, effects: [] };
      return {
        state: {
          ...state,
          name: "failed",
          error: event.message || "Couldn't create the Page. Try again.",
        },
        effects: [],
      };
    }
    case "cancel":
      if (state.name === "preparing")
        return { state: { ...state, name: "cancelled" }, effects: [] };
      if (state.name === "writing" && !state.detached)
        return { state: { ...state, detached: true }, effects: [] };
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
            idempotency_key: await retryKey(listed.retry_token),
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
      event = { type: "failed", message: error instanceof Error ? error.message : String(error) };
    }
    // open() navigates by itself, so only the other answers check the
    // navigation they started on.
    if (effect.type !== "open" && !current()) apply({ type: "cancel" });
    apply(event);
  }
  return state;
}
