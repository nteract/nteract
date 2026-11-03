// The shared list_projects request: every state × event through the pure
// machine, then ProjectList's interpretation of it.
import test from "node:test";
import assert from "node:assert/strict";
import { runTable } from "../shared/machine-test.mjs";
import { ProjectList, REJECT, projectListMachine } from "./project-list.mjs";

const idle = { name: "idle" };
const loading = (principal = "alice", key = "k1") => ({ name: "loading", principal, key });
const ready = (principal = "alice") => ({ name: "ready", principal });
const refreshing = (principal = "alice", key = "k1") => ({ name: "refreshing", principal, key });
const request = (principal = "alice", key = "k2", fresh = false) => ({
  type: "request",
  principal,
  key,
  fresh,
});
const fetch = (key) => ({ type: "fetch", key });
const rejected = (state, reason) => ({ state, effects: [], rejected: reason });

const ROWS = [
  {
    label: "the first request for an account asks list_projects",
    state: idle,
    event: request("alice", "k1"),
    expect: { state: loading("alice", "k1"), effects: [fetch("k1")] },
  },
  {
    label: "another screen's request joins the one in flight",
    case: "join",
    state: loading(),
    event: request(),
    expect: rejected(loading(), REJECT.joined),
  },
  {
    label: "a create this tab made asks again rather than trust the request in flight",
    case: "fresh",
    state: loading(),
    event: request("alice", "k2", true),
    expect: { state: loading("alice", "k2"), effects: [fetch("k2")] },
  },
  {
    label: "another account's request starts over",
    case: "account",
    state: loading(),
    event: request("bob", "k2"),
    expect: { state: loading("bob", "k2"), effects: [{ type: "clear" }, fetch("k2")] },
  },
  {
    label: "a later visit lists again with the Projects still shown",
    case: "same",
    state: ready(),
    event: request(),
    expect: { state: refreshing("alice", "k2"), effects: [fetch("k2")] },
  },
  {
    label: "another account never sees the Projects listed",
    case: "account",
    state: ready(),
    event: request("bob", "k2"),
    expect: { state: loading("bob", "k2"), effects: [{ type: "clear" }, fetch("k2")] },
  },
  {
    label: "a request during a refresh joins it",
    case: "join",
    state: refreshing(),
    event: request(),
    expect: rejected(refreshing(), REJECT.joined),
  },
  {
    label: "a move this tab made supersedes the refresh in flight",
    case: "fresh",
    state: refreshing(),
    event: request("alice", "k2", true),
    expect: { state: refreshing("alice", "k2"), effects: [fetch("k2")] },
  },
  {
    label: "another account during a refresh starts over",
    case: "account",
    state: refreshing(),
    event: request("bob", "k2"),
    expect: { state: loading("bob", "k2"), effects: [{ type: "clear" }, fetch("k2")] },
  },
  {
    label: "nothing answers before a request",
    state: idle,
    event: { type: "loaded", key: "k1" },
    expect: rejected(idle, REJECT.idle),
  },
  {
    label: "the first answer shows",
    case: "current",
    state: loading(),
    event: { type: "loaded", key: "k1" },
    expect: { state: ready(), effects: [{ type: "show", key: "k1" }] },
  },
  {
    label: "a superseded answer never shows",
    case: "stale",
    state: loading("alice", "k2"),
    event: { type: "loaded", key: "k1" },
    expect: rejected(loading("alice", "k2"), REJECT.stale),
  },
  {
    label: "an answer after the last one settled is ignored",
    state: ready(),
    event: { type: "loaded", key: "k1" },
    expect: rejected(ready(), REJECT.idle),
  },
  {
    label: "a refresh's answer replaces the Projects",
    case: "current",
    state: refreshing(),
    event: { type: "loaded", key: "k1" },
    expect: { state: ready(), effects: [{ type: "show", key: "k1" }] },
  },
  {
    label: "a superseded refresh never shows",
    case: "stale",
    state: refreshing("alice", "k2"),
    event: { type: "loaded", key: "k1" },
    expect: rejected(refreshing("alice", "k2"), REJECT.stale),
  },
  {
    label: "a failure before any request is ignored",
    state: idle,
    event: { type: "failed", key: "k1" },
    expect: rejected(idle, REJECT.idle),
  },
  {
    label: "a failed first request knows nothing",
    case: "current",
    state: loading(),
    event: { type: "failed", key: "k1" },
    expect: { state: idle, effects: [] },
  },
  {
    label: "a superseded first request's failure changes nothing",
    case: "stale",
    state: loading("alice", "k2"),
    event: { type: "failed", key: "k1" },
    expect: rejected(loading("alice", "k2"), REJECT.stale),
  },
  {
    label: "a failure after the last answer is ignored",
    state: ready(),
    event: { type: "failed", key: "k1" },
    expect: rejected(ready(), REJECT.idle),
  },
  {
    label: "a failed refresh keeps the Projects listed",
    case: "current",
    state: refreshing(),
    event: { type: "failed", key: "k1" },
    expect: { state: ready(), effects: [] },
  },
  {
    label: "a superseded refresh's failure changes nothing",
    case: "stale",
    state: refreshing("alice", "k2"),
    event: { type: "failed", key: "k1" },
    expect: rejected(refreshing("alice", "k2"), REJECT.stale),
  },
  ...[idle, loading(), ready(), refreshing()].map((state) => ({
    label: `signing out from ${state.name} forgets the Projects`,
    state,
    event: { type: "reset" },
    expect: { state: idle, effects: [{ type: "clear" }] },
  })),
];

test("the project-list table covers every state and event", async () => {
  assert.deepEqual(await runTable(projectListMachine, ROWS), {
    rows: 25,
    pairs: 16,
    unreachable: 0,
    cases: 16,
  });
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => ((resolve = yes), (reject = no)));
  return { promise, resolve, reject };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const calls = [];
  let n = 0;
  const list = new ProjectList({
    call: (operation, args) => {
      const reply = deferred();
      calls.push({ operation, args, ...reply });
      return reply.promise;
    },
    newKey: () => `k${++n}`,
  });
  return { list, calls, shown: () => list.store.snapshot() };
}

test("screens asking at once share one list_projects request", async () => {
  const { list, calls, shown } = harness();
  const filter = list.request("alice");
  const projectsView = list.request("alice");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { limit: 100 });
  assert.equal(filter, projectsView, "both wait on the same answer");
  assert.equal(shown().ready, false);
  calls[0].resolve({ projects: [{ project_id: "p1" }], next_cursor: null, principal: "alice" });
  assert.deepEqual((await filter).projects, [{ project_id: "p1" }]);
  await settle();
  assert.deepEqual(shown(), { principal: "alice", projects: [{ project_id: "p1" }], ready: true });
  // A later visit asks again; the Projects stay while it does.
  list.request("alice");
  assert.equal(calls.length, 2);
  assert.equal(shown().projects.length, 1);
});

test("a fresh request supersedes the one in flight, whose answer never shows", async () => {
  const { list, calls, shown } = harness();
  list.request("alice");
  const fresh = list.request("alice", { fresh: true });
  assert.equal(calls.length, 2);
  calls[1].resolve({ projects: [{ project_id: "new" }], principal: "alice" });
  await fresh;
  await settle();
  calls[0].resolve({ projects: [{ project_id: "old" }], principal: "alice" });
  await settle();
  assert.deepEqual(shown().projects, [{ project_id: "new" }]);
});

test("another account's Projects never show for this one", async () => {
  const { list, calls, shown } = harness();
  list.request("alice");
  calls[0].resolve({ projects: [{ project_id: "hers" }], principal: "alice" });
  await settle();
  list.request("bob");
  assert.deepEqual(shown(), { principal: null, projects: [], ready: false }, "cleared at once");
  list.reset();
  calls[1].resolve({ projects: [{ project_id: "his" }], principal: "bob" });
  await settle();
  assert.equal(shown().ready, false, "a reply after sign-out shows nothing");
  assert.equal(list.state.name, "idle");
});

test("a failed refresh keeps what was listed; a failed first request can be retried", async () => {
  const { list, calls, shown } = harness();
  const first = list.request("alice");
  calls[0].reject(new TypeError("Failed to fetch"));
  await assert.rejects(first, TypeError);
  await settle();
  assert.equal(list.state.name, "idle");
  list.request("alice");
  calls[1].resolve({ projects: [{ project_id: "p1" }], principal: "alice" });
  await settle();
  const again = list.request("alice");
  calls[2].reject(new TypeError("Failed to fetch"));
  await assert.rejects(again, TypeError);
  await settle();
  assert.deepEqual(shown().projects, [{ project_id: "p1" }]);
  assert.equal(list.state.name, "ready");
  await assert.rejects(list.request(null), /Sign in/);
});

test("an answer for another account never shows as this one's Projects", async () => {
  const { list, calls, shown } = harness();
  list.request("alice");
  // Another window signed in as Bob, and the cookie followed.
  calls[0].resolve({ projects: [{ project_id: "his" }], principal: "bob" });
  await settle();
  assert.deepEqual(shown(), { principal: null, projects: [], ready: false });
  assert.equal(list.state.name, "idle");
  // An answer that names no account (an older API) shows, as the library
  // listing shows one; it isn't kept past the next request.
  list.request("alice");
  calls[1].resolve({ projects: [{ project_id: "anon" }] });
  await settle();
  assert.deepEqual(shown(), {
    principal: "alice",
    projects: [{ project_id: "anon" }],
    ready: true,
  });
  list.request("alice");
  calls[2].resolve({ projects: [{ project_id: "hers" }], principal: "alice" });
  await settle();
  assert.deepEqual(shown(), {
    principal: "alice",
    projects: [{ project_id: "hers" }],
    ready: true,
  });
  // A refresh answered for Bob keeps what Alice was shown.
  list.request("alice");
  calls[3].resolve({ projects: [{ project_id: "his" }], principal: "bob" });
  await settle();
  assert.deepEqual(shown().projects, [{ project_id: "hers" }]);
});
