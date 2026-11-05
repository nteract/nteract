import { asyncScheduler, timer } from "rxjs";
import { defineMachine, reject } from "../shared/machine.mjs";
import { isTransientFailure } from "./request.mjs";

/** Every Page of one Project, following list_pages cursors. */
export async function listProjectPages(call, projectId, { maxRequests = 10 } = {}) {
  const pages = new Map();
  let cursor;
  for (let request = 0; request < maxRequests; request++) {
    const result = await call("list_pages", {
      project_id: projectId,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const page of result.pages ?? [])
      if (!pages.has(page.page_id)) pages.set(page.page_id, page);
    cursor = result.next_cursor;
    if (typeof cursor !== "string") break;
  }
  return [...pages.values()];
}

/** Rows for a Project view: top-level Pages, each followed by its descendants in
 * position order. A Page whose parent is missing (in Trash, or not listed)
 * shows at the top level. */
export function projectTree(pages) {
  const ids = new Set(pages.map((page) => page.page_id));
  const children = new Map();
  for (const page of pages) {
    const parent = page.parent_id && ids.has(page.parent_id) ? page.parent_id : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(page);
  }
  const order = (a, b) =>
    (a.position ?? "") === (b.position ?? "")
      ? a.page_id.localeCompare(b.page_id)
      : (a.position ?? "") < (b.position ?? "")
        ? -1
        : 1;
  const rows = [];
  const seen = new Set();
  const visit = (parent, depth) => {
    for (const page of (children.get(parent) ?? []).sort(order)) {
      if (seen.has(page.page_id)) continue;
      seen.add(page.page_id);
      rows.push({ page, depth });
      if (depth < 8) visit(page.page_id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

/** An open document's kind and placement from read_page, limited to what this
 * account can open. Project content is not a Page in the tree; top-level
 * Pages have parent_id null. */
export async function pageLocation(call, pageId) {
  const result = await call("read_page", {
    page_id: pageId,
    include_content: false,
    comments: "none",
    outline_limit: 1,
  });
  return {
    kind: result.kind ?? "page",
    project_id: result.project_id ?? null,
    parent_id: result.parent_id ?? null,
    breadcrumbs: Array.isArray(result.breadcrumbs) ? result.breadcrumbs : [],
  };
}

/** What decides whether read_page can find a session's Page: a draft made in
 * this tab or offline isn't on the server until it registers, and nothing is
 * reachable until the session connects. `connectionGeneration` counts the
 * session's accepted connections, so each reconnect is a change. */
const reachability = (session) =>
  `${session.localPage?.registration ? !!session.localPage.registered : true}:${
    session.connectionGeneration ?? (session.connection ? 1 : 0)
  }`;

/** How many times a transient failure is asked again under one
 * reachability, and the first wait; each wait doubles. */
export const LOCATION_RETRIES = 3;
export const LOCATION_RETRY_MS = 2000;

const checkField = (condition, message) => {
  if (!condition) throw new Error(message);
};
const fields = (value, keys) => {
  for (const key of Object.keys(value)) checkField(keys.includes(key), `unexpected field ${key}`);
};
const reachField = (value) => checkField(typeof value === "string", "reach is a string");
const triesField = (value) =>
  checkField(
    Number.isSafeInteger(value) && value >= 0 && value <= LOCATION_RETRIES,
    "tries is a count within the cap",
  );
const asking = (value) => {
  fields(value, ["name", "asked", "tries"]);
  reachField(value.asked);
  triesField(value.tries);
};

/**
 * Where an open Page is, as a state machine: read_page refuses a Page
 * created in this tab, or a draft made offline, until it registers, and can
 * fail while the session is offline.
 *
 * States:
 * - waiting: no ask in flight. `asked` is the reachability (registered,
 *   connection generation) last asked under, or null before the first ask.
 * - asking: read_page is in flight under `asked`; `tries` counts transient
 *   retries spent on it.
 * - backoff: a transient failure under `asked`; a retry is scheduled.
 * - found, stopped: terminal.
 *
 * Events:
 * - changed: the session notified; `reach` is its reachability now.
 * - located: read_page answered.
 * - failed: read_page failed. `reach` is the reachability when it settled;
 *   `transient` says the failure may pass on its own (isTransientFailure).
 * - retry: the scheduled retry is due.
 * - stop: the shell left the Page.
 *
 * A failed ask asks again at once when reachability changed meanwhile.
 * Otherwise a transient failure retries after 2, 4 and 8 seconds under the
 * same reachability, and any failure then waits for a change, so a Page
 * read_page keeps refusing costs one request per change plus three retries.
 *
 * Effects: `locate` asks read_page; `schedule` sets the retry timer for `ms`;
 * `cancelTimer` clears it; `found` hands the answer to the shell.
 */
export const pageLocationSpec = Object.freeze({
  name: "page-location",
  states: ["waiting", "asking", "backoff", "found", "stopped"],
  events: ["changed", "located", "failed", "retry", "stop"],
  cases: {
    "waiting/changed": ["new", "same"],
    "asking/failed": ["moved", "retry", "wait"],
    "backoff/changed": ["new", "same"],
  },
  validate: {
    states: {
      waiting: (value) => {
        fields(value, ["name", "asked", "tries"]);
        if (value.asked !== null) reachField(value.asked);
        triesField(value.tries);
      },
      asking,
      backoff: asking,
      found: (value) => fields(value, ["name"]),
      stopped: (value) => fields(value, ["name"]),
    },
    events: {
      changed: (value) => {
        fields(value, ["type", "reach"]);
        reachField(value.reach);
      },
      located: (value) => fields(value, ["type"]),
      failed: (value) => {
        fields(value, ["type", "reach", "transient"]);
        reachField(value.reach);
        checkField(typeof value.transient === "boolean", "transient is a boolean");
      },
      retry: (value) => fields(value, ["type"]),
      stop: (value) => fields(value, ["type"]),
    },
    effects: {
      locate: (value) => fields(value, ["type"]),
      schedule: (value) => {
        fields(value, ["type", "ms"]);
        checkField(Number.isSafeInteger(value.ms) && value.ms > 0, "ms is a positive integer");
      },
      cancelTimer: (value) => fields(value, ["type"]),
      found: (value) => fields(value, ["type"]),
    },
  },
});

export const LOCATION_REJECT = Object.freeze({
  done: "The location is settled",
  same: "Nothing that read_page depends on changed",
  asking: "An ask is in flight",
  idle: "No ask is in flight",
  timer: "No retry is scheduled",
});

const ask = (reach) => ({
  state: { name: "asking", asked: reach, tries: 0 },
  effects: [{ type: "locate" }],
});

function locationTransition(current, input) {
  if (current.name === "found" || current.name === "stopped")
    return reject(current, LOCATION_REJECT.done);
  if (input.type === "stop")
    return {
      state: { name: "stopped" },
      effects: current.name === "backoff" ? [{ type: "cancelTimer" }] : [],
    };
  switch (current.name) {
    case "waiting":
      if (input.type !== "changed") return reject(current, LOCATION_REJECT.idle);
      return input.reach === current.asked
        ? reject(current, LOCATION_REJECT.same)
        : ask(input.reach);
    case "asking":
      if (input.type === "located")
        return { state: { name: "found" }, effects: [{ type: "found" }] };
      if (input.type === "failed") {
        if (input.reach !== current.asked) return ask(input.reach);
        if (input.transient && current.tries < LOCATION_RETRIES)
          return {
            state: { name: "backoff", asked: current.asked, tries: current.tries },
            effects: [{ type: "schedule", ms: LOCATION_RETRY_MS * 2 ** current.tries }],
          };
        return {
          state: { name: "waiting", asked: current.asked, tries: current.tries },
          effects: [],
        };
      }
      return reject(
        current,
        input.type === "changed" ? LOCATION_REJECT.asking : LOCATION_REJECT.timer,
      );
    case "backoff":
      if (input.type === "retry")
        return {
          state: { name: "asking", asked: current.asked, tries: current.tries + 1 },
          effects: [{ type: "locate" }],
        };
      if (input.type === "changed") {
        if (input.reach === current.asked) return reject(current, LOCATION_REJECT.same);
        const next = ask(input.reach);
        return { state: next.state, effects: [{ type: "cancelTimer" }, ...next.effects] };
      }
      return reject(current, LOCATION_REJECT.idle);
  }
}

export const pageLocationMachine = defineMachine({
  ...pageLocationSpec,
  initial: { name: "waiting", asked: null, tries: 0 },
  transition: locationTransition,
});

/**
 * Run pageLocationMachine for `session`'s Page and ask at once.
 *
 * `locate()` is read_page through pageLocation; `onFound(location)` hears the
 * answer once, while `current()` holds. Call `changed()` whenever the session
 * notifies, and `stop()` when the shell leaves the Page. Retry timers run on
 * `scheduler` (an RxJS scheduler; tests pass a VirtualTimeScheduler).
 */
export function watchPageLocation(
  session,
  { locate, onFound, current, transient = isTransientFailure, scheduler = asyncScheduler },
) {
  let state = pageLocationMachine.initial;
  // The scheduled retry's subscription while the machine is in backoff.
  let retry = null;
  let answer;
  const dispatch = (input) => {
    const result = pageLocationMachine.step(state, input);
    if (result.rejected) return;
    state = result.state;
    for (const effect of result.effects) run(effect);
  };
  const run = (effect) => {
    switch (effect.type) {
      case "locate": {
        let pending;
        try {
          pending = Promise.resolve(locate());
        } catch (error) {
          pending = Promise.reject(error);
        }
        pending.then(
          (location) => {
            answer = location;
            dispatch({ type: "located" });
          },
          (error) =>
            dispatch({
              type: "failed",
              reach: reachability(session),
              transient: !!transient(error),
            }),
        );
        return;
      }
      case "schedule":
        retry = timer(effect.ms, scheduler).subscribe(() => {
          retry = null;
          if (current()) dispatch({ type: "retry" });
          else dispatch({ type: "stop" });
        });
        return;
      case "cancelTimer":
        retry?.unsubscribe();
        retry = null;
        return;
      case "found":
        if (current()) onFound(answer);
        return;
    }
  };
  const changed = () => {
    if (current()) dispatch({ type: "changed", reach: reachability(session) });
  };
  changed();
  return { changed, stop: () => dispatch({ type: "stop" }), state: () => state };
}

/** Breadcrumbs for an open Page, limited to what this account can open. */
export async function pageBreadcrumbs(call, pageId) {
  return (await pageLocation(call, pageId)).breadcrumbs;
}
