// PageRecords is delete-only; the one-shot sweep (page-records-sweep.mjs)
// and purge clear the objects buffered Pages left. Delete the sweep tests
// with the sweep, and the rest with the class.
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./index.mjs";
import { OPERATOR_SECRET_HEADER } from "./operator-gate.mjs";
import { PageRecords, inspectStorage } from "./page-records.mjs";
import { SWEEP_BATCH, sweepTotals } from "./page-records-sweep.mjs";
import { Storage, fixture, pageId } from "./trash-fixture.mjs";
import { sweepRun } from "../scripts/page-records-sweep-operator.mjs";

const SECRET = "s".repeat(48);
const CELL = (n) => n.toString(16).padStart(64, "0");

/** Durable Object storage with deleteAll, as celld provides it. */
class RecordStorage extends Storage {
  async deleteAll() {
    this.values.clear();
  }
}

/** A PageRecords object holding what a buffered Page wrote: records under
 * repo/, a generation and a batch sequence. */
async function oldRecords() {
  const storage = new RecordStorage();
  await storage.put("repo/subduction-v1/aa/commits/bb", new Uint8Array(1000));
  await storage.put("repo/subduction-v1/aa/fragments/cc", new Uint8Array(500));
  await storage.put("host/generation", "g-1");
  await storage.put("host/seq", "4");
  const ctx = { storage, waitUntil() {} };
  return { storage, object: new PageRecords(ctx) };
}

const call = (object, path, method = "POST") =>
  object.fetch(new Request(`https://page-records.internal${path}`, { method }));

test("PageRecords counts and clears what it holds, and serves no record", async () => {
  const { storage, object } = await oldRecords();
  const inspected = await (await call(object, "/inspect")).json();
  assert.equal(inspected.keys, 4);
  assert.ok(inspected.bytes > 1500, JSON.stringify(inspected));
  // The read and write paths of the buffered store are gone.
  for (const [path, method] of [
    ["/records", "GET"],
    ["/records", "POST"],
    ["/lease", "POST"],
    ["/inspect", "GET"],
  ])
    assert.equal((await call(object, path, method)).status, 404, `${method} ${path}`);
  assert.equal(storage.values.size, 4, "nothing read or written");
  const cleared = await (await call(object, "/clear")).json();
  assert.deepEqual(cleared.cleared, inspected);
  assert.deepEqual(cleared.after, { keys: 0, bytes: 0 });
  assert.deepEqual(await inspectStorage(storage), { keys: 0, bytes: 0 });
});

test("inspectStorage pages through more keys than one listing holds", async () => {
  const storage = new RecordStorage();
  for (let i = 0; i < 300; i++) await storage.put(`repo/${String(i).padStart(4, "0")}`, "x");
  const counted = await inspectStorage(storage);
  assert.equal(counted.keys, 300);
  assert.equal(counted.bytes, 300 * ("repo/0000".length + 1));
});

/** A Page host whose record says `record`, with its PageRecords object. */
async function host(t, record) {
  const records = await oldRecords();
  const named = [];
  const f = await fixture(t, {
    env: {
      PAGE_RECORDS: {
        getByName: (name) => {
          named.push(name);
          return { fetch: (url, init) => records.object.fetch(new Request(url, init)) };
        },
      },
    },
  });
  Object.assign(f.page.metadata, record);
  const ask = async (mode) => {
    const response = await f.page.fetch(
      new Request("https://pages.internal/internal/operator-page-records", {
        method: "POST",
        body: JSON.stringify({ mode }),
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  return { f, records, named, ask };
}

test("a Page converted from buffered storage reports, then clears, its old records", async (t) => {
  const h = await host(t, { recordStorage: "automerge", recordStorageMigratedFrom: "buffered" });
  const dry = await h.ask("dry_run");
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.status, "would_clear");
  assert.equal(dry.body.records.keys, 4);
  assert.equal(h.records.storage.values.size, 4, "a dry run deletes nothing");
  assert.deepEqual(h.named, [pageId], "the object is named by the Page id");
  const applied = await h.ask("apply");
  assert.equal(applied.body.status, "cleared");
  assert.equal(applied.body.cleared.keys, 4);
  assert.deepEqual(applied.body.after, { keys: 0, bytes: 0 });
  assert.equal(h.records.storage.values.size, 0);
  // A second pass finds nothing left.
  assert.equal((await h.ask("dry_run")).body.status, "empty");
  // The Page's own plain content is untouched.
  assert.equal(h.f.page.metadata.recordStorage, "automerge");
});

test("a Page that never had buffered storage, or a live buffered one, is not cleared", async (t) => {
  for (const [record, status] of [
    [{ recordStorage: "automerge" }, "none"],
    [{ recordStorage: "automerge", recordStorageMigratedFrom: "local" }, "none"],
    [{ recordStorage: "buffered" }, "held"],
  ]) {
    const h = await host(t, record);
    for (const mode of ["dry_run", "apply"]) {
      const answer = await h.ask(mode);
      assert.equal(answer.body.status, status, `${JSON.stringify(record)} ${mode}`);
    }
    assert.equal(h.records.storage.values.size, 4, JSON.stringify(record));
    assert.deepEqual(h.named, [], "no PageRecords object is created by asking");
  }
});

test("a credentialed request can't reach the host route", async (t) => {
  const h = await host(t, { recordStorageMigratedFrom: "buffered" });
  const response = await h.f.page.fetch(
    new Request("https://pages.internal/internal/operator-page-records", {
      method: "POST",
      headers: { authorization: "Bearer x" },
      body: JSON.stringify({ mode: "apply" }),
    }),
  );
  assert.notEqual(response.status, 200);
  assert.equal(h.records.storage.values.size, 4);
});

test("purging a Page converted from buffered storage clears its PageRecords object", async (t) => {
  const h = await host(t, { recordStorage: "automerge", recordStorageMigratedFrom: "buffered" });
  await h.f.page.purgeConvertedRecords();
  assert.equal(h.records.storage.values.size, 0);
  assert.deepEqual(h.named, [pageId]);
});

test("the sweep route sits behind the operator gate and asks each named cell", async () => {
  const asked = [];
  const answers = {
    [CELL(1)]: { status: "would_clear", records: { keys: 3, bytes: 900 } },
    [CELL(2)]: { status: "none" },
  };
  const env = {
    PAGES_OPERATOR_SECRET: SECRET,
    PAGES: {
      idFromString: (id) => id,
      get: (id) => ({
        fetch: async (request) => {
          asked.push([id, new URL(request.url).pathname, await request.json()]);
          return answers[id] ? Response.json(answers[id]) : new Response(null, { status: 500 });
        },
      }),
    },
  };
  const sweep = (body, headers = { [OPERATOR_SECRET_HEADER]: SECRET }) =>
    worker.fetch(
      new Request("https://pages.invalid/api/operator/page-records", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      env,
    );
  // Closed gate: the unknown path, and no cell is asked.
  for (const headers of [{}, { [OPERATOR_SECRET_HEADER]: SECRET, "cf-ray": "1" }]) {
    const refused = await sweep({ mode: "dry_run", cell_ids: [CELL(1)] }, headers);
    assert.equal(refused.status, 404);
  }
  assert.deepEqual(asked, []);
  for (const body of [
    { mode: "nope", cell_ids: [CELL(1)] },
    { mode: "apply", cell_ids: [] },
    { mode: "apply", cell_ids: ["not-a-cell"] },
    { mode: "apply", cell_ids: Array.from({ length: SWEEP_BATCH + 1 }, (_, i) => CELL(i)) },
  ])
    assert.equal((await sweep(body)).status, 400, JSON.stringify(body).slice(0, 80));
  const response = await sweep({ mode: "dry_run", cell_ids: [CELL(1), CELL(2), CELL(3)] });
  assert.equal(response.status, 200);
  const { pages } = await response.json();
  assert.deepEqual(
    pages.map((page) => [page.cell_id, page.status]),
    [
      [CELL(1), "would_clear"],
      [CELL(2), "none"],
      [CELL(3), "error"],
    ],
  );
  assert.deepEqual(
    asked.map(([id, path, body]) => [id, path, body.mode]),
    [CELL(1), CELL(2), CELL(3)].map((id) => [id, "/internal/operator-page-records", "dry_run"]),
  );
  assert.deepEqual(sweepTotals(pages), {
    pages: 3,
    by_status: { would_clear: 1, none: 1, error: 1 },
    keys: 3,
    bytes: 900,
  });
});

test("the operator script sends every Page cell in batches and totals the answers", async () => {
  const cells = Array.from({ length: SWEEP_BATCH * 2 + 3 }, (_, i) => CELL(i));
  const calls = [];
  const logged = [];
  const report = await sweepRun({
    mode: "apply",
    log: (record) => logged.push(record),
    transport: {
      cells: async () => cells,
      call: async (body) => {
        calls.push(body);
        return {
          status: 200,
          text: JSON.stringify({
            mode: body.mode,
            pages: body.cell_ids.map((cell_id, i) =>
              i === 0
                ? { cell_id, status: "cleared", cleared: { keys: 2, bytes: 10 } }
                : { cell_id, status: "none" },
            ),
          }),
        };
      },
    },
  });
  assert.deepEqual(
    calls.map((body) => body.cell_ids.length),
    [SWEEP_BATCH, SWEEP_BATCH, 3],
  );
  assert.ok(calls.every((body) => body.mode === "apply"));
  assert.equal(report.page_cells, cells.length);
  assert.deepEqual(report.totals, {
    pages: cells.length,
    by_status: { cleared: 3, none: cells.length - 3 },
    keys: 6,
    bytes: 30,
  });
  assert.equal(logged.length, 3);
});

test("a failed sweep call stops the run and keeps the report so far", async () => {
  await assert.rejects(
    sweepRun({
      mode: "dry_run",
      transport: {
        cells: async () => [CELL(1)],
        call: async () => ({ status: 404, text: '{"error":"Not found"}' }),
      },
    }),
    (error) => {
      assert.match(error.message, /^404/);
      assert.equal(error.report.page_cells, 1);
      return true;
    },
  );
});
