import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OfflineMergeTracker, type OfflineMergeNoticeData } from "../viewer/offline-merge-tracker";

const SETTLE_MS = 1_500;

// Offline edits merge silently today: no signal that local edits
// interleaved with remote ones, and a cell edited offline that was deleted
// remotely vanishes wordlessly. The tracker derives ONE quiet notice per
// outage from existing signals only — and a reconnect with nothing pending
// must surface nothing at all.
describe("offline merge tracker", () => {
  function tracked(projectedCellIds: () => readonly string[] = () => ["cell-a"]) {
    const notices: OfflineMergeNoticeData[] = [];
    const tracker = new OfflineMergeTracker({
      settleMs: SETTLE_MS,
      getProjectedCellIds: projectedCellIds,
      onNotice: (notice) => notices.push(notice),
    });
    return { notices, tracker };
  }

  it("fires once after offline edits, recovery, and the settle window", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { notices, tracker } = tracked();

    tracker.noteConnectionStatus("reconnecting");
    tracker.noteLocalDocActivity();
    tracker.noteConnectionStatus("online");
    assert.deepEqual(notices, [], "no notice before the settle window elapses");

    t.mock.timers.tick(SETTLE_MS - 1);
    assert.deepEqual(notices, []);
    t.mock.timers.tick(1);
    assert.equal(notices.length, 1);
    assert.deepEqual(notices[0], { mergedRemoteCellCount: 0, removedEditedCellCount: 0 });
    tracker.dispose();
  });

  it("fires after a restored pending-local-edit marker reaches online", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { notices, tracker } = tracked();

    tracker.notePersistedPendingLocalWork();
    tracker.noteConnectionStatus("online");

    t.mock.timers.tick(SETTLE_MS);
    assert.equal(notices.length, 1);
    assert.deepEqual(notices[0], { mergedRemoteCellCount: 0, removedEditedCellCount: 0 });
    tracker.dispose();
  });

  it("ignores a restored pending marker while the session is ineligible", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { notices, tracker } = tracked();

    tracker.noteSessionEligibility(false);
    tracker.notePersistedPendingLocalWork();
    tracker.noteConnectionStatus("online");

    t.mock.timers.tick(60_000);
    assert.deepEqual(notices, []);
    tracker.dispose();
  });

  it("stays silent on a clean reconnect with nothing pending", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { notices, tracker } = tracked();

    tracker.noteConnectionStatus("reconnecting");
    tracker.noteConnectionStatus("online");
    t.mock.timers.tick(60_000);
    assert.deepEqual(notices, []);
    tracker.dispose();
  });

  it("stays silent across pending-free flaps", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { notices, tracker } = tracked();

    for (let i = 0; i < 5; i += 1) {
      tracker.noteConnectionStatus("reconnecting");
      tracker.noteConnectionStatus("connecting");
      tracker.noteConnectionStatus("online");
    }
    t.mock.timers.tick(60_000);
    assert.deepEqual(notices, []);
    tracker.dispose();
  });

  it("ignores local doc activity and edits outside the offline window", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { notices, tracker } = tracked();

    // Online edits are ordinary sync, not offline work.
    tracker.noteLocalDocActivity();
    tracker.noteLocalCellEdit("cell-a");
    tracker.noteConnectionStatus("reconnecting");
    tracker.noteConnectionStatus("online");
    t.mock.timers.tick(60_000);
    assert.deepEqual(notices, []);
    tracker.dispose();
  });

  it("counts distinct remote-touched cells during the settle window", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { notices, tracker } = tracked();

    tracker.noteConnectionStatus("reconnecting");
    tracker.noteLocalDocActivity();
    tracker.noteConnectionStatus("online");
    tracker.noteRemoteCellChanges({
      changed: [{ cell_id: "cell-b" }, { cell_id: "cell-c" }],
      added: ["cell-d"],
      removed: [],
    });
    tracker.noteRemoteCellChanges({
      changed: [{ cell_id: "cell-b" }], // repeat — deduplicated
      added: [],
      removed: ["cell-e"],
    });
    t.mock.timers.tick(SETTLE_MS);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].mergedRemoteCellCount, 4);
    tracker.dispose();
  });

  it("discounts successful local mutation echoes during the settle window", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { notices, tracker } = tracked();

    tracker.noteConnectionStatus("reconnecting");
    tracker.noteLocalCellEdit("cell-a");
    tracker.noteConnectionStatus("online");
    tracker.noteLocalCellEdit("local-changed", { discountEcho: true });
    tracker.noteLocalCellEdit("local-added", { discountEcho: true });
    tracker.noteLocalCellDelete("local-removed", { discountEcho: true });
    tracker.noteRemoteCellChanges({
      changed: [{ cell_id: "local-changed" }, { cell_id: "remote-changed" }],
      added: ["local-added"],
      removed: ["local-removed"],
    });

    t.mock.timers.tick(SETTLE_MS);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].mergedRemoteCellCount, 1);
    tracker.dispose();
  });

  it("drops the count (null) when a full-materialization changeset is seen", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { notices, tracker } = tracked();

    tracker.noteConnectionStatus("reconnecting");
    tracker.noteLocalDocActivity();
    tracker.noteConnectionStatus("online");
    tracker.noteRemoteCellChanges({ changed: [{ cell_id: "cell-b" }], added: [], removed: [] });
    tracker.noteRemoteCellChanges(null);
    tracker.noteRemoteCellChanges({ changed: [{ cell_id: "cell-c" }], added: [], removed: [] });
    t.mock.timers.tick(SETTLE_MS);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].mergedRemoteCellCount, null, "unknowable, never guessed");
    tracker.dispose();
  });

  it("ignores remote changesets outside the settle window", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { notices, tracker } = tracked();

    tracker.noteRemoteCellChanges({ changed: [{ cell_id: "cell-x" }], added: [], removed: [] });
    tracker.noteConnectionStatus("reconnecting");
    tracker.noteLocalDocActivity();
    tracker.noteConnectionStatus("online");
    t.mock.timers.tick(SETTLE_MS);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].mergedRemoteCellCount, 0);
    tracker.dispose();
  });

  it("reports a cell edited offline that is absent post-resync", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { notices, tracker } = tracked(() => ["cell-a", "cell-b"]);

    tracker.noteConnectionStatus("reconnecting");
    tracker.noteLocalCellEdit("cell-gone");
    tracker.noteLocalCellEdit("cell-a"); // still present — not counted
    tracker.noteConnectionStatus("online");
    t.mock.timers.tick(SETTLE_MS);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].removedEditedCellCount, 1);
    tracker.dispose();
  });

  it("an edit alone marks local work pending (flush may land post-resync)", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { notices, tracker } = tracked();

    tracker.noteConnectionStatus("reconnecting");
    tracker.noteLocalCellEdit("cell-a"); // no noteLocalDocActivity — debounce had not fired
    tracker.noteConnectionStatus("online");
    t.mock.timers.tick(SETTLE_MS);
    assert.equal(notices.length, 1);
    tracker.dispose();
  });

  it("does not blame collaborators for the user's own delete", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { notices, tracker } = tracked(() => ["cell-a"]);

    tracker.noteConnectionStatus("reconnecting");
    tracker.noteLocalCellEdit("cell-gone");
    tracker.noteLocalCellDelete("cell-gone");
    tracker.noteLocalDocActivity();
    tracker.noteConnectionStatus("online");
    t.mock.timers.tick(SETTLE_MS);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].removedEditedCellCount, 0);
    tracker.dispose();
  });

  it("distrusts an empty projection instead of reporting mass deletion", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { notices, tracker } = tracked(() => []);

    tracker.noteConnectionStatus("reconnecting");
    tracker.noteLocalCellEdit("cell-a");
    tracker.noteConnectionStatus("online");
    t.mock.timers.tick(SETTLE_MS);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].removedEditedCellCount, 0);
    tracker.dispose();
  });

  it("a drop during settling resumes the SAME outage and still fires once", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { notices, tracker } = tracked();

    tracker.noteConnectionStatus("reconnecting");
    tracker.noteLocalCellEdit("cell-gone");
    tracker.noteConnectionStatus("online");
    t.mock.timers.tick(SETTLE_MS - 100);
    tracker.noteConnectionStatus("reconnecting"); // outage resumes pre-settle
    t.mock.timers.tick(60_000);
    assert.deepEqual(notices, [], "cancelled settle never fires");

    tracker.noteConnectionStatus("online");
    t.mock.timers.tick(SETTLE_MS);
    assert.equal(notices.length, 1, "single notice for the whole outage");
    tracker.dispose();
  });

  it("repeated reconnecting deliveries are no-ops within one outage", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { notices, tracker } = tracked();

    tracker.noteConnectionStatus("reconnecting");
    tracker.noteLocalDocActivity();
    tracker.noteConnectionStatus("reconnecting");
    tracker.noteConnectionStatus("connecting");
    tracker.noteConnectionStatus("reconnecting");
    tracker.noteConnectionStatus("online");
    t.mock.timers.tick(SETTLE_MS);
    assert.equal(notices.length, 1);
    tracker.dispose();
  });

  it("firing resets state — the next flap needs fresh pending work", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { notices, tracker } = tracked();

    tracker.noteConnectionStatus("reconnecting");
    tracker.noteLocalDocActivity();
    tracker.noteConnectionStatus("online");
    t.mock.timers.tick(SETTLE_MS);
    assert.equal(notices.length, 1);

    tracker.noteConnectionStatus("reconnecting");
    tracker.noteConnectionStatus("online");
    t.mock.timers.tick(60_000);
    assert.equal(notices.length, 1, "clean follow-up reconnect stays silent");
    tracker.dispose();
  });

  it("terminal manual disconnect clears the window without firing", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { notices, tracker } = tracked();

    tracker.noteConnectionStatus("reconnecting");
    tracker.noteLocalCellEdit("cell-a");
    tracker.noteConnectionStatus("offline");
    tracker.noteConnectionStatus("online");
    t.mock.timers.tick(60_000);
    assert.deepEqual(notices, []);
    tracker.dispose();
  });

  it("ineligible (anonymous) sessions are inert", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { notices, tracker } = tracked();

    tracker.noteSessionEligibility(false);
    tracker.noteConnectionStatus("reconnecting");
    tracker.noteLocalDocActivity();
    tracker.noteLocalCellEdit("cell-a");
    tracker.noteConnectionStatus("online");
    t.mock.timers.tick(60_000);
    assert.deepEqual(notices, []);
    tracker.dispose();
  });

  it("going ineligible mid-window drops tracked state", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { notices, tracker } = tracked();

    tracker.noteConnectionStatus("reconnecting");
    tracker.noteLocalDocActivity();
    tracker.noteSessionEligibility(false);
    tracker.noteSessionEligibility(true);
    tracker.noteConnectionStatus("online");
    t.mock.timers.tick(60_000);
    assert.deepEqual(notices, []);
    tracker.dispose();
  });

  it("dispose cancels an armed settle timer", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { notices, tracker } = tracked();

    tracker.noteConnectionStatus("reconnecting");
    tracker.noteLocalDocActivity();
    tracker.noteConnectionStatus("online");
    tracker.dispose();
    t.mock.timers.tick(60_000);
    assert.deepEqual(notices, []);
  });
});
