// The viewer-sync-status table, run through the pure machine, and the labels
// it renders. PageSession's use of it is covered in receipt-reconnect.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import {
  LINKS,
  OVERLAY_FLAGS,
  STATUS_KEYS,
  fullStatus,
  overlayStatus,
  statusLabel,
  syncStatus,
  syncStatusLabel,
  viewerSyncStatusMachine,
} from "./sync-status-machine.mjs";

const TABLE = new URL("../test/fixtures/machines/viewer-sync-status.json", import.meta.url);

test("the viewer-sync-status table runs through the pure machine", async () => {
  assert.deepEqual(await runTable(viewerSyncStatusMachine, loadTable(TABLE)), {
    rows: 89,
    pairs: 50,
    unreachable: 6,
    cases: 51,
  });
});

test("opening after the receipt queue started is a bug, not a quiet no-op", () => {
  const syncing = { name: "syncing", revision: 1, pending: false, link: "connected" };
  assert.throws(
    () => viewerSyncStatusMachine.step(syncing, { type: "opened", pending: false }),
    /unreachable/,
  );
});

const DIRTY = new Set(["quiet", "saving"]);
/** A valid state named `name`; a quiet save armed its timer at its revision. */
const example = (name, link, pending = DIRTY.has(name)) => ({
  name,
  revision: 1,
  pending,
  link,
  ...(name === "quiet" && { armed: 1 }),
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
  quiet: {
    connecting: ["Saving", "Saving"],
    connected: ["Saving", "Saving"],
    reconnecting: ["Saving", "Saving"],
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
        const pending = DIRTY.has(name) || (name !== "syncing" && name !== "saved" && localCopy);
        const state = example(name, link, pending);
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

// The presentation keys for every label the machine renders. Presentation
// branches on the key, so this table is what a reworded label must keep.
// Saving has two: a quiet save keeps the label PageSession and the reload gate
// read, and is drawn as nothing.
const KEYS = {
  Connecting: ["connecting"],
  Reconnecting: ["connecting"],
  Connected: ["connected"],
  Syncing: ["syncing"],
  Saving: ["quiet", "saving"],
  Saved: ["saved"],
  "Saved locally": ["attention"],
  Offline: ["attention"],
  Deleted: ["attention"],
  "Access removed": ["attention"],
  "Access changed": ["attention"],
  "Sign in to sync": ["attention"],
  Unsaved: ["failed"],
  "Local save failed": ["failed"],
};

test("every rendered status carries its presentation key", () => {
  const seen = new Set();
  const check = (status, context) => {
    assert.ok(STATUS_KEYS.includes(status.key), context);
    assert.ok(KEYS[status.label]?.includes(status.key), `${context}: ${status.label}`);
    seen.add(`${status.label}/${status.key}`);
  };
  for (const name of viewerSyncStatusMachine.states)
    for (const link of LINKS)
      for (const localCopy of [false, true]) {
        const state = example(name, link);
        check(syncStatus(state, { localCopy }), `${name} / ${link} / ${localCopy}`);
        assert.deepEqual(fullStatus(state, { localCopy }), syncStatus(state, { localCopy }));
      }
  const saving = { name: "saving", revision: 1, pending: true, link: "connected" };
  for (const flag of OVERLAY_FLAGS) {
    check(overlayStatus(flag), flag);
    assert.deepEqual(fullStatus(saving, { [flag]: true }), overlayStatus(flag), flag);
    assert.equal(statusLabel(saving, { [flag]: true }), overlayStatus(flag).label, flag);
  }
  // Every key in the table is reachable, so the table can't hold stale labels.
  const all = Object.entries(KEYS).flatMap(([label, keys]) => keys.map((key) => `${label}/${key}`));
  assert.deepEqual([...seen].sort(), all.sort());
  assert.deepEqual(new Set(all.map((pair) => pair.split("/")[1])), new Set(STATUS_KEYS));
  assert.throws(() => overlayStatus("readOnly"), /unknown status overlay/);
});
