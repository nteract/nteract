// The bucket archive of view library catalog revisions: its lifecycle over
// every state and event, and the copy from the build's assets.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  EFFECT_DEADLINE_MS,
  archiveKey,
  archiveTransition,
  copyRevision,
  libraryArchive,
  retryDelayMs,
} from "./library-archive.mjs";
import { Bucket, assetsBinding, catalogFixture } from "./library-archive-fixture.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const origin = "https://pages.example";

const STATES = [
  { kind: "unknown" },
  { kind: "checking", attempts: 0, deadline: 1_000 },
  { kind: "checking", attempts: 2, deadline: 1_000 },
  { kind: "copying", attempts: 0, deadline: 1_000 },
  { kind: "copying", attempts: 2, deadline: 1_000 },
  { kind: "archived" },
  { kind: "failed", attempts: 1, retryAt: 1_000 },
];
// 1_000 is each in-flight state's deadline and the failed state's retry time.
const EVENTS = [
  { type: "request", now: 999 },
  { type: "request", now: 1_000 },
  { type: "present" },
  { type: "absent", now: 700 },
  { type: "copied" },
  { type: "failed", now: 500 },
];

/** The expected next state for every state and event. */
function expected(state, event) {
  const key = `${state.kind}:${event.type}`;
  switch (key) {
    case "unknown:request":
      return { kind: "checking", attempts: 0, deadline: event.now + EFFECT_DEADLINE_MS };
    case "failed:request":
      return event.now >= state.retryAt
        ? { kind: "checking", attempts: state.attempts, deadline: event.now + EFFECT_DEADLINE_MS }
        : state;
    // An effect still in flight at its deadline counts as a failure.
    case "checking:request":
    case "copying:request":
      return event.now >= state.deadline
        ? {
            kind: "failed",
            attempts: state.attempts + 1,
            retryAt: event.now + retryDelayMs(state.attempts + 1),
          }
        : state;
    case "checking:present":
      return { kind: "archived" };
    case "checking:absent":
      return {
        kind: "copying",
        attempts: state.attempts,
        deadline: event.now + EFFECT_DEADLINE_MS,
      };
    case "copying:copied":
      return { kind: "archived" };
    case "checking:failed":
    case "copying:failed":
      return {
        kind: "failed",
        attempts: state.attempts + 1,
        retryAt: event.now + retryDelayMs(state.attempts + 1),
      };
    default:
      return state;
  }
}

for (const state of STATES)
  for (const event of EVENTS)
    test(`archive lifecycle: ${JSON.stringify(state)} on ${JSON.stringify(event)}`, () => {
      const next = archiveTransition(state, event);
      assert.deepEqual(next, expected(state, event));
      // A transition that changes nothing returns the same state.
      if (JSON.stringify(next) === JSON.stringify(state)) assert.equal(next, state);
    });

test("an unknown event leaves every state unchanged", () => {
  for (const state of STATES) assert.equal(archiveTransition(state, { type: "other" }), state);
});

test("the wait after a failure doubles from a minute to at most an hour", () => {
  assert.deepEqual(
    [1, 2, 3, 6, 7, 8, 20].map(retryDelayMs),
    [60_000, 120_000, 240_000, 1_920_000, 3_600_000, 3_600_000, 3_600_000],
  );
});

test("the copy puts every listed file, checked, and then the manifest", async () => {
  const { revision, manifest, files } = catalogFixture();
  const bucket = new Bucket();
  await copyRevision({ assets: assetsBinding(files), bucket, origin, revision });
  assert.deepEqual(
    bucket.calls.map(([method, key]) => `${method} ${key}`),
    [
      `put catalog/${revision}/shout.js`,
      `put catalog/${revision}/sift.wasm`,
      `put catalog/${revision}/manifest.json`,
    ],
  );
  assert.equal(
    new TextDecoder().decode(bucket.objects.get(archiveKey(revision, "manifest.json"))),
    manifest,
  );
  for (const [path, [bytes]] of files)
    assert.deepEqual(bucket.objects.get(path.slice(1)), new Uint8Array(bytes));
});

for (const [what, tamper, reason] of [
  [
    "a manifest whose sha256 is not the revision",
    ({ files, revision }) => {
      const path = `/catalog/${revision}/manifest.json`;
      files.set(path, [new TextEncoder().encode('{"files":{}}\n'), "application/json"]);
    },
    "manifest_digest",
  ],
  [
    "a file whose bytes differ from the manifest",
    ({ files, revision }) => {
      files.set(`/catalog/${revision}/sift.wasm`, [new Uint8Array([1]), "application/wasm"]);
    },
    "file_digest",
  ],
  [
    "a listed file the assets answer with the HTML shell",
    ({ files, revision }) => files.delete(`/catalog/${revision}/sift.wasm`),
    "asset_missing",
  ],
])
  test(`the copy refuses ${what} and writes no manifest`, async () => {
    const fixture = catalogFixture();
    tamper(fixture);
    const bucket = new Bucket();
    await assert.rejects(
      copyRevision({
        assets: assetsBinding(fixture.files),
        bucket,
        origin,
        revision: fixture.revision,
      }),
      { message: reason },
    );
    assert.equal(bucket.objects.has(archiveKey(fixture.revision, "manifest.json")), false);
  });

test("the copy refuses a manifest naming a file outside the catalog's names", async () => {
  const manifest = JSON.stringify({ files: { "../pages/x.js": sha256("x") } });
  const revision = sha256(manifest);
  const files = new Map([
    [
      `/catalog/${revision}/manifest.json`,
      [new TextEncoder().encode(manifest), "application/json"],
    ],
  ]);
  const bucket = new Bucket();
  await assert.rejects(copyRevision({ assets: assetsBinding(files), bucket, origin, revision }), {
    message: "file_name",
  });
  assert.deepEqual(bucket.calls, []);
});

test("an isolate archives a revision once, and a second request reads nothing", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { revision, files } = catalogFixture();
  const assets = assetsBinding(files);
  const bucket = new Bucket();
  const archive = libraryArchive();
  const io = { revision, assets, bucket, origin };
  // Two requests in flight together start one check and one copy.
  await Promise.all([archive.request(io), archive.request(io)]);
  assert.deepEqual(archive.state(revision), { kind: "archived" });
  assert.equal(bucket.calls.filter(([method]) => method === "head").length, 1);
  assert.equal(bucket.calls.filter(([method]) => method === "put").length, 3);
  const before = { bucket: bucket.calls.length, assets: assets.requests.length };
  await archive.request(io);
  assert.deepEqual({ bucket: bucket.calls.length, assets: assets.requests.length }, before);
});

test("a revision the bucket already holds is archived after one head", async () => {
  const { revision, files } = catalogFixture();
  const assets = assetsBinding(files);
  const bucket = new Bucket();
  bucket.objects.set(archiveKey(revision, "manifest.json"), new Uint8Array([1]));
  const archive = libraryArchive();
  await archive.request({ revision, assets, bucket, origin });
  assert.deepEqual(archive.state(revision), { kind: "archived" });
  assert.deepEqual(bucket.calls, [["head", archiveKey(revision, "manifest.json")]]);
  assert.deepEqual(assets.requests, []);
});

test("a failed archive logs the revision, waits, then retries and completes", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const { revision, files } = catalogFixture();
  const assets = assetsBinding(files);
  const bucket = new Bucket();
  bucket.fail = "put";
  let clock = 10_000;
  const archive = libraryArchive({ now: () => clock });
  const io = { revision, assets, bucket, origin };
  await archive.request(io);
  assert.deepEqual(archive.state(revision), {
    kind: "failed",
    attempts: 1,
    retryAt: 10_000 + 60_000,
  });
  assert.equal(warn.mock.callCount(), 1);
  const line = JSON.parse(warn.mock.calls[0].arguments[0]);
  assert.deepEqual(Object.keys(line).sort(), [
    "event",
    "reason",
    "revision",
    "service",
    "timestamp",
  ]);
  assert.equal(line.event, "library_catalog.archive_failed");
  assert.equal(line.revision, revision);
  assert.equal(line.reason, "bucket_or_asset_error");
  // Before the wait ends, a request touches neither the bucket nor the assets.
  bucket.fail = null;
  const before = bucket.calls.length;
  clock += 59_999;
  await archive.request(io);
  assert.equal(bucket.calls.length, before);
  assert.equal(archive.state(revision).kind, "failed");
  clock += 1;
  await archive.request(io);
  assert.deepEqual(archive.state(revision), { kind: "archived" });
  assert.ok(bucket.objects.has(archiveKey(revision, "manifest.json")));
});

test("a refused copy is logged with its reason and fails without a manifest", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const fixture = catalogFixture();
  fixture.files.set(`/catalog/${fixture.revision}/shout.js`, [
    new TextEncoder().encode("changed"),
    "text/javascript",
  ]);
  const bucket = new Bucket();
  const archive = libraryArchive({ now: () => 0 });
  await archive.request({
    revision: fixture.revision,
    assets: assetsBinding(fixture.files),
    bucket,
    origin,
  });
  assert.equal(archive.state(fixture.revision).kind, "failed");
  assert.equal(JSON.parse(warn.mock.calls[0].arguments[0]).reason, "file_digest");
  assert.equal(bucket.objects.has(archiveKey(fixture.revision, "manifest.json")), false);
});

test("a copy that never settles fails at its deadline, is logged, and a later request archives", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const { revision, files } = catalogFixture();
  const working = assetsBinding(files);
  // The first copy's asset read never answers, as work dropped after its
  // request would look from this isolate.
  let hang = true;
  const assets = {
    fetch: (request) => (hang ? new Promise(() => {}) : working.fetch(request)),
  };
  const bucket = new Bucket();
  let clock = 0;
  const archive = libraryArchive({ now: () => clock });
  const io = { revision, assets, bucket, origin };
  archive.request(io);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(archive.state(revision).kind, "copying");
  // Before the deadline a request starts nothing more.
  clock = EFFECT_DEADLINE_MS - 1;
  await archive.request(io);
  assert.equal(archive.state(revision).kind, "copying");
  assert.equal(warn.mock.callCount(), 0);
  clock = EFFECT_DEADLINE_MS;
  await archive.request(io);
  assert.deepEqual(archive.state(revision), {
    kind: "failed",
    attempts: 1,
    retryAt: EFFECT_DEADLINE_MS + 60_000,
  });
  assert.equal(JSON.parse(warn.mock.calls[0].arguments[0]).reason, "deadline");
  hang = false;
  clock += 60_000;
  await archive.request(io);
  assert.deepEqual(archive.state(revision), { kind: "archived" });
  assert.ok(bucket.objects.has(archiveKey(revision, "manifest.json")));
});
