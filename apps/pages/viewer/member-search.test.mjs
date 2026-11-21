// The member picker's transition function over every state and event, and
// its stream on virtual time: the pause before a search, a newer query
// cancelling an older one, and late answers.
import test from "node:test";
import assert from "node:assert/strict";
import { map, of, throwError, timer } from "rxjs";
import { TestScheduler } from "rxjs/testing";
import {
  MEMBER_SEARCH_IDLE,
  createMemberSearch,
  memberSearchTransition,
  searchMembers,
  shownMembers,
} from "./member-search.mjs";

const org = "org-acme";
const jesse = { id: "jesse-person", name: "Jesse Doe", image_url: null };
const shown = { id: "jesse-person", name: "Jesse Doe", imageUrl: null };

const states = {
  idle: MEMBER_SEARCH_IDLE,
  waiting: { name: "waiting", organizationId: org, query: "jes" },
  searching: { name: "searching", organizationId: org, query: "jes" },
  results: { name: "results", organizationId: org, query: "jes", members: [shown] },
  failed: {
    name: "failed",
    organizationId: org,
    query: "jes",
    rateLimited: false,
    unavailable: false,
  },
  signin: { name: "signin", organizationId: org, query: "jes" },
  unavailable: { name: "unavailable" },
};

test("typing a searchable query waits, and a short or long one is idle, from every live state", () => {
  for (const [name, state] of Object.entries(states)) {
    const typed = (query) =>
      memberSearchTransition(state, { type: "typed", organizationId: org, query });
    if (name === "unavailable") {
      assert.equal(typed("jess"), state, "unavailable is final");
      continue;
    }
    assert.deepEqual(typed("jess"), { name: "waiting", organizationId: org, query: "jess" }, name);
    assert.deepEqual(typed(" j "), { name: "idle", organizationId: org, query: "j" }, name);
    assert.equal(typed("x".repeat(101)).name, "idle", name);
    // The query being searched or shown, typed again, keeps its search.
    if (name === "searching" || name === "results") assert.equal(typed(" jes "), state, name);
    else assert.equal(typed("jes").name, "waiting", name);
  }
  // Another organization is another search.
  assert.equal(
    memberSearchTransition(states.results, { type: "typed", organizationId: "org-b", query: "jes" })
      .name,
    "waiting",
  );
});

test("a search starts only from the query waiting, and is answered only for that query", () => {
  const event = (type, extra = {}) => ({ type, organizationId: org, query: "jes", ...extra });
  for (const [name, state] of Object.entries(states)) {
    const started = memberSearchTransition(state, event("started"));
    assert.equal(started.name, name === "waiting" ? "searching" : name, `started from ${name}`);
    const answered = memberSearchTransition(state, event("answered", { members: [shown] }));
    assert.equal(answered.name, name === "searching" ? "results" : name, `answered in ${name}`);
    const failed = memberSearchTransition(state, event("failed", { error: { status: 500 } }));
    assert.equal(failed.name, name === "searching" ? "failed" : name, `failed in ${name}`);
  }
  // A late answer for an older query changes nothing.
  assert.equal(
    memberSearchTransition(states.searching, { ...event("answered"), query: "je", members: [] }),
    states.searching,
  );
  assert.equal(
    memberSearchTransition(states.waiting, { ...event("started"), organizationId: "org-b" }),
    states.waiting,
  );
});

test("a failure says whether to hide the picker, sign in again, slow down, or retry", () => {
  const failed = (error) =>
    memberSearchTransition(states.searching, {
      type: "failed",
      organizationId: org,
      query: "jes",
      error,
    });
  // No organization search on this deployment: final.
  assert.deepEqual(failed({ status: 404, code: "member_search_unavailable" }), {
    name: "unavailable",
  });
  assert.deepEqual(failed({ status: 404 }), { name: "unavailable" });
  // A directory outage fails this search only.
  assert.deepEqual(failed({ status: 503, code: "member_search_unavailable", retryable: true }), {
    ...states.failed,
    unavailable: true,
  });
  assert.equal(failed({ status: 403, code: "organization_proof_required" }).name, "signin");
  assert.deepEqual(failed({ status: 429 }), { ...states.failed, rateLimited: true });
  assert.deepEqual(failed(new TypeError("Failed to fetch")), states.failed);
});

test("after an outage the next query searches again; after a 404 nothing does", () => {
  const outage = { ...states.failed, unavailable: true };
  const typed = (state, query) =>
    memberSearchTransition(state, { type: "typed", organizationId: org, query });
  assert.equal(typed(outage, "jes").name, "waiting", "the same query retries");
  assert.equal(typed(outage, "jess").name, "waiting");
  assert.equal(typed(states.unavailable, "jess"), states.unavailable);
});

test("reset clears any live state; nothing leaves unavailable", () => {
  for (const [name, state] of Object.entries(states))
    assert.equal(
      memberSearchTransition(state, { type: "reset" }),
      name === "unavailable" ? state : MEMBER_SEARCH_IDLE,
      name,
    );
  assert.equal(memberSearchTransition(states.results, { type: "unknown" }), states.results);
});

test("only well-formed members are shown, with https avatars only", () => {
  assert.deepEqual(
    shownMembers({
      members: [
        jesse,
        { id: "a", name: "  Ada  ", image_url: "https://avatars.example/a.png" },
        { id: "b", name: "Bad avatar", image_url: "http://avatars.example/b.png" },
        { id: "", name: "No id" },
        { id: "c", name: "   " },
        { id: "d" },
      ],
    }),
    [
      shown,
      { id: "a", name: "Ada", imageUrl: "https://avatars.example/a.png" },
      { id: "b", name: "Bad avatar", imageUrl: null },
    ],
  );
  assert.throws(() => shownMembers({}));
});

test("the search request names the organization and query, and passes the abort signal", async () => {
  const calls = [];
  const signal = new AbortController().signal;
  await searchMembers({ organizationId: org, query: "jes" }, signal, async (url, options) => {
    calls.push({ url, options });
    return { members: [] };
  });
  assert.equal(calls[0].url, "/api/organization-members");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.signal, signal);
  assert.deepEqual(JSON.parse(calls[0].options.body), { organization_id: org, query: "jes" });
});

// --- The stream on virtual time --------------------------------------------

/** Runs the picker's stream under TestScheduler with a search that answers
 * each query `latency` virtual ms after it starts, recording each search and
 * each abort. `typing` lists `[frame, query]`; `resets` lists frames. Returns
 * the searches, the aborted queries and every state published, with its
 * frame. */
function play({ typing, latency = 10, debounceMs = 25, resets = [] }) {
  const scheduler = new TestScheduler((actual, expected) => assert.deepEqual(actual, expected));
  const searched = [];
  const aborted = [];
  const seen = [];
  scheduler.run(({ cold, flush }) => {
    const search = ({ query }, signal) => {
      searched.push({ query, at: scheduler.now() });
      signal.addEventListener("abort", () => aborted.push(query));
      return timer(latency, scheduler).pipe(
        map(() => ({ members: [{ id: `${query}-id`, name: `Match ${query}` }] })),
      );
    };
    const picker = createMemberSearch({ search, debounceMs, scheduler });
    picker.state$.subscribe((state) => seen.push({ at: scheduler.now(), ...state }));
    for (const [at, query] of typing) cold(`${at}ms a`).subscribe(() => picker.type(org, query));
    for (const at of resets) cold(`${at}ms a`).subscribe(() => picker.reset());
    flush();
    picker.dispose();
  });
  return { searched, aborted, seen };
}
const trail = (seen) => seen.map(({ at, name, query }) => `${at} ${name}:${query ?? ""}`);

test("typing searches once the pause passes, not on every keystroke", () => {
  const { searched, seen } = play({
    typing: [
      [0, "j"],
      [5, "je"],
      [10, "jes"],
    ],
  });
  assert.deepEqual(searched, [{ query: "jes", at: 35 }]);
  assert.deepEqual(trail(seen), [
    "0 idle:",
    "0 idle:j",
    "5 waiting:je",
    "10 waiting:jes",
    "35 searching:jes",
    "45 results:jes",
  ]);
  assert.deepEqual(seen.at(-1).members, [{ id: "jes-id", name: "Match jes", imageUrl: null }]);
});

test("a newer query cancels the search in flight, and its answer never shows", () => {
  const { searched, aborted, seen } = play({
    typing: [
      [0, "jes"],
      [30, "jor"],
    ],
    latency: 50,
  });
  assert.deepEqual(searched, [
    { query: "jes", at: 25 },
    { query: "jor", at: 55 },
  ]);
  assert.deepEqual(aborted, ["jes"]);
  assert.deepEqual(trail(seen).slice(-3), [
    "30 waiting:jor",
    "55 searching:jor",
    "105 results:jor",
  ]);
  assert.equal(
    seen.some(({ name, query }) => name === "results" && query === "jes"),
    false,
  );
});

test("typing back to the query being searched keeps that search", () => {
  const { searched, aborted, seen } = play({
    typing: [
      [0, "jes"],
      [30, "jes "],
    ],
    latency: 50,
  });
  assert.deepEqual(
    searched.map(({ query }) => query),
    ["jes"],
  );
  assert.deepEqual(aborted, []);
  assert.equal(seen.at(-1).name, "results");
});

test("a reset while searching drops the answer, and the same query searches again", () => {
  const { searched, seen } = play({
    typing: [
      [0, "jes"],
      [100, "jes"],
    ],
    resets: [30],
    latency: 50,
  });
  assert.deepEqual(searched, [
    { query: "jes", at: 25 },
    { query: "jes", at: 125 },
  ]);
  assert.deepEqual(trail(seen), [
    "0 idle:",
    "0 waiting:jes",
    "25 searching:jes",
    "30 idle:",
    "100 waiting:jes",
    "125 searching:jes",
    "175 results:jes",
  ]);
});

test("a failed search shows as failed, and typing again retries", () => {
  const scheduler = new TestScheduler((actual, expected) => assert.deepEqual(actual, expected));
  const names = [];
  scheduler.run(({ cold, flush }) => {
    let calls = 0;
    const search = () =>
      ++calls === 1
        ? throwError(() => Object.assign(Error("Too many searches"), { status: 429 }))
        : of({ members: [] });
    const picker = createMemberSearch({ search, debounceMs: 25, scheduler });
    picker.state$.subscribe((state) => names.push(state.name));
    cold("0ms a").subscribe(() => picker.type(org, "jes"));
    cold("50ms a").subscribe(() => picker.type(org, "jes"));
    flush();
    picker.dispose();
  });
  assert.deepEqual(names, [
    "idle",
    "waiting",
    "searching",
    "failed",
    "waiting",
    "searching",
    "results",
  ]);
});

test("an outage fails one search and the next query recovers", () => {
  const scheduler = new TestScheduler((actual, expected) => assert.deepEqual(actual, expected));
  const names = [];
  let calls = 0;
  scheduler.run(({ cold, flush }) => {
    const search = () =>
      ++calls === 1
        ? throwError(() =>
            Object.assign(Error("unavailable"), {
              status: 503,
              code: "member_search_unavailable",
              retryable: true,
            }),
          )
        : of({ members: [] });
    const picker = createMemberSearch({ search, debounceMs: 25, scheduler });
    picker.state$.subscribe((state) => names.push(state.name));
    cold("0ms a").subscribe(() => picker.type(org, "jes"));
    cold("50ms a").subscribe(() => picker.type(org, "jess"));
    flush();
    picker.dispose();
  });
  assert.equal(calls, 2);
  assert.deepEqual(names, [
    "idle",
    "waiting",
    "searching",
    "failed",
    "waiting",
    "searching",
    "results",
  ]);
});

test("a deployment without organization search is final: typing afterwards searches nothing", () => {
  const scheduler = new TestScheduler((actual, expected) => assert.deepEqual(actual, expected));
  let calls = 0;
  let last;
  scheduler.run(({ cold, flush }) => {
    const search = () => {
      calls++;
      return throwError(() =>
        Object.assign(Error("unavailable"), { status: 404, code: "member_search_unavailable" }),
      );
    };
    const picker = createMemberSearch({ search, debounceMs: 25, scheduler });
    cold("0ms a").subscribe(() => picker.type(org, "jes"));
    cold("50ms a").subscribe(() => picker.type(org, "jordan"));
    flush();
    last = picker.getState();
    picker.dispose();
  });
  assert.equal(calls, 1);
  assert.deepEqual(last, { name: "unavailable" });
});

test("a 429 that names a wait holds searches; typing keeps the latest query", () => {
  const limited = memberSearchTransition(states.searching, {
    type: "failed",
    organizationId: org,
    query: "jes",
    error: { status: 429, retryAfterMs: 12_000 },
  });
  assert.deepEqual(limited, {
    name: "limited",
    organizationId: org,
    query: "jes",
    retryAfterMs: 12_000,
  });
  const typed = memberSearchTransition(limited, {
    type: "typed",
    organizationId: org,
    query: " jess ",
  });
  assert.deepEqual(typed, { ...limited, query: "jess" });
  assert.equal(
    memberSearchTransition(typed, { type: "started", organizationId: org, query: "jess" }),
    typed,
  );
  assert.deepEqual(memberSearchTransition(typed, { type: "resumed" }), {
    name: "idle",
    organizationId: org,
    query: "jess",
  });
  assert.deepEqual(memberSearchTransition(typed, { type: "reset" }), {
    ...typed,
    organizationId: null,
    query: "",
  });
  // Only a limited picker resumes.
  assert.equal(memberSearchTransition(states.results, { type: "resumed" }), states.results);
});

test("after the host's wait the latest query searches, and not before", () => {
  const scheduler = new TestScheduler((actual, expected) => assert.deepEqual(actual, expected));
  const searched = [];
  const seen = [];
  scheduler.run(({ cold, flush }) => {
    const search = ({ query }) => {
      searched.push({ query, at: scheduler.now() });
      return searched.length === 1
        ? throwError(() => Object.assign(Error("Too many"), { status: 429, retryAfterMs: 1000 }))
        : of({ members: [] });
    };
    const picker = createMemberSearch({ search, debounceMs: 25, scheduler });
    picker.state$.subscribe((state) =>
      seen.push(`${scheduler.now()} ${state.name}:${state.query}`),
    );
    cold("0ms a").subscribe(() => picker.type(org, "jes"));
    cold("100ms a").subscribe(() => picker.type(org, "jess"));
    flush();
    picker.dispose();
  });
  assert.deepEqual(searched, [
    { query: "jes", at: 25 },
    { query: "jess", at: 1050 },
  ]);
  assert.ok(seen.includes("25 limited:jes"));
  assert.ok(seen.includes("100 limited:jess"));
  assert.equal(seen.at(-1), "1050 results:jess");
});
