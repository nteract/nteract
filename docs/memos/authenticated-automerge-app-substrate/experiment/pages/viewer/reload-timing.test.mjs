// Virtual-time specs for the drain timeout, navigation cancelling a reload,
// and a reload waiting for its receipt. Inputs and expected outputs are
// marbles; times are milliseconds (TestScheduler run mode).
//
// Each spec runs under TestScheduler.run: PageSession's drain and the reload
// gate's timeout use RxJS schedulers, so the whole sequence plays on virtual
// time and the phases they publish are the observed output.
import test from "node:test";
import assert from "node:assert/strict";
import { filter, map } from "rxjs";
import { TestScheduler } from "rxjs/testing";
import * as A from "@automerge/automerge";
import { CLOSE_DRAIN_MS, PageSession } from "./session.mjs";
import { ReloadGate } from "./build-freshness.mjs";
import { SessionHost } from "./session-host.mjs";
import { FakeSession } from "./session-fixture.mjs";
import { createPageData, initializePage } from "../model/page.mjs";

const SAVE_TIMEOUT =
  "Your latest edits haven't saved yet, so this tab won't reload. Check your connection and try again.";
const OUTCOMES = {
  o: { ok: true },
  x: { ok: false, cancelled: true },
  t: { ok: false, message: SAVE_TIMEOUT },
};

/** Run `inputs` (name -> marbles) as calls on `actions` and compare what
 * `output$` emits with `expected`. */
function runMarbles({ inputs, expected, values, start }) {
  const scheduler = new TestScheduler((actual, wanted) => assert.deepStrictEqual(actual, wanted));
  scheduler.run(({ cold, expectObservable }) => {
    const { actions, output$ } = start();
    for (const [name, spec] of Object.entries(inputs)) cold(spec).subscribe(() => actions[name]());
    expectObservable(output$).toBe(expected, values);
  });
}

/** A PageSession whose storage and sockets are recorders. It is saving an
 * edit the host has not acknowledged. */
function savingSession() {
  const pageId = crypto.randomUUID();
  const doc = A.change(A.from(createPageData({ pageId, title: "Garden notes" })), initializePage);
  const session = new PageSession(pageId);
  session.identity = { principal: "dev" };
  session.handle = { doc: () => doc };
  session.repo = { flush: async () => {} };
  session.localPage = { pending: true };
  session.persistLocal = async () => {};
  session.releaseLocal = async () => {};
  session.disconnectSockets = async () => {};
  session.statusId = "saving";
  session.dispatch({ type: "opened", denied: false });
  const receipt = () => {
    session.savedHeads = A.getHeads(doc);
    session.localPage = { pending: false };
    session.statusId = "saved";
    session.emit();
  };
  const offline = () => {
    session.statusId = "offline";
    session.emit();
  };
  return { session, receipt, offline };
}

/** Leave a saving Page; `c` marks the frame its close starts. */
function drain(inputs, expected) {
  runMarbles({
    inputs,
    expected,
    start() {
      const { session, receipt, offline } = savingSession();
      return {
        actions: { leave: () => void session.leave({ drain: true }), receipt, offline },
        output$: session.phase$
          .select((phase) => phase.name)
          .pipe(
            filter((name) => name === "checkpointing"),
            map(() => "c"),
          ),
      };
    },
  });
}

test("a left Page closes at its receipt, when it goes offline, or after CLOSE_DRAIN_MS", () => {
  assert.equal(CLOSE_DRAIN_MS, 10_000);
  drain({ leave: "a" }, "10s c");
  drain({ leave: "a", receipt: "4s r" }, "4s c");
  drain({ leave: "a", offline: "2s f" }, "2s c");
  // A receipt after the drain gave up changes nothing.
  drain({ leave: "a", receipt: "12s r" }, "10s c");
});

function outcomeOf(state) {
  if (state.name === "reloading") return OUTCOMES.o;
  if (state.name === "cancelled") return OUTCOMES.x;
  return { ok: false, ...state.outcome };
}

/** Reload while Page A saves. `leave` drains A, `open` installs B, `receipt`
 * acknowledges A's edits. The reload's answer is recorded at its frame. */
function reloadWith(inputs, expected) {
  runMarbles({
    inputs,
    expected,
    values: OUTCOMES,
    start() {
      const host = new SessionHost();
      const gate = new ReloadGate();
      gate.watch(host);
      const a = new FakeSession("page-a");
      host.install(a, host.generation, "dev");
      return {
        actions: {
          reload: () => void gate.reload({ reload() {} }),
          leave: () => void host.release(),
          open: () =>
            host.install(
              Object.assign(new FakeSession("page-b"), { pending: false, statusId: "saved" }),
              host.generation,
              "dev",
            ),
          receipt: () => a.set({ pending: false, statusId: "saved", savedHeads: ["h1"] }),
        },
        output$: gate.store
          .select((state) => state.name)
          .pipe(
            filter((name) => name !== "idle" && name !== "waiting"),
            map(() => outcomeOf(gate.store.snapshot())),
          ),
      };
    },
  });
}

test("a reload waits for the held Page's receipt, or gives up after SAVE_BEFORE_RELOAD_MS", () => {
  reloadWith({ reload: "a", receipt: "3s r" }, "3s o");
  reloadWith({ reload: "a" }, "15s t");
});

test("navigation during the wait cancels the reload once everything settles", () => {
  // Leaving A keeps it saving; the attempt ends with A's receipt, cancelled.
  reloadWith({ reload: "a", leave: "2s l", receipt: "5s r" }, "5s x");
  // Opening B while A saves cancels too.
  reloadWith({ reload: "a", open: "1s b", receipt: "4s r" }, "4s x");
  // A Page left mid-wait that never saves: the attempt waits on it as a held
  // save, so its timeout ends the attempt, cancelled, while the Page drains.
  reloadWith({ reload: "a", leave: "6s l" }, "15s x");
});
