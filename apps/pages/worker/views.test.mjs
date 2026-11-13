// A Page's views end to end, on a Page host over real plain sync and
// in-memory storage: the agent contract (edit_page set_view, read_page views,
// insert_node of a view node), each view's document created on its first
// write, the cap, the refusals that create nothing, sockets, restarts and
// purge.

import assert from "node:assert/strict";
import test from "node:test";
import * as A from "@automerge/automerge";
import { createAuthFixture } from "../auth-fixtures.mjs";
import { MEMBER_FORMATS, readableFormats } from "../model/document-types.mjs";
import { documentFeatures } from "../model/schema-features.mjs";
import { checkChartSpec } from "../shared/chart-spec.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import { commentsDocUuid, commentsDocumentId } from "./comments-store.mjs";
import { derivedDocumentId, sourcesDocUuid, viewDocumentId } from "../shared/document-ids.mjs";
import { BUILD_FEATURES } from "../model/schema-features.mjs";
import { decodeFrame, encodeFrame, framePipe } from "../sync/wire.mjs";
import { until } from "../sync/test-helpers.mjs";
import { Storage, pageId } from "./trash-fixture.mjs";
import { Page } from "./index.mjs";
import { treeOf } from "./plain-sync.mjs";

const PARQUET = "application/vnd.apache.parquet";
const VEGA_LITE = "application/vnd.vegalite.v6+json";
const first = "a".repeat(64),
  second = "b".repeat(64);

/** Storage that deletes key lists, as plain sync's purge does. A crash
 * `{ test, before }` throws once from the first put with an entry that
 * passes `test`: before storing it, or after. */
class PlainStorage extends Storage {
  crashes = [];
  // Tests of key names: the next delete of a key one passes throws once,
  // before deleting anything.
  failDeletes = [];
  // Tests of this storage: the next sync one passes throws once.
  failSyncs = [];
  // Tests in `stuck` fail every time they pass, until removed.
  stuck = [];
  async sync() {
    if (this.stuck.some((test) => test.sync?.(this))) throw Error("Simulated sync failure");
    const index = this.failSyncs.findIndex((test) => test(this));
    if (index >= 0) {
      this.failSyncs.splice(index, 1);
      throw Error("Simulated crash before a sync");
    }
    return super.sync();
  }
  async delete(key) {
    const names = Array.isArray(key) ? key : [key];
    if (this.stuck.some((test) => names.some((name) => test.delete?.(name))))
      throw Error("Simulated delete failure");
    const index = this.failDeletes.findIndex((test) => names.some(test));
    if (index >= 0) {
      this.failDeletes.splice(index, 1);
      throw Error("Simulated crash before a delete");
    }
    for (const name of names) this.values.delete(name);
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

const parquetHead = (assetId) => ({
  size: 1018,
  httpMetadata: { contentType: PARQUET },
  customMetadata: { page_id: pageId, hash: assetId },
});

/** A Page over real plain sync with one source, `usage`, at revisions "1"
 * (asset `first`) and "2" (asset `second`). `page()` starts a new host over
 * the same storage, as after eviction or a crash. With `documentId`, the
 * Page is a registered draft under that document id, and with `sources:
 * false` it holds no source. */
async function viewsHost(t, { documentId, sources = true, registerOnly = false } = {}) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  t.mock.method(console, "error", () => {});
  const storage = new PlainStorage();
  const env = {
    ...auth.env,
    CATALOGS: { getByName: () => ({ fetch: async () => Response.json({ ok: true }) }) },
    PAGES_ASSETS: { head: async (key) => parquetHead(key.slice(-64)) },
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
  const edit = async (host, operations, nonce = `views-${++nonces}`) => {
    const read = await tool(host, "read_page", { include_content: false });
    return tool(host, "edit_page", { revision: read.body.revision, nonce, operations });
  };
  const setView = (host, fields = {}, nonce) =>
    edit(host, [{ op: "set_view", ...chart(fields) }], nonce);
  const host = page();
  let created;
  if (documentId) {
    const draft = A.change(A.from(createPageData({ pageId, title: "Usage" })), (doc) =>
      initializePage(doc, "Some text"),
    );
    created = await call(host, "/internal/register", {
      page_id: pageId,
      expected_principal: `user:anaconda-fixture:${auth.subject}`,
      document_id: documentId,
      initial_snapshot_base64: Buffer.from(A.save(draft)).toString("base64"),
      title: "Usage",
      nonce: "register-draft",
      record_storage: "automerge",
    });
    A.free(draft);
    if (registerOnly) return { storage, created };
  } else
    created = await call(host, "/internal/create", {
      page_id: pageId,
      title: "Usage",
      markdown: "Some text",
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const versions = [
    [first, null],
    [second, "1"],
  ];
  for (const [asset_id, source_revision] of sources ? versions : []) {
    const source = await edit(host, [
      { op: "set_source", source_id: "usage", name: "Usage", asset_id, source_revision },
    ]);
    assert.equal(source.status, 200, JSON.stringify(source.body));
  }
  const record = () => storage.get("host/document");
  const keys = async (prefix) => [...(await storage.list({ prefix })).keys()];
  // A view document's own stored history: its manifest and chunks.
  const viewStored = async (viewId) =>
    keys(`plain/sync/${treeOf(await viewDocumentId(pageId, viewId))}/`);
  // What a refused write must leave as it was.
  const snapshot = async () => ({
    record: (await record()).documentFormats,
    views: await keys("host/view/"),
    writers: await keys("plain/writer/"),
    plain: (await keys("plain/sync/")).length,
  });
  return {
    storage,
    host,
    page,
    call,
    tool,
    edit,
    setView,
    record,
    keys,
    viewStored,
    snapshot,
  };
}

const SPEC = Object.freeze({
  data: { name: "usage" },
  mark: "line",
  encoding: {
    x: { field: "day", type: "temporal" },
    y: { field: "count", type: "quantitative" },
  },
});
const chart = (fields = {}) => ({
  view_id: "daily",
  title: "Daily usage",
  media_type: VEGA_LITE,
  spec: SPEC,
  data: { usage: { source_id: "usage" } },
  view_revision: null,
  ...fields,
});

test("set_view creates a view, rewrites it, refuses a stale revision, and reads it back", async (t) => {
  const h = await viewsHost(t);
  const empty = await h.tool(h.host, "read_page", { views: true });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.views, []);
  assert.equal(empty.body.blocks, undefined, "a views read skips the Page's content");
  assert.equal(
    (await h.call(h.host, `/api/connect?page=${pageId}`)).body.documents.views,
    undefined,
  );
  const before = await h.snapshot();

  const created = await h.setView(h.host);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.view_revision, "1");
  assert.equal(created.body.revision, undefined, "a view write names no Page revision");
  assert.deepEqual(created.body.result.edits, [
    { op: "set_view", view_id: "daily", view_revision: "1" },
  ]);
  // The key is the view's only record: a host that predates views opens
  // the Page.
  assert.deepEqual((await h.record()).documentFormats, { ...MEMBER_FORMATS, "pages.sources": 1 });
  assert.deepEqual(await h.keys("host/view/"), ["host/view/daily"]);
  assert.equal((await h.keys("plain/writer/")).length, before.writers.length, "same writer");
  const connected = await h.call(h.host, `/api/connect?page=${pageId}`);
  assert.deepEqual(connected.body.documents.views, {
    daily: await viewDocumentId(pageId, "daily"),
  });

  const listed = await h.tool(h.host, "read_page", { views: true });
  assert.deepEqual(listed.body.views, [
    {
      view_id: "daily",
      title: "Daily usage",
      media_type: VEGA_LITE,
      revision: "1",
      data: { usage: { source_id: "usage" } },
    },
  ]);
  const one = await h.tool(h.host, "read_page", { view_id: "daily" });
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.view.spec, SPEC);
  assert.equal(one.body.view.producer.kind, "edit_page");
  assert.equal(one.body.view.producer.by.driver, "ChatGPT");
  const doc = h.host.viewDoc("daily");
  assert.equal(typeof doc.spec, "string", "the spec is stored as text");
  assert.deepEqual(JSON.parse(doc.spec), SPEC);

  // A rewrite names the revision it read and pins a source revision.
  const spec = { ...SPEC, mark: "bar" };
  const rewritten = await h.setView(h.host, {
    title: "Daily usage, as bars",
    spec,
    data: { usage: { source_id: "usage", revision: "1" } },
    view_revision: "1",
  });
  assert.equal(rewritten.status, 200, JSON.stringify(rewritten.body));
  assert.equal(rewritten.body.view_revision, "2");
  const reread = await h.tool(h.host, "read_page", { view_id: "daily" });
  assert.deepEqual(reread.body.view.spec, spec);
  assert.deepEqual(reread.body.view.data, { usage: { source_id: "usage", revision: "1" } });
  assert.equal(reread.body.view.title, "Daily usage, as bars");

  for (const [view_revision, status, code] of [
    ["1", 409, "stale_view"],
    [null, 409, "stale_view"],
  ]) {
    const refused = await h.setView(h.host, { view_revision });
    assert.equal(refused.status, status, JSON.stringify(refused.body));
    assert.equal(refused.body.code, code);
    assert.equal(refused.body.view_id, "daily");
    assert.equal(refused.body.view_revision, "2");
  }
  const missing = await h.setView(h.host, { view_id: "weekly", view_revision: "1" });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "view_not_found");
  const unknown = await h.tool(h.host, "read_page", { view_id: "weekly" });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, "view_not_found");

  // A new host boots every listed view.
  const next = h.page();
  const booted = await h.tool(next, "read_page", { views: true });
  assert.equal(booted.body.views[0].revision, "2");
});

test("every set_view refusal creates no document, no listed view and no writer", async (t) => {
  const h = await viewsHost(t);
  const refusedByChart = { ...SPEC, data: { url: "https://example.com/data.json" } };
  const expected = checkChartSpec(refusedByChart, { datasets: ["usage"] });
  assert.equal(expected.ok, false);
  const huge = { ...SPEC, description: "x".repeat(64 * 1024) };
  const cases = [
    [{ view_id: "Bad" }, 400, "invalid_view"],
    [{ view_id: "__proto__" }, 400, "invalid_view"],
    [
      { view_id: "constructor" },
      400,
      "invalid_view",
      "view_id must match ^[a-z][a-z0-9_-]{0,63}$, not constructor or prototype",
    ],
    [
      { title: "Daily\nusage" },
      400,
      "invalid_view",
      "title can't hold control characters such as a newline or NUL",
    ],
    [{ title: "  " }, 400, "invalid_view"],
    [{ title: "x".repeat(201) }, 400, "invalid_view"],
    [{ media_type: "application/vnd.vega.v5+json" }, 400, "invalid_view"],
    [{ spec: [] }, 400, "invalid_view"],
    [{ spec: "{}" }, 400, "invalid_view"],
    [{ spec: huge }, 400, "invalid_view"],
    [{ spec: refusedByChart }, 400, "invalid_view", expected.error],
    [
      { data: { usage: { source_id: "usage" }, extra: { source_id: "usage" } } },
      400,
      "invalid_view",
      'data names "extra", but the spec doesn\'t read it.',
    ],
    [
      { data: { other: { source_id: "usage" } } },
      400,
      "invalid_view",
      checkChartSpec(SPEC, { datasets: ["other"] }).error,
    ],
    [{ data: { usage: { source_id: "usage", extra: 1 } } }, 400, "invalid_view"],
    // A data name is a safe key, and a source_id is checked before a lookup.
    ...["1usage", "us age", "constructor", "prototype", "x".repeat(65)].map((name) => [
      { data: { [name]: { source_id: "usage" } } },
      400,
      "invalid_view",
      `data can't name "${name.slice(0, 64)}": a data name matches ^[A-Za-z_][A-Za-z0-9_-]{0,63}$, not constructor or prototype or __proto__`,
    ]),
    [
      { data: JSON.parse('{"__proto__": {"source_id": "usage"}}') },
      400,
      "invalid_view",
      `data can't name "__proto__": a data name matches ^[A-Za-z_][A-Za-z0-9_-]{0,63}$, not constructor or prototype or __proto__`,
    ],
    [
      { data: { usage: { source_id: "__proto__" } } },
      400,
      "invalid_view",
      'data.usage.source_id must match ^[a-z][a-z0-9_-]{0,63}$, not "__proto__"',
    ],
    [
      {
        data: Object.fromEntries(
          Array.from({ length: 33 }, (_, i) => [`d${i}`, { source_id: "usage" }]),
        ),
      },
      400,
      "invalid_view",
      "data can bind at most 32 data names",
    ],
    [{ data: { usage: { source_id: "missing" } } }, 400, "unknown_source"],
    [{ data: { usage: { source_id: "usage", revision: "9" } } }, 400, "unknown_source_revision"],
    [{ view_revision: "1" }, 404, "view_not_found"],
    [{ view_revision: "one" }, 400, "invalid_view"],
    [{ extra: true }, 400, "invalid_view"],
  ];
  const before = await h.snapshot();
  for (const [fields, status, code, message] of cases) {
    const refused = await h.setView(h.host, fields);
    const label = JSON.stringify(fields).slice(0, 80);
    assert.equal(refused.status, status, `${label}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.code, code, label);
    if (message) assert.equal(refused.body.error, message, label);
    assert.deepEqual(await h.snapshot(), before, label);
    assert.deepEqual(await h.viewStored("daily"), [], label);
  }
  assert.equal(h.host.viewDoc("daily"), undefined);
  const mixed = await h.edit(h.host, [
    { op: "set_view", ...chart() },
    { op: "set_title", title: "Other" },
  ]);
  assert.equal(mixed.status, 400);
  assert.equal(mixed.body.code, "invalid_arguments");
  assert.deepEqual(await h.snapshot(), before);
});

test("a Page holds ten views, each served; an eleventh is refused naming them", async (t) => {
  const h = await viewsHost(t);
  const ids = Array.from({ length: 10 }, (_, i) => `v${i}`);
  for (const view_id of ids)
    assert.equal((await h.setView(h.host, { view_id })).status, 200, view_id);
  const documentIds = await Promise.all(ids.map((id) => viewDocumentId(pageId, id)));
  for (const id of documentIds) assert.ok(h.host.documentIds().includes(id));
  const connected = await h.call(h.host, `/api/connect?page=${pageId}`);
  assert.deepEqual(
    connected.body.documents.views,
    Object.fromEntries(ids.map((id, i) => [id, documentIds[i]])),
  );
  const before = await h.snapshot();
  const over = await h.setView(h.host, { view_id: "eleventh" });
  assert.equal(over.status, 400);
  assert.equal(over.body.code, "view_limit");
  for (const id of ids) assert.ok(over.body.error.includes(id), id);
  assert.deepEqual(over.body.view_ids, ids);
  assert.deepEqual(await h.snapshot(), before);
  // Rewriting one of the ten is still allowed.
  assert.equal((await h.setView(h.host, { view_id: "v3", view_revision: "1" })).status, 200);
  // A new host boots and serves all ten.
  const next = h.page();
  const listed = await h.tool(next, "read_page", { views: true });
  assert.deepEqual(
    listed.body.views.map((view) => view.view_id),
    ids,
  );
  for (const id of documentIds) assert.ok(next.documentIds().includes(id));
});

test("insert_node places a view the Page holds and refuses one it doesn't", async (t) => {
  const h = await viewsHost(t);
  const before = await h.tool(h.host, "read_page", { include_content: false });
  const unknown = await h.edit(h.host, [
    { op: "insert_node", node: { type: "view", attrs: { view_id: "daily" } } },
  ]);
  assert.equal(unknown.status, 400, JSON.stringify(unknown.body));
  assert.equal(unknown.body.code, "unknown_view");
  const after = await h.tool(h.host, "read_page", { include_content: false });
  assert.equal(after.body.revision, before.body.revision, "the Page is unchanged");
  const malformed = await h.edit(h.host, [
    { op: "insert_node", node: { type: "view", attrs: { view_id: "Not An Id" } } },
  ]);
  assert.equal(malformed.status, 400, JSON.stringify(malformed.body));
  assert.equal(malformed.body.code, "invalid_edit_selector");

  assert.equal((await h.setView(h.host)).status, 200);
  const inserted = await h.edit(h.host, [
    { op: "insert_node", node: { type: "view", attrs: { view_id: "daily" } } },
  ]);
  assert.equal(inserted.status, 200, JSON.stringify(inserted.body));
  const edit = inserted.body.result.edits[0];
  assert.equal(edit.type, "view");
  assert.deepEqual(edit.attrs, { view_id: "daily" });

  const read = await h.tool(h.host, "read_page", { comments: "none" });
  const line = String.raw`\[View: daily\]`;
  assert.ok(
    read.body.blocks.some((block) => block.markdown === line),
    JSON.stringify(read.body),
  );
  const entry = read.body.outline.entries.find((item) => item.type === "view");
  assert.deepEqual(entry.attrs, { view_id: "daily" });
  assert.deepEqual(entry.summary, { title: "Daily usage", media_type: VEGA_LITE });
  assert.ok(read.body.schema_features.includes("view"), "the Page carries the view stamp");
  assert.ok(documentFeatures(h.host.handle.doc()).includes("view"));

  // A rewrite that keeps the line keeps the node.
  const block = read.body.blocks.find((item) => item.markdown === line);
  const rewritten = await h.edit(h.host, [
    { op: "replace_block_markdown", node_id: block.node_id, markdown: `Intro\n\n${line}` },
  ]);
  assert.equal(rewritten.status, 200, JSON.stringify(rewritten.body));
  const reread = await h.tool(h.host, "read_page", { comments: "none" });
  assert.equal(reread.body.outline.entries.filter((item) => item.type === "view").length, 1);
  // One without it is refused.
  const dropped = await h.edit(h.host, [
    { op: "replace_block_markdown", node_id: block.node_id, markdown: "Intro" },
  ]);
  assert.equal(dropped.status, 400);
  assert.equal(dropped.body.code, "markdownless_node");
  assert.match(dropped.body.error, /a view with no line/);

  // delete_node removes the embed and keeps the view.
  const node = reread.body.outline.entries.find((item) => item.type === "view");
  const deleted = await h.edit(h.host, [{ op: "delete_node", node_id: node.node_id }]);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal((await h.tool(h.host, "read_page", { views: true })).body.views.length, 1);
});

/** A browser on the host's PlainSync, declaring this build's formats. */
function browser(plain) {
  const link = framePipe();
  const socket = new EventTarget();
  socket.send = (bytes) => link.host.send(decodeFrame(bytes));
  socket.close = (code, reason) => link.host.close(code, reason);
  link.host.onMessage((frame) =>
    socket.dispatchEvent(Object.assign(new Event("message"), { data: encodeFrame(frame).buffer })),
  );
  link.host.onClose(() => socket.dispatchEvent(new Event("close")));
  const frames = [];
  link.client.onMessage((frame) => frames.push(frame));
  plain.accept(
    socket,
    {
      principal: "user:anaconda-fixture:fixture-user",
      displayName: "Reader",
      driver: "Browser",
      canWrite: false,
      credentialKind: "api-key",
      expiresAt: Date.now() + 3_600_000,
    },
    {
      features: [...BUILD_FEATURES],
      formats: readableFormats(),
      senderId: `b-${crypto.randomUUID()}`,
    },
  );
  let r = 0;
  return {
    frames,
    /** Ask for `id` with an empty document; resolve with the host's answer. */
    async ask(id) {
      const [, message] = A.generateSyncMessage(A.init(), A.initSyncState());
      const frame = { t: "sync", doc: treeOf(id), m: message, r: ++r };
      link.client.send(frame);
      await until(() => frames.some((f) => f.r === frame.r), { label: `answer to ${frame.r}` });
      return frames.find((f) => f.r === frame.r);
    },
  };
}

test("a view created while a socket is open is served to that socket", async (t) => {
  const h = await viewsHost(t);
  const id = await viewDocumentId(pageId, "daily");
  const tab = browser(h.host.plain);
  const before = await tab.ask(id);
  assert.equal(before.has, false, "no view yet");
  assert.equal((await h.setView(h.host)).status, 200);
  const after = await tab.ask(id);
  assert.equal(after.t, "sync");
  assert.equal(after.has, true, "the same socket syncs the new view");
  assert.deepEqual([...after.heads].sort(), A.getHeads(h.host.viewDoc("daily")).sort());
});

test("a restart after a view's genesis is stored, before its key is written, starts over", async (t) => {
  const h = await viewsHost(t);
  h.storage.crashes.push({ test: (name) => name === "host/view/daily", before: true });
  assert.equal((await h.setView(h.host)).status, 500);
  assert.ok((await h.viewStored("daily")).length > 0, "the genesis is stored");
  const host = h.page();
  assert.deepEqual((await h.tool(host, "read_page", { views: true })).body.views, []);
  assert.deepEqual(await h.keys("host/view/"), []);
  const written = await h.setView(host);
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal(written.body.view_revision, "1");
});

test("a restart after a view write is journaled replays it, and the retry returns its receipt", async (t) => {
  const h = await viewsHost(t);
  h.storage.crashes.push({
    test: (name, value) => name.startsWith("host/operation/") && value?.pending === true,
    before: false,
  });
  const read = await h.tool(h.host, "read_page", { include_content: false });
  const args = {
    revision: read.body.revision,
    nonce: "journaled-view",
    operations: [{ op: "set_view", ...chart() }],
  };
  assert.equal((await h.tool(h.host, "edit_page", args)).status, 500);
  const host = h.page();
  const views = await h.tool(host, "read_page", { views: true });
  assert.equal(views.body.views[0].revision, "1");
  const retried = await h.tool(host, "edit_page", args);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.view_revision, "1");
});

test("purge deletes every view's document and the host's view list", async (t) => {
  const h = await viewsHost(t);
  for (const view_id of ["a", "b", "c"])
    assert.equal((await h.setView(h.host, { view_id })).status, 200);
  const host = h.page();
  assert.equal(
    (await h.call(host, "/internal/trash", { page_id: pageId, nonce: "trash-it" })).status,
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
  assert.deepEqual(await h.keys("plain/"), []);
  assert.deepEqual(await h.keys("host/view/"), []);
  for (const view_id of ["a", "b", "c"]) assert.equal(host.viewDoc(view_id), undefined);
});

/** Edit `operations` against `revision` without reading first. */
const editAt = (h, revision, nonce, operations) =>
  h.tool(h.host, "edit_page", { revision, nonce, operations });

test("a full journal refuses a new view before its slot is taken", async (t) => {
  const h = await viewsHost(t);
  const before = await h.snapshot();
  const { revision } = (await h.tool(h.host, "read_page", { include_content: false })).body;
  const pending = Array.from({ length: 64 }, (_, n) => `host/operation/held-${n}`);
  for (const key of pending)
    h.storage.values.set(key, {
      fingerprint: key,
      pending: true,
      createdAt: new Date().toISOString(),
    });
  const refused = await editAt(h, revision, "full-journal", [{ op: "set_view", ...chart() }]);
  assert.equal(refused.status, 429, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "pending_operation_capacity");
  assert.deepEqual(await h.snapshot(), before);
  assert.deepEqual(await h.viewStored("daily"), []);
  assert.equal(h.host.views?.has("daily") ?? false, false);
  for (const key of pending) h.storage.values.delete(key);
  const written = await editAt(h, revision, "drained", [{ op: "set_view", ...chart() }]);
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal(written.body.view_revision, "1");
});

/** A view slot no write landed in: the host fails between the key and the
 * journal entry. */
async function emptySlot(h) {
  h.storage.crashes.push({
    test: (name, value) => name.startsWith("host/operation/") && value?.pending === true,
    before: true,
  });
  assert.equal((await h.setView(h.host)).status, 500);
  assert.deepEqual(await h.keys("host/view/"), ["host/view/daily"], "the slot is taken");
}

test("a slot whose write failed stays served and unlisted, and its next write reaches an open tab", async (t) => {
  const h = await viewsHost(t);
  await emptySlot(h);
  assert.equal(
    (await h.call(h.host, `/api/connect?page=${pageId}`)).body.documents.views,
    undefined,
    "a view with no revision isn't advertised",
  );
  assert.deepEqual((await h.tool(h.host, "read_page", { views: true })).body.views, []);
  // A tab syncs the genesis while the slot holds no write.
  const id = await viewDocumentId(pageId, "daily");
  const tab = browser(h.host.plain);
  const genesis = await tab.ask(id);
  assert.equal(genesis.has, true);
  const seen = tab.frames.length;
  const written = await h.setView(h.host, {}, "after-failure");
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal(written.body.view_revision, "1");
  // The same subscription gets the write, with no new request.
  const heads = A.getHeads(h.host.viewDoc("daily")).sort();
  await until(
    () =>
      tab.frames
        .slice(seen)
        .some((frame) => frame.doc === treeOf(id) && sameHeads(frame.heads, heads)),
    { label: "the write pushed to the open tab" },
  );
});

const sameHeads = (a, b) =>
  Array.isArray(a) && a.length === b.length && [...a].sort().every((x, i) => x === b[i]);

test("boot releases a slot no write landed in", async (t) => {
  const h = await viewsHost(t);
  await emptySlot(h);
  const host = h.page();
  assert.deepEqual((await h.tool(host, "read_page", { views: true })).body.views, []);
  assert.deepEqual(await h.keys("host/view/"), [], "boot released the slot");
  assert.deepEqual(await h.viewStored("daily"), []);
  assert.equal(host.views?.has("daily") ?? false, false);
  const written = await h.setView(host);
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal(written.body.view_revision, "1");
});

/** Each step of an empty slot's release, failing every time it runs. */
const releaseSteps = async () => {
  const tree = `plain/sync/${treeOf(await viewDocumentId(pageId, "daily"))}/`;
  return [
    ["the document delete", { delete: (name) => name.startsWith(tree) }],
    ["the key delete", { delete: (name) => name === "host/view/daily" }],
  ];
};
const syncAfterKeyDelete = (storage) =>
  !storage.values.has("host/view/daily") && storage.synced.has("host/view/daily");

// A sync that keeps failing fails every write to the Page, so only the
// deletes are made to fail every time.
for (const step of ["the document delete", "the key delete"])
  test(`a release that keeps failing at ${step} leaves the Page readable and editable, and the id takes no write until it finishes`, async (t) => {
    const h = await viewsHost(t);
    await emptySlot(h);
    const stuck = new Map(await releaseSteps()).get(step);
    h.storage.stuck.push(stuck);
    let host;
    let retry;
    for (let boot = 0; boot < 2; boot++) {
      host = h.page();
      const read = await h.tool(host, "read_page", { comments: "none" });
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.equal(host.views.get("daily").state.name, "releasing");
      const edited = await h.edit(host, [{ op: "set_title", title: `Usage ${boot}` }]);
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      const listed = (await h.tool(host, "read_page", { views: true })).body.views;
      assert.ok(!listed.some((view) => view.view_id === "daily"));
      assert.equal(
        (await h.call(host, `/api/connect?page=${pageId}`)).body.documents.views?.daily,
        undefined,
      );
      const answer = await browser(host.plain).ask(await viewDocumentId(pageId, "daily"));
      assert.notEqual(answer.has, true, "the document isn't served");
      const { revision } = (await h.tool(host, "read_page", { include_content: false })).body;
      retry = { revision, nonce: `daily-${boot}`, operations: [{ op: "set_view", ...chart() }] };
      const refused = await h.tool(host, "edit_page", retry);
      assert.equal(refused.status, 503, JSON.stringify(refused.body));
      assert.equal(refused.body.code, "view_unavailable");
      assert.equal(refused.body.retryable, true);
      assert.equal(host.views.get("daily").state.name, "releasing");
      const other = await h.setView(host, { view_id: `other-${boot}` });
      assert.equal(other.status, 200, "other ids work");
    }
    // Once storage recovers, the same host's retry of the exact request
    // that got 503 finishes the release and creates the view; repeating it
    // replays its receipt.
    h.storage.stuck.length = 0;
    const written = await h.tool(host, "edit_page", retry);
    assert.equal(written.status, 200, JSON.stringify(written.body));
    assert.equal(written.body.view_revision, "1");
    const replayed = await h.tool(host, "edit_page", retry);
    assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
    assert.deepEqual(replayed.body, written.body);
    assert.deepEqual(await h.keys("host/view/"), [
      "host/view/daily",
      "host/view/other-0",
      "host/view/other-1",
    ]);
    assert.deepEqual((await h.call(host, `/api/connect?page=${pageId}`)).body.documents.views, {
      daily: await viewDocumentId(pageId, "daily"),
      "other-0": await viewDocumentId(pageId, "other-0"),
      "other-1": await viewDocumentId(pageId, "other-1"),
    });
  });

test("access revoked while a write finishes a view's release is refused, and takes no slot", async (t) => {
  const h = await viewsHost(t);
  await emptySlot(h);
  h.storage.stuck.push({ delete: (name) => name === "host/view/daily" });
  const host = h.page();
  assert.equal((await h.tool(host, "read_page", { views: true })).status, 200);
  assert.equal(host.views.get("daily").state.name, "releasing");
  h.storage.stuck.length = 0;
  // The release pauses at its key delete; the caller's access ends there.
  const remove = h.storage.delete.bind(h.storage);
  t.mock.method(h.storage, "delete", async (key) => {
    if (key === "host/view/daily")
      t.mock.method(host.policy, "account", () => {
        throw Object.assign(Error("Document access denied"), { status: 403 });
      });
    return remove(key);
  });
  const refused = await h.setView(host);
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.deepEqual(await h.keys("host/view/"), [], "the release finished; no slot was taken");
  assert.deepEqual(await h.viewStored("daily"), []);
  assert.equal(host.views?.has("daily") ?? false, false);
});

test("a view whose release removed its document, on a Page then stamped with a feature this build lacks, keeps its slot unserved and the Page boots", async (t) => {
  const h = await viewsHost(t);
  await emptySlot(h);
  h.storage.stuck.push({ delete: (name) => name === "host/view/daily" });
  const host = h.page();
  assert.equal((await h.tool(host, "read_page", { views: true })).status, 200);
  assert.equal(host.views.get("daily").state.name, "releasing");
  assert.deepEqual(await h.viewStored("daily"), [], "the document is gone, the key is not");
  await stampFuture(host);
  await host.flush();
  h.storage.stuck.length = 0;

  const next = h.page();
  const read = await h.tool(next, "read_page", { views: true });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body.views, []);
  assert.deepEqual(await h.keys("host/view/"), ["host/view/daily"], "the slot is kept");
  assert.deepEqual(await h.viewStored("daily"), [], "no genesis is recreated");
  assert.equal(next.views?.has("daily") ?? false, false, "not served");
  const answer = await browser(next.plain).ask(await viewDocumentId(pageId, "daily"));
  assert.notEqual(answer.has, true);
  const refused = await h.setView(next);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "unsupported_schema_feature");
});

test("a release whose sync after the key delete fails leaves the Page working, and the next write to the id finishes it", async (t) => {
  const h = await viewsHost(t);
  await emptySlot(h);
  h.storage.failSyncs.push(syncAfterKeyDelete);
  const host = h.page();
  const read = await h.tool(host, "read_page", { comments: "none" });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(h.storage.failSyncs.length, 0, "the failure ran");
  assert.equal(host.views.get("daily").state.name, "releasing");
  assert.equal((await h.edit(host, [{ op: "set_title", title: "Edited" }])).status, 200);
  const written = await h.setView(host);
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal(written.body.view_revision, "1");
  assert.deepEqual(await h.keys("host/view/"), ["host/view/daily"]);
});

test("a release that failed is finished by the next boot", async (t) => {
  const h = await viewsHost(t);
  await emptySlot(h);
  const [, stuck] = (await releaseSteps())[1];
  h.storage.stuck.push(stuck);
  const failed = h.page();
  assert.equal((await h.tool(failed, "read_page", { views: true })).status, 200);
  assert.deepEqual(await h.keys("host/view/"), ["host/view/daily"]);
  h.storage.stuck.length = 0;
  const host = h.page();
  assert.deepEqual((await h.tool(host, "read_page", { views: true })).body.views, []);
  assert.deepEqual(await h.keys("host/view/"), []);
  assert.deepEqual(await h.viewStored("daily"), []);
  assert.equal(host.views?.has("daily") ?? false, false);
});

test("a view stored in a format this build doesn't write is never opened, counts, refuses writes and purges", async (t) => {
  const h = await viewsHost(t);
  assert.equal((await h.setView(h.host, { view_id: "known" })).status, 200);
  // A later build wrote `future` in format 2: its document, its key and a
  // pending intent for it.
  assert.equal((await h.setView(h.host, { view_id: "future" })).status, 200);
  h.storage.crashes.push({
    test: (name, value) => name.startsWith("host/operation/") && value?.pending === true,
    before: false,
  });
  assert.equal(
    (await h.setView(h.host, { view_id: "future", title: "Later", view_revision: "1" })).status,
    500,
  );
  await h.storage.put("host/view/future", { format: 2 });
  for (let n = 0; n < 8; n++)
    assert.equal((await h.setView(h.host, { view_id: `v${n}` })).status, 200);
  const journal = async () =>
    [...(await h.storage.list({ prefix: "host/operation/" }))].filter(
      ([, entry]) => entry.pending === true && entry.doc === "view:future",
    );
  const pendingBefore = await journal();
  assert.equal(pendingBefore.length, 1, "a pending view:future intent");
  const storedBefore = await h.viewStored("future");
  assert.ok(storedBefore.length > 0);
  const bytes = async () =>
    Promise.all(storedBefore.map((key) => h.storage.get(key).then((v) => v && Buffer.from(v))));
  const bytesBefore = await bytes();
  const host = h.page();
  const listed = await h.tool(host, "read_page", { views: true });
  assert.deepEqual(
    listed.body.views.map((view) => view.view_id),
    ["known", ...Array.from({ length: 8 }, (_, n) => `v${n}`)],
  );
  assert.equal(host.views?.has("future") ?? false, false, "not served or replayed");
  assert.equal(
    (await h.call(host, `/api/connect?page=${pageId}`)).body.documents.views.future,
    undefined,
  );
  assert.deepEqual(await h.keys("host/view/future"), ["host/view/future"], "not released");
  assert.deepEqual(await journal(), pendingBefore, "its intent is left pending, not replayed");
  assert.deepEqual(await h.viewStored("future"), storedBefore);
  assert.deepEqual(await bytes(), bytesBefore, "its document bytes are untouched");
  const answer = await browser(host.plain).ask(await viewDocumentId(pageId, "future"));
  assert.notEqual(answer.has, true, "plain sync doesn't serve it");
  for (const view_revision of [null, "1"]) {
    const refused = await h.setView(host, { view_id: "future", view_revision });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "document_format_unsupported");
  }
  const capped = await h.setView(host, { view_id: "eleventh" });
  assert.equal(capped.status, 400);
  assert.equal(capped.body.code, "view_limit");
  assert.ok(capped.body.view_ids.includes("future"), "it counts toward the cap");
  assert.equal(
    (await h.call(host, "/internal/trash", { page_id: pageId, nonce: "trash-it" })).status,
    200,
  );
  const preview = await h.call(host, "/internal/purge", { page_id: pageId, action: "preview" });
  const purged = await h.call(host, "/internal/purge", {
    page_id: pageId,
    action: "confirm",
    preview_token: preview.body.preview_token,
    nonce: "purge-it",
  });
  assert.equal(purged.status, 200, JSON.stringify(purged.body));
  assert.deepEqual(await h.keys("host/view/"), []);
  assert.deepEqual(await h.viewStored("future"), [], "purge removes its document bytes");
});

test("two editors racing to create one view: one creates it, the other is stale", async (t) => {
  const h = await viewsHost(t);
  const { revision } = (await h.tool(h.host, "read_page", { include_content: false })).body;
  const results = await Promise.all(
    ["first-editor", "second-editor"].map((nonce, n) =>
      editAt(h, revision, nonce, [{ op: "set_view", ...chart({ title: `Editor ${n}` }) }]),
    ),
  );
  assert.deepEqual(
    results.map((result) => result.status).sort(),
    [200, 409],
    JSON.stringify(results.map((result) => result.body)),
  );
  const stale = results.find((result) => result.status === 409);
  assert.equal(stale.body.code, "stale_view");
  assert.equal(stale.body.view_revision, "1");
  assert.deepEqual(await h.keys("host/view/"), ["host/view/daily"]);
  const listed = await h.tool(h.host, "read_page", { views: true });
  assert.equal(listed.body.views.length, 1);
  assert.equal(listed.body.views[0].revision, "1");
});

test("access revoked while a new view's slot is checked creates nothing", async (t) => {
  const h = await viewsHost(t);
  const before = await h.snapshot();
  const { revision } = (await h.tool(h.host, "read_page", { include_content: false })).body;
  // The view list read is slow; the caller's access ends while it runs.
  const list = h.storage.list.bind(h.storage);
  t.mock.method(h.storage, "list", async (options) => {
    const listed = await list(options);
    if (options?.prefix === "host/view/")
      t.mock.method(h.host.policy, "account", () => {
        throw Object.assign(Error("Document access denied"), { status: 403 });
      });
    return listed;
  });
  const refused = await editAt(h, revision, "revoked", [{ op: "set_view", ...chart() }]);
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.deepEqual(await h.snapshot(), before);
  assert.deepEqual(await h.viewStored("daily"), []);
  assert.equal(h.host.views?.has("daily") ?? false, false);
});

test("refused creates leave the host's view map as it was", async (t) => {
  const h = await viewsHost(t);
  const { revision } = (await h.tool(h.host, "read_page", { include_content: false })).body;
  const size = h.host.views?.size ?? 0;
  for (let n = 0; n < 1000; n++) {
    const refused = await editAt(h, revision, `unknown-${n}`, [
      { op: "set_view", ...chart({ view_id: `v${n}`, data: { usage: { source_id: "nope" } } }) },
    ]);
    assert.equal(refused.body.code, "unknown_source");
  }
  assert.equal(h.host.views?.size ?? 0, size);
  assert.deepEqual(await h.keys("host/view/"), []);
});

test("a Page registered under a view's document id refuses set_view and keeps its content", async (t) => {
  const h = await viewsHost(t, { documentId: await viewDocumentId(pageId, "daily") });
  const heads = A.getHeads(h.host.handle.doc());
  const before = await h.snapshot();
  const refused = await h.setView(h.host);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "document_conflict");
  assert.deepEqual(A.getHeads(h.host.handle.doc()), heads);
  assert.equal(h.host.handle.doc().title, "Usage");
  assert.deepEqual(await h.snapshot(), before);
  assert.equal(h.host.views?.has("daily") ?? false, false);
  // Another view id is a different document.
  const other = await h.setView(h.host, { view_id: "weekly" });
  assert.equal(other.status, 200, JSON.stringify(other.body));
});

for (const [kind, documentId] of [
  ["comments", async () => commentsDocumentId(await commentsDocUuid(pageId))],
  ["sources", async () => derivedDocumentId(await sourcesDocUuid(pageId))],
])
  test(`registration refuses a draft under the Page's ${kind} document id before its intent`, async (t) => {
    const { storage, created } = await viewsHost(t, {
      documentId: await documentId(),
      registerOnly: true,
    });
    assert.equal(created.status, 409, JSON.stringify(created.body));
    assert.equal(created.body.code, "document_conflict");
    assert.equal(await storage.get("host/creation"), undefined, "no intent is stored");
    assert.equal(await storage.get("host/document"), undefined);
  });

/** Stamp the live Page with a schema feature this build lacks, as a newer
 * build would before a rollback. */
async function stampFuture(host) {
  const features = documentFeatures(host.handle.doc());
  await host.handle.update(
    (doc) =>
      A.change(doc, (draft) => {
        draft.schema = { features: [...features, "future-feature"] };
      }),
    { internal: true },
  );
  assert.ok(documentFeatures(host.handle.doc()).includes("future-feature"));
}

test("a set_view on a Page stamped with a feature this build lacks is refused before it is journaled, and the Page still boots", async (t) => {
  const h = await viewsHost(t);
  assert.equal((await h.setView(h.host)).status, 200);
  await stampFuture(h.host);
  const operations = () => h.keys("host/operation/");
  const before = await operations();
  const refused = await h.setView(h.host, { title: "Renamed", view_revision: "1" });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "unsupported_schema_feature");
  assert.deepEqual(await operations(), before, "nothing is journaled");
  const host = h.page();
  const read = await h.tool(host, "read_page", { views: true });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.views[0].title, "Daily usage");
});

test("a set_source on a Page stamped with a feature this build lacks is refused before it is journaled, and the Page still boots", async (t) => {
  const h = await viewsHost(t);
  await stampFuture(h.host);
  const operations = () => h.keys("host/operation/");
  const before = await operations();
  const refused = await h.edit(h.host, [
    {
      op: "set_source",
      source_id: "usage",
      name: "Renamed",
      asset_id: first,
      source_revision: "2",
    },
  ]);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "unsupported_schema_feature");
  assert.deepEqual(await operations(), before, "nothing is journaled");
  const host = h.page();
  const read = await h.tool(host, "read_page", { sources: true });
  assert.equal(read.status, 200, JSON.stringify(read.body));
});

test("a pending view intent the Page's stamp now refuses stays pending, the Page boots, and its retry gets the schema refusal", async (t) => {
  const h = await viewsHost(t);
  assert.equal((await h.setView(h.host)).status, 200);
  h.storage.crashes.push({
    test: (name, value) => name.startsWith("host/operation/") && value?.pending === true,
    before: false,
  });
  const read = await h.tool(h.host, "read_page", { include_content: false });
  const args = {
    revision: read.body.revision,
    nonce: "pending-rewrite",
    operations: [{ op: "set_view", ...chart({ title: "Renamed", view_revision: "1" }) }],
  };
  assert.equal((await h.tool(h.host, "edit_page", args)).status, 500);
  const pending = async () =>
    [...(await h.storage.list({ prefix: "host/operation/" })).values()].filter(
      (entry) => entry.pending === true,
    ).length;
  assert.equal(await pending(), 1);
  await stampFuture(h.host);
  await h.host.flush();

  const host = h.page();
  const views = await h.tool(host, "read_page", { views: true });
  assert.equal(views.status, 200, JSON.stringify(views.body));
  assert.equal(views.body.views[0].revision, "1");
  assert.equal(views.body.views[0].title, "Daily usage");
  assert.equal(await pending(), 1, "the intent stays pending");
  const retried = await h.tool(host, "edit_page", args);
  assert.equal(retried.status, 409, JSON.stringify(retried.body));
  assert.equal(retried.body.code, "unsupported_schema_feature");
  assert.equal(await pending(), 1);
});
