import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createAuthFixture } from "../auth-fixtures.mjs";
import { Catalog, Page } from "./index.mjs";
import { DocumentPolicy } from "./policy.mjs";
import { applyPageOperation, createPageData, initializePage } from "../model/page.mjs";
import { comment, newCommentsDoc } from "../model/comments-test-support.mjs";
import { blockAddress, nodeAddresses } from "../model/addresses.mjs";
import { documentMutation, operationKey, recoverDocumentMutations } from "./mutations.mjs";
import {
  HORIZON,
  JOURNAL_LIMITS,
  RECEIPT_LIFETIME_MS,
  readRevision,
  reserveOperation,
} from "./operation-journal.mjs";
import { headsFor } from "./revisions.mjs";
import { plainStub } from "./plain-stub.mjs";
import { MEMBER_FORMATS } from "../model/document-types.mjs";

const start = Date.parse("2026-10-25T00:00:00Z");
/** The key of the block `address` names in `doc`, or undefined. */
const blockKey = (doc, address) =>
  Object.keys(doc.blocks).find((key) => blockAddress(doc, key) === address);
const pageId = "33333333-3333-4333-8333-333333333333";
class Storage {
  values = new Map();
  durable = new Map();
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    if (typeof key === "object") {
      for (const [name, entry] of Object.entries(key)) await this.put(name, entry);
      return;
    }
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    this.values.delete(key);
  }
  async list({ prefix = "", limit = Infinity, startAfter } = {}) {
    return new Map(
      [...this.values]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
        .slice(0, limit),
    );
  }
  async sync() {
    this.durable = structuredClone(this.values);
  }
}
/** The revision handle of the fixture document as it is now, its receipt
 * key for a request, and the heads a handle names. */
function revisionHelpers(storage, handle, identity) {
  return {
    revision: () => readRevision(storage, "page", A.getHeads(handle.doc())),
    key: (args) => operationKey(args, identity, "page"),
    heads: (revision) => headsFor(storage, "page", revision),
  };
}
function fixture() {
  const storage = new Storage();
  let doc = A.from({ page_id: pageId, text: "base", edits: 0 });
  let applications = 0;
  const handle = {
    doc: () => doc,
    async update(fn) {
      doc = fn(doc);
    },
  };
  const identity = { principal: "user:fixture:owner", driver: "ChatGPT" };
  const context = {
    storage,
    handle,
    operation: "edit_page",
    identity,
    apply(draft) {
      applications++;
      draft.edits++;
      A.updateText(draft, ["text"], `edit ${draft.edits}`);
    },
    flush: async () => storage.sync(),
  };
  return {
    storage,
    handle,
    identity,
    context,
    applications: () => applications,
    ...revisionHelpers(storage, handle, identity),
  };
}
async function argsFor(f, nonce) {
  return { nonce, revision: await f.revision() };
}
/** `count` completed receipts recorded at `at`, oldest key first. */
function completedReceipts(storage, at, count = JOURNAL_LIMITS.entries) {
  for (let index = 0; index < count; index++)
    storage.values.set(`host/operation/done-${String(index).padStart(5, "0")}`, {
      fingerprint: `fixture-${index}`,
      pending: false,
      receipt: { accepted: index },
      recordedAt: at,
    });
}

function richMutationFixture(t, markdown = "## Introduction\n\nOriginal body.") {
  const storage = new Storage();
  let doc = A.change(A.from(createPageData({ pageId, title: "Guide" })), (draft) =>
    initializePage(draft, markdown),
  );
  const blockId = Object.keys(doc.blocks)[0];
  const handle = {
    doc: () => doc,
    async update(fn) {
      doc = fn(doc);
    },
  };
  const identity = {
    principal: "user:fixture:owner",
    displayName: "Fixture Owner",
    driver: "ChatGPT",
  };
  let applications = 0;
  const context = (args, operation = "edit_page", overrides = {}) => ({
    storage,
    handle,
    operation,
    args,
    identity,
    apply(draft) {
      applications++;
      return applyPageOperation(draft, { operation, arguments: args, identity });
    },
    flush: () => storage.sync(),
    ...overrides,
  });
  t.after(() => A.free(doc));
  return {
    storage,
    handle,
    identity,
    blockId,
    block: blockAddress(doc, blockId),
    context,
    applications: () => applications,
    ...revisionHelpers(storage, handle, identity),
  };
}

test("opening title warnings describe receipt heads before concurrent native edits during flush", async (t) => {
  const f = richMutationFixture(t);
  const args = {
    nonce: "opening-title-concurrent",
    revision: await f.revision(),
    operations: [
      { op: "replace_block_markdown", node_id: f.block, markdown: "# Guide\n\nTool body." },
    ],
  };
  let flushes = 0;
  const receipt = await documentMutation(
    f.context(args, "edit_page", {
      async flush() {
        if (++flushes === 1)
          await f.handle.update((doc) =>
            A.change(doc, (draft) => {
              A.updateText(draft, ["title"], "Later human title");
            }),
          );
        await f.storage.sync();
      },
    }),
  );
  assert.equal(receipt.warnings[0].code, "opening_heading_repeats_title");
  assert.equal(receipt.warnings[0].heading, "Guide");
  assert.equal(receipt.warnings[0].node_id, nodeAddresses(f.handle.doc(), f.blockId)[0]);
  assert.equal(A.view(f.handle.doc(), await f.heads(receipt.revision)).title, "Guide");
  assert.equal(f.handle.doc().title, "Later human title");
  assert.notDeepEqual(A.getHeads(f.handle.doc()), await f.heads(receipt.revision));
  assert.match(f.handle.doc().blocks[f.blockId].richText, /Tool body/);
  const beforeRetry = A.save(f.handle.doc());
  assert.deepEqual(await documentMutation(f.context(args)), receipt);
  assert.deepEqual(A.save(f.handle.doc()), beforeRetry);
  assert.equal(f.applications(), 1);
});

for (const recovery of ["retry", "startup"]) {
  test(`opening title warning survives pending ${recovery}, later edits, and terminal replay`, async (t) => {
    const f = richMutationFixture(t);
    const operation = "edit_page";
    const args = {
      nonce: `opening-title-${recovery}`,
      revision: await f.revision(),
      operations:
        recovery === "startup"
          ? [
              {
                op: "replace_match",
                node_id: f.block,
                match_text: "Introduction",
                replacement: "Guide",
              },
              {
                op: "replace_match",
                node_id: f.block,
                match_text: "Original body.",
                replacement: "Accepted body.",
              },
            ]
          : [
              {
                op: "replace_block_markdown",
                node_id: f.block,
                markdown: "# Guide\n\nAccepted body.",
              },
            ],
    };
    let flushes = 0;
    await assert.rejects(
      documentMutation(
        f.context(args, operation, {
          async flush() {
            if (++flushes === 2) throw Error("Interrupted title warning durability");
            await f.storage.sync();
          },
        }),
      ),
      /Interrupted title warning/,
    );
    const key = await f.key(args);
    const pending = await f.storage.get(key);
    assert.equal(pending.pending, true);
    assert.equal(pending.receipt.warnings[0].heading, "Guide");
    await f.handle.update((doc) =>
      A.change(doc, (draft) => {
        A.updateText(draft, ["title"], "Later human title");
        initializePage(draft, "## New section\n\nKeep this body.");
      }),
    );
    const laterBytes = A.save(f.handle.doc());
    if (recovery === "startup")
      await recoverDocumentMutations(f.storage, f.handle, () => f.storage.sync());
    const replay = f.context(args, operation, {
      prepare: () => assert.fail("Warning retry must not repeat preparation"),
      apply: () => assert.fail("Warning retry must not reapply semantic edits"),
    });
    assert.deepEqual(await documentMutation(replay), pending.receipt);
    assert.deepEqual(await documentMutation(replay), pending.receipt);
    assert.deepEqual((await f.storage.get(key)).receipt, pending.receipt);
    assert.equal((await f.storage.get(key)).pending, false);
    assert.deepEqual(A.save(f.handle.doc()), laterBytes);
    assert.equal(f.applications(), 1);
  });
}

test("patch removal omits warnings and comment operations do not report existing duplicate headings", async (t) => {
  const f = richMutationFixture(t, "# Guide\n\nOriginal body.");
  const args = {
    nonce: "opening-title-removal",
    revision: await f.revision(),
    operations: [
      {
        op: "replace_match",
        node_id: f.block,
        match_text: "Guide",
        replacement: "Different section",
      },
    ],
  };
  const removed = await documentMutation(f.context(args, "edit_page"));
  assert.equal(Object.hasOwn(removed, "warnings"), false);
  assert.equal(f.handle.doc().title, "Guide");
  await f.handle.update((doc) =>
    A.change(doc, (draft) => initializePage(draft, "# Guide\n\nOriginal body.")),
  );
  // Comments never go through a Page edit, so they never carry its warnings:
  // the Page document refuses a comment operation outright.
  const headsBefore = A.getHeads(f.handle.doc());
  await assert.rejects(
    documentMutation(
      f.context(
        {
          nonce: "opening-title-comment",
          revision: await f.revision(),
          node_id: f.block,
          body: "A comment on the existing content.",
        },
        "manage_page_comment",
      ),
    ),
    /Unsupported Page operation/,
  );
  assert.deepEqual(A.getHeads(f.handle.doc()), headsBefore);
});

test("a edit_page receipt names the marks a replace_match dropped, per edit and at the top, and replays them", async (t) => {
  const f = richMutationFixture(
    t,
    "# Guide\n\nThe `rotate()` helper is in `worker/keys.mjs`.\n\nPlain sentence here.",
  );
  const args = {
    nonce: "marks-dropped-receipt",
    revision: await f.revision(),
    operations: [
      {
        op: "replace_match",
        node_id: f.block,
        match_text: "Plain sentence",
        replacement: "Quiet sentence",
      },
      {
        // A word retyped inside a code span keeps it: nothing to report.
        op: "replace_match",
        node_id: f.block,
        match_text: "The rotate() helper is in worker/keys.mjs.",
        replacement: "The rotateKey() helper is in worker/signing-keys.mjs.",
      },
      {
        // Rewriting the sentence crosses both code spans: plain, and reported.
        op: "replace_match",
        node_id: f.block,
        match_text: "The rotateKey() helper is in worker/signing-keys.mjs.",
        replacement: "Rewritten entirely.",
      },
    ],
  };
  const receipt = await documentMutation(f.context(args, "edit_page"));
  assert.match(f.handle.doc().blocks[f.blockId].richText, /Rewritten entirely\./);
  // The quiet edits carry no warning; the third names what it dropped.
  assert.equal(receipt.result.edits[0].warnings, undefined);
  assert.equal(receipt.result.edits[1].warnings, undefined);
  const [dropped] = receipt.result.edits[2].warnings;
  assert.equal(dropped.code, "marks_dropped");
  assert.deepEqual(dropped.marks, ["code"]);
  assert.deepEqual(dropped.ranges, [
    { mark: "code", start: 4, end: 15 },
    { mark: "code", start: 29, end: 52 },
  ]);
  // The receipt's own list repeats it with the edit it came from, beside the
  // opening-title warning this document also raises.
  assert.deepEqual(
    receipt.warnings.map(({ code, edit_index, node_id }) => ({ code, edit_index, node_id })),
    [
      {
        code: "opening_heading_repeats_title",
        edit_index: undefined,
        node_id: nodeAddresses(f.handle.doc(), f.blockId)[0],
      },
      { code: "marks_dropped", edit_index: 2, node_id: f.block },
    ],
  );
  assert.deepEqual(receipt.warnings[1].ranges, dropped.ranges);
  // Warnings are part of the journaled receipt: an exact retry replays them.
  assert.deepEqual(await documentMutation(f.context(args, "edit_page")), receipt);
  assert.equal(f.applications(), 1);
});

test("a Markdown edit whose list restarts at 1 lists the warning with its edit", async (t) => {
  const f = richMutationFixture(t);
  const args = {
    nonce: "list-numbers-reset-receipt",
    revision: await f.revision(),
    operations: [
      { op: "replace_block_markdown", node_id: f.block, markdown: "Steps.\n\n3. Third\n4. Fourth" },
    ],
  };
  const receipt = await documentMutation(f.context(args, "edit_page"));
  const [entry] = receipt.result.edits[0].warnings;
  assert.equal(entry.code, "list_numbers_reset");
  assert.deepEqual(entry.lists, [{ start: 3, first_item: "Third" }]);
  assert.deepEqual(receipt.warnings, [{ ...entry, edit_index: 0, node_id: f.block }]);
  // The items are kept and numbered from 1.
  assert.match(f.handle.doc().blocks[f.blockId].richText, /Third/);
  // An exact retry replays the same warning.
  assert.deepEqual(await documentMutation(f.context(args, "edit_page")), receipt);
});

test("old receipts without warnings are replayed unchanged despite a currently duplicate heading", async (t) => {
  const f = richMutationFixture(t);
  const args = {
    nonce: "opening-title-old-receipt",
    revision: await f.revision(),
    operations: [{ op: "replace_block_markdown", node_id: f.block, markdown: "# Guide\n\nBody." }],
  };
  await documentMutation(f.context(args));
  const key = await f.key(args);
  const old = await f.storage.get(key);
  delete old.receipt.warnings;
  await f.storage.put(key, old);
  await f.storage.sync();
  const bytes = A.save(f.handle.doc());
  assert.deepEqual(await documentMutation(f.context(args)), old.receipt);
  assert.deepEqual(await f.storage.get(key), old);
  assert.deepEqual(A.save(f.handle.doc()), bytes);
  assert.equal(f.applications(), 1);
});

test("an exact retry returns the same receipt and revision; another request under its nonce is nonce_conflict", async (t) => {
  let now = start;
  t.mock.method(Date, "now", () => now);
  const f = fixture();
  const args = await argsFor(f, "exact-edit");
  const receipt = await documentMutation({ ...f.context, args });
  assert.match(receipt.revision, /^r\d+$/);
  assert.deepEqual(A.getHeads(f.handle.doc()), await f.heads(receipt.revision));
  // A later write moves the Page on; the retry still reports its own revision.
  now += 1000;
  await documentMutation({ ...f.context, args: await argsFor(f, "later-edit") });
  assert.deepEqual(await documentMutation({ ...f.context, args }), receipt);
  assert.equal(f.applications(), 2);
  await assert.rejects(documentMutation({ ...f.context, args: { ...args, extra: true } }), {
    status: 409,
    code: "nonce_conflict",
    message: "This nonce was used for a different request",
  });
  assert.equal(f.applications(), 2);
});

test("two accounts using one nonce on one Page do not collide", async (t) => {
  t.mock.method(Date, "now", () => start);
  const f = fixture();
  const first = await documentMutation({ ...f.context, args: await argsFor(f, "shared-nonce") });
  const other = { ...f.identity, principal: "user:fixture:other" };
  const second = await documentMutation({
    ...f.context,
    identity: other,
    args: await argsFor(f, "shared-nonce"),
  });
  assert.notEqual(second.revision, first.revision);
  assert.equal(f.applications(), 2);
  assert.notEqual(
    await operationKey({ nonce: "shared-nonce" }, other, "page"),
    await f.key({ nonce: "shared-nonce" }),
  );
});

test("new-intent preparation cannot bypass a concurrently changed head guard", async () => {
  const f = fixture();
  const args = await argsFor(f, "preflight-race");
  await assert.rejects(
    documentMutation({
      ...f.context,
      args,
      prepare: async () => {
        await f.handle.update((doc) =>
          A.change(doc, (draft) => {
            draft.concurrent = true;
          }),
        );
      },
    }),
    { status: 409, code: "stale_revision" },
  );
  assert.equal(f.applications(), 0);
  assert.equal(f.handle.doc().concurrent, true);
  assert.equal(await f.storage.get(await f.key(args)), undefined);
});

test("pending and completed retries preserve receipts without repeating external preparation", async () => {
  const f = fixture();
  const args = await argsFor(f, "preflight-retry");
  let prepared = 0,
    flushes = 0;
  await assert.rejects(
    documentMutation({
      ...f.context,
      args,
      prepare: async () => {
        prepared++;
      },
      flush: async () => {
        if (++flushes === 2) throw Error("Interrupted durability");
        await f.context.flush();
      },
    }),
    /Interrupted durability/,
  );
  const entry = await f.storage.get(await f.key(args));
  assert.equal(entry.pending, true);
  // The handle the receipt reports was stored with the pending entry.
  assert.deepEqual(await f.heads(entry.receipt.revision), entry.heads);
  const retry = {
    ...f.context,
    args,
    prepare: async () => assert.fail("External asset/source rechecked on retry"),
  };
  assert.deepEqual(await documentMutation(retry), entry.receipt);
  assert.deepEqual(await documentMutation(retry), entry.receipt);
  assert.equal(prepared, 1);
  assert.equal(f.applications(), 1);
});

test("a retry whose receipt aged out is refused at the fence and never runs again", async (t) => {
  let now = start;
  t.mock.method(Date, "now", () => now);
  const f = fixture();
  const args = await argsFor(f, "aged-edit");
  await documentMutation({ ...f.context, args });
  now += RECEIPT_LIFETIME_MS;
  // A new write collects the old receipt and raises the horizon to it.
  await documentMutation({ ...f.context, args: await argsFor(f, "collector") });
  assert.equal(await f.storage.get(await f.key(args)), undefined);
  assert.equal(await f.storage.get(HORIZON), start);
  await assert.rejects(documentMutation({ ...f.context, args }), {
    status: 409,
    code: "resync_required",
  });
  assert.equal(f.applications(), 2);
  assert.equal(f.handle.doc().edits, 2);
});

test("a retry whose receipt a full journal evicted is refused at the fence", async (t) => {
  let now = start;
  t.mock.method(Date, "now", () => now);
  const f = fixture();
  const args = await argsFor(f, "evicted-edit");
  await documentMutation({ ...f.context, args });
  // Newer receipts fill the journal; the next write evicts the oldest, this one.
  now += 1000;
  completedReceipts(f.storage, now, JOURNAL_LIMITS.entries - 1);
  await documentMutation({ ...f.context, args: await argsFor(f, "evicting-edit") });
  assert.equal(await f.storage.get(await f.key(args)), undefined);
  assert.equal(await f.storage.get(HORIZON), start);
  await assert.rejects(documentMutation({ ...f.context, args }), {
    status: 409,
    code: "resync_required",
  });
  assert.equal(f.applications(), 2);
});

test("a quiet Page's old latest handle is refused, and a fresh read names its heads anew", async (t) => {
  let now = start;
  t.mock.method(Date, "now", () => now);
  const f = fixture();
  await documentMutation({ ...f.context, args: await argsFor(f, "first-edit") });
  const old = await f.revision();
  now += RECEIPT_LIFETIME_MS * 3;
  completedReceipts(f.storage, now - 1);
  // The Page hasn't changed, but its latest handle is behind the horizon.
  await assert.rejects(
    documentMutation({ ...f.context, args: { nonce: "after-all", revision: old } }),
    { status: 409, code: "resync_required" },
  );
  // A read names the same heads under a new number, and a write against it lands.
  const fresh = await f.revision();
  assert.notEqual(fresh, old);
  assert.deepEqual(await f.heads(fresh), await f.heads(old));
  const receipt = await documentMutation({
    ...f.context,
    args: { nonce: "after-all-fresh", revision: fresh },
  });
  assert.notEqual(receipt.revision, fresh);
  assert.ok((await f.storage.get(HORIZON)) >= now - RECEIPT_LIFETIME_MS);
  assert.equal(f.applications(), 2);
});

test("a revision superseded after the horizon passes the fence and meets stale_revision", async (t) => {
  let now = start;
  t.mock.method(Date, "now", () => now);
  const f = fixture();
  const read = await f.revision();
  now += 1000;
  await documentMutation({ ...f.context, args: { nonce: "first-edit", revision: read } });
  now += 1000;
  await assert.rejects(
    documentMutation({ ...f.context, args: { nonce: "second-edit", revision: read } }),
    { status: 409, code: "stale_revision" },
  );
  assert.equal(f.applications(), 1);
});

test("a malformed nonce or revision is refused before the journal is touched", async (t) => {
  t.mock.method(Date, "now", () => start);
  const f = fixture();
  const revision = await f.revision();
  for (const [args, code] of [
    [{ nonce: "short", revision }, "invalid_nonce"],
    [{ nonce: "x".repeat(65), revision }, "invalid_nonce"],
    [{ nonce: "has:colon", revision }, "invalid_nonce"],
    [{ revision }, "invalid_nonce"],
    [{ nonce: "no-revision" }, "invalid_revision"],
    [{ nonce: "comments-letter", revision: "c1" }, "invalid_revision"],
    [{ nonce: "heads-array", revision: A.getHeads(f.handle.doc()) }, "invalid_revision"],
  ])
    await assert.rejects(documentMutation({ ...f.context, args }), { status: 400, code });
  await assert.rejects(
    documentMutation({ ...f.context, args: { nonce: "unknown-revision", revision: "r99" } }),
    { status: 409, code: "resync_required" },
  );
  assert.equal(f.applications(), 0);
  assert.equal((await f.storage.list({ prefix: "host/operation/" })).size, 0);
});

for (const recovery of ["retry", "startup"]) {
  test(`a pending document intent outlives the receipt lifetime and completes through ${recovery}`, async (t) => {
    let now = start;
    t.mock.method(Date, "now", () => now);
    const f = fixture();
    const args = await argsFor(f, "interrupted-edit");
    let flushes = 0;
    await assert.rejects(
      documentMutation({
        ...f.context,
        args,
        async flush() {
          if (++flushes === 2) throw Error("interrupted persistence");
          await f.context.flush();
        },
      }),
      /interrupted persistence/,
    );
    const entry = await f.storage.get(await f.key(args));
    assert.equal(entry.pending, true);
    assert.equal(f.applications(), 1);
    now += RECEIPT_LIFETIME_MS * 2;
    // Collection never takes a pending entry.
    completedReceipts(f.storage, start - 1, 1);
    await reserveOperation(f.storage, {
      key: "host/operation/collector",
      entry: { fingerprint: "collector", pending: true },
    });
    assert.equal(await f.storage.get("host/operation/done-00000"), undefined);
    assert.deepEqual(await f.storage.get(await f.key(args)), entry);
    if (recovery === "startup") {
      await recoverDocumentMutations(f.storage, f.handle, f.context.flush);
      assert.equal((await f.storage.get(await f.key(args))).pending, false);
    }
    assert.deepEqual(await documentMutation({ ...f.context, args }), entry.receipt);
    assert.equal((await f.storage.get(await f.key(args))).pending, false);
    assert.equal(f.applications(), 1);
    assert.deepEqual(await f.heads(entry.receipt.revision), entry.heads);
    assert.ok(A.hasHeads(f.handle.doc(), entry.heads));
  });
}

async function catalogFixture(t) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const storage = new Storage();
  const requests = [];
  const principal = `user:anaconda-fixture:${auth.subject}`;
  const catalog = new Catalog(
    { id: { name: principal }, storage },
    {
      ...auth.env,
      PAGES: {
        getByName: (id) => ({
          async fetch(request) {
            const path = new URL(request.url).pathname;
            requests.push({ path, id, body: await request.json() });
            return Response.json(
              path === "/internal/trash"
                ? {
                    receipt: {
                      page_id: id,
                      state: "trashed",
                      trashed: true,
                      title: "Shared plan",
                      trashed_at: new Date(start).toISOString(),
                      trashed_by: principal,
                      trash_root_id: id,
                    },
                    current: {
                      page_id: id,
                      state: "trashed",
                      revision: 1,
                      title: "Shared plan",
                      trashed_at: new Date(start).toISOString(),
                      trashed_by: principal,
                      trash_root_id: id,
                    },
                  }
                : { page_id: id, title: "Shared plan", revision: "r1" },
            );
          },
        }),
      },
    },
  );
  const credential = auth.apiKey();
  const request = (operation, args = {}) =>
    catalog.fetch(
      new Request("https://pages.invalid/internal/catalog", {
        method: "POST",
        headers: { authorization: `Bearer ${credential}`, "x-pages-driver": "ChatGPT" },
        body: JSON.stringify({ operation, arguments: args }),
      }),
    );
  return { storage, requests, request, principal };
}

test("catalog create and delete replay their receipts by nonce, and run again once a receipt is gone", async (t) => {
  let now = start;
  t.mock.method(Date, "now", () => now);
  const f = await catalogFixture(t);
  const listed = await (await f.request("list_pages")).json();
  for (const field of ["retry_token", "retry_until", "retry_key_prefix"])
    assert.equal(listed[field], undefined, field);
  const create = { title: "Shared plan", nonce: "catalog-create" };
  const createdResponse = await f.request("create_page", create);
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json();
  assert.equal(created.revision, "r1");
  assert.deepEqual(await (await f.request("create_page", create)).json(), created);
  assert.equal(f.requests.length, 1);
  const changed = await f.request("create_page", { ...create, title: "Changed payload" });
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).code, "nonce_conflict");
  const deletion = { page_id: created.page_id, nonce: "catalog-delete" };
  const deletedResponse = await f.request("delete_page", deletion);
  assert.equal(deletedResponse.status, 200);
  const deleted = await deletedResponse.json();
  assert.equal(deleted.state, "trashed");
  assert.equal(f.requests.at(-1).path, "/internal/trash");
  assert.deepEqual(await (await f.request("delete_page", deletion)).json(), deleted);
  assert.equal(f.requests.length, 2);
  assert.equal((await (await f.request("list_pages")).json()).pages.length, 0);
  const trash = await (await f.request("list_pages", { in_trash: true })).json();
  assert.deepEqual(
    trash.pages.map(({ page_id, state }) => ({ page_id, state })),
    [{ page_id: created.page_id, state: "trashed" }],
  );
  now += RECEIPT_LIFETIME_MS;
  // A new admitted operation collects receipts past their lifetime; reads don't.
  assert.equal(
    (await f.request("create_page", { title: "Fresh request", nonce: "next-catalog-create" }))
      .status,
    200,
  );
  assert.equal(
    await f.storage.get(await operationKey(create, { principal: f.principal }, "catalog")),
    undefined,
  );
  // create_page names no revision, so nothing fences it: a retry after its
  // receipt is gone is a new request and makes a second Page.
  const again = await f.request("create_page", create);
  assert.equal(again.status, 200);
  assert.notEqual((await again.json()).page_id, created.page_id);
  assert.equal(f.requests.length, 4);
});

test("a catalog journal full of completed receipts accepts a new operation", async (t) => {
  t.mock.method(Date, "now", () => start);
  const f = await catalogFixture(t);
  completedReceipts(f.storage, start - 1);
  const response = await f.request("create_page", {
    title: "Shared plan",
    nonce: "catalog-after-full",
  });
  assert.equal(response.status, 200);
  assert.equal(f.requests.length, 1);
  assert.equal(
    (await f.storage.list({ prefix: "host/operation/" })).size,
    JOURNAL_LIMITS.entries,
    "one receipt made room for one new one",
  );
  assert.equal(await f.storage.get("host/operation/done-00000"), undefined);
  assert.equal(await f.storage.get(HORIZON), start - 1);
});

async function pageFixture(t, { readContent = false } = {}) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const storage = new Storage();
  // A current Page: its comments already live in their own document.
  let doc = A.change(A.from(createPageData({ pageId, title: "Accepted content" })), (draft) =>
    initializePage(draft),
  );
  let comments = newCommentsDoc();
  let updates = 0;
  const principal = `user:anaconda-fixture:${auth.subject}`;
  const blockId = Object.keys(doc.blocks)[0];
  let threadId;
  if (readContent) {
    doc = A.change(doc, (draft) => {
      initializePage(draft, "## First section\n\nOriginal selected content.");
      applyPageOperation(draft, {
        operation: "edit_page",
        arguments: {
          operations: [
            {
              op: "insert_markdown",
              after_node_id: blockAddress(draft, blockId),
              markdown: "Other block.",
            },
          ],
        },
      });
    });
    let result;
    ({ comments, result } = comment(
      doc,
      comments,
      { block_id: blockId, body: "Original comment." },
      { principal, displayName: "Fixture owner", driver: "Browser" },
    ));
    threadId = result.thread_id;
  }
  const page = Object.assign(Object.create(Page.prototype), {
    plain: plainStub(),
    ready: Promise.resolve(),
    tail: Promise.resolve(),
    env: auth.env,
    ctx: { storage, id: { name: pageId } },
    metadata: {
      pageId,
      documentFormats: MEMBER_FORMATS,
      documentId: "test",
      tree: "c".repeat(32),
      owner: principal,
      deleted: false,
    },
    handle: {
      doc: () => doc,
      async update(fn) {
        updates++;
        doc = fn(doc);
      },
      broadcast() {},
    },
    commentsHandle: {
      doc: () => comments,
      async update(fn) {
        comments = fn(comments);
      },
      broadcast() {},
    },
    async flush() {
      await storage.sync();
    },
    cacheTitle() {},
  });
  page.policy = new DocumentPolicy({
    metadata: () => page.metadata,
  });
  const token = auth.apiKey();
  const request = (operation, args = {}) =>
    page.fetch(
      new Request("https://pages.invalid/internal/tool", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "x-pages-driver": "ChatGPT" },
        body: JSON.stringify({ operation, arguments: args }),
      }),
    );
  // The receipt key edit_page writes for `args` from this caller.
  const key = (args) => operationKey(args, { principal }, "page");
  return {
    page,
    request,
    storage,
    principal,
    blockId,
    block: blockAddress(doc, blockId),
    threadId,
    key,
    updates: () => updates,
  };
}

test("actual Page read_page names the revision its edit uses; a retry past the horizon is refused", async (t) => {
  let now = start;
  t.mock.method(Date, "now", () => now);
  const f = await pageFixture(t);
  const response = await f.request("read_page");
  assert.equal(response.status, 200);
  const before = await response.json();
  assert.equal(before.title, "Accepted content");
  assert.match(before.revision, /^r\d+$/);
  const args = {
    page_id: pageId,
    revision: before.revision,
    nonce: "page-route-edit",
    operations: [{ op: "set_title", title: "Edited once" }],
  };
  const changed = await f.request("edit_page", args);
  assert.equal(changed.status, 200);
  const receipt = await changed.json();
  assert.deepEqual(await (await f.request("edit_page", args)).json(), receipt);
  assert.equal(f.updates(), 1);
  assert.equal((await (await f.request("read_page")).json()).title, "Edited once");
  now += RECEIPT_LIFETIME_MS;
  const current = await (await f.request("read_page")).json();
  // Another write collects the aged receipt.
  const later = await f.request("edit_page", {
    page_id: pageId,
    revision: current.revision,
    nonce: "page-route-later",
    operations: [{ op: "set_title", title: "Edited twice" }],
  });
  assert.equal(later.status, 200);
  const refused = await f.request("edit_page", args);
  assert.equal(refused.status, 409);
  const body = await refused.json();
  assert.equal(body.code, "resync_required");
  assert.equal(body.current_revision, (await later.json()).revision);
  assert.match(body.comment_revision, /^c\d+$/);
  assert.doesNotMatch(JSON.stringify(body), /[a-f0-9]{64}/);
  assert.equal(f.updates(), 2);
});

test("a passage comment and a reply each replay their receipt on an exact retry", async (t) => {
  const f = await pageFixture(t, { readContent: true });
  t.after(() => A.free(f.page.handle.doc()));
  const call = async (args) => {
    const response = await f.request("manage_page_comment", { page_id: pageId, ...args });
    return { status: response.status, body: await response.json() };
  };
  const read = await (await f.request("read_page", { page_id: pageId, comments: "all" })).json();
  const messages = async () => {
    const listed = await (await f.request("list_page_comments", { page_id: pageId })).json();
    return listed.comments.reduce((count, thread) => count + thread.messages.length, 0);
  };
  const before = await messages();
  const passage = {
    nonce: "retry-passage",
    action: "add",
    node_id: f.block,
    selected_text: "Original selected",
    revision: read.revision,
    body: "On the passage.",
  };
  const reply = { nonce: "retry-reply", action: "reply", thread_id: f.threadId, body: "A reply." };
  for (const args of [passage, reply]) {
    const first = await call(args);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const again = await call(args);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(again.body, first.body, `${args.action} replays`);
    // The same nonce with another body is another request, refused.
    const changed = await call({ ...args, body: "Something else." });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.code, "nonce_conflict");
  }
  assert.equal(await messages(), before + 2, "each wrote one message");
});

// A write against revision r whose receipt is forgotten (aged out, or
// evicted by a full journal) is refused on retry, whether or not the Page has
// moved since: neither a passage comment nor a target-scope edit runs twice.
for (const write of ["passage comment", "target-scope edit"])
  for (const forgotten of ["age", "capacity"])
    for (const laterEdit of [false, true])
      test(`a ${write} retried after its receipt is lost to ${forgotten}${laterEdit ? ", after a later edit," : ""} is refused`, async (t) => {
        let now = start;
        t.mock.method(Date, "now", () => now);
        const f = await pageFixture(t, { readContent: true });
        t.after(() => A.free(f.page.handle.doc()));
        const call = async (operation, args) => {
          const response = await f.request(operation, { page_id: pageId, ...args });
          return { status: response.status, body: await response.json() };
        };
        const read = (await call("read_page", { comments: "all" })).body;
        const [operation, args] =
          write === "passage comment"
            ? [
                "manage_page_comment",
                {
                  nonce: "lost-write",
                  action: "add",
                  node_id: f.block,
                  selected_text: "Original selected",
                  revision: read.revision,
                  body: "Once.",
                },
              ]
            : [
                "edit_page",
                {
                  nonce: "lost-write",
                  revision: read.revision,
                  conflict_scope: "target",
                  operations: [
                    {
                      op: "replace_match",
                      node_id: f.block,
                      match_text: "selected",
                      replacement: "selected and checked",
                    },
                  ],
                },
              ];
        const state = async () => {
          const page = (await call("read_page", { comments: "all" })).body;
          return {
            text: page.blocks.map((block) => block.markdown).join("\n"),
            messages: page.comments.reduce((count, thread) => count + thread.messages.length, 0),
          };
        };
        const first = await call(operation, args);
        assert.equal(first.status, 200, JSON.stringify(first.body));
        const once = await state();
        // Forget the receipt with a write that doesn't move the Page.
        now += 1000;
        if (forgotten === "age") now += RECEIPT_LIFETIME_MS;
        else completedReceipts(f.storage, now, JOURNAL_LIMITS.entries - 1);
        const collector = await call("manage_page_comment", {
          nonce: "collector",
          action: "reply",
          thread_id: f.threadId,
          body: "Collects.",
        });
        assert.equal(collector.status, 200, JSON.stringify(collector.body));
        assert.equal(await f.storage.get(await f.key({ nonce: "lost-write" })), undefined);
        assert.equal(
          await f.storage.get(
            await operationKey({ nonce: "lost-write" }, { principal: f.principal }, "comments"),
          ),
          undefined,
        );
        if (laterEdit) {
          now += 1000;
          const current = (await call("read_page", { comments: "none" })).body;
          const edited = await call("edit_page", {
            nonce: "later-edit",
            revision: current.revision,
            operations: [{ op: "set_title", title: "Later title" }],
          });
          assert.equal(edited.status, 200, JSON.stringify(edited.body));
        }
        const before = await state();
        assert.equal(before.messages, once.messages + 1, "only the collector's reply since");
        const retry = await call(operation, args);
        assert.equal(retry.status, 409, JSON.stringify(retry.body));
        assert.equal(retry.body.code, "resync_required");
        assert.match(retry.body.current_revision, /^r\d+$/);
        assert.deepEqual(await state(), before, "nothing was written again");
      });

test("no agent body names Automerge heads: reads, receipts and every revision refusal", async (t) => {
  const f = await pageFixture(t, { readContent: true });
  t.after(() => A.free(f.page.handle.doc()));
  const answered = [];
  const call = async (operation, args = {}) => {
    const response = await f.request(operation, { page_id: pageId, ...args });
    const body = await response.json();
    answered.push([operation, response.status, body]);
    return { status: response.status, body };
  };
  const read = await call("read_page", { comments: "all" });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const first = read.body.revision;
  assert.match(first, /^r\d+$/);
  assert.match(read.body.comment_revision, /^c\d+$/);
  assert.equal((await call("list_page_comments")).status, 200);
  const passage = await call("manage_page_comment", {
    nonce: "hex-passage",
    action: "add",
    node_id: f.block,
    selected_text: "Original selected",
    revision: first,
    body: "On the passage.",
  });
  assert.equal(passage.status, 200, JSON.stringify(passage.body));
  const reply = await call("manage_page_comment", {
    nonce: "hex-reply",
    action: "reply",
    thread_id: f.threadId,
    body: "A reply.",
  });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const edit = await call("edit_page", {
    revision: first,
    nonce: "hex-edit",
    operations: [
      {
        op: "replace_match",
        node_id: f.block,
        match_text: "Original selected content.",
        replacement: "Changed content.",
      },
    ],
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const changes = await call("read_page_changes", {
    since_revision: first,
    since_comment_revision: read.body.comment_revision,
  });
  assert.equal(changes.status, 200, JSON.stringify(changes.body));
  // A structural edit at the old revision is stale.
  const stale = await call("edit_page", {
    revision: first,
    nonce: "hex-stale",
    operations: [{ op: "set_title", title: "Stale" }],
  });
  assert.equal(stale.body.code, "stale_revision", JSON.stringify(stale.body));
  // A target-scoped edit of the passage that changed conflicts.
  const conflict = await call("edit_page", {
    revision: first,
    nonce: "hex-conflict",
    conflict_scope: "target",
    operations: [
      {
        op: "replace_match",
        node_id: f.block,
        match_text: "Original selected content.",
        replacement: "Again.",
      },
    ],
  });
  assert.equal(conflict.body.code, "edit_conflict", JSON.stringify(conflict.body));
  // A revision the Page never minted needs a resync.
  const resync = await call("edit_page", {
    revision: "r999999",
    nonce: "hex-resync",
    operations: [{ op: "set_title", title: "Unknown" }],
  });
  assert.equal(resync.body.code, "resync_required", JSON.stringify(resync.body));
  for (const refusal of [stale, conflict, resync]) {
    assert.equal(refusal.body.current_revision, edit.body.revision);
    assert.match(refusal.body.comment_revision, /^c\d+$/);
  }
  for (const [operation, status, body] of answered)
    assert.doesNotMatch(JSON.stringify(body), /[a-f0-9]{64}/, `${operation} ${status}`);
});

for (const operation of ["read_page", "list_page_comments"]) {
  test(`actual Page ${operation} partial read names an unchanged revision its edit uses`, async (t) => {
    const f = await pageFixture(t, { readContent: true });
    t.after(() => A.free(f.page.handle.doc()));
    const heads = A.getHeads(f.page.handle.doc());
    const response = await f.request(
      operation,
      operation === "read_page"
        ? { node_ids: [f.block], comments: "none" }
        : { thread_ids: [f.threadId], include_messages: false },
    );
    assert.equal(response.status, 200);
    const before = await response.json();
    assert.deepEqual(await headsFor(f.storage, "page", before.revision), heads);
    assert.deepEqual(A.getHeads(f.page.handle.doc()), heads);
    assert.equal(f.updates(), 0);
    assert.match(before.revision, /^r\d+$/);
    if (operation === "read_page") {
      assert.deepEqual(
        before.blocks.map((block) => block.node_id),
        [f.block],
      );
      assert.doesNotMatch(JSON.stringify(before), /Other block|Original comment/);
    } else {
      assert.deepEqual(
        before.comments.map((thread) => thread.id),
        [f.threadId],
      );
      assert.equal(before.comments[0].messages, undefined);
      assert.doesNotMatch(JSON.stringify(before), /Original comment|Original selected content/);
    }
    const args = {
      page_id: pageId,
      revision: before.revision,
      nonce: `${operation}-edit`,
      operations: [{ op: "set_title", title: "Edited from a partial read" }],
    };
    const changed = await f.request("edit_page", args);
    assert.equal(changed.status, 200);
    const receipt = await changed.json();
    assert.deepEqual(await (await f.request("edit_page", args)).json(), receipt);
    assert.equal(f.updates(), 1);
    assert.equal(f.page.handle.doc().title, "Edited from a partial read");
  });
}

test(
  "actual Page read captures content, comments and heads before revision storage awaits",
  { timeout: 5000 },
  async (t) => {
    const f = await pageFixture(t, { readContent: true });
    t.after(() => A.free(f.page.handle.doc()));
    const heads = A.getHeads(f.page.handle.doc());
    const entered = Promise.withResolvers();
    const released = Promise.withResolvers();
    t.after(() => released.resolve());
    const get = f.storage.get.bind(f.storage);
    let paused = false;
    t.mock.method(f.storage, "get", async (key) => {
      if (key === "host/revision/page/latest" && !paused) {
        paused = true;
        entered.resolve();
        await released.promise;
      }
      return get(key);
    });
    const pending = f.request("read_page", { node_ids: [f.block], comments: "all" });
    await entered.promise;
    // Native synchronization bypasses the Page HTTP queue. Advance the handle
    // while revision storage is blocked, without queueing another HTTP mutation.
    await f.page.handle.update((doc) =>
      A.change(doc, (draft) => {
        A.updateText(draft, ["title"], "Concurrent native title");
        initializePage(draft, "Concurrent native content.");
      }),
    );
    await f.page.commentsHandle.update(
      (current) =>
        comment(
          f.page.handle.doc(),
          current,
          { action: "reply", thread_id: f.threadId, body: "Concurrent native reply." },
          { principal: f.principal, displayName: "Fixture owner", driver: "Browser" },
        ).comments,
    );
    assert.notDeepEqual(A.getHeads(f.page.handle.doc()), heads);
    released.resolve();
    const response = await pending;
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(await headsFor(f.storage, "page", body.revision), heads);
    assert.equal(body.title, "Accepted content");
    assert.match(body.blocks[0].markdown, /Original selected content/);
    assert.match(JSON.stringify(body.comments), /Original comment/);
    assert.doesNotMatch(JSON.stringify(body), /Concurrent native/);
    assert.match(body.revision, /^r\d+$/);
  },
);

test("actual Page rejects a stale node read with a fresh outline instead of selected content", async (t) => {
  const f = await pageFixture(t, { readContent: true });
  t.after(() => A.free(f.page.handle.doc()));
  const heads = A.getHeads(f.page.handle.doc());
  const [heading] = nodeAddresses(f.page.handle.doc(), f.blockId);
  await f.page.handle.update((doc) =>
    A.change(doc, (draft) => {
      initializePage(
        draft,
        "Inserted first paragraph.\n\n## First section\n\nOriginal selected content.",
      );
    }),
  );
  const current = A.getHeads(f.page.handle.doc());
  const response = await f.request("read_page", {
    node_ids: [heading],
    revision: await readRevision(f.storage, "page", heads),
    comments: "none",
  });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "read_revision_changed");
  assert.deepEqual(await headsFor(f.storage, "page", body.revision), current);
  assert.ok(Array.isArray(body.outline.entries));
  assert.equal(body.blocks, undefined);
  assert.equal(body.comments, undefined);
  assert.doesNotMatch(JSON.stringify(body), /Inserted first paragraph|Original selected content/);
  assert.equal(f.updates(), 1, "the rejected read performs no mutation");
  const fresh = await f.request("read_page", {
    node_ids: [f.block],
    revision: body.revision,
    comments: "none",
  });
  assert.equal(fresh.status, 200);
  assert.match((await fresh.json()).blocks[0].markdown, /Inserted first paragraph/);
});

test("actual Page returns a bounded UTF-8 budget error without truncated content", async (t) => {
  const f = await pageFixture(t, { readContent: true });
  t.after(() => A.free(f.page.handle.doc()));
  await f.page.handle.update((doc) =>
    A.change(doc, (draft) => {
      initializePage(draft, `## Budget section\n\n${"雪".repeat(1800)}`);
    }),
  );
  const heads = A.getHeads(f.page.handle.doc());
  const response = await f.request("read_page", {
    node_ids: [f.block],
    comments: "none",
    max_bytes: 4096,
  });
  assert.equal(response.status, 413);
  const text = await response.text();
  assert.ok(new TextEncoder().encode(text).byteLength <= 4096);
  const body = JSON.parse(text);
  assert.equal(body.code, "read_budget_exceeded");
  assert.deepEqual(await headsFor(f.storage, "page", body.revision), heads);
  assert.match(body.revision, /^r\d+$/);
  assert.match(JSON.stringify(body.outline.entries), /Budget section/);
  assert.equal(body.blocks, undefined);
  assert.doesNotMatch(text, /雪/);
  assert.equal(f.updates(), 1);
});

test("Page image insertion validates storage once and journals actual block identity across retries", async (t) => {
  const f = await pageFixture(t);
  const assetId = "a".repeat(64);
  let heads = 0;
  f.page.env = {
    ...f.page.env,
    PAGES_ASSETS: {
      async head(key) {
        heads++;
        assert.ok(key.includes(pageId) && key.includes(assetId));
        return {
          size: 74,
          httpMetadata: { contentType: "image/png" },
          customMetadata: { page_id: pageId, hash: assetId, width: "3", height: "2" },
        };
      },
    },
  };
  const before = await (await f.request("read_page")).json();
  const args = {
    page_id: pageId,
    revision: before.revision,
    nonce: "insert-image-once",
    operations: [{ op: "insert_image", asset_id: assetId, alt: "A cat" }],
  };
  const response = await f.request("edit_page", args);
  assert.equal(response.status, 200);
  const receipt = await response.json();
  const [image] = receipt.result.edits;
  const key = blockKey(f.page.handle.doc(), image.node_id);
  assert.ok(key);
  assert.equal(image.op, "insert_image");
  assert.equal(image.asset_id, assetId);
  assert.equal(heads, 1);
  // Receipt remains a record of the original operation, not a claim about the
  // latest document: a peer can remove the block before the requester retries.
  await f.page.handle.update((doc) =>
    A.change(doc, (draft) => {
      delete draft.blocks[key];
    }),
  );
  f.page.env.PAGES_ASSETS.head = async () => assert.fail("Retry depends on blob storage");
  assert.deepEqual(await (await f.request("edit_page", args)).json(), receipt);
  assert.equal(f.page.handle.doc().blocks[key], undefined);
  assert.equal(
    (
      await f.request("edit_page", {
        ...args,
        operations: [{ ...args.operations[0], alt: "Different" }],
      })
    ).status,
    409,
  );
});

test("Page theme image set preflights both sources and keeps exact heads", async (t) => {
  const f = await pageFixture(t);
  const assetId = "a".repeat(64),
    dark = "b".repeat(64);
  let invalid = null;
  const checked = [];
  f.page.env = {
    ...f.page.env,
    PAGES_ASSETS: {
      async head(key) {
        const id = key.includes(dark) ? dark : assetId;
        checked.push(id);
        return {
          size: 74,
          httpMetadata: {
            contentType:
              invalid === "type" && id === dark ? "application/vnd.apache.parquet" : "image/png",
          },
          customMetadata: {
            page_id: invalid === "page" && id === dark ? crypto.randomUUID() : pageId,
            hash: id,
            width: "3",
            height: "2",
          },
        };
      },
    },
  };
  const before = await (await f.request("read_page")).json();
  const inserted = await (
    await f.request("edit_page", {
      page_id: pageId,
      revision: before.revision,
      nonce: "theme-insert",
      operations: [{ op: "insert_image", asset_id: assetId, alt: "Chart" }],
    })
  ).json();
  const image = inserted.result.edits[0];
  for (const reason of ["type", "page", null]) {
    invalid = reason;
    const read = await (await f.request("read_page")).json();
    const response = await f.request("edit_page", {
      page_id: pageId,
      revision: read.revision,
      nonce: `theme-set-${reason}`,
      operations: [
        {
          op: "set_image",
          node_id: image.image,
          asset_id: assetId,
          dark_asset_id: dark,
        },
      ],
    });
    assert.equal(response.status === 200, reason === null);
  }
  assert.ok(checked.includes(dark));
  const stale = await f.request("edit_page", {
    page_id: pageId,
    revision: before.revision,
    nonce: "theme-stale",
    operations: [{ op: "set_image", node_id: image.image, alt: "No" }],
  });
  assert.equal(stale.status, 409);
});

test("Page image preflight rejects missing assets and lost write access before editing", async (t) => {
  for (const denied of ["missing", "permission"]) {
    const f = await pageFixture(t);
    const assetId = "a".repeat(64);
    f.page.env = {
      ...f.page.env,
      PAGES_ASSETS: {
        async head() {
          if (denied === "missing") return null;
          f.page.metadata.owner = "user:other";
          return {
            size: 74,
            httpMetadata: { contentType: "image/png" },
            customMetadata: { page_id: pageId, hash: assetId, width: "3", height: "2" },
          };
        },
      },
    };
    const before = await (await f.request("read_page")).json();
    const args = {
      page_id: pageId,
      revision: before.revision,
      nonce: `image-${denied}`,
      operations: [
        { op: "set_title", title: "Must not apply" },
        { op: "insert_image", asset_id: assetId, alt: "cat" },
      ],
    };
    const response = await f.request("edit_page", args);
    assert.equal(response.status, denied === "missing" ? 404 : 403);
    assert.equal(f.updates(), 0);
    assert.equal(f.page.handle.doc().title, "Accepted content");
    assert.equal(await f.storage.get(await f.key(args)), undefined);
  }
});

const parquetHead = (assetId, owner = pageId) => ({
  size: 1018,
  httpMetadata: { contentType: "application/vnd.apache.parquet" },
  customMetadata: { page_id: owner, hash: assetId },
});

test("Page dataframe insertion checks storage once and replays without it", async (t) => {
  const f = await pageFixture(t);
  const assetId = "c".repeat(64);
  let heads = 0;
  f.page.env = {
    ...f.page.env,
    PAGES_ASSETS: {
      async head(key) {
        heads++;
        assert.ok(key.includes(pageId) && key.includes(assetId));
        return parquetHead(assetId);
      },
    },
  };
  const before = await (await f.request("read_page")).json();
  const args = {
    page_id: pageId,
    revision: before.revision,
    nonce: "insert-dataframe-once",
    operations: [
      {
        op: "insert_node",
        node: { type: "dataframe", attrs: { asset_id: assetId, title: "Usage" } },
      },
    ],
  };
  const response = await f.request("edit_page", args);
  assert.equal(response.status, 200);
  const receipt = await response.json();
  const [node] = receipt.result.edits;
  assert.equal(node.op, "insert_node");
  assert.equal(node.attrs.src, `/api/pages/${pageId}/assets/${assetId}`);
  assert.ok(blockKey(f.page.handle.doc(), node.node_id));
  assert.equal(heads, 1);
  f.page.env.PAGES_ASSETS.head = async () => assert.fail("Retry depends on blob storage");
  assert.deepEqual(await (await f.request("edit_page", args)).json(), receipt);
});

test("Page dataframe preflight refuses missing, image and malformed assets before editing", async (t) => {
  const assetId = "c".repeat(64);
  for (const [name, head, attrs, status, code] of [
    ["missing", () => null, { asset_id: assetId }, 404, "dataset_not_found"],
    [
      "image",
      () => ({
        size: 74,
        httpMetadata: { contentType: "image/png" },
        customMetadata: { page_id: pageId, hash: assetId, width: "3", height: "2" },
      }),
      { asset_id: assetId },
      415,
      undefined,
    ],
    // A stored object whose metadata names another Page fails closed.
    [
      "foreign",
      () => parquetHead(assetId, "44444444-4444-4444-8444-444444444444"),
      { asset_id: assetId },
      500,
      undefined,
    ],
    [
      "malformed",
      () => assert.fail("No HEAD for a malformed node"),
      { asset_id: "x" },
      400,
      "invalid_edit_selector",
    ],
    [
      "media type",
      () => assert.fail("No HEAD for an unknown media type"),
      { asset_id: assetId, media_type: "text/csv" },
      400,
      "invalid_edit_selector",
    ],
  ]) {
    const f = await pageFixture(t);
    f.page.env = { ...f.page.env, PAGES_ASSETS: { head } };
    const before = await (await f.request("read_page")).json();
    const args = {
      page_id: pageId,
      revision: before.revision,
      nonce: `dataframe-${name.replace(" ", "-")}`,
      operations: [
        { op: "set_title", title: "Must not apply" },
        { op: "insert_node", node: { type: "dataframe", attrs } },
      ],
    };
    const response = await f.request("edit_page", args);
    assert.equal(response.status, status, name);
    if (code) assert.equal((await response.json()).code, code, name);
    assert.equal(f.updates(), 0, name);
    assert.equal(f.page.handle.doc().title, "Accepted content", name);
    assert.equal(await f.storage.get(await f.key(args)), undefined, name);
  }
});

test("recovery-blocked Page keeps accepted content readable and rejects tool and sync writes", async (t) => {
  t.mock.method(Date, "now", () => start);
  const f = await pageFixture(t);
  f.page.metadata.recoveryBlocked = { code: "history_capacity" };
  const response = await f.request("read_page");
  assert.equal(response.status, 200);
  const accepted = await response.json();
  assert.equal(accepted.title, "Accepted content");
  const edit = await f.request("edit_page", {
    page_id: pageId,
    revision: accepted.revision,
    nonce: "blocked-page-edit",
    operations: [{ op: "set_title", title: "Must not apply" }],
  });
  assert.equal(edit.status, 409);
  assert.equal((await edit.json()).code, "page_recovery_blocked");
  assert.equal(f.updates(), 0);
  // Sync connections read but can't write.
  const identity = {
    principal: f.principal,
    displayName: "Owner",
    driver: "Browser",
    canWrite: true,
    expiresAt: start + 60_000,
  };
  f.page.policy.account(identity);
  assert.throws(() => f.page.policy.account(identity, true), {
    status: 409,
    code: "page_recovery_blocked",
  });
  assert.equal(f.page.handle.doc().title, "Accepted content");
});
