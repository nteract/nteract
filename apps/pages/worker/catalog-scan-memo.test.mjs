import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_KEYS, countedStorage } from "./catalog-counts.mjs";
import { locationScan } from "./catalog-location.mjs";
import { emptyScanMemo, locationScanMemo, scanMemo } from "./catalog-scan-memo.mjs";
import { Storage, world } from "./projects-fixture.mjs";
import { PHASE_TIMING_HEADER, TIMING_REQUEST_HEADER, parseTiming } from "./server-timing.mjs";

/** Storage that counts each `page/` listing (one per location scan of a
 * small account, though other passes list `page/` too) and can fail chosen
 * puts. */
class CountingStorage extends Storage {
  scans = 0;
  failPut = null;
  async list(options = {}) {
    if (options.prefix === "page/") this.scans++;
    return super.list(options);
  }
  async put(key, value) {
    if (typeof key === "string" && this.failPut?.(key)) throw Error("injected put failure");
    return super.put(key, value);
  }
}

test("scanMemo: every state and event", () => {
  const scan = { entries: new Map(), contents: new Map(), counts: {} };
  const other = { entries: new Map(), contents: new Map(), counts: {} };
  const held = { generation: 2, writing: 0, held: { scan, verified: false } };
  const writing = { generation: 3, writing: 1, held: null };

  // A covered write drops what is held, from any state.
  for (const state of [emptyScanMemo, held, writing])
    assert.deepEqual(scanMemo(state, { type: "write_issued" }).state, {
      generation: state.generation + 1,
      writing: state.writing + 1,
      held: null,
    });
  assert.deepEqual(scanMemo(writing, { type: "write_settled" }).state, {
    generation: 4,
    writing: 0,
    held: null,
  });
  assert.equal(scanMemo(held, { type: "write_settled" }).rejected, "no write is in flight");
  assert.equal(
    scanMemo(emptyScanMemo, { type: "write_settled" }).rejected,
    "no write is in flight",
  );

  // A scan is kept only when no write was issued or in flight while it ran.
  const kept = scanMemo(emptyScanMemo, { type: "scanned", generation: 0, scan });
  assert.equal(kept.kept, true);
  assert.deepEqual(kept.state.held, { scan, verified: false });
  assert.equal(scanMemo(writing, { type: "scanned", generation: 3, scan }).kept, false);
  assert.equal(scanMemo(held, { type: "scanned", generation: 1, scan }).kept, false);
  assert.equal(scanMemo(held, { type: "scanned", generation: 1, scan }).state, held);

  // `verified` marks only the scan it names.
  assert.equal(scanMemo(held, { type: "verified", scan }).state.held.verified, true);
  assert.equal(scanMemo(held, { type: "verified", scan: other }).state, held);
  assert.equal(scanMemo(emptyScanMemo, { type: "verified", scan }).state, emptyScanMemo);
  assert.equal(scanMemo(held, { type: "nonsense" }).rejected, "unknown event");
});

test("writing() ignores keys a scan doesn't cover, and a transaction covers all", () => {
  const memo = locationScanMemo();
  memo.writing(["space/x", "shared/y", "host/count/active", "project-discovery/z"])();
  assert.equal(memo.state.generation, 0);
  const settle = memo.writing(["host/x", "trash/y"]);
  assert.equal(memo.state.writing, 1);
  settle();
  settle();
  assert.equal(memo.state.writing, 0, "settling twice counts once");
  memo.writing(ALL_KEYS)();
  assert.equal(memo.state.generation, 4);
});

const locate = (catalog, query) =>
  catalog.fetch(
    new Request("https://pages.internal/internal/location", {
      method: "POST",
      body: JSON.stringify(query),
    }),
  );

async function memoWorld(t) {
  const w = await world(t, { storage: () => new CountingStorage() });
  const raw = () => w.catalogStorage();
  return { w, raw };
}

test("N location reads make one scan, and a listing reuses it", async (t) => {
  const { w, raw } = await memoWorld(t);
  const pageId = (await w.createPage({ title: "Plan" })).body.page_id;
  const before = raw().scans;
  for (let n = 0; n < 10; n++) {
    const response = await locate(w.catalog(), { page_id: pageId });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).page_id, pageId);
  }
  assert.equal(raw().scans - before, 1, "ten reads, one scan");
  // A timed listing counts the memo hit and doesn't scan.
  const response = await w.catalog().fetch(
    new Request("https://pages.invalid/internal/catalog", {
      method: "POST",
      headers: { authorization: `Bearer ${w.auth.apiKey()}`, [TIMING_REQUEST_HEADER]: "1" },
      body: JSON.stringify({ operation: "list_pages", arguments: {} }),
    }),
  );
  assert.equal(response.status, 200);
  const phases = parseTiming(response.headers.get(PHASE_TIMING_HEADER));
  // The index pass may list `page/` itself, so the hit is the measure here.
  assert.ok(phases.some((metric) => metric.name === "scan_memo" && metric.n === 1));
});

test("a write under each covered prefix forces a new scan, and results match an unmemoized scan", async (t) => {
  const { w, raw } = await memoWorld(t);
  const catalog = w.catalog();
  const project = await w.createProject("Docs");
  const root = (await w.createPage({ title: "Root" })).body.page_id;
  const child = (await w.createPage({ title: "Child", parent_id: root })).body.page_id;
  const lifecycle = (operation, args) =>
    w.call("owner", operation, { nonce: w.key(), ...args }).then((answer) => {
      assert.equal(answer.status, 200, `${operation}: ${JSON.stringify(answer.body)}`);
      return answer;
    });
  const steps = [
    ["create", () => w.createPage({ title: "Later" })],
    [
      "move into a Project",
      () => lifecycle("move_page", { page_id: root, project_id: project.project_id }),
    ],
    ["move out of a Project", () => lifecycle("move_page", { page_id: root, project_id: null })],
    ["trash", () => lifecycle("delete_page", { page_id: child })],
    ["restore", () => lifecycle("restore_page", { page_id: child })],
    ["trash again", () => lifecycle("delete_page", { page_id: child })],
    [
      "purge",
      async () => {
        const preview = await w.call("owner", "purge_page", { page_id: child, action: "preview" });
        assert.equal(preview.status, 200, JSON.stringify(preview.body));
        await lifecycle("purge_page", {
          page_id: child,
          action: "confirm",
          preview_token: preview.body.preview_token,
        });
      },
    ],
  ];
  for (const [name, step] of steps) {
    // Warm the memo, then write.
    await catalog.scans.read(catalog.storage);
    const warm = raw().scans;
    assert.equal((await catalog.scans.read(catalog.storage)).hit, true, `${name}: warm`);
    await step();
    await w.settle();
    const after = await catalog.scans.read(catalog.storage);
    assert.equal(after.hit, false, `${name}: the write dropped the scan`);
    assert.ok(raw().scans > warm, `${name}: scanned again`);
    assert.deepEqual(after.scan, await locationScan(raw()), `${name}: same as a fresh scan`);
    assert.deepEqual(
      (await catalog.scans.read(catalog.storage)).scan,
      await locationScan(raw()),
      `${name}: the kept scan matches`,
    );
  }
  const listed = await w.call("owner", "list_pages", { in_trash: true });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.pages.length, 0, "the purged Page is gone from Trash");
});

test("a failed write still drops the scan", async (t) => {
  const { w, raw } = await memoWorld(t);
  const catalog = w.catalog();
  const pageId = (await w.createPage({ title: "Plan" })).body.page_id;
  await catalog.scans.read(catalog.storage);
  const entry = await raw().get(`page/${pageId}`);
  raw().failPut = (key) => key.startsWith("page/");
  await assert.rejects(
    catalog.storage.put(`page/${pageId}`, { ...entry, parent_id: "x" }),
    /injected put failure/,
  );
  raw().failPut = null;
  assert.equal(catalog.scans.state.writing, 0);
  const scans = raw().scans;
  const read = await catalog.scans.read(catalog.storage);
  assert.equal(read.hit, false);
  assert.equal(raw().scans, scans + 1);
  assert.deepEqual(read.scan, await locationScan(raw()));
});

test("a scan that overlaps a write is answered but not kept", async (t) => {
  const storage = new CountingStorage();
  const memo = locationScanMemo();
  const counted = countedStorage(storage, { onWrite: (keys) => memo.writing(keys) });
  await counted.put("page/a", { page_id: "a", parent_id: null, position: "a0" });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const list = storage.list.bind(storage);
  storage.list = async (options) => {
    const answer = await list(options);
    if (options.prefix === "trash/") await gate;
    return answer;
  };
  const reading = memo.read(counted);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await counted.put("page/b", { page_id: "b", parent_id: null, position: "a1" });
  release();
  const first = await reading;
  assert.equal(first.hit, false);
  assert.deepEqual([...first.scan.entries.keys()], ["a"], "its own caller gets what it read");
  storage.list = list;
  const second = await memo.read(counted);
  assert.equal(second.hit, false, "the overlapping scan wasn't kept");
  assert.deepEqual([...second.scan.entries.keys()].sort(), ["a", "b"]);
  assert.equal((await memo.read(counted)).hit, true);
});

test("a transaction drops the scan even when it throws partway", async () => {
  const storage = new CountingStorage();
  storage.transaction = async (work) => work(storage);
  const memo = locationScanMemo();
  const counted = countedStorage(storage, { onWrite: (keys) => memo.writing(keys) });
  await memo.read(counted);
  const settled = memo.state.generation;
  await assert.rejects(
    counted.transaction(async (target) => {
      await target.put("page/a", { page_id: "a", parent_id: null, position: "a0" });
      throw Error("partway");
    }),
    /partway/,
  );
  assert.equal(memo.state.generation, settled + 2);
  const read = await memo.read(counted);
  assert.equal(read.hit, false);
  assert.deepEqual([...read.scan.entries.keys()], ["a"]);
});

test("callers can't change the kept scan", async () => {
  const storage = new CountingStorage();
  const memo = locationScanMemo();
  const counted = countedStorage(storage, { onWrite: (keys) => memo.writing(keys) });
  await counted.put("page/a", { page_id: "a", parent_id: null, position: "a0" });
  const first = await memo.read(counted);
  assert.throws(() => {
    first.scan.entries.get("a").parent_id = "elsewhere";
  }, TypeError);
  first.scan.entries.delete("a");
  first.scan.counts["page/"] = 99;
  const second = await memo.read(counted);
  assert.equal(second.hit, true);
  assert.equal(second.scan.entries.get("a").parent_id, null);
  assert.equal(second.scan.counts["page/"], 1);
});
