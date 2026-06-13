/**
 * SyncHealScheduler — the resync heal loop's ladder, confirmation
 * settling, exhaustion-once discipline, roomReady reset, and the
 * deliberate non-interference with the rejection tracker. Session wiring
 * (the hook cannot run under node) is pinned by source guardrails.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { CloudRecoverableRejectionTracker } from "../viewer/live-sync.ts";
import { NOTEBOOK_DOC_HEAL_KEY, SyncHealScheduler } from "../viewer/sync-heal.ts";

const DOC = NOTEBOOK_DOC_HEAL_KEY;

const silentLogger = { debug: () => {}, warn: () => {} };

/**
 * node:test mock timers do NOT fire timers scheduled during a tick, so a
 * chained deadline ladder must be advanced rung by rung.
 */
function tickRungs(t: { mock: { timers: { tick: (ms: number) => void } } }, rungs: number[]): void {
  for (const rung of rungs) {
    t.mock.timers.tick(rung);
  }
}

function createHarness(
  overrides: Partial<ConstructorParameters<typeof SyncHealScheduler>[0]> = {},
) {
  const kicks: string[] = [];
  const exhausted: string[] = [];
  const recovered: string[] = [];
  let kickAllowed = true;
  const scheduler = new SyncHealScheduler({
    kick: (docKey) => kicks.push(docKey),
    shouldKick: () => kickAllowed,
    onExhausted: (docKey) => exhausted.push(docKey),
    onRecovered: (docKey) => recovered.push(docKey),
    baseDelayMs: 100,
    maxDelayMs: 800,
    backoffFactor: 2,
    maxAttempts: 3,
    random: () => 0.5, // exact rungs — no jitter
    logger: silentLogger,
    ...overrides,
  });
  return {
    scheduler,
    kicks,
    exhausted,
    recovered,
    setKickAllowed: (allowed: boolean) => {
      kickAllowed = allowed;
    },
  };
}

describe("SyncHealScheduler", () => {
  it("re-kicks on the deadline ladder and exhausts ONCE", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = createHarness();

    h.scheduler.noteResyncKicked(DOC);
    t.mock.timers.tick(99);
    assert.deepEqual(h.kicks, [], "no kick before the first deadline");
    t.mock.timers.tick(1); // 100ms rung
    assert.deepEqual(h.kicks, [DOC]);

    t.mock.timers.tick(199);
    assert.equal(h.kicks.length, 1, "second rung is 200ms (factor 2)");
    t.mock.timers.tick(1);
    assert.equal(h.kicks.length, 2);

    t.mock.timers.tick(400); // third rung
    assert.equal(h.kicks.length, 3);
    assert.deepEqual(h.exhausted, []);

    t.mock.timers.tick(800); // fourth deadline: attempts == max -> terminal
    assert.deepEqual(h.exhausted, [DOC], "exhaustion fires once");
    assert.equal(h.kicks.length, 3, "no kick on the exhausting deadline");

    // The ladder is stopped: nothing further fires, ever.
    t.mock.timers.tick(600_000);
    assert.equal(h.kicks.length, 3);
    assert.deepEqual(h.exhausted, [DOC]);
    h.scheduler.dispose();
  });

  it("caught_up settles the loop — no spurious re-kicks after convergence", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = createHarness();

    h.scheduler.noteResyncKicked(DOC);
    t.mock.timers.tick(100);
    assert.equal(h.kicks.length, 1);

    // Confirmation is just another sync: the catch-up fact landing true
    // means the previous exchange landed.
    h.scheduler.noteVerification(DOC, true);
    t.mock.timers.tick(600_000);
    assert.equal(h.kicks.length, 1, "converged: the deadline is cancelled");
    assert.deepEqual(h.exhausted, []);
    assert.deepEqual(h.recovered, [], "recovery only fires after an exhaustion");

    // The ladder also reset: a NEW stall starts from the base rung.
    h.scheduler.noteResyncKicked(DOC);
    t.mock.timers.tick(100);
    assert.equal(h.kicks.length, 2, "fresh episode starts at the base deadline");
    h.scheduler.dispose();
  });

  it("caught_up === false is not a failure; the deadline stays the judge", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = createHarness();

    h.scheduler.noteResyncKicked(DOC);
    h.scheduler.noteVerification(DOC, false);
    h.scheduler.noteVerification(DOC, false);
    t.mock.timers.tick(99);
    assert.deepEqual(h.kicks, []);
    t.mock.timers.tick(1);
    assert.deepEqual(h.kicks, [DOC], "deadline unaffected by not-yet polls");
    h.scheduler.dispose();
  });

  it("late convergence after exhaustion fires onRecovered once and re-arms future episodes", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = createHarness();

    h.scheduler.noteResyncKicked(DOC);
    tickRungs(t, [100, 200, 400, 800]);
    assert.deepEqual(h.exhausted, [DOC]);

    h.scheduler.noteVerification(DOC, true);
    assert.deepEqual(h.recovered, [DOC], "late convergence clears the terminal surface");
    h.scheduler.noteVerification(DOC, true);
    assert.deepEqual(h.recovered, [DOC], "recovery fires once per episode");

    // A NEW stall after recovery is a new episode: it may exhaust again.
    h.scheduler.noteResyncKicked(DOC);
    tickRungs(t, [100, 200, 400, 800]);
    assert.deepEqual(h.exhausted, [DOC, DOC]);
    h.scheduler.dispose();
  });

  it("roomReady reset returns the ladder to the base rung but keeps a standing exhaustion", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = createHarness();

    h.scheduler.noteResyncKicked(DOC);
    tickRungs(t, [100, 200]); // two re-kicks in
    assert.equal(h.kicks.length, 2);

    h.scheduler.reset(DOC); // fresh connection
    t.mock.timers.tick(600_000);
    assert.equal(h.kicks.length, 2, "reset cancels the pending deadline");

    h.scheduler.noteResyncKicked(DOC); // the re-establish's resync
    t.mock.timers.tick(100);
    assert.equal(h.kicks.length, 3, "ladder restarted at the base rung");

    // Exhaust, reconnect, stall again: the SAME episode stays silent.
    tickRungs(t, [200, 400, 800]);
    assert.deepEqual(h.exhausted, [DOC]);
    h.scheduler.reset(DOC);
    h.scheduler.noteResyncKicked(DOC);
    tickRungs(t, [100, 200, 400, 800]);
    assert.deepEqual(h.exhausted, [DOC], "no second terminal signal without convergence between");
    h.scheduler.dispose();
  });

  it("a closed kick gate holds the rung without kicking or consuming attempts", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = createHarness();

    h.scheduler.noteResyncKicked(DOC);
    h.setKickAllowed(false); // link down: the reconnect line owns this
    t.mock.timers.tick(100 * 50);
    assert.deepEqual(h.kicks, [], "no kicks while the gate is closed");
    assert.deepEqual(h.exhausted, [], "held deadlines never consume attempts");

    h.setKickAllowed(true);
    t.mock.timers.tick(100);
    assert.deepEqual(h.kicks, [DOC], "first open deadline kicks at the held rung");
    h.scheduler.dispose();
  });

  it("ignores verification for docs that never armed and is inert after dispose", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = createHarness();

    h.scheduler.noteVerification("runtime-state-doc", true); // future adopter, not armed
    assert.deepEqual(h.recovered, []);

    h.scheduler.noteResyncKicked(DOC);
    h.scheduler.dispose();
    t.mock.timers.tick(600_000);
    assert.deepEqual(h.kicks, []);
    h.scheduler.noteResyncKicked(DOC); // post-dispose no-op
    t.mock.timers.tick(600_000);
    assert.deepEqual(h.kicks, []);
  });

  it("jitter stays inside the configured ratio around each rung", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    // random() = 1 -> +25%; the first deadline lands at 125ms, not 100.
    const h = createHarness({ random: () => 1, jitterRatio: 0.25 });
    h.scheduler.noteResyncKicked(DOC);
    t.mock.timers.tick(124);
    assert.deepEqual(h.kicks, []);
    t.mock.timers.tick(1);
    assert.deepEqual(h.kicks, [DOC]);
    h.scheduler.dispose();
  });

  it("keys docs independently (RuntimeStateDoc/Comms can adopt later)", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = createHarness();

    h.scheduler.noteResyncKicked(DOC);
    h.scheduler.noteResyncKicked("runtime-state-doc");
    t.mock.timers.tick(100);
    assert.deepEqual(h.kicks.sort(), [DOC, "runtime-state-doc"].sort());

    h.scheduler.noteVerification(DOC, true); // settles one doc only
    t.mock.timers.tick(200);
    assert.equal(h.kicks.filter((k) => k === "runtime-state-doc").length, 2);
    assert.equal(h.kicks.filter((k) => k === DOC).length, 1);
    h.scheduler.dispose();
  });
});

describe("heal loop / rejection tracker non-interference", () => {
  it("heal re-kicks never count as strikes or disturb the absorb window", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const tracker = new CloudRecoverableRejectionTracker();
    const h = createHarness({
      // The session's kick seam calls engine.resetAndResync() ONLY — by
      // construction it cannot touch the tracker. Model that here.
      kick: () => {},
    });

    // Strike 1: in-place resync, absorb window open until delivery.
    assert.equal(tracker.record(true), "resync_in_place");

    // The heal loop re-kicks several times while the window is open.
    h.scheduler.noteResyncKicked(NOTEBOOK_DOC_HEAL_KEY);
    t.mock.timers.tick(100 + 200 + 400);

    // A pipelined rejection still absorbs — heal activity added nothing.
    assert.equal(tracker.record(true), "absorb");
    assert.equal(tracker.record(true), "absorb");

    // Post-delivery escalation semantics are untouched.
    tracker.resyncSettled();
    assert.equal(tracker.record(true), "escalate");
    h.scheduler.dispose();
  });
});

// Session wiring pins (the hook cannot run under node).
describe("cloud session sync-heal wiring", () => {
  const sessionSource = readFileSync(
    new URL("../viewer/cloud-viewer-session.ts", import.meta.url),
    "utf8",
  );

  it("verifies both fire-and-forget resync sites", () => {
    // roomReady adoption: reset the ladder, then verify the re-establish.
    assert.match(
      sessionSource,
      /applyRoomReady\(ready\)\) return;[\s\S]{0,400}?syncHeal\.reset\(NOTEBOOK_DOC_HEAL_KEY\);\s*\n\s*syncHeal\.noteResyncKicked\(NOTEBOOK_DOC_HEAL_KEY\);/,
      "roomReady resets the ladder then arms verification",
    );
    // The rejection tracker's in-place recovery is verified too.
    assert.match(
      sessionSource,
      /resync_in_place[\s\S]{0,700}?resetAndResync\(\);[\s\S]{0,400}?syncHeal\.noteResyncKicked\(NOTEBOOK_DOC_HEAL_KEY\);/,
      "strike-1 in-place resync arms verification",
    );
  });

  it("arms verification for the initial bootstrap exchange", () => {
    // The replayed first handshake trips the applyRoomReady peer-id dedupe,
    // so the roomReady$ arming never covers the cold load — the connect
    // resolution block must arm it directly or a first-connection stall
    // never kicks, never exhausts, and never surfaces.
    assert.match(
      sessionSource,
      /armTabBridge\(liveRuntime\);[\s\S]{0,600}?syncHeal\.noteResyncKicked\(NOTEBOOK_DOC_HEAL_KEY\);/,
      "the connect resolution block arms initial-exchange verification",
    );
  });

  it("feeds the caught-up confirmation from notebookSyncApplied$", () => {
    assert.match(
      sessionSource,
      /notebookSyncApplied\$\.subscribe[\s\S]{0,400}?cloudNotebookHandleCaughtUp\(liveRuntime\.handle\);[\s\S]{0,400}?syncHeal\.noteVerification\(NOTEBOOK_DOC_HEAL_KEY, caughtUp\);/,
    );
  });

  it("gates re-kicks on the link being online and keeps failure domains separate", () => {
    const schedulerBlock = sessionSource.slice(
      sessionSource.indexOf("const syncHeal = new SyncHealScheduler"),
      sessionSource.indexOf("const persistenceRearmGate"),
    );
    assert.match(schedulerBlock, /getCurrent\(\) === "online"/, "shouldKick gates on online");
    assert.match(schedulerBlock, /resetAndResync\(\)/, "kick is the resync seam");
    assert.doesNotMatch(
      schedulerBlock,
      /rejectionTracker/,
      "heal kicks never touch the rejection tracker",
    );
    assert.doesNotMatch(
      schedulerBlock,
      /tabBridgeQuarantinedRef/,
      "heal exhaustion is not bridge poison",
    );
    assert.doesNotMatch(
      schedulerBlock,
      /offlineMergeTracker/,
      "heal kicks never feed the offline-merge tracker directly",
    );
  });

  it("keeps routine heal re-kicks out of the production console", () => {
    assert.match(
      sessionSource,
      /const quietSyncHealLogger = \{[\s\S]{0,120}?debug: \(\) => \{\},[\s\S]{0,160}?warn: \(message: string, \.\.\.args: unknown\[\]\) => console\.warn\(message, \.\.\.args\),[\s\S]{0,80}?\};/,
      "quiet logger drops routine retry debug lines but preserves terminal warnings",
    );
    assert.match(
      sessionSource,
      /logger: quietSyncHealLogger/,
      "the hosted viewer should not wire sync-heal directly to console",
    );
    assert.doesNotMatch(
      sessionSource,
      /logger: console,\s*\}\);[\s\S]{0,120}?const persistenceRearmGate/,
      "routine sync-heal retries must not leak to the browser console",
    );
  });

  it("disposes the scheduler and clears the stall surface on cleanup", () => {
    assert.match(sessionSource, /syncHeal\.dispose\(\);/);
    assert.match(sessionSource, /setSyncHealStalled\(false\);/);
  });

  it("wires the persistence single heal: self-disable noted, one re-arm on online or recovery", () => {
    assert.match(
      sessionSource,
      /onSelfDisabled: \(\) => persistenceRearmGate\.noteSelfDisabled\(\)/,
      "controller pair reports self-disable into the gate",
    );
    assert.match(
      sessionSource,
      /status === "online"[\s\S]{0,80}?attemptPersistenceRearm\(\);/,
      "online transition attempts the single re-arm",
    );
    assert.match(
      sessionSource,
      /onRecovered: [\s\S]{0,400}?attemptPersistenceRearm\(\);/,
      "heal-loop recovery is the successful-resync trigger",
    );
  });
});
