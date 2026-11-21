// The share dialog's organization member search: the owner types part of a
// colleague's name and sees up to ten names and avatars from one of their
// organizations (worker/organization-members.mjs). Picking one is a sharing
// change the dialog sends; the host asks Kilo again before it grants.
//
// One pure transition function holds the lifecycle. The stream around it
// waits for typing to pause, asks the host, and cancels a search a newer
// query replaces, so a slow answer never shows over a newer one.
import {
  BehaviorSubject,
  Observable,
  Subject,
  asyncScheduler,
  catchError,
  debounceTime,
  defer,
  filter,
  map,
  switchMap,
  take,
  tap,
} from "rxjs";
import { request } from "./request.mjs";

/** How long typing must pause before a search. */
export const MEMBER_SEARCH_DEBOUNCE_MS = 250;
/** A query's length after trimming, as the host takes it. */
export const MIN_MEMBER_QUERY = 2;
export const MAX_MEMBER_QUERY = 100;

/** The directory couldn't answer: a 503, retryable, or a 404 where the
 * deployment has no organization search. */
const UNAVAILABLE = "member_search_unavailable";
/** The owner's sign-in no longer proves the organization or carries a proof. */
const PROOF_REQUIRED = "organization_proof_required";

/** The state before anything is typed. */
export const MEMBER_SEARCH_IDLE = Object.freeze({ name: "idle", organizationId: null, query: "" });

const trimmed = (query) => (typeof query === "string" ? query.trim() : "");
const searchable = (query) => query.length >= MIN_MEMBER_QUERY && query.length <= MAX_MEMBER_QUERY;
const same = (state, event) =>
  state.organizationId === event.organizationId && state.query === event.query;

/**
 * The picker's lifecycle. States:
 *
 * - `idle`: no query to search, or one too short or too long.
 * - `waiting`: a query is typed and the pause before searching runs.
 * - `searching`: the host is asked about the query.
 * - `results`: `members` for the query, possibly none.
 * - `failed`: this search failed; typing again searches again. `rateLimited`
 *   when the host asked to slow down, `unavailable` when the directory
 *   couldn't answer (a 503: an outage, a timeout, or rules not yet in place).
 * - `signin`: the owner must sign in again before searching this
 *   organization. Typing again tries again, since another tab may have.
 * - `unavailable`: this deployment has no organization search (a 404).
 *   Final: the dialog hides the picker and email invites stay. A deployment
 *   whose sign-in carried no directory credential never shows the picker.
 *
 * Events: `typed` (`organizationId`, `query`), `started`, `answered`
 * (`members`) and `failed` (`error`), each naming the search it belongs to,
 * and `reset`. An event for any search but the current one changes nothing,
 * so a late answer can't replace a newer query's.
 */
export function memberSearchTransition(state, event) {
  if (state.name === "unavailable") return state;
  switch (event.type) {
    case "typed": {
      const query = trimmed(event.query);
      if (!searchable(query)) return { name: "idle", organizationId: event.organizationId, query };
      if (
        same(state, { organizationId: event.organizationId, query }) &&
        ["searching", "results"].includes(state.name)
      )
        return state;
      return { name: "waiting", organizationId: event.organizationId, query };
    }
    case "started":
      if (!same(state, event) || state.name !== "waiting") return state;
      return { name: "searching", organizationId: state.organizationId, query: state.query };
    case "answered":
      if (!same(state, event) || state.name !== "searching") return state;
      return {
        name: "results",
        organizationId: state.organizationId,
        query: state.query,
        members: event.members,
      };
    case "failed": {
      if (!same(state, event) || state.name !== "searching") return state;
      const { error } = event;
      if (error?.status === 404) return { name: "unavailable" };
      const base = { organizationId: state.organizationId, query: state.query };
      if (error?.code === PROOF_REQUIRED) return { name: "signin", ...base };
      return {
        name: "failed",
        ...base,
        rateLimited: error?.status === 429,
        unavailable: error?.code === UNAVAILABLE,
      };
    }
    case "reset":
      return MEMBER_SEARCH_IDLE;
    default:
      return state;
  }
}

/** Only well-formed members reach the picker: `{ id, name, imageUrl }`, with
 * `imageUrl` only as an `https:` URL. */
export function shownMembers(value) {
  if (!Array.isArray(value?.members)) throw Error("The server returned an unexpected answer");
  const members = [];
  for (const entry of value.members) {
    if (typeof entry?.id !== "string" || !entry.id || typeof entry.name !== "string") continue;
    const name = entry.name.trim();
    if (!name) continue;
    let imageUrl = null;
    try {
      if (typeof entry.image_url === "string" && new URL(entry.image_url).protocol === "https:")
        imageUrl = entry.image_url;
    } catch {}
    members.push({ id: entry.id, name, imageUrl });
  }
  return members;
}

/** Asks the host for `query`'s matches in `organizationId`, cancelled with
 * `signal`. The stream takes the first answer only. */
export function searchMembers({ organizationId, query }, signal, send = request) {
  return send("/api/organization-members", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ organization_id: organizationId, query }),
    signal,
  });
}

/** The search as an Observable: `search` may answer with a Promise or an
 * Observable, and unsubscribing before its first answer aborts it. */
const asked = (search, input) =>
  new Observable((subscriber) => {
    const controller = new AbortController();
    let settled = false;
    const inner = defer(() => search(input, controller.signal)).subscribe({
      next: (value) => {
        settled = true;
        subscriber.next(value);
      },
      error: (error) => {
        settled = true;
        subscriber.error(error);
      },
      complete: () => {
        settled = true;
        subscriber.complete();
      },
    });
    return () => {
      inner.unsubscribe();
      if (!settled) controller.abort();
    };
  });

/**
 * One picker's search. `type(organizationId, query)` feeds it; `state$`
 * holds the transition function's state. A query is searched once typing has
 * paused for `debounceMs` and only while it is still the one waiting, so
 * typing back to the query being searched keeps that search. A newer search
 * or `dispose()` cancels the one in flight; an answer to any search but the
 * current one is ignored by the transition.
 */
export function createMemberSearch({
  search = searchMembers,
  debounceMs = MEMBER_SEARCH_DEBOUNCE_MS,
  scheduler = asyncScheduler,
} = {}) {
  const state$ = new BehaviorSubject(MEMBER_SEARCH_IDLE);
  const input$ = new Subject();
  const dispatch = (event) => {
    const next = memberSearchTransition(state$.value, event);
    if (next !== state$.value) state$.next(next);
  };
  const subscription = input$
    .pipe(
      tap((input) => dispatch({ type: "typed", ...input })),
      debounceTime(debounceMs, scheduler),
      map(({ organizationId, query }) => ({ organizationId, query: trimmed(query) })),
      filter((input) => state$.value.name === "waiting" && same(state$.value, input)),
      switchMap(({ organizationId, query }) =>
        defer(() => {
          dispatch({ type: "started", organizationId, query });
          return asked(search, { organizationId, query });
        }).pipe(
          take(1),
          map((value) => ({
            type: "answered",
            organizationId,
            query,
            members: shownMembers(value),
          })),
          catchError((error) => [{ type: "failed", organizationId, query, error }]),
        ),
      ),
    )
    .subscribe(dispatch);
  return {
    state$,
    getState: () => state$.value,
    type(organizationId, query) {
      input$.next({ organizationId, query });
    },
    reset() {
      dispatch({ type: "reset" });
    },
    dispose() {
      subscription.unsubscribe();
      state$.complete();
    },
  };
}
