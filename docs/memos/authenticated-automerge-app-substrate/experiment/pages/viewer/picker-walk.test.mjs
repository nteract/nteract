// The Browse picker's machine over every state and event, and PickerWalk's
// interpretation of it: cancelled walks, accounts, and a 401 that can't loop.
import test from "node:test";
import assert from "node:assert/strict";
import { VirtualTimeScheduler } from "rxjs";
import { runTable } from "../shared/machine-test.mjs";
import {
  OTHER_ACCOUNT_MESSAGE,
  PickerWalk,
  REJECT,
  SIGNED_OUT_MESSAGE,
  pickerWalkMachine,
  pickerWalkSpec,
} from "./picker-walk.mjs";
import { ACCOUNT_CHANGED, listAllPages } from "./page-list.mjs";

const closed = { name: "closed" };
const loading = (key = "k1") => ({ name: "loading", principal: "alice", key });
const refreshing = (key = "k1") => ({ name: "refreshing", principal: "alice", key });
const ready = { name: "ready", principal: "alice" };
const failed = { name: "failed", principal: "alice", message: "Couldn't reach Pages" };
const open = (seeded = false) => ({ type: "open", principal: "alice", key: "k2", seeded });
const loaded = (key = "k1") => ({ type: "loaded", key });
const failure = (key = "k1") => ({ type: "failed", key, message: "Couldn't reach Pages" });
const stays = (state, reason) => ({ state, effects: [], rejected: reason });
const shut = { state: closed, effects: [{ type: "cancel" }, { type: "clear" }] };
const refused = { type: "refused" };
const signedOut = {
  state: { name: "failed", principal: "alice", message: SIGNED_OUT_MESSAGE },
  effects: [{ type: "cancel" }, { type: "clear" }, { type: "report", message: SIGNED_OUT_MESSAGE }],
};

const ROWS = [
  {
    label: "opening walks every Page",
    case: "fresh",
    state: closed,
    event: open(),
    expect: {
      state: loading("k2"),
      effects: [{ type: "fetch", key: "k2", principal: "alice" }],
    },
  },
  {
    label: "opening paints the library's remembered first page while it walks",
    case: "seeded",
    state: closed,
    event: open(true),
    expect: {
      state: refreshing("k2"),
      effects: [
        { type: "paint", principal: "alice" },
        { type: "fetch", key: "k2", principal: "alice" },
      ],
    },
  },
  { state: closed, event: loaded(), expect: stays(closed, REJECT.idle) },
  { state: closed, event: failure(), expect: stays(closed, REJECT.idle) },
  { state: closed, event: { type: "close" }, expect: stays(closed, REJECT.closed) },
  { state: closed, event: { type: "forget" }, expect: stays(closed, REJECT.closed) },
  { state: closed, event: refused, expect: stays(closed, REJECT.closed) },
  ...[loading(), refreshing()].flatMap((walking) => [
    { state: walking, event: open(), expect: stays(walking, REJECT.open) },
    {
      label: `${walking.name}: the walk's rows show`,
      case: "current",
      state: walking,
      event: loaded(),
      expect: { state: ready, effects: [{ type: "show", key: "k1" }] },
    },
    {
      label: `${walking.name}: a cancelled walk's answer is ignored`,
      case: "stale",
      state: walking,
      event: loaded("k0"),
      expect: stays(walking, REJECT.stale),
    },
    {
      label: `${walking.name}: a failed walk lists nothing and reports`,
      case: "current",
      state: walking,
      event: failure(),
      expect: {
        state: failed,
        effects: [{ type: "clear" }, { type: "report", message: "Couldn't reach Pages" }],
      },
    },
    {
      label: `${walking.name}: a cancelled walk's failure is ignored`,
      case: "stale",
      state: walking,
      event: failure("k0"),
      expect: stays(walking, REJECT.stale),
    },
    {
      label: `${walking.name}: closing cancels the walk`,
      state: walking,
      event: { type: "close" },
      expect: shut,
    },
    {
      label: `${walking.name}: forgetting the account closes without walking again`,
      state: walking,
      event: { type: "forget" },
      expect: shut,
    },
    {
      label: `${walking.name}: a 401 cancels the walk and stays open to say so`,
      state: walking,
      event: refused,
      expect: signedOut,
    },
  ]),
  ...[ready, failed].flatMap((settled) => [
    { state: settled, event: open(), expect: stays(settled, REJECT.open) },
    { state: settled, event: loaded(), expect: stays(settled, REJECT.idle) },
    { state: settled, event: failure(), expect: stays(settled, REJECT.idle) },
    { state: settled, event: { type: "close" }, expect: shut },
    { state: settled, event: { type: "forget" }, expect: shut },
    {
      label: `${settled.name}: a 401 drops the rows and says why`,
      state: settled,
      event: refused,
      expect: signedOut,
    },
  ]),
];

test("the picker table runs through the pure machine", async () => {
  assert.deepEqual(await runTable(pickerWalkMachine, ROWS), {
    rows: ROWS.length,
    pairs: pickerWalkSpec.states.length * pickerWalkSpec.events.length,
    unreachable: 0,
    cases: 10,
  });
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => ((resolve = yes), (reject = no)));
  return { promise, resolve, reject };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness({ seed = () => null } = {}) {
  const walks = [];
  const reports = [];
  const others = [];
  let n = 0;
  const picker = new PickerWalk({
    walk: ({ principal, signal }) => {
      const reply = deferred();
      walks.push({ principal, signal, ...reply });
      return reply.promise;
    },
    seed,
    report: (message) => reports.push(message),
    onOtherAccount: () => others.push(true),
    newKey: () => `k${++n}`,
  });
  return {
    picker,
    walks,
    reports,
    others,
    titles: () => picker.store.snapshot().items.map((page) => page.title),
  };
}

test("no account, no walk", () => {
  const { picker, walks } = harness();
  assert.equal(picker.open(null), false);
  assert.equal(picker.open(""), false);
  assert.equal(picker.state.name, "closed");
  assert.equal(walks.length, 0);
});

test("closing cancels the walk, and a reopen never shows the earlier one", async () => {
  const { picker, walks, titles } = harness();
  picker.open("alice");
  picker.close();
  assert.equal(walks[0].signal.aborted, true, "the walk stops between pages");
  picker.open("alice");
  walks[0].resolve({ pages: [{ title: "Old" }], principal: "alice" });
  await settle();
  assert.deepEqual(titles(), [], "the cancelled walk shows nothing");
  assert.equal(picker.state.name, "loading");
  walks[1].resolve({ pages: [{ title: "New" }], principal: "alice" });
  await settle();
  assert.deepEqual(titles(), ["New"]);
  picker.close();
  assert.deepEqual(titles(), [], "a closed picker holds no rows");
});

test("a walk shows only for its account; an older API's answer shows", async () => {
  const { picker, walks, titles, reports, others } = harness();
  picker.open("alice");
  walks[0].resolve({ pages: [{ title: "Bob's" }], principal: "bob" });
  await settle();
  assert.deepEqual(titles(), []);
  assert.equal(picker.state.name, "failed");
  assert.deepEqual(reports, [OTHER_ACCOUNT_MESSAGE]);
  assert.equal(others.length, 1, "the shell checks the session");
  picker.close();
  picker.open("alice");
  walks[1].resolve({ pages: [{ title: "Anyone's" }] });
  await settle();
  assert.deepEqual(titles(), ["Anyone's"]);
});

test("a remembered first page paints while the walk runs", async () => {
  const { picker, walks, titles } = harness({
    seed: (principal) => (principal === "alice" ? [{ title: "Remembered" }] : null),
  });
  picker.open("alice");
  assert.equal(picker.state.name, "refreshing");
  assert.deepEqual(titles(), ["Remembered"]);
  walks[0].reject(new TypeError("Failed to fetch"));
  await settle();
  assert.equal(picker.state.name, "failed");
  assert.deepEqual(titles(), [], "a failed walk drops what it painted");
});

test("a 401 with the picker open makes one request, however long it waits", async () => {
  // The shell's wiring: every refused tool call tells the picker, and the
  // session check closes it if the account changed or signed out. Every
  // list_pages answers 401.
  const scheduler = new VirtualTimeScheduler();
  const reports = [];
  let calls = 0;
  let signedIn = true;
  let picker;
  const call = async () => {
    calls++;
    const error = Object.assign(Error("Sign in required"), {
      status: 401,
      code: "unauthenticated",
    });
    picker.refused();
    // The session check answers later: still signed in, or signed out.
    queueMicrotask(() => {
      if (!signedIn) picker.forget();
    });
    throw error;
  };
  const wait = async () => {
    for (let tick = 0; tick < 100; tick++) {
      scheduler.schedule(() => {}, 1000);
      scheduler.flush();
      await settle();
    }
  };
  picker = new PickerWalk({
    walk: ({ signal }) => listAllPages(call, { signal }),
    report: (message) => reports.push(message),
  });
  picker.open("alice");
  await wait();
  assert.equal(calls, 1, "signed in: one request");
  assert.equal(picker.state.name, "failed", "the picker stays open");
  assert.deepEqual(reports, [SIGNED_OUT_MESSAGE], "and says why its rows went");
  assert.deepEqual(picker.store.snapshot().items, []);
  // Reopening is the person's retry, and walks once more.
  picker.close();
  signedIn = false;
  calls = 0;
  picker.open("alice");
  await wait();
  assert.equal(calls, 1, "signed out: one request");
  assert.equal(picker.state.name, "closed", "the session check closed it");
  calls = 0;
  assert.equal(picker.open(null), false);
  await wait();
  assert.equal(calls, 0, "no account, no walk");
});

test("a walk whose pages change account partway asks who is signed in", async () => {
  const { picker, walks, reports, others } = harness();
  picker.open("alice");
  walks[0].reject(
    Object.assign(Error("The account changed while Pages were listed. Try again."), {
      code: ACCOUNT_CHANGED,
    }),
  );
  await settle();
  assert.equal(picker.state.name, "failed");
  assert.deepEqual(reports, [OTHER_ACCOUNT_MESSAGE]);
  assert.equal(others.length, 1, "the shell checks the session");
  // Any other failure only reports.
  picker.close();
  picker.open("alice");
  walks[1].reject(new Error("Couldn't reach Pages"));
  await settle();
  assert.deepEqual(reports, [OTHER_ACCOUNT_MESSAGE, "Couldn't reach Pages"]);
  assert.equal(others.length, 1);
});

test("a 401 drops what the picker shows; a closed picker ignores it", async () => {
  const { picker, walks, reports, titles } = harness();
  assert.equal(picker.refused(), false, "nothing to say while closed");
  picker.open("alice");
  walks[0].resolve({ pages: [{ title: "Roadmap" }], principal: "alice" });
  await settle();
  assert.deepEqual(titles(), ["Roadmap"]);
  // Some other request was refused while the picker shows its rows.
  assert.equal(picker.refused(), true);
  assert.deepEqual(titles(), []);
  assert.equal(picker.state.name, "failed");
  assert.deepEqual(reports, [SIGNED_OUT_MESSAGE]);
  // A 401 during a walk cancels it; its answer never shows.
  picker.close();
  picker.open("alice");
  picker.refused();
  assert.equal(walks[1].signal.aborted, true);
  walks[1].resolve({ pages: [{ title: "Late" }], principal: "alice" });
  await settle();
  assert.deepEqual(titles(), []);
  assert.equal(picker.state.name, "failed");
});
