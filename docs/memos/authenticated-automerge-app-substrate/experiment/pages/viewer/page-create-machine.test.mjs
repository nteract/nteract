import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EVENTS,
  FINAL,
  STATES,
  placementArguments,
  replayAttempt,
  runPageCreation,
  start,
  transition,
} from "./page-create-machine.mjs";

const PRJ = "prj_one";
const attempt = { retry_token: "token", idempotency_key: "v1_abc_nonce1234" };
const receipt = { page_id: "new", project_id: PRJ };
const placement = { project_id: PRJ };
const at = (name, extra = {}) => ({ name, placement, attempt, detached: false, ...extra });

const SAMPLE = {
  prepared: { type: "prepared", attempt },
  written: { type: "written", receipt },
  opened: { type: "opened" },
  failed: { type: "failed", message: "Nope" },
  cancel: { type: "cancel" },
};
// [next state, effect types] for every state × event, attached and detached.
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
    cancel: ["writing", []],
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
// A detached run (cancelled while its write was in flight) differs here.
const DETACHED = {
  writing: { written: ["done", ["refresh"]], failed: ["cancelled", []] },
  preparing: { failed: ["cancelled", []] },
  opening: { failed: ["cancelled", []] },
};

test("every state × event lands where the table says", () => {
  assert.deepEqual(Object.keys(SAMPLE).sort(), [...EVENTS].sort());
  assert.deepEqual(Object.keys(NEXT).sort(), [...STATES].sort());
  for (const name of STATES)
    for (const event of EVENTS)
      for (const detached of [false, true]) {
        const [expected, effects] = (detached && DETACHED[name]?.[event]) || NEXT[name][event];
        const state = at(name, { detached });
        const result = transition(state, SAMPLE[event]);
        const label = `${name}${detached ? " (detached)" : ""} × ${event}`;
        assert.equal(result.state.name, expected, label);
        assert.deepEqual(
          result.effects.map((effect) => effect.type),
          effects,
          label,
        );
        if (
          expected === name &&
          effects.length === 0 &&
          !(name === "writing" && event === "cancel")
        )
          assert.equal(result.state, state, `${label} returns the same state`);
      }
});

test("cancel during the write detaches the run instead of ending it", () => {
  const writing = at("writing");
  const detached = transition(writing, SAMPLE.cancel).state;
  assert.equal(detached.detached, true);
  assert.equal(transition(detached, SAMPLE.cancel).state, detached, "a second cancel is a no-op");
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
  // A failed step says something even without a message.
  assert.match(transition(at("writing"), { type: "failed" }).state.error, /Couldn't create/);
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
    if (fail[operation]) throw new Error(fail[operation]);
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
  assert.match(args.idempotency_key, /^v1_/);
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
  assert.equal(state.detached, true);
  assert.deepEqual(world.opened, []);
  assert.equal(world.refreshed(), 1);
});

test("runPageCreation: a failed write keeps its attempt, and the retry replays it", async () => {
  const failing = fake({ fail: { create_page: "offline" } });
  const failed = await runPageCreation({ placement, current: () => true, ...failing });
  assert.equal(failed.name, "failed");
  assert.equal(failed.error, "offline");
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
  assert.equal(lost.error, undefined, "a detached run shows no error");
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
