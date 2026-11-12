// A Page's sources document end to end, on a Page host over real plain sync
// and in-memory storage: the agent contract (edit_page set_source, read_page
// sources), the document's creation on the first write, restarts at each
// persisted step, and the Page's lifecycle.

import assert from "node:assert/strict";
import test from "node:test";
import * as A from "@automerge/automerge";
import { createAuthFixture } from "../auth-fixtures.mjs";
import { MEMBER_FORMATS } from "../model/document-types.mjs";
import { Storage, pageId } from "./trash-fixture.mjs";
import { derivedDocUuid, derivedDocumentId } from "./comments-store.mjs";
import { SOURCES_MODULE } from "./document-modules.mjs";
import { Page } from "./index.mjs";
import { treeOf } from "./plain-sync.mjs";

const PARQUET = "application/vnd.apache.parquet";
const first = "a".repeat(64),
  second = "b".repeat(64);

/** Storage that deletes key lists, as plain sync's purge does. A crash
 * `{ test, before }` throws once from the first put with an entry that
 * passes `test`: before storing it (`before`), or after, as a process that
 * died right after a durable write. */
class PlainStorage extends Storage {
  crashes = [];
  async delete(key) {
    for (const name of Array.isArray(key) ? key : [key]) this.values.delete(name);
  }
  async put(key, value) {
    const entries = typeof key === "object" ? Object.entries(key) : [[key, value]];
    const index = this.crashes.findIndex(({ test }) => entries.some(([name, v]) => test(name, v)));
    const crash = index >= 0 ? this.crashes.splice(index, 1)[0] : undefined;
    if (crash?.before) throw Error("Simulated crash before a write");
    await super.put(key, value);
    if (crash) throw Error("Simulated crash after a durable write");
  }
}
/** A put of the record that names the sources document. */
const namesSources = (name, value) =>
  name === "host/document" && !!value?.documentFormats?.["pages.sources"];

const parquetHead = (assetId, owner = pageId) => ({
  size: 1018,
  httpMetadata: { contentType: PARQUET },
  customMetadata: { page_id: owner, hash: assetId },
});

/** A Page over real plain sync. `page()` starts a new host over the same
 * storage, as after eviction or a crash; `assets.head` answers asset HEADs. */
async function sourcesHost(t) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  t.mock.method(console, "error", () => {});
  const storage = new PlainStorage();
  const assets = { heads: 0, head: async (key) => parquetHead(key.slice(-64)) };
  const env = {
    ...auth.env,
    CATALOGS: { getByName: () => ({ fetch: async () => Response.json({ ok: true }) }) },
    PAGES_ASSETS: {
      head: (key) => {
        assets.heads++;
        return assets.head(key);
      },
    },
  };
  const token = auth.apiKey();
  const hosts = [];
  t.after(async () => {
    for (const host of hosts) await host.plain?.close();
  });
  const page = () => {
    const host = new Page(
      { id: { name: pageId }, storage, blockConcurrencyWhile: (fn) => fn(), waitUntil() {} },
      env,
    );
    hosts.push(host);
    return host;
  };
  const call = async (host, path, body) => {
    const response = await host.fetch(
      new Request(`https://pages.invalid${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "x-pages-driver": "ChatGPT" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  const tool = (host, operation, args = {}) =>
    call(host, "/internal/tool", { operation, arguments: { page_id: pageId, ...args } });
  let nonces = 0;
  const setSource = async (host, operations, extra = {}) => {
    const read = await tool(host, "read_page", { include_content: false });
    return tool(host, "edit_page", {
      revision: read.body.revision,
      nonce: `sources-${++nonces}`,
      operations: operations.map((operation) => ({ op: "set_source", ...operation })),
      ...extra,
    });
  };
  const host = page();
  const created = await call(host, "/internal/create", {
    page_id: pageId,
    title: "Usage",
    markdown: "Some text",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const sourcesId = derivedDocumentId(await derivedDocUuid(SOURCES_MODULE.derived.label, pageId));
  const record = () => storage.get("host/document");
  const plainKeys = async () => [...(await storage.list({ prefix: "plain/" })).keys()];
  // The sources document's own stored history: its manifest and chunks.
  const sourcesStored = async () => [
    ...(await storage.list({ prefix: `plain/sync/${treeOf(sourcesId)}/` })).keys(),
  ];
  return {
    auth,
    storage,
    assets,
    host,
    page,
    call,
    tool,
    setSource,
    sourcesId,
    record,
    plainKeys,
    sourcesStored,
  };
}

const usage = (fields = {}) => ({
  source_id: "usage",
  name: "Usage",
  asset_id: first,
  source_revision: null,
  ...fields,
});

test("a Page has no sources document until its first source write", async (t) => {
  const h = await sourcesHost(t);
  assert.deepEqual((await h.record()).documentFormats, MEMBER_FORMATS);
  assert.deepEqual(await h.sourcesStored(), []);
  const empty = await h.tool(h.host, "read_page", { sources: true });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.sources, []);
  assert.equal(empty.body.sources_revision, undefined);
  assert.equal(empty.body.blocks, undefined, "a sources read skips the Page's content");
  assert.equal(
    (await h.call(h.host, `/api/connect?page=${pageId}`)).body.documents.sources,
    undefined,
  );

  // A refused first write creates nothing.
  h.assets.head = async () => null;
  const missing = await h.setSource(h.host, [usage()]);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "dataset_not_found");
  assert.deepEqual((await h.record()).documentFormats, MEMBER_FORMATS);
  assert.equal(h.host.sourcesView(), undefined);

  h.assets.head = async (key) => parquetHead(key.slice(-64));
  const written = await h.setSource(h.host, [usage()]);
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.match(written.body.sources_revision, /^s\d+$/);
  assert.equal(written.body.revision, undefined, "a source write names no Page revision");
  assert.deepEqual(written.body.result.edits, [
    { op: "set_source", source_id: "usage", source_revision: "1" },
  ]);
  assert.deepEqual((await h.record()).documentFormats, { ...MEMBER_FORMATS, "pages.sources": 1 });
  const connected = await h.call(h.host, `/api/connect?page=${pageId}`);
  assert.deepEqual(connected.body.documents.sources, {
    id: h.sourcesId,
    type: "pages.sources",
    format: 1,
  });

  const listed = await h.tool(h.host, "read_page", { sources: true, include_content: false });
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.body.outline.entries), "sources add to an outline read");
  assert.deepEqual(listed.body.sources, [
    {
      source_id: "usage",
      name: "Usage",
      source_revision: "1",
      asset_id: first,
      media_type: PARQUET,
    },
  ]);
  assert.equal(listed.body.sources_revision, written.body.sources_revision);
  const one = await h.tool(h.host, "read_page", { source_id: "usage" });
  assert.deepEqual(one.body.source.producer, {
    kind: "upload",
    principal: `user:anaconda-fixture:${h.auth.subject}`,
  });

  // A restart serves the same document from the record.
  const restarted = h.page();
  const again = await h.tool(restarted, "read_page", { sources: true });
  assert.deepEqual(again.body.sources, listed.body.sources);
  assert.equal(again.body.sources_revision, listed.body.sources_revision);
});

test("set_source creates, renames and refreshes, and refuses stale, missing and malformed writes", async (t) => {
  const h = await sourcesHost(t);
  assert.equal((await h.setSource(h.host, [usage()])).status, 200);
  const renamed = await h.setSource(h.host, [usage({ name: "Daily usage", source_revision: "1" })]);
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.result.edits[0].source_revision, "2");
  const refreshed = await h.setSource(h.host, [
    usage({ name: "Daily usage", asset_id: second, source_revision: "2" }),
  ]);
  assert.equal(refreshed.status, 200);
  const read = await h.tool(h.host, "read_page", { source_id: "usage" });
  assert.equal(read.body.source.name, "Daily usage");
  assert.equal(read.body.source.asset_id, second);
  assert.equal(read.body.source.source_revision, "3");

  const stale = await h.setSource(h.host, [usage({ source_revision: "2" })]);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "stale_source");
  assert.equal(stale.body.source_id, "usage");
  assert.equal(stale.body.source_revision, "3");
  const exists = await h.setSource(h.host, [usage()]);
  assert.equal(exists.status, 409);
  assert.equal(exists.body.source_revision, "3");

  const unknown = await h.setSource(h.host, [usage({ source_id: "other", source_revision: "1" })]);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, "source_not_found");
  assert.equal(unknown.body.source_revision, null);
  const unread = await h.tool(h.host, "read_page", { source_id: "other" });
  assert.equal(unread.status, 404);
  assert.equal(unread.body.code, "source_not_found");

  for (const bad of [
    { source_id: "Bad" },
    { name: "" },
    { asset_id: "x" },
    { source_revision: "0" },
    { extra: true },
  ]) {
    const refused = await h.setSource(h.host, [usage(bad)]);
    assert.equal(refused.status, 400, JSON.stringify(bad));
    assert.equal(refused.body.code, "invalid_source", JSON.stringify(bad));
  }
  const badRead = await h.tool(h.host, "read_page", { source_id: "Bad/id" });
  assert.equal(badRead.status, 400);
  assert.equal(badRead.body.code, "invalid_source");
  const after = await h.tool(h.host, "read_page", { source_id: "usage" });
  assert.deepEqual(after.body.source, read.body.source);
});

test("a source must name a dataset stored on this Page", async (t) => {
  const h = await sourcesHost(t);
  for (const [name, head, status] of [
    ["missing", () => null, 404],
    [
      "image",
      () => ({
        size: 74,
        httpMetadata: { contentType: "image/png" },
        customMetadata: { page_id: pageId, hash: first, width: "3", height: "2" },
      }),
      415,
    ],
    ["another Page's", () => parquetHead(first, "44444444-4444-4444-8444-444444444444"), 500],
  ]) {
    h.assets.head = async () => head();
    const refused = await h.setSource(h.host, [usage()]);
    assert.equal(refused.status, status, name);
    assert.equal(h.host.sourcesView(), undefined, name);
  }
});

test("a Page holds up to 64 sources", async (t) => {
  const h = await sourcesHost(t);
  const full = Array.from({ length: 64 }, (_, i) => usage({ source_id: `s${i}` }));
  const written = await h.setSource(h.host, full);
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal(written.body.result.edits.length, 64);
  const over = await h.setSource(h.host, [usage({ source_id: "one-more" })]);
  assert.equal(over.status, 400);
  assert.equal(over.body.code, "invalid_source");
  assert.equal((await h.tool(h.host, "read_page", { sources: true })).body.sources.length, 64);
});

test("a batch with set_source holds only set_source operations", async (t) => {
  const h = await sourcesHost(t);
  const read = await h.tool(h.host, "read_page", { include_content: false });
  const mixed = await h.tool(h.host, "edit_page", {
    revision: read.body.revision,
    nonce: "mixed-batch",
    operations: [
      { op: "set_source", ...usage() },
      { op: "set_title", title: "Not applied" },
    ],
  });
  assert.equal(mixed.status, 400);
  assert.equal(mixed.body.code, "invalid_arguments");
  assert.match(mixed.body.error, /second edit_page request/);
  assert.equal(h.host.sourcesView(), undefined);
  assert.equal((await h.tool(h.host, "read_page", { include_content: false })).body.title, "Usage");
});

test("a retried set_source replays its receipt without a second revision or asset check", async (t) => {
  const h = await sourcesHost(t);
  const read = await h.tool(h.host, "read_page", { include_content: false });
  const args = {
    revision: read.body.revision,
    nonce: "set-source-once",
    operations: [{ op: "set_source", ...usage() }],
  };
  const written = await h.tool(h.host, "edit_page", args);
  assert.equal(written.status, 200);
  const checks = h.assets.heads;
  h.assets.head = async () => assert.fail("A replay must not read asset storage");
  const replayed = await h.tool(h.host, "edit_page", args);
  assert.deepEqual(replayed, written);
  assert.equal(h.assets.heads, checks);
  const sources = (await h.tool(h.host, "read_page", { sources: true })).body;
  assert.equal(sources.sources[0].source_revision, "1");
  assert.equal(sources.sources_revision, written.body.sources_revision);
  // The nonce belongs to edit_page's lane: another batch under it conflicts.
  const conflict = await h.tool(h.host, "edit_page", {
    ...args,
    operations: [{ op: "set_title", title: "Other" }],
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "nonce_conflict");
});

test("a Page revision that isn't current still writes a source", async (t) => {
  const h = await sourcesHost(t);
  const read = await h.tool(h.host, "read_page", { include_content: false });
  const edited = await h.tool(h.host, "edit_page", {
    revision: read.body.revision,
    nonce: "title-edit",
    operations: [{ op: "set_title", title: "Moved on" }],
  });
  assert.equal(edited.status, 200);
  assert.notEqual(edited.body.revision, read.body.revision);
  const written = await h.tool(h.host, "edit_page", {
    revision: read.body.revision,
    nonce: "stale-page-source",
    operations: [{ op: "set_source", ...usage() }],
  });
  assert.equal(written.status, 200, JSON.stringify(written.body));
  // A malformed Page revision is still refused.
  const malformed = await h.tool(h.host, "edit_page", {
    revision: "c1",
    nonce: "bad-revision-source",
    operations: [{ op: "set_source", ...usage({ source_id: "other" }) }],
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, "invalid_revision");
});

test("a restart after the genesis is stored, before the record names it, starts over", async (t) => {
  const h = await sourcesHost(t);
  h.storage.crashes.push({ test: namesSources, before: true });
  const crashed = await h.setSource(h.host, [usage()]);
  assert.equal(crashed.status, 500);
  // The sources document's genesis is stored under its own keys.
  assert.ok((await h.sourcesStored()).length > 0);
  // Restart: the record doesn't name the document, so the Page has none.
  const host = h.page();
  assert.deepEqual((await h.record()).documentFormats, MEMBER_FORMATS);
  assert.deepEqual((await h.tool(host, "read_page", { sources: true })).body.sources, []);
  assert.equal(
    (await h.tool(host, "read_page", { sources: true })).body.sources_revision,
    undefined,
  );
  const written = await h.setSource(host, [usage()]);
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal(written.body.result.edits[0].source_revision, "1");
  assert.deepEqual((await h.record()).documentFormats, { ...MEMBER_FORMATS, "pages.sources": 1 });
});

test("a restart after the record names the document, before the write is journaled, serves it empty", async (t) => {
  const h = await sourcesHost(t);
  const read = await h.tool(h.host, "read_page", { include_content: false });
  const args = {
    revision: read.body.revision,
    nonce: "first-source",
    operations: [{ op: "set_source", ...usage() }],
  };
  h.storage.crashes.push({ test: namesSources, before: false });
  assert.equal((await h.tool(h.host, "edit_page", args)).status, 500);
  assert.equal((await h.storage.list({ prefix: "host/operation/" })).size, 0);
  const host = h.page();
  const empty = await h.tool(host, "read_page", { sources: true });
  assert.deepEqual(empty.body.sources, []);
  assert.match(empty.body.sources_revision, /^s\d+$/);
  const written = await h.tool(host, "edit_page", args);
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal(written.body.result.edits[0].source_revision, "1");
});

test("a restart after the write is journaled replays it, and the retry returns its receipt", async (t) => {
  const h = await sourcesHost(t);
  const read = await h.tool(h.host, "read_page", { include_content: false });
  const args = {
    revision: read.body.revision,
    nonce: "journaled-source",
    operations: [{ op: "set_source", ...usage() }],
  };
  h.storage.crashes.push({
    test: (name, value) => name.startsWith("host/operation/") && value?.pending === true,
    before: false,
  });
  assert.equal((await h.tool(h.host, "edit_page", args)).status, 500);
  const host = h.page();
  const sources = await h.tool(host, "read_page", { sources: true });
  assert.equal(sources.body.sources[0].source_revision, "1");
  h.assets.head = async () => assert.fail("A replay must not read asset storage");
  const retried = await h.tool(host, "edit_page", args);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.result.edits[0].source_revision, "1");
  assert.equal(retried.body.sources_revision, sources.body.sources_revision);
});

test("a first write the Page's sources refuse creates no document", async (t) => {
  const h = await sourcesHost(t);
  const over = Array.from({ length: 65 }, (_, i) => usage({ source_id: `s${i}` }));
  for (const [operations, status, code] of [
    [[usage({ source_revision: "1" })], 404, "source_not_found"],
    [over, 400, "invalid_source"],
  ]) {
    const refused = await h.setSource(h.host, operations);
    assert.equal(refused.status, status, code);
    assert.equal(refused.body.code, code);
  }
  assert.equal(h.assets.heads, 0, "the batch is refused before any asset is read");
  assert.deepEqual((await h.record()).documentFormats, MEMBER_FORMATS);
  assert.deepEqual(await h.sourcesStored(), []);
  const connected = await h.call(h.host, `/api/connect?page=${pageId}`);
  assert.equal(connected.body.documents.sources, undefined);
  assert.equal(h.host.sourcesView(), undefined);
});

test("a write whose apply didn't finish is replayed before another write is checked", async (t) => {
  const h = await sourcesHost(t);
  const read = await h.tool(h.host, "read_page", { include_content: false });
  const first = {
    revision: read.body.revision,
    nonce: "write-a",
    operations: [{ op: "set_source", ...usage() }],
  };
  // A's pending entry is durable; its barrier fails before the apply.
  h.storage.crashes.push({
    test: (name, value) => name.startsWith("host/operation/") && value?.pending === true,
    before: false,
  });
  assert.equal((await h.tool(h.host, "edit_page", first)).status, 500);
  // B, under another nonce on the same host, meets A's source.
  const second = await h.tool(h.host, "edit_page", {
    ...first,
    nonce: "write-b",
    operations: [{ op: "set_source", ...usage({ name: "B" }) }],
  });
  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.equal(second.body.code, "stale_source");
  assert.equal(second.body.source_revision, "1");
  // A's retry returns its receipt.
  const retried = await h.tool(h.host, "edit_page", first);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.result.edits[0].source_revision, "1");
  const one = await h.tool(h.host, "read_page", { source_id: "usage" });
  assert.equal(one.body.source.name, "Usage");
  assert.equal(one.body.source.source_revision, "1");
  const doc = h.host.sourcesView();
  assert.ok(
    Object.keys(A.getConflicts(doc.sources, "usage") ?? {}).length <= 1,
    "one write created the source",
  );
});

test("a failed boot load refuses requests until a new host loads the document", async (t) => {
  const h = await sourcesHost(t);
  assert.equal((await h.setSource(h.host, [usage()])).status, 200);
  const failing = h.page();
  const load = Page.prototype.sourcesEffect;
  t.mock.method(failing, "sourcesEffect", async function (effect) {
    if (effect === "load") throw Error("Simulated sources load failure");
    return load.call(this, effect);
  });
  const refused = await h.tool(failing, "read_page", { sources: true });
  assert.ok(refused.status >= 500, JSON.stringify(refused.body));
  const write = await h.setSource(failing, [usage({ name: "Again", source_revision: "1" })]);
  assert.ok(write.status >= 500, "a write can't follow a failed boot on the same host");
  const next = h.page();
  const sources = await h.tool(next, "read_page", { sources: true });
  assert.equal(sources.body.sources[0].source_revision, "1");
});

test("Trash and restore keep the sources document; purge deletes its stored bytes", async (t) => {
  const h = await sourcesHost(t);
  assert.equal((await h.setSource(h.host, [usage()])).status, 200);
  const trashed = await h.call(h.host, "/internal/trash", { page_id: pageId, nonce: "trash-it" });
  assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
  assert.deepEqual((await h.record()).documentFormats, { ...MEMBER_FORMATS, "pages.sources": 1 });
  const restored = await h.call(h.host, "/internal/restore", {
    page_id: pageId,
    nonce: "restore-it",
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  const kept = await h.tool(h.page(), "read_page", { sources: true });
  assert.equal(kept.body.sources.length, 1);

  const host = h.page();
  assert.equal(
    (await h.call(host, "/internal/trash", { page_id: pageId, nonce: "trash-2" })).status,
    200,
  );
  const preview = await h.call(host, "/internal/purge", { page_id: pageId, action: "preview" });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const purged = await h.call(host, "/internal/purge", {
    page_id: pageId,
    action: "confirm",
    preview_token: preview.body.preview_token,
    nonce: "purge-it",
  });
  assert.equal(purged.status, 200, JSON.stringify(purged.body));
  assert.deepEqual(await h.plainKeys(), []);
  assert.equal(host.sourcesView(), undefined);
});
