import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { pmNodeToSpans } from "@automerge/prosemirror";
import { closePeers, connectPeers, createPeer, eventually } from "../../backend.mjs";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { orderedBlockIds } from "../model/page.mjs";
import { hasPreservedBlocks } from "../model/raw-migration.mjs";
import { adapter, schema, textPath } from "../model/richtext.mjs";
import { BUILD_FEATURES } from "../model/schema-features.mjs";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import { CONTENT_ACTIVITY_KEY } from "./content-activity.mjs";
import { Page } from "./index.mjs";
import { Storage } from "./trash-fixture.mjs";

// Content activity on a real Page host: the repository and SubductionBackend
// the host serves from, the DocHandle's own `change` events, and real tool,
// native-sync, comment and conversion paths. No fake handle.

const pageId = "44444444-4444-4444-8444-444444444444";
const requestFor = (token, path, body) =>
  new Request(`https://pages.invalid${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "x-pages-driver": "ChatGPT" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const contextFor = (storage, held) => ({
  id: { name: pageId },
  storage,
  blockConcurrencyWhile: (fn) => fn(),
  waitUntil: (work) => held.push(work),
});

/** A real Page host over in-memory storage and a SQLite D1, with a Catalog
 * namespace that records every call. `catalog(path, body)` answers them. */
async function host(t, { catalog = () => Response.json({ ok: true }) } = {}) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const storage = new Storage();
  const db = sqliteD1(t).open();
  const calls = [];
  const held = [];
  const env = {
    ...auth.env,
    DB: db,
    PAGES_CATALOG_INDEX: "1",
    CATALOGS: {
      getByName: (principal) => ({
        fetch: async (request) => {
          const path = new URL(request.url).pathname;
          const body = await request.json();
          calls.push({ principal, path, body });
          return catalog(path, body);
        },
      }),
    },
  };
  const pages = [];
  const peers = [];
  const wires = [];
  t.after(async () => {
    for (const page of pages) page.contentActivity?.stop();
    await closePeers(peers, wires);
    for (const page of pages) {
      await page.repo?.shutdown();
      await page.backend?.close();
      page.signer?.free();
    }
  });
  const open = async () => {
    const page = new Page(contextFor(storage, held), env);
    pages.push(page);
    await page.ready;
    return page;
  };
  const owner = auth.apiKey();
  const call = async (page, path, body) => {
    const response = await page.fetch(requestFor(owner, path, body));
    return { status: response.status, body: await response.json() };
  };
  const tool = (page, operation, args) =>
    call(page, "/internal/tool", { operation, arguments: { page_id: pageId, ...args } });
  // Everything the host holds on its requests, but not a window timer, which
  // settles only when it fires.
  const settle = async () => {
    for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
  };
  const ownerRow = () =>
    db.rows(
      "SELECT content_updated_at FROM pages_catalog_access WHERE page_id = ? AND source = 'owner'",
      pageId,
    )[0]?.content_updated_at ?? null;
  const contentReports = () => calls.filter((entry) => entry.path === "/internal/content-activity");
  /** A native peer bound as the owner, connected to `page`'s backend. */
  const nativePeer = async (page) => {
    const peer = createPeer();
    peers.push(peer);
    await page.policy.bind(
      peer.keyId,
      peer.senderId,
      {
        principal: page.metadata.owner,
        displayName: "Owner",
        driver: "Browser",
        canWrite: true,
        expiresAt: Date.now() + 600_000,
      },
      {
        reauthenticate: async () => ({ principal: page.metadata.owner, canWrite: true }),
        disconnect: async () => {},
        features: [...BUILD_FEATURES].sort(),
      },
    );
    wires.push(await connectPeers(peer, page));
    const handle = await peer.repo.find(page.metadata.documentId);
    await eventually(
      () => A.getHeads(handle.doc()).join() === A.getHeads(page.handle.doc()).join(),
    );
    return handle;
  };
  return {
    auth,
    storage,
    db,
    calls,
    held,
    open,
    owner,
    call,
    tool,
    settle,
    ownerRow,
    contentReports,
    nativePeer,
  };
}

async function created(h) {
  const page = await h.open();
  const response = await h.call(page, "/internal/create", {
    page_id: pageId,
    title: "Launch plan",
    markdown: "We ship on Friday.",
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  // The first read projects the title, which indexes the Page in D1.
  assert.equal((await h.tool(page, "read_page", { comments: "none" })).status, 200);
  await h.settle();
  assert.ok(h.db.rows("SELECT 1 FROM pages_catalog_access WHERE page_id = ?", pageId).length);
  return page;
}

test("a tool edit on a real Page host records a time and reports it on its own route", async (t) => {
  const h = await host(t);
  const page = await created(h);
  assert.equal(page.contentActivity.value, null, "creation isn't a content change");
  assert.equal(h.contentReports().length, 0);
  const read = await h.tool(page, "read_page", { comments: "none" });
  const before = new Date().toISOString();
  const edit = await h.tool(page, "patch_page", {
    base_heads: read.body.heads,
    idempotency_key: "content-activity-host-patch",
    operations: [
      {
        op: "replace_match",
        block_id: read.body.blocks[0].id,
        match_text: "Friday",
        replacement: "Monday",
      },
    ],
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  await h.settle();
  const value = page.contentActivity.value;
  assert.ok(value >= before, `${value} >= ${before}`);
  assert.equal(page.contentActivity.pending, false, "the edit's request ran the flush");
  assert.deepEqual(await h.storage.get(CONTENT_ACTIVITY_KEY), { content_updated_at: value });
  assert.equal(h.ownerRow(), value);
  assert.deepEqual(
    h.contentReports().map(({ principal, body }) => ({ principal, body })),
    [{ principal: page.metadata.owner, body: { page_id: pageId, content_updated_at: value } }],
  );
  // No projection without a title: an earlier Catalog reads one as "Untitled".
  for (const entry of h.calls.filter(({ path }) => path === "/internal/projection"))
    assert.equal(typeof entry.body.title, "string", JSON.stringify(entry.body));
  // A comment is not content.
  const comment = await h.tool(page, "manage_page_comment", {
    action: "add",
    block_id: read.body.blocks[0].id,
    body: "Monday works",
    idempotency_key: "content-activity-host-comment",
  });
  assert.equal(comment.status, 200, JSON.stringify(comment.body));
  await h.settle();
  assert.equal(page.contentActivity.value, value);
  assert.equal(page.contentActivity.state.name, "idle");
  assert.equal(h.contentReports().length, 1);
});

test("a native peer's edit records a time, run by a live request rather than the repository's loop", async (t) => {
  const h = await host(t);
  const page = await created(h);
  const peerHandle = await h.nativePeer(page);
  peerHandle.change((doc) => {
    doc.title = "Launch plan, revised";
  });
  await eventually(() => page.handle.doc().title === "Launch plan, revised");
  await h.settle();
  // The host's `change` event came from its repository's loop, which on celld
  // keeps a finished request's context: nothing may start there.
  const value = page.contentActivity.value;
  assert.ok(value);
  assert.equal(page.contentActivity.pending, true);
  assert.equal(await h.storage.get(CONTENT_ACTIVITY_KEY), undefined);
  assert.equal(h.contentReports().length, 0);
  // A resident socket's request serves it, as /api/sync does.
  let close;
  const serving = page.contentActivity.serve(
    new Promise((resolve) => {
      close = resolve;
    }),
  );
  await h.settle();
  assert.equal(page.contentActivity.pending, false);
  assert.deepEqual(await h.storage.get(CONTENT_ACTIVITY_KEY), { content_updated_at: value });
  assert.equal(h.ownerRow(), value);
  assert.equal(h.contentReports().length, 1);
  close();
  await serving;
  // After the socket closed, a change inside the window waits, and its timer
  // waits for a live request to arm it.
  await new Promise((resolve) => setTimeout(resolve, 5));
  peerHandle.change((doc) => {
    doc.title = "Launch plan, final";
  });
  await eventually(() => page.handle.doc().title === "Launch plan, final");
  await h.settle();
  assert.equal(page.contentActivity.state.name, "waiting");
  assert.equal(page.contentActivity.pending, true);
  assert.ok(page.contentActivity.value > value);
});

test("the next request runs a native edit's flush when no socket serves it", async (t) => {
  const h = await host(t);
  const page = await created(h);
  const peerHandle = await h.nativePeer(page);
  peerHandle.change((doc) => {
    doc.title = "Launch plan, from a tab";
  });
  await eventually(() => page.handle.doc().title === "Launch plan, from a tab");
  await h.settle();
  assert.equal(page.contentActivity.pending, true);
  const read = await h.tool(page, "read_page", { comments: "none" });
  assert.equal(read.status, 200);
  await h.settle();
  assert.equal(page.contentActivity.pending, false);
  assert.equal(h.ownerRow(), page.contentActivity.value);
});

test("a preserved Markdown conversion on load records nothing; an edit after it does", async (t) => {
  const h = await host(t);
  const first = await created(h);
  // A preserved block, as an earlier build stored one, written by the host.
  const block = orderedBlockIds(first.handle.doc())[0];
  const tree = schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("We ship on Friday.")]),
    schema.node("raw", { source: "Old ~~text~~.", importId: "", kind: "markdown" }),
  ]);
  first.contentActivity.stop();
  first.unwatchContent();
  await first.handle.update((doc) =>
    A.change(doc, (draft) =>
      A.updateSpans(
        draft,
        textPath(block),
        pmNodeToSpans(adapter, tree),
        adapter.updateSpansConfig(),
      ),
    ),
  );
  await first.flush();
  assert.equal(hasPreservedBlocks(first.handle.doc()), true);
  await first.repo.shutdown();
  await first.backend.close();
  first.signer.free();
  first.repo = first.backend = first.signer = undefined;

  const page = await h.open();
  await h.settle();
  assert.equal(hasPreservedBlocks(page.handle.doc()), false, "the host converted it on load");
  assert.equal(page.contentActivity.value, null);
  assert.equal(page.contentActivity.pending, false);
  assert.equal(await h.storage.get(CONTENT_ACTIVITY_KEY), undefined);
  assert.equal(h.contentReports().length, 0);
  const read = await h.tool(page, "read_page", { comments: "none" });
  const edit = await h.tool(page, "edit_page", {
    base_heads: read.body.heads,
    idempotency_key: "content-activity-host-after-conversion",
    operations: [{ op: "insert_markdown", markdown: "One more line." }],
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  await h.settle();
  assert.ok(page.contentActivity.value);
  assert.equal(h.contentReports().length, 1);
});

test("a Catalog from before the content route answers non-OK, and the flush retries", async (t) => {
  let upgraded = false;
  const h = await host(t, {
    catalog: (path) =>
      path === "/internal/content-activity" && !upgraded
        ? Response.json({ error: "Unauthorized" }, { status: 401 })
        : Response.json({ ok: true }),
  });
  const page = await created(h);
  const read = await h.tool(page, "read_page", { comments: "none" });
  await h.tool(page, "edit_page", {
    base_heads: read.body.heads,
    idempotency_key: "content-activity-host-mixed",
    operations: [{ op: "insert_markdown", markdown: "Mixed rollout." }],
  });
  await h.settle();
  assert.equal(page.contentActivity.state.name, "waiting");
  assert.equal(page.contentActivity.state.attempt, 1);
  assert.equal(page.contentActivity.state.durable, null);
  assert.equal(h.contentReports().length, 1);
  // The retry lands once the owner's Catalog runs this build.
  upgraded = true;
  t.mock.timers.enable({ apis: ["Date"], now: page.contentActivity.state.dueAt });
  page.contentActivity.pump();
  await h.settle();
  t.mock.timers.reset();
  assert.equal(page.contentActivity.state.name, "idle");
  assert.equal(page.contentActivity.state.durable, page.contentActivity.value);
  assert.equal(h.contentReports().length, 2);
});

test("deleting a Page stops recording, detaches the listener and forgets the stored time", async (t) => {
  const h = await host(t);
  const page = await created(h);
  const read = await h.tool(page, "read_page", { comments: "none" });
  await h.tool(page, "edit_page", {
    base_heads: read.body.heads,
    idempotency_key: "content-activity-host-delete-edit",
    operations: [{ op: "insert_markdown", markdown: "Soon gone." }],
  });
  await h.settle();
  assert.ok(await h.storage.get(CONTENT_ACTIVITY_KEY));
  const handle = page.handle;
  assert.equal(handle.listenerCount("change") > 0, true);
  await page.applyLifecycle([{ type: "closePolicy" }, { type: "deleteDocument" }], {});
  assert.equal(page.contentActivity.state.name, "stopped");
  assert.equal(handle.listenerCount("change"), 0);
  assert.equal(await h.storage.get(CONTENT_ACTIVITY_KEY), undefined);
  page.contentActivity.changed();
  page.contentActivity.pump();
  await h.settle();
  assert.equal(await h.storage.get(CONTENT_ACTIVITY_KEY), undefined);
});

test("a host whose handle has no event API fails loudly under test", async (t) => {
  const h = await host(t);
  const page = await created(h);
  const handle = page.handle;
  page.handle = { doc: () => handle.doc() };
  await assert.rejects(page.watchContent(), /no event API/);
  page.handle = handle;
});
