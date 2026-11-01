// The viewer-sync-status table, run through the pure machine, and the labels
// it renders. PageSession's use of it is covered in receipt-reconnect.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import {
  LINKS,
  statusLabel,
  syncStatusLabel,
  viewerSyncStatusMachine,
} from "./sync-status-machine.mjs";

const TABLE = new URL("../test/fixtures/machines/viewer-sync-status.json", import.meta.url);

test("the viewer-sync-status table runs through the pure machine", async () => {
  assert.deepEqual(await runTable(viewerSyncStatusMachine, loadTable(TABLE)), {
    rows: 68,
    pairs: 37,
    unreachable: 5,
    cases: 41,
  });
});

test("opening after the receipt queue started is a bug, not a quiet no-op", () => {
  const syncing = { name: "syncing", revision: 1, pending: false, link: "connected" };
  assert.throws(
    () => viewerSyncStatusMachine.step(syncing, { type: "opened", pending: false }),
    /unreachable/,
  );
});

// Every state × link × local copy, written out. Offline outranks all but a
// local save; a pending edit outranks reconnecting.
const LABELS = {
  idle: {
    connecting: ["Connecting", "Saved locally"],
    connected: ["Connected", "Connected"],
    reconnecting: ["Reconnecting", "Reconnecting"],
    offline: ["Offline", "Saved locally"],
  },
  syncing: {
    connecting: ["Syncing", "Syncing"],
    connected: ["Syncing", "Syncing"],
    reconnecting: ["Reconnecting", "Reconnecting"],
    offline: ["Offline", "Offline"],
  },
  saving: {
    connecting: ["Saving", "Saving"],
    connected: ["Saving", "Saving"],
    reconnecting: ["Saving", "Saving"],
    offline: ["Offline", "Offline"],
  },
  saved: {
    connecting: ["Saved", "Saved"],
    connected: ["Saved", "Saved"],
    reconnecting: ["Reconnecting", "Reconnecting"],
    offline: ["Offline", "Offline"],
  },
  local: {
    connecting: ["Saved locally", "Saved locally"],
    connected: ["Saved locally", "Saved locally"],
    reconnecting: ["Reconnecting", "Reconnecting"],
    offline: ["Saved locally", "Saved locally"],
  },
  unsaved: {
    connecting: ["Unsaved", "Unsaved"],
    connected: ["Unsaved", "Unsaved"],
    reconnecting: ["Reconnecting", "Reconnecting"],
    offline: ["Offline", "Offline"],
  },
};

test("every state, link and local copy renders one label", () => {
  assert.deepEqual(Object.keys(LABELS), [...viewerSyncStatusMachine.states]);
  for (const name of viewerSyncStatusMachine.states)
    for (const link of LINKS)
      for (const [index, localCopy] of [false, true].entries()) {
        const pending = name === "saving" || (name !== "syncing" && name !== "saved" && localCopy);
        const state = { name, revision: 1, pending, link };
        viewerSyncStatusMachine.assertState(state);
        assert.equal(
          syncStatusLabel(state, { localCopy }),
          LABELS[name][link][index],
          `${name} / ${link} / localCopy ${localCopy}`,
        );
      }
});

test("catching up says Syncing and never Saving", () => {
  let state = viewerSyncStatusMachine.initial;
  const labels = [];
  const step = (event) => {
    const result = viewerSyncStatusMachine.step(state, event);
    assert.equal(result.rejected, undefined, JSON.stringify(event));
    state = result.state;
    labels.push(syncStatusLabel(state, { localCopy: true }));
  };
  step({ type: "opened", pending: false });
  step({ type: "admitted" });
  for (let revision = 1; revision <= 20; revision++)
    step({ type: "queued", revision, edit: false });
  step({ type: "acknowledged", revision: 20 });
  assert.deepEqual(labels, ["Saved locally", "Connected", ...Array(20).fill("Syncing"), "Saved"]);
});

test("a phase pause or a failed local save outranks the receipt", () => {
  const saving = { name: "saving", revision: 1, pending: true, link: "offline" };
  const flags = ["deleted", "accessDenied", "accessReloadRequired", "authRequired", "localFailed"];
  const labels = [
    "Deleted",
    "Access removed",
    "Access changed",
    "Sign in to sync",
    "Local save failed",
  ];
  for (let i = 0; i < flags.length; i++) {
    // Every weaker flag is also set; the strongest one wins.
    const set = Object.fromEntries(flags.slice(i).map((flag) => [flag, true]));
    assert.equal(statusLabel(saving, set), labels[i], flags[i]);
  }
  assert.equal(statusLabel(saving), "Offline");
  assert.equal(statusLabel({ ...saving, link: "connected" }), "Saving");
});
