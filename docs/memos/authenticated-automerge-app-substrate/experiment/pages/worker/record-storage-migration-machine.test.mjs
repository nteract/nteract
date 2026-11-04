import assert from "node:assert/strict";
import { test } from "node:test";
import { runTable } from "../shared/machine-test.mjs";
import {
  MAX_BACKOFF_MS,
  backoffMs,
  migrationStart,
  recordStorageMigration,
} from "./record-storage-migration.mjs";

const q = 1000;
const s = (name, extra = {}) => ({ name, attempts: 0, quietMs: q, ...extra });
const activity = (sockets, requests = 0) => ({
  type: "activity",
  sockets,
  requests,
});
const ok = (state, effects = []) => ({ state, effects });
const no = (state, rejected) => ({ state, effects: [], rejected });

test("record-storage-migration covers every state and event", () => {
  runTable(recordStorageMigration, [
    {
      state: { name: "off" },
      event: activity(1),
      expect: no({ name: "off" }, "this object never converts"),
    },
    {
      state: { name: "retired" },
      event: activity(0),
      expect: no({ name: "retired" }, "the record already says plain"),
    },
    {
      case: "socket",
      state: s("dormant"),
      event: activity(1),
      expect: ok(s("connected")),
    },
    {
      label: "a request alone, as a listing check, makes nothing eligible",
      case: "no-socket",
      state: s("dormant"),
      event: activity(0, 2),
      expect: no(s("dormant"), "only a browser session makes a Page eligible"),
    },
    {
      case: "idle",
      state: s("connected"),
      event: activity(0, 0),
      expect: ok(s("quiet"), [{ type: "arm", ms: q }]),
    },
    {
      case: "busy",
      state: s("connected"),
      event: activity(0, 1),
      expect: ok(s("connected")),
    },
    {
      state: s("connected"),
      event: { type: "elapsed" },
      expect: no(s("connected"), "a stale timer"),
    },
    {
      case: "idle",
      state: s("quiet"),
      event: activity(0, 0),
      expect: ok(s("quiet")),
    },
    {
      case: "busy",
      state: s("quiet"),
      event: activity(1, 0),
      expect: ok(s("connected"), [{ type: "disarm" }]),
    },
    {
      state: s("quiet"),
      event: { type: "elapsed" },
      expect: ok(s("converting"), [{ type: "convert" }]),
    },
    {
      state: s("converting"),
      event: activity(0, 1),
      expect: ok(s("converting", { busy: true })),
    },
    {
      state: s("converting"),
      event: { type: "elapsed" },
      expect: no(s("converting"), "a stale timer"),
    },
    {
      state: s("converting"),
      event: { type: "converted" },
      expect: ok({ name: "retired" }, [{ type: "retire" }]),
    },
    {
      state: s("converting", { attempts: 2 }),
      event: { type: "skipped", reason: "journal_pending" },
      expect: ok({ name: "backoff", attempts: 3, quietMs: q, busy: false }, [
        { type: "arm", ms: 4 * q },
      ]),
    },
    {
      state: s("converting", { busy: true }),
      event: { type: "failed" },
      expect: ok({ name: "backoff", attempts: 1, quietMs: q, busy: true }, [
        { type: "arm", ms: q },
      ]),
    },
    {
      state: s("backoff", { busy: false }),
      event: activity(1),
      expect: ok(s("backoff", { busy: true })),
    },
    {
      case: "idle",
      state: s("backoff", { busy: false }),
      event: { type: "elapsed" },
      expect: ok(s("quiet"), [{ type: "arm", ms: q }]),
    },
    {
      case: "busy",
      state: s("backoff", { busy: true }),
      event: { type: "elapsed" },
      expect: ok(s("connected")),
    },
  ]);
});

test("the backoff doubles from the quiet window and stops at six hours", () => {
  assert.equal(backoffMs(0, q), q);
  assert.equal(backoffMs(3, q), 8 * q);
  assert.equal(backoffMs(40, q), MAX_BACKOFF_MS);
});

test("only a live Subduction Page with both switches on starts eligible", () => {
  const env = {
    PAGES_RECORD_STORAGE: "automerge",
    PAGES_MIGRATE_RECORD_STORAGE: "true",
  };
  const live = { documentId: "d", recordStorage: "buffered" };
  assert.equal(migrationStart(env, live).name, "dormant");
  assert.equal(migrationStart({ ...env, PAGES_MIGRATE_QUIET_MS: "250" }, live).quietMs, 250);
  assert.equal(migrationStart(env, { ...live, recordStorage: "automerge" }).name, "off");
  assert.equal(migrationStart(env, { ...live, deleted: true }).name, "off");
  assert.equal(
    migrationStart({ ...env, PAGES_MIGRATE_RECORD_STORAGE: undefined }, live).name,
    "off",
  );
  assert.equal(migrationStart({ ...env, PAGES_RECORD_STORAGE: undefined }, live).name, "off");
});
