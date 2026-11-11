import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EVENTS,
  FINAL,
  STATES,
  attemptSpent,
  pageCreations,
  placementArguments,
  placementKey,
  replayAttempt,
  runPageCreation,
  start,
  transition,
} from "./page-create-machine.mjs";

const PRJ = "prj_one";
const attempt = { retry_token: "token", idempotency_key: "nonce1234" };
const receipt = { page_id: "new", project_id: PRJ };
const placement = { project_id: PRJ };
const at = (name, extra = {}) => ({ name, placement, attempt, ...extra });
const httpError = (status, code) => Object.assign(new Error(code), { status, code });

const SAMPLE = {
  prepared: { type: "prepared", attempt },
  written: { type: "written", receipt },
  opened: { type: "opened" },
  failed: { type: "failed", error: new Error("Nope") },
  cancel: { type: "cancel" },
};
// [next state, effect types] for every state × event.
const NEXT = {
  preparing: {
    prepared: ["writing", ["write"]],
    written: ["preparing", []],
    opened: ["preparing", []],
    failed: ["failed", []],
    cancel: ["cancelled", []],
  },
  writing: {
    prepared: ["writing", []],
    written: ["opening", ["open", "refresh"]],
    opened: ["writing", []],
    failed: ["failed", []],
    cancel: ["writingDetached", []],
  },
  writingDetached: {
    prepared: ["writingDetached", []],
    written: ["done", ["refresh"]],
    opened: ["writingDetached", []],
    failed: ["cancelled", []],
    cancel: ["writingDetached", []],
  },
  opening: {
    prepared: ["opening", []],
    written: ["opening", []],
    opened: ["done", []],
    failed: ["failed", []],
    cancel: ["done", []],
  },
  ...Object.fromEntries(
    FINAL.map((name) => [name, Object.fromEntries(EVENTS.map((event) => [event, [name, []]]))]),
  ),
};

test("every state × event lands where the table says", () => {
  assert.deepEqual(Object.keys(SAMPLE).sort(), [...EVENTS].sort());
  assert.deepEqual(Object.keys(NEXT).sort(), [...STATES].sort());
  for (const name of STATES)
    for (const event of EVENTS) {
      const [expected, effects] = NEXT[name][event];
      const state = at(name);
      const result = transition(state, SAMPLE[event]);
      const label = `${name} × ${event}`;
      assert.equal(result.state.name, expected, label);
      assert.deepEqual(
        result.effects.map((effect) => effect.type),
        effects,
        label,
      );
      if (expected === name && effects.length === 0)
        assert.equal(result.state, state, `${label} returns the same state`);
      // A failure keeps its attempt for the replay and its cause for the banner.
      if (event === "failed" && expected !== name) {
        assert.equal(result.state.attempt, attempt, label);
        assert.equal(result.state.cause, SAMPLE.failed.error, label);
      }
    }
});

test("a failure the server won't replay spends the attempt and refreshes the list", () => {
  for (const error of [httpError(410, "retry_expired"), httpError(409, "idempotency_conflict")])
    for (const name of ["writing", "writingDetached"]) {
      const result = transition(at(name), { type: "failed", error });
      assert.equal(result.state.attempt, null, `${name} × ${error.code}`);
      assert.deepEqual(
        result.effects.map((effect) => effect.type),
        ["refresh"],
      );
      assert.equal(replayAttempt(result.state), null);
    }
  assert.equal(attemptSpent(httpError(410, "retry_expired")), true);
  assert.equal(attemptSpent(httpError(410, "gone")), false);
  assert.equal(attemptSpent(httpError(409, "idempotency_conflict")), true);
  assert.equal(attemptSpent(new TypeError("Failed to fetch")), false);
});

test("start: every run prepares first; a replay carries its attempt", () => {
  assert.deepEqual(start(placement).effects, [{ type: "prepare", attempt: null }]);
  assert.equal(start(placement).state.name, "preparing");
  const replay = start({ parent_id: "p" }, attempt);
  assert.equal(replay.state.name, "preparing");
  assert.equal(replay.state.attempt, attempt);
  assert.deepEqual(replay.effects, [{ type: "prepare", attempt }]);
  // A cancel before a replayed write ends the run with nothing written.
  assert.equal(transition(replay.state, SAMPLE.cancel).state.name, "cancelled");
  assert.throws(() => start({}), /Project or a parent/);
  assert.deepEqual(placementArguments({ parent_id: "p", project_id: PRJ }), { parent_id: "p" });
  assert.deepEqual(placementArguments(placement), { project_id: PRJ });
  assert.equal(placementKey({ parent_id: "p", project_id: PRJ }), "parent:p");
  assert.equal(placementKey(placement), `project:${PRJ}`);
  // A failed step carries an Error even when it threw something else.
  const cause = transition(at("writing"), { type: "failed", error: "?" }).state.cause;
  assert.ok(cause instanceof Error);
  assert.match(cause.message, /Couldn't create/);
  // The write carries the placement and the prepared attempt.
  assert.deepEqual(transition(at("preparing", { attempt: null }), SAMPLE.prepared).effects, [
    { type: "write", placement, attempt },
  ]);
});

/** A fake world for runPageCreation. */
function fake({ fail = {}, onCall } = {}) {
  const calls = [];
  const opened = [];
  let refreshed = 0;
  const call = async (operation, args) => {
    calls.push([operation, args]);
    await onCall?.(operation);
    const failure = typeof fail[operation] === "function" ? fail[operation]() : fail[operation];
    if (failure) throw failure instanceof Error ? failure : new Error(failure);
    if (operation === "list_pages") return { retry_token: "token" };
    if (operation === "create_page") return { page_id: "new", project_id: args.project_id };
    throw new Error(operation);
  };
  return {
    calls,
    opened,
    refreshed: () => refreshed,
    call,
    open: async (pageId) => {
      if (fail.open) throw new Error(fail.open);
      opened.push(pageId);
    },
    refresh: async () => {
      refreshed++;
    },
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve));

test("runPageCreation writes the placement once and opens the new Page", async () => {
  const world = fake();
  const state = await runPageCreation({ placement, current: () => true, ...world });
  await settle();
  assert.equal(state.name, "done");
  assert.deepEqual(
    world.calls.map(([operation]) => operation),
    ["list_pages", "create_page"],
  );
  const args = world.calls[1][1];
  assert.equal(args.project_id, PRJ);
  assert.equal(args.retry_token, "token");
  assert.match(
    args.idempotency_key,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  assert.deepEqual(world.opened, ["new"]);
  assert.equal(world.refreshed(), 1);
});

test("runPageCreation: a navigation before the write writes nothing", async () => {
  let live = true;
  const world = fake({
    onCall: (operation) => {
      if (operation === "list_pages") live = false;
    },
  });
  const state = await runPageCreation({ placement, current: () => live, ...world });
  assert.equal(state.name, "cancelled");
  assert.deepEqual(
    world.calls.map(([operation]) => operation),
    ["list_pages"],
  );
  assert.deepEqual(world.opened, []);
});

test("runPageCreation: a navigation during the write lands the Page without opening it", async () => {
  let live = true;
  const world = fake({
    onCall: (operation) => {
      if (operation === "create_page") live = false;
    },
  });
  const state = await runPageCreation({ placement, current: () => live, ...world });
  await settle();
  assert.equal(state.name, "done");
  assert.equal(state.receipt.page_id, "new");
  assert.deepEqual(world.opened, []);
  assert.equal(world.refreshed(), 1);
});

test("runPageCreation: a failed write keeps its attempt, and the retry replays it", async () => {
  const failing = fake({ fail: { create_page: "offline" } });
  const failed = await runPageCreation({ placement, current: () => true, ...failing });
  assert.equal(failed.name, "failed");
  assert.equal(failed.cause.message, "offline");
  assert.ok(failed.attempt.idempotency_key);
  const world = fake();
  const state = await runPageCreation({
    placement,
    attempt: failed.attempt,
    current: () => true,
    ...world,
  });
  assert.equal(state.name, "done");
  assert.deepEqual(
    world.calls.map(([operation]) => operation),
    ["create_page"],
  );
  assert.equal(world.calls[0][1].idempotency_key, failed.attempt.idempotency_key);
  // A failed listing leaves no attempt to replay.
  const unlisted = await runPageCreation({
    placement,
    current: () => true,
    ...fake({ fail: { list_pages: "down" } }),
  });
  assert.equal(unlisted.name, "failed");
  assert.equal(unlisted.attempt, null);
  // A failed open keeps the attempt: the replay answers with the same Page.
  const unopened = await runPageCreation({
    placement: { parent_id: "p" },
    current: () => true,
    ...fake({ fail: { open: "closed" } }),
  });
  assert.equal(unopened.name, "failed");
  assert.ok(unopened.attempt);
});

test("runPageCreation: a navigation before a replayed write writes nothing", async () => {
  const world = fake();
  const state = await runPageCreation({ placement, attempt, current: () => false, ...world });
  assert.equal(state.name, "cancelled");
  assert.deepEqual(world.calls, []);
  assert.deepEqual(world.opened, []);
  assert.equal(replayAttempt(state), attempt, "the next try still replays it");
});

test("replayAttempt: only a run that reached done starts the next try fresh", () => {
  for (const name of STATES)
    assert.equal(replayAttempt(at(name)), name === "done" ? null : attempt, name);
  assert.equal(replayAttempt(at("failed", { attempt: null })), null);
});

test("runPageCreation: a write that fails after a cancel detached it is replayed", async () => {
  let live = true;
  const failing = fake({
    fail: { create_page: "lost" },
    onCall: (operation) => {
      if (operation === "create_page") live = false;
    },
  });
  const lost = await runPageCreation({ placement, current: () => live, ...failing });
  assert.equal(lost.name, "cancelled");
  assert.equal(lost.cause.message, "lost", "the cause is kept, but the run ends quietly");
  const sent = failing.calls.find(([operation]) => operation === "create_page")[1];
  const retry = fake();
  const state = await runPageCreation({
    placement,
    attempt: replayAttempt(lost),
    current: () => true,
    ...retry,
  });
  assert.equal(state.name, "done");
  assert.deepEqual(
    retry.calls.map(([operation, args]) => [operation, args.idempotency_key]),
    [["create_page", sent.idempotency_key]],
    "the retry sends the lost request again, without a new listing",
  );
});

/** A world for pageCreations: every create_page is recorded with its key,
 * and `lose` makes the next ones land on the server but lose their answer. */
function server() {
  const sent = [];
  const landed = new Map();
  let listed = 0;
  let lose = 0;
  let refuse = null;
  const call = async (operation, args) => {
    await Promise.resolve();
    if (operation === "list_pages") return { retry_token: `token-${++listed}` };
    sent.push([placementKey(args), args.idempotency_key]);
    if (refuse) throw refuse;
    if (!landed.has(args.idempotency_key))
      landed.set(args.idempotency_key, `page-${landed.size + 1}`);
    if (lose > 0) {
      lose--;
      throw new TypeError("Failed to fetch");
    }
    return { page_id: landed.get(args.idempotency_key) };
  };
  return {
    sent,
    landed,
    lose: (count = 1) => (lose = count),
    refuse: (error) => (refuse = error),
    deps: { call, open: async () => {}, refresh: async () => {}, current: () => true },
  };
}
const A = { parent_id: "a" };
const B = { project_id: PRJ };

test("pageCreations: two concurrent calls send one create_page", async () => {
  const world = server();
  const creations = pageCreations();
  const [first, second] = await Promise.all([
    creations.create({ principal: "alice", placement: A, ...world.deps }),
    creations.create({ principal: "alice", placement: A, ...world.deps }),
  ]);
  assert.equal(first.name, "done");
  assert.equal(second, null, "the second call found one pending");
  assert.equal(world.sent.length, 1);
  assert.equal(world.landed.size, 1);
  // A draft in Your items shares the guard.
  let drafts = 0;
  const [draft, placed] = await Promise.all([
    creations.exclusive(async () => drafts++),
    creations.create({ principal: "alice", placement: A, ...world.deps }),
  ]);
  assert.equal(draft.busy, false);
  assert.equal(placed, null);
  assert.equal(drafts, 1);
  assert.equal(creations.pending, false);
});

test("pageCreations: A, then B, then a retry of A replays A's key", async () => {
  const world = server();
  const creations = pageCreations();
  world.lose();
  const lost = await creations.create({ principal: "alice", placement: A, ...world.deps });
  assert.equal(lost.name, "failed");
  const [[, aKey]] = world.sent;
  assert.equal(creations.attempt("alice", A).idempotency_key, aKey);
  assert.equal(
    (await creations.create({ principal: "alice", placement: B, ...world.deps })).name,
    "done",
  );
  assert.equal(creations.attempt("alice", A).idempotency_key, aKey, "B leaves A's attempt");
  assert.equal(creations.attempt("alice", B), null, "a done run keeps nothing");
  const retried = await creations.create({ principal: "alice", placement: A, ...world.deps });
  assert.equal(retried.name, "done");
  assert.deepEqual(world.sent.at(-1), ["parent:a", aKey]);
  assert.equal(world.landed.size, 2, "A landed once, B once");
  assert.equal(creations.attempt("alice", A), null);
});

test("pageCreations: an account change clears attempts", async () => {
  const world = server();
  const creations = pageCreations();
  world.lose();
  await creations.create({ principal: "alice", placement: A, ...world.deps });
  assert.ok(creations.attempt("alice", A));
  creations.account("alice");
  assert.ok(creations.attempt("alice", A), "the same account keeps them");
  creations.account("bob");
  assert.equal(creations.attempt("alice", A), null);
  creations.account("alice");
  assert.equal(creations.attempt("alice", A), null, "switching back starts fresh");
  world.lose();
  await creations.create({ principal: "alice", placement: A, ...world.deps });
  creations.account(null);
  assert.equal(creations.attempt("alice", A), null, "sign-out clears them");
  // A run that ends after the account changed keeps nothing for anyone.
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const slow = pageCreations({
    run: async () => {
      await gate;
      return { name: "failed", placement: A, attempt };
    },
  });
  const running = slow.create({ principal: "alice", placement: A, ...world.deps });
  slow.account("bob");
  release();
  await running;
  assert.equal(slow.attempt("alice", A), null);
  assert.equal(slow.attempt("bob", A), null);
  // A different principal on create() clears the earlier account's attempts too.
  world.lose();
  await creations.create({ principal: "alice", placement: A, ...world.deps });
  await creations.create({ principal: "bob", placement: B, ...world.deps });
  assert.equal(creations.attempt("alice", A), null);
});

test("pageCreations: a 410 drops the attempt and refreshes; the next try starts fresh", async () => {
  const world = server();
  let refreshed = 0;
  const deps = { ...world.deps, refresh: async () => refreshed++ };
  const creations = pageCreations();
  world.lose();
  await creations.create({ principal: "alice", placement: A, ...deps });
  const [[, lostKey]] = world.sent;
  world.refuse(httpError(410, "retry_expired"));
  const expired = await creations.create({ principal: "alice", placement: A, ...deps });
  await settle();
  assert.equal(expired.name, "failed");
  assert.equal(expired.cause.code, "retry_expired");
  assert.deepEqual(world.sent.at(-1), ["parent:a", lostKey], "it replayed once");
  assert.equal(creations.attempt("alice", A), null, "and dropped the attempt");
  assert.equal(refreshed, 1, "the list refreshes to show a Page that landed");
  world.refuse(null);
  const fresh = await creations.create({ principal: "alice", placement: A, ...deps });
  assert.equal(fresh.name, "done");
  assert.notEqual(world.sent.at(-1)[1], lostKey, "a new request, with a new key");
});
