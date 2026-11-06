// PageRecords is delete-only; purge clears the objects buffered Pages left.
// Delete these tests with the class.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PageRecords, inspectStorage } from "./page-records.mjs";
import { Storage, fixture, pageId } from "./trash-fixture.mjs";

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
  return { f, records, named };
}

test("purging a Page converted from buffered storage clears its PageRecords object", async (t) => {
  const h = await host(t, { recordStorage: "automerge", recordStorageMigratedFrom: "buffered" });
  await h.f.page.purgeConvertedRecords();
  assert.equal(h.records.storage.values.size, 0);
  assert.deepEqual(h.named, [pageId]);
});

test("purging a Page that never had buffered storage asks no PageRecords object", async (t) => {
  for (const record of [
    { recordStorage: "automerge" },
    { recordStorage: "automerge", recordStorageMigratedFrom: "local" },
  ]) {
    const h = await host(t, record);
    await h.f.page.purgeConvertedRecords();
    assert.equal(h.records.storage.values.size, 4, JSON.stringify(record));
    assert.deepEqual(h.named, [], "no PageRecords object is created by purging");
  }
});
