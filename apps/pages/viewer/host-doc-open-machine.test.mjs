// The host-doc-open table over every state and event, run through the pure
// machine. Its interpreter (host-doc-replica.mjs) and PageSession's use of it
// are covered in host-doc-replica.test.mjs, view-replicas.test.mjs and
// session-sources.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { runTable } from "../shared/machine-test.mjs";
import { parseDocumentDescriptor } from "../model/document-types.mjs";
import {
  MISSING_ATTEMPTS,
  OPEN_ATTEMPTS,
  REJECT,
  discoveryEvent,
  hostDocOpenMachine,
  lookAgainDelay,
  retryDelay,
} from "./host-doc-open-machine.mjs";

const S1 = "s1";
const S2 = "s2";
const closed = { name: "closed" };
const absent = { name: "absent" };
const missed = { name: "absent", id: S1, misses: 1 };
const cooling = { name: "absent", id: S1, misses: 1, cooling: true };
const asked = { name: "absent", id: S1, misses: 1, cooling: true, asked: true };
const unserved = { name: "unserved" };
const unreadable = { name: "unreadable" };
const retired = { name: "retired" };
const opening = (attempt, id = S1, via = "named", misses) => ({
  name: "opening",
  attempt,
  id,
  via,
  ...(misses && { misses }),
});
const retrying = (attempt, id = S1, via = "named") => ({ name: "retrying", attempt, id, via });
const failed = { name: "failed", attempt: OPEN_ATTEMPTS, id: S1, via: "named" };
const ready = (id = S1) => ({ name: "ready", id });

const named = (id = S1) => ({ type: "discovered", answer: "named", id });
const derived = (id = S1) => ({ type: "discovered", answer: "derived", id });
const answer = (kind) => ({ type: "discovered", answer: kind });
const wanted = (id = S1) => ({ type: "wanted", id });
const settled = (type, attempt = 2) => ({ type, attempt });
const cooled = { type: "cooled" };
const retire = { type: "retire" };
const close = { type: "close" };

const lookup = (attempt, id = S1) => ({ type: "lookup", attempt, id });
const cancel = (attempt) => ({ type: "cancel", attempt });
const clearTimer = { type: "clearTimer" };
const uninstall = { type: "uninstall" };
const forget = (id = S1) => ({ type: "forget", id });

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
const lateCooled = (state) =>
  row(
    `${state.name}: a cleared look-again timer fires late`,
    state,
    cooled,
    no(state, REJECT.stale),
    state.name === "absent" ? "stale" : undefined,
  );

/** A state that holds no lookup or handle, through the discoveries. */
const discoveries = (state, { none, unaware, unreadable: unread }) => [
  row(
    `${state.name}: discovery names the document`,
    state,
    named(),
    go(opening(1), [...(state.cooling ? [clearTimer] : []), lookup(1)]),
    "named",
  ),
  row(
    `${state.name}: a connection that finds it by its derived id`,
    state,
    derived(),
    go(opening(1, S1, "derived"), [...(state.cooling ? [clearTimer] : []), lookup(1)]),
    "derived",
  ),
  row(`${state.name}: an older host`, state, answer("unaware"), unaware, "unaware"),
  row(`${state.name}: an unreadable format`, state, answer("unreadable"), unread, "unreadable"),
  ...(none
    ? [row(`${state.name}: discovery names none`, state, answer("none"), none, "none")]
    : []),
];

/** A state that holds no lookup, timer or handle, through every event. */
function quiet(state, answers, { wanted: want, wantedCase, close: closing }) {
  return [
    ...discoveries(state, answers),
    row(`${state.name}: something asks for the document`, state, wanted(), want, wantedCase),
    ...lateAnswers(state),
    lateCooled(state),
    row(`${state.name}: retire`, state, retire, go(retired)),
    row(`${state.name}: close`, state, close, closing),
  ];
}

/** A state that holds something to stop, through a discovery that leaves it. */
function leaving(state, stop, lookupRow) {
  return [
    lookupRow,
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

const answered = no(unserved, REJECT.answered);

const ROWS = [
  ...quiet(
    closed,
    { none: go(absent), unaware: go(unserved), unreadable: go(unreadable) },
    { wanted: no(closed, REJECT.closed), close: no(closed, REJECT.closed) },
  ),
  ...quiet(
    unserved,
    { none: go(absent), unaware: no(unserved, REJECT.same), unreadable: go(unreadable) },
    { wanted: answered, close: go(closed) },
  ),
  ...quiet(
    unreadable,
    { none: go(absent), unaware: go(unserved), unreadable: no(unreadable, REJECT.same) },
    { wanted: no(unreadable, REJECT.answered), close: go(closed) },
  ),
  ...quiet(
    failed,
    { none: go(absent), unaware: go(unserved), unreadable: go(unreadable) },
    { wanted: no(failed, REJECT.answered), close: go(closed) },
  ),

  // No such document.
  ...quiet(
    absent,
    { none: no(absent, REJECT.same), unaware: go(unserved), unreadable: go(unreadable) },
    { wanted: go(opening(1, S1, "derived"), [lookup(1)]), wantedCase: "look", close: go(closed) },
  ),
  row(
    "absent after a miss: a discovery that names none starts plain",
    missed,
    answer("none"),
    go(absent),
    "cooling",
  ),
  row(
    "absent after a rest: an ask runs one lookup at once",
    missed,
    wanted(),
    go(opening(1, S1, "derived", 1), [lookup(1)]),
    "again",
  ),
  row("cooling: an ask waits for the look-again timer", cooling, wanted(), go(asked), "ask"),
  row(
    "cooling, asked: another ask changes nothing",
    asked,
    wanted(),
    no(asked, REJECT.asked),
    "asked",
  ),
  row(
    "cooling: a new connection looks at once and clears the timer",
    cooling,
    derived(),
    go(opening(1, S1, "derived"), [clearTimer, lookup(1)]),
    "derived",
  ),
  row(
    "cooling: a discovery naming none clears the timer",
    cooling,
    answer("none"),
    go(absent, [clearTimer]),
    "cooling",
  ),
  row("cooling: retire clears the timer", cooling, retire, go(retired, [clearTimer])),
  row("cooling: close clears the timer", cooling, close, go(closed, [clearTimer])),
  row(
    "cooling: the timer fires with nobody asking, and the replica rests",
    cooling,
    cooled,
    go(missed),
    "rest",
  ),
  row(
    "cooling, asked: the timer fires and one lookup runs",
    asked,
    cooled,
    go(opening(1, S1, "derived", 1), [lookup(1)]),
    "look",
  ),

  // A lookup is running.
  ...leaving(
    opening(2),
    [cancel(2)],
    row(
      "opening: a new connection restarts the lookup on it",
      opening(2),
      named(),
      go(opening(1), [cancel(2), lookup(1)]),
      "lookup",
    ),
  ),
  row(
    "opening: a derived lookup restarts on a new connection too",
    opening(2, S1, "derived"),
    derived(),
    go(opening(1, S1, "derived"), [cancel(2), lookup(1)]),
    "lookup",
  ),
  row(
    "opening: an ask while looking changes nothing",
    opening(2),
    wanted(),
    no(opening(2), REJECT.looking),
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
    go(failed),
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
    "opening: an older host answers it holds no named document",
    opening(2),
    settled("unknown"),
    go({ name: "unserved", id: S1 }),
    "unserved",
  ),
  row(
    "opening: a derived document the host doesn't hold yet is asked for again",
    opening(2, S1, "derived"),
    settled("unknown"),
    go(retrying(2, S1, "derived"), [
      forget(),
      { type: "schedule", attempt: 2, delay: retryDelay(2) },
    ]),
    "retry",
  ),
  row(
    "opening: the last derived miss rests and arms the look-again timer",
    opening(MISSING_ATTEMPTS, S1, "derived"),
    settled("unknown", MISSING_ATTEMPTS),
    go(cooling, [forget(), { type: "cool", delay: lookAgainDelay(1) }]),
    "missing",
  ),
  row(
    "opening: a miss after a rest doesn't retry, and widens the window",
    opening(1, S1, "derived", 1),
    settled("unknown", 1),
    go({ name: "absent", id: S1, misses: 2, cooling: true }, [
      forget(),
      { type: "cool", delay: lookAgainDelay(2) },
    ]),
    "again",
  ),
  row(
    "opening: a cancelled lookup's unknown answer",
    opening(2),
    settled("unknown", 1),
    no(opening(2), REJECT.stale),
    "stale",
  ),
  row("opening: no timer is armed", opening(2), settled("timer"), no(opening(2), REJECT.stale)),
  lateCooled(opening(2)),

  // A retry is waiting.
  ...leaving(
    retrying(2),
    [clearTimer],
    row(
      "retrying: a new connection retries at once",
      retrying(2),
      named(),
      go(opening(1), [clearTimer, lookup(1)]),
      "lookup",
    ),
  ),
  row(
    "retrying: an ask while waiting changes nothing",
    retrying(2),
    wanted(),
    no(retrying(2), REJECT.looking),
  ),
  row(
    "retrying: the timer starts the next lookup",
    retrying(2),
    settled("timer"),
    go(opening(3), [lookup(3)]),
    "current",
  ),
  row(
    "retrying: a derived retry keeps its way",
    retrying(2, S1, "derived"),
    settled("timer"),
    go(opening(3, S1, "derived"), [lookup(3)]),
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
  lateCooled(retrying(2)),

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
  row(
    "ready: a reconnect that derives the same id keeps it too",
    ready(),
    derived(),
    no(ready(), REJECT.ready),
    "same",
  ),
  row(
    "ready: discovery names another document",
    ready(),
    named(S2),
    go(opening(1, S2), [uninstall, lookup(1, S2)]),
    "other",
  ),
  row("ready: an ask changes nothing", ready(), wanted(), no(ready(), REJECT.ready)),
  ...lateAnswers(ready()),
  lateCooled(ready()),

  // Retired: nothing opens again.
  row("retired: a discovery opens nothing", retired, named(), no(retired, REJECT.retired)),
  row("retired: an ask opens nothing", retired, wanted(), no(retired, REJECT.retired)),
  ...lateAnswers(retired),
  lateCooled(retired),
  row("retired: retire again", retired, retire, no(retired, REJECT.retired)),
  row("retired: close", retired, close, no(retired, REJECT.retired)),
];

test("the host-doc-open table covers every state and event", async () => {
  const result = await runTable(hostDocOpenMachine, ROWS);
  assert.equal(result.pairs, 81);
  assert.equal(result.unreachable, 0);
});

test("the table's effects only find, wait, adopt and drop: none writes the document", () => {
  const effects = ROWS.flatMap((r) => r.expect.effects);
  assert.deepEqual([...new Set(effects.map((effect) => effect.type))].sort(), [
    "cancel",
    "clearTimer",
    "cool",
    "forget",
    "install",
    "lookup",
    "schedule",
    "uninstall",
  ]);
});

test("retries back off as the comments document's do, then stop at the attempt limit", () => {
  let { state } = hostDocOpenMachine.step(hostDocOpenMachine.initial, named());
  for (let attempt = 1; attempt < OPEN_ATTEMPTS; attempt++) {
    const failedOnce = hostDocOpenMachine.step(state, settled("lookupFailed", attempt));
    assert.deepEqual(failedOnce.effects, [
      { type: "schedule", attempt, delay: retryDelay(attempt) },
    ]);
    ({ state } = hostDocOpenMachine.step(failedOnce.state, settled("timer", attempt)));
  }
  ({ state } = hostDocOpenMachine.step(state, settled("lookupFailed", OPEN_ATTEMPTS)));
  assert.deepEqual(state, failed);
});

test("a derived document the host never holds is asked for a bounded number of times", () => {
  let { state } = hostDocOpenMachine.step(hostDocOpenMachine.initial, derived());
  let lookups = 1;
  for (;;) {
    const result = hostDocOpenMachine.step(state, settled("unknown", state.attempt));
    state = result.state;
    if (state.name !== "retrying") break;
    ({ state } = hostDocOpenMachine.step(state, settled("timer", state.attempt)));
    lookups++;
  }
  assert.equal(lookups, MISSING_ATTEMPTS);
  assert.deepEqual(state, cooling);
  // Nobody asks: the timer fires and nothing more runs.
  ({ state } = hostDocOpenMachine.step(state, cooled));
  assert.deepEqual(state, missed);
});

test("with steady demand, a missing document gets one lookup per window, widening to 60 s", () => {
  let { state } = hostDocOpenMachine.step(hostDocOpenMachine.initial, derived());
  for (let attempt = 1; attempt < MISSING_ATTEMPTS; attempt++) {
    ({ state } = hostDocOpenMachine.step(state, settled("unknown", attempt)));
    ({ state } = hostDocOpenMachine.step(state, settled("timer", attempt)));
  }
  const windows = [];
  for (let rest = 1; rest <= 5; rest++) {
    const missedOnce = hostDocOpenMachine.step(state, settled("unknown", state.attempt));
    const cool = missedOnce.effects.find((effect) => effect.type === "cool");
    windows.push(cool.delay);
    assert.ok(
      !missedOnce.effects.some((effect) => effect.type === "schedule"),
      "no burst after a rest",
    );
    ({ state } = hostDocOpenMachine.step(missedOnce.state, wanted()));
    ({ state } = hostDocOpenMachine.step(state, cooled));
    assert.deepEqual(state, opening(1, S1, "derived", rest));
  }
  assert.deepEqual(windows, [10_000, 30_000, 60_000, 60_000, 60_000]);
  // A new connection starts over with a fresh burst.
  ({ state } = hostDocOpenMachine.step(state, derived()));
  assert.deepEqual(state, opening(1, S1, "derived"));
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
