// The viewer-sync-status table, run through the pure machine, and the labels
// it renders. PageSession's use of it is covered in receipt-reconnect.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import {
  LINKS,
  STATUS_IDS,
  RETRYABLE_STATUS,
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
    connecting: ["Syncing", "Syncing"],
    connected: ["Syncing", "Syncing"],
    reconnecting: ["Syncing", "Syncing"],
    offline: ["Offline", "Offline"],
  },
  saving: {
    connecting: ["Syncing", "Syncing"],
    connected: ["Syncing", "Syncing"],
    reconnecting: ["Syncing", "Syncing"],
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
    connecting: ["Not saved", "Not saved"],
    connected: ["Not saved", "Not saved"],
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
  assert.equal(statusLabel({ ...saving, link: "connected" }), "Syncing");
});

// The presentation keys for every label the machine renders. Presentation
// branches on the key, so this table is what a reworded label must keep.
// Syncing has three: remote catch-up, a quiet save drawn as nothing, and a
// save still pending after SLOW_SAVE_MS.
const KEYS = {
  Connecting: ["connecting"],
  Reconnecting: ["connecting"],
  Connected: ["connected"],
  Syncing: ["syncing", "quiet", "saving"],
  Saved: ["saved"],
  "Saved locally": ["attention"],
  Offline: ["attention"],
  Deleted: ["attention"],
  "Access removed": ["attention"],
  "Access changed": ["attention"],
  "Sign in to sync": ["attention"],
  "Not saved": ["failed"],
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

// The id for every label: what the reload gate and close drain read. Labels
// can be reworded; these ids can't, without changing the gate.
const IDS = {
  Connecting: ["connecting"],
  Reconnecting: ["reconnecting"],
  Connected: ["connected"],
  Syncing: ["syncing", "saving"],
  Saved: ["saved"],
  "Saved locally": ["saved-locally"],
  Offline: ["offline"],
  "Not saved": ["unsaved"],
  Deleted: ["deleted"],
  "Access removed": ["access-removed"],
  "Access changed": ["access-changed"],
  "Sign in to sync": ["sign-in"],
  "Local save failed": ["local-failed"],
};

test("every rendered status carries a stable id, and local edits keep the saving id", () => {
  const seen = new Set();
  const check = (value, context) => {
    assert.ok(IDS[value.label]?.includes(value.id), `${context}: ${value.label} / ${value.id}`);
    seen.add(value.id);
  };
  for (const name of viewerSyncStatusMachine.states)
    for (const link of LINKS)
      for (const localCopy of [false, true]) {
        const value = syncStatus(example(name, link), { localCopy });
        check(value, `${name} / ${link} / ${localCopy}`);
        // Local edits, quiet or shown, are saving to the gate; remote catch-up
        // is syncing. Both read Syncing.
        if (DIRTY.has(name) && link !== "offline") assert.equal(value.id, "saving");
        if (name === "syncing" && ["connecting", "connected"].includes(link))
          assert.equal(value.id, "syncing");
      }
  for (const flag of OVERLAY_FLAGS) check(overlayStatus(flag), flag);
  assert.deepEqual([...seen].sort(), [...STATUS_IDS].sort());
});

test("the header's Retry reads status ids from this module, not labels", async () => {
  const { readFile } = await import("node:fs/promises");
  const main = await readFile(new URL("./main.jsx", import.meta.url), "utf8");
  assert.match(main, /import \{ RETRYABLE_STATUS \} from "\.\/sync-status-machine\.mjs";/);
  assert.match(main, /RETRYABLE_STATUS\.includes\(session\.statusId\)/);
  for (const id of RETRYABLE_STATUS) assert.ok(STATUS_IDS.includes(id), id);
});
