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
import { SOURCE_HISTORY_LIMIT, WRITER_LIMITS, deletedSource } from "../model/sources-doc.mjs";
import { SOURCES_MODULE } from "./document-modules.mjs";
import { DEFAULT_READ_BYTES } from "./tool-reads.mjs";
import { Page } from "./index.mjs";
import { treeOf } from "./plain-sync.mjs";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { write_parquet_ipc } from "@nteract/sift/wasm";
// Initializes Sift's WASM for write_parquet_ipc, as the host's summaries do.
import "#sift-wasm";
import { datasetSummaryKey } from "./dataset-summary.mjs";
import { imageAssetKey } from "./image-assets.mjs";

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
 * storage, as after eviction or a crash; `assets.head` answers asset HEADs.
 * With `store`, the asset bucket also stores puts in `assets.objects` and
 * reads them back; a HEAD of a key it holds answers from there.
 * `assets.put(key)` runs before each put, to fail or observe it. */
async function sourcesHost(t, { profile, store = false } = {}) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  t.mock.method(console, "error", () => {});
  const storage = new PlainStorage();
  const assets = {
    heads: 0,
    puts: 0,
    objects: new Map(),
    head: async (key) => parquetHead(key.slice(-64)),
    put: async () => {},
  };
  const env = {
    ...auth.env,
    CATALOGS: { getByName: () => ({ fetch: async () => Response.json({ ok: true }) }) },
    PAGES_ASSETS: {
      head: (key) => {
        assets.heads++;
        return assets.objects.get(key) ?? assets.head(key);
      },
      ...(store && {
        put: async (key, bytes, options) => {
          await assets.put(key);
          assets.puts++;
          if (assets.objects.has(key)) return null;
          const object = { key, bytes: bytes.slice(), size: bytes.length, ...options };
          assets.objects.set(key, object);
          return object;
        },
        get: async (key) => {
          const object = assets.objects.get(key);
          return object
            ? { ...object, text: async () => new TextDecoder().decode(object.bytes) }
            : null;
        },
      }),
    },
  };
  // `profile` is the account's provider profile, which names it.
  const token = auth.apiKey(profile && { profile });
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
  // `headers` adds to or replaces the default ones: an agent assertion
  // (`agentHeader`) or another `x-pages-driver`.
  const call = async (host, path, body, headers = {}) => {
    const response = await host.fetch(
      new Request(`https://pages.invalid${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "x-pages-driver": "ChatGPT", ...headers },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  const tool = (host, operation, args = {}, headers) =>
    call(host, "/internal/tool", { operation, arguments: { page_id: pageId, ...args } }, headers);
  let nonces = 0;
  const setSource = async (host, operations, extra = {}, headers) => {
    const read = await tool(host, "read_page", { include_content: false });
    return tool(
      host,
      "edit_page",
      {
        revision: read.body.revision,
        nonce: `sources-${++nonces}`,
        operations: operations.map((operation) => ({ op: "set_source", ...operation })),
        ...extra,
      },
      headers,
    );
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

/** The internal header a gateway forwards an agent's `{ name?, model? }` in. */
const agentHeader = (agent) => ({
  "x-pages-internal-request-agent": encodeURIComponent(JSON.stringify(agent)),
});

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
  const { at, by } = one.body.source.producer;
  assert.equal(one.body.source.producer.kind, "upload");
  assert.ok(Math.abs(Date.parse(at) - Date.now()) < 60_000, "the host's time of the write");
  assert.equal(by.principal, `user:anaconda-fixture:${h.auth.subject}`);
  assert.equal(by.driver, "ChatGPT");
  assert.equal(by.agent, undefined, "no agent asserted, none stored");
  assert.deepEqual(one.body.source.history, [
    {
      revision: "1",
      name: "Usage",
      media_type: PARQUET,
      asset_id: first,
      at,
      by,
    },
  ]);
  assert.equal(one.body.source.history_truncated, false);
  assert.equal(listed.body.sources[0].history, undefined, "the list carries no history");

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

test("a missing dataset with an asset_from hint asks the gateway to copy, before any journal entry", async (t) => {
  const h = await sourcesHost(t);
  const held = new Set();
  h.assets.head = async (key) => (held.has(key.slice(-64)) ? parquetHead(key.slice(-64)) : null);
  const read = await h.tool(h.host, "read_page", { include_content: false });
  // Each attempt is the gateway's forward: the batch without asset_from, its
  // hints beside the arguments.
  const send = async (nonce, hints) => {
    const response = await h.host.fetch(
      new Request("https://pages.invalid/internal/tool", {
        method: "POST",
        headers: { authorization: `Bearer ${h.auth.apiKey()}`, "x-pages-driver": "ChatGPT" },
        body: JSON.stringify({
          operation: "edit_page",
          arguments: {
            page_id: pageId,
            revision: read.body.revision,
            nonce,
            operations: [
              { op: "set_source", ...usage() },
              { op: "set_source", ...usage({ source_id: "other", asset_id: second }) },
            ],
          },
          ...(hints && { asset_hints: hints }),
        }),
      }),
    );
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  held.add(second);
  const asked = await send("copy-0001", [first, second]);
  assert.equal(asked.status, 409);
  assert.equal(asked.headers.get("x-pages-asset-copy"), "required");
  // Only the missing one; the one already here is never copied.
  assert.deepEqual(asked.body, { asset_ids: [first] });
  assert.equal(h.host.sourcesView(), undefined);
  assert.deepEqual(await h.sourcesStored(), []);
  // Without a hint, a missing dataset is refused as it always was.
  const plain = await send("copy-0002");
  assert.equal(plain.status, 404);
  assert.equal(plain.body.code, "dataset_not_found");
  // After the copy, the same nonce applies; a later retry replays the
  // receipt even with the dataset gone again and its hint resent.
  held.add(first);
  const applied = await send("copy-0001");
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  held.clear();
  const replay = await send("copy-0001", [first, second]);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.deepEqual(replay.body, applied.body);
  // The stored source names the asset and nothing else of the request.
  const listed = await h.tool(h.host, "read_page", { source_id: "usage" });
  assert.equal(listed.body.source.asset_id, first);
  assert.equal(JSON.stringify(listed.body).includes("asset_from"), false);
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

test("each source write stores its writer and time, and the read returns them as history", async (t) => {
  const h = await sourcesHost(t);
  const principal = `user:anaconda-fixture:${h.auth.subject}`;
  // The fixture account's display name.
  const displayName = "Fixture Person";
  const loader = { name: "Loader", model: "m-1" };
  const create = await h.setSource(h.host, [usage()], {}, agentHeader(loader));
  assert.equal(create.status, 200, JSON.stringify(create.body));
  // No agent asserted, and another driver.
  const rename = await h.setSource(
    h.host,
    [usage({ name: "Daily", source_revision: "1" })],
    {},
    {
      "x-pages-driver": "Claude Code",
    },
  );
  assert.equal(rename.status, 200, JSON.stringify(rename.body));
  // A name alone, without a model.
  const refresh = await h.setSource(
    h.host,
    [usage({ name: "Daily", asset_id: second, source_revision: "2" })],
    {},
    agentHeader({ name: "Refresher" }),
  );
  assert.equal(refresh.status, 200, JSON.stringify(refresh.body));

  const { source } = (await h.tool(h.host, "read_page", { source_id: "usage" })).body;
  assert.deepEqual(
    source.history.map(({ revision, name, asset_id, by }) => [revision, name, asset_id, by]),
    [
      ["1", "Usage", first, { principal, displayName, driver: "ChatGPT", agent: loader }],
      ["2", "Daily", first, { principal, displayName, driver: "Claude Code" }],
      [
        "3",
        "Daily",
        second,
        { principal, displayName, driver: "ChatGPT", agent: { name: "Refresher" } },
      ],
    ],
  );
  const at = source.history.map((state) => Date.parse(state.at));
  assert.ok(
    at.every((time, index) => time >= (at[index - 1] ?? 0)),
    "times only move forward",
  );
  assert.deepEqual(source.producer, {
    kind: "upload",
    at: source.history[2].at,
    by: source.history[2].by,
  });
  assert.equal(source.history_truncated, false);

  // A retry under the same nonce must assert the same agent: a changed
  // assertion conflicts instead of replaying, as a comment's does.
  const read = await h.tool(h.host, "read_page", { include_content: false });
  const args = {
    revision: read.body.revision,
    nonce: "attributed-source",
    operations: [{ op: "set_source", ...usage({ source_id: "other" }) }],
  };
  const written = await h.tool(h.host, "edit_page", args, agentHeader(loader));
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.deepEqual(await h.tool(h.host, "edit_page", args, agentHeader(loader)), written);
  for (const changed of [{ name: "Loader", model: "m-2" }, { name: "Other" }]) {
    const conflict = await h.tool(h.host, "edit_page", args, agentHeader(changed));
    assert.equal(conflict.status, 409, JSON.stringify(changed));
    assert.equal(conflict.body.code, "nonce_conflict");
  }
  const unasserted = await h.tool(h.host, "edit_page", args);
  assert.equal(unasserted.status, 409);
  assert.equal(unasserted.body.code, "nonce_conflict");
  const other = (await h.tool(h.host, "read_page", { source_id: "other" })).body.source;
  assert.equal(other.history.length, 1);
  assert.deepEqual(other.producer.by.agent, loader);
});

test("a full history at the longest attribution reads inside the default read budget", async (t) => {
  // The provider joins profile names with no bound; a control character
  // costs six bytes once escaped in the JSON a read returns.
  const h = await sourcesHost(t, {
    profile: { first_name: "\u0001".repeat(3000), last_name: "\u0001".repeat(3000) },
  });
  const headers = {
    "x-pages-driver": "D".repeat(80),
    ...agentHeader({ name: "N".repeat(80), model: "M".repeat(120) }),
  };
  // A 200-character name of three-byte characters.
  const name = "数".repeat(200);
  for (let revision = 0; revision < SOURCE_HISTORY_LIMIT; revision++) {
    const written = await h.setSource(
      h.host,
      [usage({ name, source_revision: revision ? String(revision) : null })],
      {},
      headers,
    );
    assert.equal(written.status, 200, JSON.stringify(written.body));
  }
  const read = await h.tool(h.host, "read_page", { source_id: "usage" });
  assert.equal(read.status, 200, JSON.stringify(read.body).slice(0, 300));
  const { source } = read.body;
  assert.equal(source.history.length, SOURCE_HISTORY_LIMIT);
  assert.equal(source.producer.by.displayName.length, WRITER_LIMITS.displayName);
  assert.ok(
    source.history.every((state) => state.by.displayName === source.producer.by.displayName),
  );
  const bytes = new TextEncoder().encode(JSON.stringify(read.body)).byteLength;
  // About 122 KB of the 128 KiB default.
  assert.ok(bytes <= DEFAULT_READ_BYTES, `${bytes} bytes`);
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

test("read_page source_id carries its dataset's summary, stored once at set_source", async (t) => {
  const h = await sourcesHost(t);
  const parquet = write_parquet_ipc(
    tableToIPC(tableFromArrays({ units: Int32Array.from([3, 9, 4]) }), "stream"),
  );
  const objects = new Map([[imageAssetKey(pageId, first), parquet]]);
  const bucket = h.host.env.PAGES_ASSETS;
  const ranged = [];
  h.assets.head = async (key) =>
    objects.has(key) ? { ...parquetHead(first), size: objects.get(key).byteLength } : null;
  bucket.get = async (key, { range } = {}) => {
    const bytes = objects.get(key);
    if (!bytes) return null;
    if (range) ranged.push(key);
    const body = range ? bytes.subarray(range.offset, range.offset + range.length) : bytes;
    return {
      arrayBuffer: async () => body.slice().buffer,
      text: async () => new TextDecoder().decode(body),
    };
  };
  bucket.put = async (key, value) => objects.set(key, new TextEncoder().encode(value));
  const warming = [];
  h.host.ctx.waitUntil = (promise) => warming.push(promise);

  assert.equal((await h.setSource(h.host, [usage()])).status, 200);
  await Promise.all(warming);
  assert.ok(objects.has(datasetSummaryKey(pageId, first)), "set_source stores the summary");

  const read = await h.tool(h.host, "read_page", { source_id: "usage" });
  assert.equal(read.status, 200);
  const { summary } = read.body.source;
  assert.equal(summary.rows, 3);
  assert.deepEqual(
    summary.columns.map(({ name, type, min, max }) => [name, type, min, max]),
    [["units", "Int32", 3, 9]],
  );
  assert.deepEqual(Object.keys(read.body.source).slice(0, 6), [
    "source_id",
    "name",
    "source_revision",
    "asset_id",
    "media_type",
    "summary",
  ]);

  // A new host reads the stored summary, not the dataset.
  const reads = ranged.length;
  const next = h.page();
  const again = await h.tool(next, "read_page", { source_id: "usage" });
  assert.deepEqual(again.body.source.summary, summary);
  assert.equal(ranged.length, reads);

  // A bucket failure leaves the summary out of the read, not the read out.
  bucket.get = async () => {
    throw Error("object store unavailable");
  };
  const failed = await h.tool(h.page(), "read_page", { source_id: "usage" });
  assert.equal(failed.status, 200);
  assert.equal(failed.body.source.summary, null);
});

test("a source read gives up summary columns before it refuses for max_bytes", async (t) => {
  const h = await sourcesHost(t);
  assert.equal((await h.setSource(h.host, [usage()])).status, 200);
  const columns = Array.from({ length: 200 }, (_, i) => ({
    name: `column_${i}`,
    type: "Int64",
    nullable: true,
    null_count: 0,
    min: 0,
    max: i,
    bounds_exact: true,
  }));
  const held = { rows: 1, row_groups: 1, created_by: null, column_count: 200, columns };
  h.host.datasetSummary = async () => held;

  const maxBytes = 8192;
  const read = await h.tool(h.host, "read_page", { source_id: "usage", max_bytes: maxBytes });
  assert.equal(read.status, 200);
  const { summary } = read.body.source;
  assert.equal(summary.columns_truncated, true);
  assert.ok(summary.columns.length > 0 && summary.columns.length < 200);
  assert.deepEqual(summary.columns, columns.slice(0, summary.columns.length));
  assert.ok(new TextEncoder().encode(JSON.stringify(read.body)).byteLength <= maxBytes);
  assert.equal(held.columns.length, 200, "the host's summary is untouched");
  assert.equal(held.columns_truncated, undefined);
});

test("stored usage tables follow or pin in place; deletion is fenced, durable and replayable", async (t) => {
  const h = await sourcesHost(t);
  const write = async (operations, extra = {}) => {
    const result = await h.setSource(h.host, operations, extra);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  await write([usage()]);
  const inserted = await write([
    { op: "insert_node", node: { type: "dataframe", attrs: { asset_id: first, title: "Usage" } } },
  ]);
  const node_id = inserted.result.edits[0].nodes[0];
  const block_id = inserted.result.edits[0].node_id;
  const comment = await h.tool(h.host, "manage_page_comment", {
    action: "add",
    node_id: block_id,
    body: "Keep this table",
    nonce: "table-comment",
  });
  assert.equal(comment.status, 200, JSON.stringify(comment.body));
  await write([{ op: "set_node", node_id, attrs: { binding: { source_id: "usage" } } }]);
  const table = async (host) => {
    const read = await h.tool(host, "read_page", { comments: "all", include_content: false });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.comments[0].node_id, block_id);
    return read.body.outline.entries.find((n) => n.type === "dataframe");
  };
  assert.deepEqual((await table(h.host)).attrs.binding, { source_id: "usage" });
  assert.equal((await table(h.host)).attrs.src, undefined);
  await write([usage({ asset_id: second, source_revision: "1" })]);
  assert.equal((await table(h.host)).node_id, node_id);
  await write([
    { op: "set_node", node_id, attrs: { binding: { source_id: "usage", revision: "1" } } },
  ]);
  assert.deepEqual((await table(h.host)).attrs.binding, { source_id: "usage", revision: "1" });
  const stale = await h.setSource(h.host, [
    { op: "delete_source", source_id: "usage", source_revision: "1" },
  ]);
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  const read = await h.tool(h.host, "read_page");
  const args = {
    revision: read.body.revision,
    nonce: "delete-usage",
    operations: [{ op: "delete_source", source_id: "usage", source_revision: "2" }],
  };
  const before = Date.now();
  const deleted = await h.tool(h.host, "edit_page", args);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.deepEqual(deleted.body.result.edits, [{ op: "delete_source", source_id: "usage" }]);
  const tombstone = deletedSource(h.host.sourcesView(), "usage");
  assert.deepEqual(tombstone.by, {
    principal: `user:anaconda-fixture:${h.auth.subject}`,
    displayName: "Fixture Person",
    driver: "ChatGPT",
  });
  assert.ok(Date.parse(tombstone.at) >= before && Date.parse(tombstone.at) <= Date.now());
  assert.equal((await table(h.host)).node_id, node_id);
  assert.deepEqual((await h.tool(h.host, "read_page", { sources: true })).body.sources, []);
  assert.equal((await h.tool(h.host, "read_page", { source_id: "usage" })).status, 404);
  const restarted = h.page();
  const replay = await h.tool(restarted, "edit_page", args);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.deepEqual(replay.body.result.edits, deleted.body.result.edits);
  assert.deepEqual(
    deletedSource(restarted.sourcesView(), "usage"),
    tombstone,
    "a replayed delete keeps the first delete's time and writer",
  );
  assert.equal((await table(restarted)).node_id, node_id);
  assert.equal(
    (await h.setSource(restarted, [usage()])).status,
    404,
    "deleted IDs cannot revive old pins",
  );
  await write([{ op: "set_node", node_id, attrs: { asset_id: first } }]);
  assert.equal((await table(h.host)).attrs.binding, undefined);
  assert.equal((await table(h.host)).attrs.asset_id, first);
});

test("new table bindings require a source and retained revision; failed edits leave the table unchanged", async (t) => {
  const h = await sourcesHost(t);
  await h.setSource(h.host, [usage()]);
  for (const binding of [
    { source_id: "missing" },
    { source_id: "usage", revision: "9" },
    { source_id: "usage", revision: 1 },
  ]) {
    const refused = await h.setSource(h.host, [
      { op: "insert_node", node: { type: "dataframe", attrs: { binding } } },
    ]);
    assert.ok(refused.status >= 400 && refused.status < 500, JSON.stringify(refused.body));
  }
  const made = await h.setSource(h.host, [
    { op: "insert_node", node: { type: "dataframe", attrs: { binding: { source_id: "usage" } } } },
  ]);
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const node_id = made.body.result.edits[0].nodes[0];
  h.assets.head = async () => null;
  const refused = await h.setSource(h.host, [
    { op: "set_node", node_id, attrs: { asset_id: second } },
  ]);
  assert.equal(refused.status, 404);
  const read = await h.tool(h.host, "read_page", { include_content: false });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body.outline.entries.find((n) => n.node_id === node_id).attrs.binding, {
    source_id: "usage",
  });
});

test("ESM and WAV sources bind to an executable view through the real Page host", async (t) => {
  const h = await sourcesHost(t);
  h.assets.head = async (key) => ({
    ...parquetHead(key.slice(-64)),
    httpMetadata: { contentType: key.endsWith(first) ? "text/javascript" : "audio/wav" },
  });
  const source = await h.setSource(h.host, [
    usage({ source_id: "code" }),
    usage({ source_id: "recording", asset_id: second }),
  ]);
  assert.equal(source.status, 200, JSON.stringify(source.body));
  const read = await h.tool(h.host, "read_page", { include_content: false });
  const view = await h.tool(h.host, "edit_page", {
    revision: read.body.revision,
    nonce: "esm-view",
    operations: [
      {
        op: "set_view",
        view_id: "audio",
        title: "Listen",
        media_type: "application/vnd.nteract.anywidget.v2+json",
        spec: {
          module: { source_id: "code" },
          buffers: [{ source: { source_id: "recording" }, path: ["recording"] }],
        },
        view_revision: null,
      },
    ],
  });
  assert.equal(view.status, 200, JSON.stringify(view.body));
  const saved = await h.tool(h.host, "read_page", { view_id: "audio" });
  assert.deepEqual(saved.body.view.spec.module, { source_id: "code" });
  assert.equal(Object.hasOwn(saved.body.view, "data"), false);
  const listed = await h.tool(h.host, "read_page", { views: true });
  assert.deepEqual(
    listed.body.views[0].dependencies.map((d) => d.source.source_id),
    ["code", "recording"],
  );
  const placed = await h.setSource(h.host, [
    { op: "insert_node", node: { type: "view", attrs: { view_id: "audio" } } },
  ]);
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
  const bad = await h.setSource(h.host, [
    {
      op: "set_view",
      view_id: "bad-widget",
      title: "Wrong type",
      media_type: "application/vnd.nteract.anywidget.v2+json",
      spec: { module: { source_id: "recording" } },
      view_revision: null,
    },
  ]);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /spec.module.*text\/javascript/);
  assert.equal((await h.tool(h.host, "read_page", { views: true })).body.views.length, 1);
  const restarted = h.page();
  const again = await h.tool(restarted, "read_page", { view_id: "audio" });
  assert.deepEqual(again.body.view.spec, saved.body.view.spec);
});

// set_source with inline text (inline-sources.mjs) ----------------------------

const sha256 = async (text) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
const MODULE = "export function render({ el }) { el.textContent = 'hi'; }\n";
const inlineSource = (fields = {}) => ({
  source_id: "code",
  name: "Code",
  text: MODULE,
  media_type: "text/javascript",
  source_revision: null,
  ...fields,
});

test("set_source with text stores the bytes as an upload would and names them", async (t) => {
  const h = await sourcesHost(t, { store: true });
  h.assets.head = async () => null;
  const written = await h.setSource(h.host, [inlineSource()]);
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.deepEqual(written.body.result.edits, [
    { op: "set_source", source_id: "code", source_revision: "1" },
  ]);
  const assetId = await sha256(MODULE);
  const object = h.assets.objects.get(imageAssetKey(pageId, assetId));
  assert.equal(new TextDecoder().decode(object.bytes), MODULE);
  assert.equal(object.httpMetadata.contentType, "text/javascript");
  assert.deepEqual(object.customMetadata, { page_id: pageId, hash: assetId });
  const read = await h.tool(h.host, "read_page", { source_id: "code" });
  assert.equal(read.body.source.asset_id, assetId);
  assert.equal(read.body.source.media_type, "text/javascript");
  assert.equal(read.body.source.producer.kind, "upload");
  // The journal holds the asset id, never the text.
  const journal = JSON.stringify([...(await h.storage.list({ prefix: "host/operation/" }))]);
  assert.equal(journal.includes("textContent"), false);

  // Refresh by text with the receipt's revision; a later set_source by the
  // stored asset_id names the same asset.
  const next = "export function render({ el }) { el.textContent = 'bye'; }\n";
  const refreshed = await h.setSource(h.host, [inlineSource({ text: next, source_revision: "1" })]);
  assert.equal(refreshed.body.result.edits[0].source_revision, "2");
  const back = await h.setSource(h.host, [
    { source_id: "code", name: "Code", asset_id: assetId, source_revision: "2" },
  ]);
  assert.equal(back.status, 200, JSON.stringify(back.body));
  const again = await h.tool(h.host, "read_page", { source_id: "code" });
  assert.deepEqual(
    again.body.source.history.map(({ revision, asset_id }) => [revision, asset_id]),
    [
      ["1", assetId],
      ["2", await sha256(next)],
      ["3", assetId],
    ],
  );
  assert.equal(h.assets.puts, 2, "the same bytes are stored once");
});

test("set_source text is refused when malformed, before anything is stored", async (t) => {
  const h = await sourcesHost(t, { store: true });
  h.assets.head = async () => null;
  for (const [bad, pattern] of [
    [{ asset_id: first }, /asset_id or text, not both/],
    [{ text: undefined }, /asset_id, or text with media_type/],
    [{ text: 42 }, /text is the source's content, a string/],
    [{ media_type: "application/vnd.apache.parquet" }, /media_type with text is exactly one of/],
    [{ media_type: "image/png" }, /media_type with text is exactly one of/],
    [{ media_type: undefined }, /media_type with text is exactly one of/],
    [{ media_type: "text/javascript; charset=utf-8" }, /media_type with text is exactly one of/],
    [{ text: "" }, /^text is empty; a source holds at least one byte$/],
    [{ text: "x\ud800y" }, /^text holds a lone UTF-16 surrogate/],
    [{ text: "x".repeat(256 * 1024 + 1) }, /at most 262144 bytes.*create_page_asset_upload/],
    // Bytes, not characters: 87,382 three-byte characters pass 256 KiB.
    [{ text: "€".repeat(87_382) }, /at most 262144 bytes/],
  ]) {
    const op = inlineSource(bad);
    for (const key of Object.keys(op)) if (op[key] === undefined) delete op[key];
    const refused = await h.setSource(h.host, [op]);
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "invalid_source");
    assert.match(refused.body.error, pattern);
  }
  // media_type goes only with text.
  const typed = await h.setSource(h.host, [usage({ media_type: "text/csv" })]);
  assert.equal(typed.status, 400);
  assert.match(typed.body.error, /media_type goes with text/);
  // A batch holds at most 512 KiB of text.
  const big = "y".repeat(256 * 1024 - 1);
  const batch = await h.setSource(
    h.host,
    Array.from({ length: 3 }, (_, i) => inlineSource({ source_id: `s${i}`, text: big + i })),
  );
  assert.equal(batch.status, 400);
  assert.match(batch.body.error, /at most 524288 bytes as JSON, escapes included/);
  // The content checks an upload gets: JSON parses, text is UTF-8 without NUL.
  for (const [type, text] of [
    ["application/json", "{not json"],
    ["text/csv", " "],
    ["text/css", "a\u0000b"],
    ["text/javascript", " \n"],
  ]) {
    const refused = await h.setSource(h.host, [inlineSource({ media_type: type, text })]);
    assert.equal(refused.status, 400, type);
    assert.equal(refused.body.code, "invalid_source", type);
    assert.match(refused.body.error, /^code: /, type);
  }
  // One asset id holds one media type.
  const twins = await h.setSource(h.host, [
    inlineSource({ source_id: "a", text: "[1]", media_type: "application/json" }),
    inlineSource({ source_id: "b", text: "[1]", media_type: "text/javascript" }),
  ]);
  assert.equal(twins.status, 400);
  assert.equal(twins.body.code, "invalid_source");
  assert.match(twins.body.error, /^b: another set_source in this batch holds the same text as/);
  // Bytes this Page stores as another type keep that type.
  h.assets.head = async (key) => ({
    ...parquetHead(key.slice(-64)),
    httpMetadata: { contentType: "application/json" },
  });
  const retyped = await h.setSource(h.host, [inlineSource({ text: "[1]" })]);
  assert.equal(retyped.status, 400);
  assert.equal(retyped.body.code, "invalid_source");
  assert.equal(
    retyped.body.error,
    "code: this Page stores the same bytes as application/json; send them with that media_type",
  );
  assert.equal(h.assets.puts, 0);
  // A stored type inline text can't carry is answered with the asset's id.
  h.assets.head = async (key) => ({
    ...parquetHead(key.slice(-64)),
    httpMetadata: { contentType: "application/octet-stream" },
  });
  const opaque = await h.setSource(h.host, [inlineSource({ text: "[1]" })]);
  assert.equal(opaque.status, 400);
  assert.equal(opaque.body.code, "invalid_source");
  assert.match(
    opaque.body.error,
    /^code: this Page stores the same bytes as application\/octet-stream; pass asset_id [a-f0-9]{64} in place of text$/,
  );
  assert.equal(h.assets.puts, 0);
  assert.equal(h.host.sourcesView(), undefined);
});

test("bytes a concurrent write stores as another type between the check and the put are invalid_source", async (t) => {
  const h = await sourcesHost(t, { store: true });
  h.assets.head = async () => null;
  // Another request stores the same bytes as JSON after this one's HEAD and
  // before its conditional put, which then finds the key taken.
  h.assets.put = async (key) => {
    h.assets.objects.set(key, {
      key,
      size: 3,
      httpMetadata: { contentType: "application/json" },
      customMetadata: { page_id: pageId, hash: key.slice(-64) },
    });
  };
  const raced = await h.setSource(h.host, [inlineSource({ text: "[1]" })]);
  assert.equal(raced.status, 400, JSON.stringify(raced.body));
  assert.equal(raced.body.code, "invalid_source");
  assert.equal(
    raced.body.error,
    "code: this Page stores the same bytes as application/json; send them with that media_type",
  );
  assert.equal(h.host.sourcesView(), undefined);
});

test("JSON text with a byte order mark is accepted, as an uploaded file is", async (t) => {
  const h = await sourcesHost(t, { store: true });
  h.assets.head = async () => null;
  const text = '\ufeff{"limit":3}';
  const written = await h.setSource(h.host, [
    inlineSource({ source_id: "settings", text, media_type: "application/json" }),
  ]);
  assert.equal(written.status, 200, JSON.stringify(written.body));
  const object = h.assets.objects.get(imageAssetKey(pageId, await sha256(text)));
  assert.deepEqual([...object.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "stored as sent");
});

test("a nonce names one inline request: its text and its media type", async (t) => {
  const h = await sourcesHost(t, { store: true });
  h.assets.head = async () => null;
  const read = await h.tool(h.host, "read_page", { include_content: false });
  const send = (fields) =>
    h.tool(h.host, "edit_page", {
      revision: read.body.revision,
      nonce: "inline-nonce",
      operations: [
        {
          op: "set_source",
          ...inlineSource({ text: "[1]", media_type: "application/json", ...fields }),
        },
      ],
    });
  const written = await send({});
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.deepEqual(await send({}), written, "the same text and type replay the receipt");
  for (const [what, fields] of [
    ["other text", { text: "[2]" }],
    ["another media type", { media_type: "text/javascript" }],
    [
      "the same bytes by asset_id",
      { text: undefined, media_type: undefined, asset_id: await sha256("[1]") },
    ],
  ]) {
    const op = inlineSource({ text: "[1]", media_type: "application/json", ...fields });
    for (const key of Object.keys(op)) if (op[key] === undefined) delete op[key];
    const conflict = await h.tool(h.host, "edit_page", {
      revision: read.body.revision,
      nonce: "inline-nonce",
      operations: [{ op: "set_source", ...op }],
    });
    assert.equal(conflict.status, 409, `${what}: ${JSON.stringify(conflict.body)}`);
    assert.equal(conflict.body.code, "nonce_conflict", what);
  }
  const source = (await h.tool(h.host, "read_page", { source_id: "code" })).body.source;
  assert.equal(source.media_type, "application/json");
  assert.equal(source.source_revision, "1");
});

test("access revoked before the store refuses an inline write with nothing stored", async (t) => {
  const h = await sourcesHost(t, { store: true });
  h.assets.head = async () => null;
  const read = await h.tool(h.host, "read_page", { include_content: false });
  // The route's check passes; the check in prepare, before the store, finds
  // the access gone.
  const account = h.host.policy.account.bind(h.host.policy);
  let checks = 0;
  h.host.policy.account = (identity, write) => {
    if (write && ++checks === 2)
      throw Object.assign(Error("Page is read-only"), { status: 403, code: "access_denied" });
    return account(identity, write);
  };
  const refused = await h.tool(h.host, "edit_page", {
    revision: read.body.revision,
    nonce: "inline-revoked",
    operations: [{ op: "set_source", ...inlineSource() }],
  });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(checks, 2);
  assert.equal(h.assets.puts, 0);
  assert.equal(h.host.sourcesView(), undefined);
});

test("an inline retry with the same nonce stores one asset and replays one revision", async (t) => {
  const h = await sourcesHost(t, { store: true });
  h.assets.head = async () => null;
  const read = await h.tool(h.host, "read_page", { include_content: false });
  const args = {
    revision: read.body.revision,
    nonce: "inline-once",
    operations: [{ op: "set_source", ...inlineSource() }],
  };
  // The first attempt stores the bytes, then stops before its journal entry.
  h.storage.crashes.push({ test: (name) => name.startsWith("host/operation/"), before: true });
  const lost = await h.tool(h.host, "edit_page", args);
  assert.equal(lost.status, 500);
  assert.equal(h.assets.objects.size, 1);
  assert.equal(h.host.sourcesView()?.sources?.code, undefined);
  // The retry finds the bytes stored and writes the source once.
  const host = h.page();
  const written = await h.tool(host, "edit_page", args);
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal(written.body.result.edits[0].source_revision, "1");
  const puts = h.assets.puts;
  h.assets.put = async () => assert.fail("A replay must not store");
  const replayed = await h.tool(host, "edit_page", args);
  assert.deepEqual(replayed, written);
  assert.equal(h.assets.puts, puts);
  assert.equal(h.assets.objects.size, 1);
  const source = (await h.tool(host, "read_page", { source_id: "code" })).body.source;
  assert.equal(source.source_revision, "1");
  assert.equal(source.history.length, 1);
});

test("an inline write that crashed after its journal entry replays without storing again", async (t) => {
  const h = await sourcesHost(t, { store: true });
  h.assets.head = async () => null;
  const read = await h.tool(h.host, "read_page", { include_content: false });
  const args = {
    revision: read.body.revision,
    nonce: "inline-journaled",
    operations: [{ op: "set_source", ...inlineSource() }],
  };
  // The pending entry is durable; the process dies right after it.
  h.storage.crashes.push({
    test: (name, value) => name.startsWith("host/operation/") && value?.pending,
  });
  const lost = await h.tool(h.host, "edit_page", args);
  assert.equal(lost.status, 500);
  assert.equal(h.assets.puts, 1);
  const host = h.page();
  h.assets.put = async () => assert.fail("A journaled write must not store again");
  h.assets.head = async () => assert.fail("A journaled write must not look up its assets");
  const replayed = await h.tool(host, "edit_page", args);
  assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
  assert.equal(replayed.body.result.edits[0].source_revision, "1");
  const source = (await h.tool(host, "read_page", { source_id: "code" })).body.source;
  assert.equal(source.asset_id, await sha256(MODULE));
  assert.equal(source.history.length, 1);
});

test("a failed inline store leaves the sources document untouched", async (t) => {
  const h = await sourcesHost(t, { store: true });
  h.assets.head = async () => null;
  h.assets.put = async () => {
    throw Error("Simulated object store outage");
  };
  const failed = await h.setSource(h.host, [inlineSource()]);
  assert.equal(failed.status, 500);
  assert.equal(h.host.sourcesView(), undefined, "no sources document is created");
  assert.deepEqual(await h.sourcesStored(), []);
  h.assets.put = async () => {};
  assert.equal((await h.setSource(h.host, [inlineSource()])).status, 200);
  const before = (await h.tool(h.host, "read_page", { source_id: "code" })).body;
  h.assets.put = async () => {
    throw Error("Simulated object store outage");
  };
  const refresh = await h.setSource(h.host, [
    inlineSource({ text: "export default 2;", source_revision: "1" }),
  ]);
  assert.equal(refresh.status, 500);
  const after = (await h.tool(h.host, "read_page", { source_id: "code" })).body;
  assert.deepEqual(after.source, before.source);
  assert.equal(after.sources_revision, before.sources_revision);
});

test("a batch stores every inline asset before its one change names any, and stays atomic", async (t) => {
  const h = await sourcesHost(t, { store: true });
  h.assets.head = async (key) => (key.endsWith(first) ? parquetHead(first) : null);
  // The Page has a sources document already, so a change that named a
  // source before its bytes were stored would show at a put.
  assert.equal((await h.setSource(h.host, [usage({ source_id: "seed" })])).status, 200);
  const seen = [];
  h.assets.put = async () => seen.push(Object.keys(h.host.sourcesView().sources).sort());
  const batch = [
    inlineSource({ source_id: "entry" }),
    inlineSource({ source_id: "helper", text: "export default 1;\n" }),
    inlineSource({ source_id: "settings", text: '{"limit":3}', media_type: "application/json" }),
    inlineSource({ source_id: "rows", text: "day,people\n1,2\n", media_type: "text/csv" }),
    usage({ source_id: "daily" }),
  ];
  const written = await h.setSource(h.host, batch);
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.deepEqual(
    seen,
    [["seed"], ["seed"], ["seed"], ["seed"]],
    "nothing is named while assets are stored",
  );
  assert.deepEqual(
    written.body.result.edits.map(({ source_id, source_revision }) => [source_id, source_revision]),
    ["entry", "helper", "settings", "rows", "daily"].map((id) => [id, "1"]),
  );
  const listed = (await h.tool(h.host, "read_page", { sources: true })).body.sources;
  assert.deepEqual(
    Object.fromEntries(listed.map(({ source_id, media_type }) => [source_id, media_type])),
    {
      daily: PARQUET,
      seed: PARQUET,
      entry: "text/javascript",
      helper: "text/javascript",
      rows: "text/csv",
      settings: "application/json",
    },
  );
  // One operation the store refuses refuses the whole batch: no source moves.
  const refused = await h.setSource(h.host, [
    inlineSource({ source_id: "entry", text: "export default 3;", source_revision: "1" }),
    inlineSource({
      source_id: "settings",
      text: "{",
      media_type: "application/json",
      source_revision: "1",
    }),
  ]);
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(refused.body.error, /^settings: Use a valid UTF-8 JSON file/);
  assert.deepEqual((await h.tool(h.host, "read_page", { sources: true })).body.sources, listed);
});

test("an inline set_source with a stale revision is stale_source, and stores nothing", async (t) => {
  const h = await sourcesHost(t, { store: true });
  h.assets.head = async () => null;
  assert.equal((await h.setSource(h.host, [inlineSource()])).status, 200);
  const second = await h.setSource(h.host, [
    inlineSource({ text: "export default 1;", source_revision: "1" }),
  ]);
  assert.equal(second.status, 200);
  const puts = h.assets.puts;
  for (const source_revision of ["1", null]) {
    const stale = await h.setSource(h.host, [
      inlineSource({ text: "export default 9;", source_revision }),
    ]);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "stale_source");
    assert.equal(stale.body.source_id, "code");
    assert.equal(stale.body.source_revision, "2");
  }
  assert.equal(h.assets.puts, puts);
});

test("a module view saved against inline sources reads their stored code", async (t) => {
  const h = await sourcesHost(t, { store: true });
  h.assets.head = async () => null;
  const sources = await h.setSource(h.host, [
    inlineSource({
      source_id: "main",
      text: `import helper from "helper";\nexport function render({ el }) { el.textContent = helper; }\n`,
    }),
    inlineSource({ source_id: "helper", text: `import "./sibling.js";\nexport default 1;\n` }),
  ]);
  assert.equal(sources.status, 200, JSON.stringify(sources.body));
  const view = {
    op: "set_view",
    view_type: "module",
    view_id: "chart",
    title: "Chart",
    module: { source_id: "main" },
    imports: { helper: { source_id: "helper" } },
    view_revision: null,
  };
  // set_view reads the helper's stored bytes and finds its relative import.
  const refused = await h.setSource(h.host, [view]);
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(refused.body.error, /"\.\/sibling\.js" in import "helper"/);
  const fixed = await h.setSource(h.host, [
    inlineSource({ source_id: "helper", text: "export default 1;\n", source_revision: "1" }),
  ]);
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  const saved = await h.setSource(h.host, [view]);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.warnings, undefined);
  const read = await h.tool(h.host, "read_page", { views: true });
  assert.deepEqual(
    read.body.views[0].dependencies.map((d) => d.source.source_id),
    ["main", "helper"],
  );
  const placed = await h.setSource(h.host, [
    { op: "insert_node", node: { type: "view", attrs: { view_id: "chart" } } },
  ]);
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
});

test("inline text exactly at the JSON cap fits the host's request and is stored", async (t) => {
  const h = await sourcesHost(t, { store: true });
  h.assets.head = async () => null;
  // 87,381 control characters are 524,288 bytes as JSON, quotes included.
  const text = "\u0001".repeat(87_381);
  const written = await h.setSource(h.host, [inlineSource({ text })]);
  assert.equal(written.status, 200, JSON.stringify(written.body).slice(0, 200));
  const over = await h.setSource(h.host, [inlineSource({ source_id: "other", text: `${text}a` })]);
  assert.equal(over.status, 400);
  assert.match(over.body.error, /at most 524288 bytes as JSON.*create_page_asset_upload/);
  assert.equal(h.assets.puts, 1);
});
