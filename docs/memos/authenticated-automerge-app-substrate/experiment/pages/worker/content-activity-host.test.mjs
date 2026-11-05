import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { closePeers, connectPeers, createPeer, eventually } from "../../backend.mjs";
import { createAuthFixture } from "../../auth-fixtures.mjs";
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
  /** A host over the shared storage. `boot: false` leaves it as a restart
   * does, booting on the first request that needs the document. */
  const open = async ({ boot = true } = {}) => {
    const page = new Page(contextFor(storage, held), env);
    pages.push(page);
    await page.ready;
    if (boot) await page.documentReady();
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

test("Trash never stops the recorder, so a restored Page keeps recording", async (t) => {
  const h = await host(t);
  const page = await created(h);
  const read = await h.tool(page, "read_page", { comments: "none" });
  const trashed = await h.call(page, "/internal/trash", {
    page_id: pageId,
    base_heads: read.body.heads,
    idempotency_key: "content-activity-host-trash",
  });
  assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
  assert.notEqual(page.contentActivity.state.name, "stopped");
  const restored = await h.call(page, "/internal/restore", {
    page_id: pageId,
    idempotency_key: "content-activity-host-restore",
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.notEqual(page.contentActivity.state.name, "stopped");
  const again = await h.tool(page, "read_page", { comments: "none" });
  const edit = await h.tool(page, "edit_page", {
    base_heads: again.body.heads,
    idempotency_key: "content-activity-host-after-restore",
    operations: [{ op: "insert_markdown", markdown: "Back from Trash." }],
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  await h.settle();
  assert.ok(page.contentActivity.value);
  assert.equal(h.ownerRow(), page.contentActivity.value);
  assert.equal(h.contentReports().length, 1);
});

test("a tombstone forgets the stored time and title projection, as a purge does", async (t) => {
  const h = await host(t);
  const page = await created(h);
  const read = await h.tool(page, "read_page", { comments: "none" });
  await h.tool(page, "edit_page", {
    base_heads: read.body.heads,
    idempotency_key: "content-activity-host-tombstone-edit",
    operations: [{ op: "insert_markdown", markdown: "Soon gone." }],
  });
  await h.settle();
  assert.ok(await h.storage.get(CONTENT_ACTIVITY_KEY));
  assert.ok(await h.storage.get("host/title-projection"));
  const handle = page.handle;
  await page.applyLifecycle([{ type: "dropDocument" }], {});
  assert.equal(page.contentActivity.state.name, "stopped");
  assert.equal(handle.listenerCount("change"), 0);
  assert.equal(await h.storage.get(CONTENT_ACTIVITY_KEY), undefined);
  assert.equal(await h.storage.get("host/title-projection"), undefined);
});

test("a restarted host projects an unchanged title with the time it first observed it", async (t) => {
  const h = await host(t);
  const first = await created(h);
  const projections = () => h.calls.filter((entry) => entry.path === "/internal/projection");
  const [initial] = projections();
  assert.equal(initial.body.keep_time, true);
  const rowTimes = () =>
    h.db.rows(
      `SELECT a.updated_at AS access, p.updated_at AS page
      FROM pages_catalog_access a JOIN pages_catalog_pages p USING (page_id)`,
    );
  const before = rowTimes();
  first.contentActivity.stop();
  first.unwatchContent();
  await first.repo.shutdown();
  await first.backend.close();
  first.signer.free();
  first.repo = first.backend = first.signer = undefined;
  await new Promise((resolve) => setTimeout(resolve, 5));

  const page = await h.open();
  const seen = projections().length;
  assert.equal((await h.tool(page, "read_page", { comments: "none" })).status, 200);
  await h.settle();
  const repeated = projections().slice(seen);
  assert.equal(repeated.length, 1, "the restart re-projects, as the first check always has");
  assert.equal(repeated[0].body.observed_at, initial.body.observed_at);
  assert.equal(page.titleProjection?.record?.observed_at, initial.body.observed_at);
  assert.deepEqual(rowTimes(), before, "the index row keeps its time");

  // A title change is a new observation.
  const read = await h.tool(page, "read_page", { comments: "none" });
  const renamed = await h.tool(page, "edit_page", {
    base_heads: read.body.heads,
    idempotency_key: "content-activity-host-rename",
    operations: [{ op: "set_title", title: "Launch plan, renamed" }],
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  await h.tool(page, "read_page", { comments: "none" });
  await h.settle();
  const changed = projections().at(-1);
  assert.equal(changed.body.title, "Launch plan, renamed");
  assert.ok(changed.body.observed_at > initial.body.observed_at);
  assert.ok(rowTimes()[0].access > before[0].access);
});

test("a restarted host answers checks from its record, then boots for an edit that records and projects", async (t) => {
  const h = await host(t);
  const first = await created(h);
  const read = await h.tool(first, "read_page", { comments: "none" });
  const edit = await h.tool(first, "edit_page", {
    base_heads: read.body.heads,
    idempotency_key: "content-activity-host-lazy-edit",
    operations: [{ op: "insert_markdown", markdown: "Before the restart." }],
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  await h.settle();
  const stored = first.contentActivity.value;
  assert.ok(stored);
  const projected = await h.storage.get("host/title-projection");
  assert.equal(projected.title, "Launch plan");
  first.contentActivity.stop();
  first.unwatchContent();
  await first.repo.shutdown();
  await first.backend.close();
  first.signer.free();
  first.repo = first.backend = first.signer = undefined;

  const page = await h.open({ boot: false });
  assert.equal(page.startup.name, "metadata");
  const calls = h.calls.length;
  const d1 = h.db.calls;
  const check = await h.call(page, "/internal/catalog", {});
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.equal(check.body.title, "Launch plan");
  assert.equal(check.body.title_observed_at, projected.observed_at);
  assert.equal(check.body.content_updated_at, stored);
  await h.settle();
  assert.equal(page.repo, undefined, "the check booted nothing");
  assert.equal(h.calls.length, calls, "and projected nothing");
  assert.equal(h.db.calls, d1, "or reported to the index");

  // An edit boots the host; content activity and title projection run as on
  // any booted host.
  const again = await h.tool(page, "read_page", { comments: "none" });
  assert.equal(page.startup.name, "ready");
  const renamed = await h.tool(page, "edit_page", {
    base_heads: again.body.heads,
    idempotency_key: "content-activity-host-lazy-rename",
    operations: [{ op: "set_title", title: "Launch plan, after restart" }],
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  await h.settle();
  assert.ok(page.contentActivity.value > stored);
  assert.equal(h.ownerRow(), page.contentActivity.value);
  assert.equal(h.contentReports().length, 2);
  const projection = h.calls.filter(({ path }) => path === "/internal/projection").at(-1);
  assert.equal(projection.body.title, "Launch plan, after restart");
  assert.equal((await h.storage.get("host/title-projection")).title, "Launch plan, after restart");
  const booted = await h.call(page, "/internal/catalog", {});
  assert.equal(booted.body.title, "Launch plan, after restart");
  assert.equal(booted.body.content_updated_at, page.contentActivity.value);

  // The next restart answers with the title the edit projected.
  page.contentActivity.stop();
  page.unwatchContent();
  const next = await h.open({ boot: false });
  const after = await h.call(next, "/internal/catalog", {});
  assert.equal(next.startup.name, "metadata");
  assert.equal(after.body.title, "Launch plan, after restart");
  assert.equal(after.body.title_observed_at, booted.body.title_observed_at);
  assert.equal(after.body.content_updated_at, page.contentActivity.value);
});

test("a host whose handle has no event API fails loudly under test", async (t) => {
  const h = await host(t);
  const page = await created(h);
  const handle = page.handle;
  page.handle = { doc: () => handle.doc() };
  await assert.rejects(page.watchContent(), /no event API/);
  page.handle = handle;
});
