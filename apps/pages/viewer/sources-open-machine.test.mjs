// The sources-open table over every state and event, run through the pure
// machine. Its interpreter (sources-replica.mjs) and PageSession's use of it
// are covered in sources-replica.test.mjs and session-sources.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { runTable } from "../shared/machine-test.mjs";
import { parseDocumentDescriptor } from "../model/document-types.mjs";
import {
  OPEN_ATTEMPTS,
  REJECT,
  discoveryEvent,
  retryDelay,
  sourcesOpenMachine,
} from "./sources-open-machine.mjs";

const S1 = "s1";
const S2 = "s2";
const closed = { name: "closed" };
const absent = { name: "absent" };
const unserved = { name: "unserved" };
const unreadable = { name: "unreadable" };
const retired = { name: "retired" };
const opening = (attempt, id = S1) => ({ name: "opening", attempt, id });
const retrying = (attempt, id = S1) => ({ name: "retrying", attempt, id });
const failed = { name: "failed", attempt: OPEN_ATTEMPTS, id: S1 };
const ready = (id = S1) => ({ name: "ready", id });

const named = (id = S1) => ({ type: "discovered", answer: "named", id });
const answer = (kind) => ({ type: "discovered", answer: kind });
const settled = (type, attempt = 2) => ({ type, attempt });
const retire = { type: "retire" };
const close = { type: "close" };

const lookup = (attempt, id = S1) => ({ type: "lookup", attempt, id });
const cancel = (attempt) => ({ type: "cancel", attempt });
const clearTimer = { type: "clearTimer" };
const uninstall = { type: "uninstall" };

const go = (state, effects = []) => ({ state, effects });
const no = (state, rejected) => ({ state, effects: [], rejected });
const row = (label, state, event, expect, kase) => ({
  label,
  state,
  event,
  expect,
  ...(kase && { case: kase }),
});

/** Results and timers for a lookup no state but `opening` and `retrying`
 * runs: every one is a cancelled lookup's late answer. */
const lateAnswers = (state) =>
  ["opened", "lookupFailed", "unknown", "timer"].map((type) =>
    row(`${state.name}: a late ${type} is ignored`, state, settled(type), no(state, REJECT.stale)),
  );

/** A state that holds no lookup, timer or handle, through every event. */
function quiet(state, { none, unaware, unreadable: unread, close: closing }) {
  return [
    row(
      `${state.name}: discovery names the document`,
      state,
      named(),
      go(opening(1), [lookup(1)]),
      "named",
    ),
    row(`${state.name}: discovery names none`, state, answer("none"), none, "none"),
    row(`${state.name}: an older host`, state, answer("unaware"), unaware, "unaware"),
    row(`${state.name}: an unreadable format`, state, answer("unreadable"), unread, "unreadable"),
    ...lateAnswers(state),
    row(`${state.name}: retire`, state, retire, go(retired)),
    row(`${state.name}: close`, state, close, closing),
  ];
}

/** A state that holds something to stop, through a discovery that leaves it. */
function leaving(state, stop, sameRow) {
  return [
    sameRow,
    row(
      `${state.name}: discovery names another document`,
      state,
      named(S2),
      go(opening(1, S2), [...stop, lookup(1, S2)]),
      "other",
    ),
    row(`${state.name}: discovery names none`, state, answer("none"), go(absent, stop), "none"),
    row(`${state.name}: an older host`, state, answer("unaware"), go(unserved, stop), "unaware"),
    row(
      `${state.name}: an unreadable format`,
      state,
      answer("unreadable"),
      go(unreadable, stop),
      "unreadable",
    ),
    row(`${state.name}: retire`, state, retire, go(retired, stop)),
    row(`${state.name}: close`, state, close, go(closed, stop)),
  ];
}

const ROWS = [
  ...quiet(closed, {
    none: go(absent),
    unaware: go(unserved),
    unreadable: go(unreadable),
    close: no(closed, REJECT.closed),
  }),
  ...quiet(absent, {
    none: no(absent, REJECT.same),
    unaware: go(unserved),
    unreadable: go(unreadable),
    close: go(closed),
  }),
  ...quiet(unserved, {
    none: go(absent),
    unaware: no(unserved, REJECT.same),
    unreadable: go(unreadable),
    close: go(closed),
  }),
  ...quiet(unreadable, {
    none: go(absent),
    unaware: go(unserved),
    unreadable: no(unreadable, REJECT.same),
    close: go(closed),
  }),
  ...quiet(failed, {
    none: go(absent),
    unaware: go(unserved),
    unreadable: go(unreadable),
    close: go(closed),
  }),

  // A lookup is running.
  ...leaving(
    opening(2),
    [cancel(2)],
    row(
      "opening: a new connection restarts the lookup on it",
      opening(2),
      named(),
      go(opening(1), [cancel(2), lookup(1)]),
      "same",
    ),
  ),
  row(
    "opening: the lookup found it",
    opening(2),
    settled("opened"),
    go(ready(), [{ type: "install", attempt: 2 }]),
    "current",
  ),
  row(
    "opening: a cancelled lookup's handle",
    opening(2),
    settled("opened", 1),
    no(opening(2), REJECT.stale),
    "stale",
  ),
  row(
    "opening: a failed lookup waits to retry",
    opening(2),
    settled("lookupFailed"),
    go(retrying(2), [{ type: "schedule", attempt: 2, delay: retryDelay(2) }]),
    "retry",
  ),
  row(
    "opening: the last failed lookup gives up",
    opening(OPEN_ATTEMPTS),
    settled("lookupFailed", OPEN_ATTEMPTS),
    go({ name: "failed", attempt: OPEN_ATTEMPTS, id: S1 }),
    "exhausted",
  ),
  row(
    "opening: a cancelled lookup's failure",
    opening(2),
    settled("lookupFailed", 1),
    no(opening(2), REJECT.stale),
    "stale",
  ),
  row(
    "opening: an older host answers it holds no such document",
    opening(2),
    settled("unknown"),
    go({ name: "unserved", id: S1 }),
    "current",
  ),
  row(
    "opening: a cancelled lookup's unknown answer",
    opening(2),
    settled("unknown", 1),
    no(opening(2), REJECT.stale),
    "stale",
  ),
  row("opening: no timer is armed", opening(2), settled("timer"), no(opening(2), REJECT.stale)),

  // A retry is waiting.
  ...leaving(
    retrying(2),
    [clearTimer],
    row(
      "retrying: a new connection retries at once",
      retrying(2),
      named(),
      go(opening(1), [clearTimer, lookup(1)]),
      "same",
    ),
  ),
  row(
    "retrying: the timer starts the next lookup",
    retrying(2),
    settled("timer"),
    go(opening(3), [lookup(3)]),
    "current",
  ),
  row(
    "retrying: a cleared timer fires late",
    retrying(2),
    settled("timer", 1),
    no(retrying(2), REJECT.stale),
    "stale",
  ),
  ...["opened", "lookupFailed", "unknown"].map((type) =>
    row(
      `retrying: a late ${type} is ignored`,
      retrying(2),
      settled(type),
      no(retrying(2), REJECT.stale),
    ),
  ),

  // The document is open.
  ...leaving(
    ready(),
    [uninstall],
    row(
      "ready: a reconnect keeps the open document",
      ready(),
      named(),
      no(ready(), REJECT.ready),
      "same",
    ),
  ),
  ...lateAnswers(ready()),

  // Retired: nothing opens again.
  row("retired: a discovery opens nothing", retired, named(), no(retired, REJECT.retired)),
  ...lateAnswers(retired),
  row("retired: retire again", retired, retire, no(retired, REJECT.retired)),
  row("retired: close", retired, close, no(retired, REJECT.retired)),
];

test("the sources-open table covers every state and event", async () => {
  assert.deepEqual(await runTable(sourcesOpenMachine, ROWS), {
    rows: ROWS.length,
    pairs: 63,
    unreachable: 0,
    cases: 44,
  });
});

test("the table's effects only find, wait, adopt and drop: none writes the document", () => {
  const effects = ROWS.flatMap((r) => r.expect.effects);
  assert.deepEqual([...new Set(effects.map((effect) => effect.type))].sort(), [
    "cancel",
    "clearTimer",
    "install",
    "lookup",
    "schedule",
    "uninstall",
  ]);
});

test("retries back off as the comments document's do, then stop at the attempt limit", () => {
  let { state } = sourcesOpenMachine.step(sourcesOpenMachine.initial, named());
  for (let attempt = 1; attempt < OPEN_ATTEMPTS; attempt++) {
    const failedOnce = sourcesOpenMachine.step(state, settled("lookupFailed", attempt));
    assert.deepEqual(failedOnce.effects, [
      { type: "schedule", attempt, delay: retryDelay(attempt) },
    ]);
    ({ state } = sourcesOpenMachine.step(failedOnce.state, settled("timer", attempt)));
  }
  ({ state } = sourcesOpenMachine.step(state, settled("lookupFailed", OPEN_ATTEMPTS)));
  assert.deepEqual(state, failed);
});

test("a discovery answer becomes one event", () => {
  const descriptor = (format = 1, type = "pages.sources") => ({ id: "abc", type, format });
  const event = (connection) => discoveryEvent(connection, parseDocumentDescriptor);
  const page = { id: "p", type: "pages.page", format: 3 };
  assert.deepEqual(event({ documents: { page, sources: descriptor() } }), named("abc"));
  assert.deepEqual(event({ documents: { page } }), answer("none"));
  // An older host's discovery carries no document map.
  assert.deepEqual(event({ documentId: "p" }), answer("unaware"));
  assert.deepEqual(event({ documents: [] }), answer("unaware"));
  assert.deepEqual(event({ documents: { page, sources: descriptor(2) } }), answer("unreadable"));
  assert.deepEqual(
    event({ documents: { page, sources: descriptor(3, "pages.page") } }),
    answer("unreadable"),
  );
  assert.deepEqual(event({ documents: { page, sources: null } }), answer("unreadable"));
});
