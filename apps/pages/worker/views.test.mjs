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
import { viewDocumentId } from "../shared/document-ids.mjs";
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

const parquetHead = (assetId) => ({
  size: 1018,
  httpMetadata: { contentType: PARQUET },
  customMetadata: { page_id: pageId, hash: assetId },
});

/** A Page over real plain sync with one source, `usage`, at revisions "1"
 * (asset `first`) and "2" (asset `second`). `page()` starts a new host over
 * the same storage, as after eviction or a crash. */
async function viewsHost(t) {
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
  const created = await call(host, "/internal/create", {
    page_id: pageId,
    title: "Usage",
    markdown: "Some text",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  for (const [asset_id, source_revision] of [
    [first, null],
    [second, "1"],
  ]) {
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
  return { storage, host, page, call, tool, edit, setView, record, keys, viewStored, snapshot };
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
  assert.deepEqual((await h.record()).documentFormats, {
    ...MEMBER_FORMATS,
    "pages.sources": 1,
    "pages.view": 1,
  });
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
  const line = `[View: daily](/p/${pageId}/view/daily)`;
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
