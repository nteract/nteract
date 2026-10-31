import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { createPageData, initializePage, orderedBlockIds } from "../model/page.mjs";
import { resolvePeerSelection } from "../model/presence.mjs";
import worker, { Page } from "./index.mjs";
import { DocumentPolicy } from "./policy.mjs";
import { authenticate } from "./auth.mjs";

const pageId = "33333333-3333-4333-8333-333333333333";
class Storage {
  values = new Map();
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
  async sync() {}
}

async function fixture(t, driver = "Kilo") {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const token = auth.apiKey();
  let doc = A.change(A.from(createPageData({ pageId })), (draft) =>
    initializePage(draft, "## Rollout\n\nShip on Monday to five users.\n\nAnother fade here."),
  );
  const broadcasts = [];
  const storage = new Storage();
  const handle = Object.assign(new EventEmitter(), {
    doc: () => doc,
    async update(fn) {
      doc = fn(doc);
    },
    broadcast: (value) => broadcasts.push(value),
  });
  const page = Object.assign(Object.create(Page.prototype), {
    env: auth.env,
    ready: Promise.resolve(),
    tail: Promise.resolve(),
    ctx: { storage },
    metadata: {
      pageId,
      owner: null,
      deleted: false,
      acl: { revision: 0, members: {}, invites: {} },
    },
    handle,
    cacheTitle() {},
    flush: async () => {},
  });
  page.policy = new DocumentPolicy({ storage, metadata: () => page.metadata });
  const call = async (operation, args = {}) => {
    const response = await worker.fetch(
      new Request("https://pages.invalid/api/tools", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "x-pages-driver": driver },
        body: JSON.stringify({ operation, arguments: { page_id: pageId, ...args } }),
      }),
      auth.env,
    );
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };
  // The fixture's caller owns the Page.
  const identity = await authenticate(
    new Request("https://pages.invalid/api/tools", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-pages-driver": driver },
    }),
    auth.env,
  );
  page.metadata.owner = identity.principal;
  page.observeActivity();
  t.after(() => {
    page.activity?.close();
  });
  auth.env.PAGES = { getByName: () => page };
  const patch = async (operations, key = crypto.randomUUID()) => {
    const auth = await call("read_page", { include_content: false });
    return call("patch_page", {
      operations,
      base_heads: auth.heads,
      retry_token: auth.retry_token,
      idempotency_key: auth.retry_key_prefix + key,
    });
  };
  return {
    page,
    storage,
    call,
    patch,
    broadcasts,
    doc: () => doc,
    blockId: () => orderedBlockIds(doc)[0],
    agents: () => broadcasts.filter((b) => b.kind === "page-activity").at(-1)?.agents ?? [],
  };
}

test("a committed patch_page publishes the agent's caret over its new text", async (t) => {
  const f = await fixture(t);
  const receipt = await f.patch([
    { op: "replace_match", block_id: f.blockId(), match_text: "Monday", replacement: "Tuesday" },
  ]);
  assert.equal(receipt.result.edits[0].matched, 1);
  assert.deepEqual(Object.keys(receipt.result.edits[0]).sort(), ["block_id", "matched", "op"]);
  const [agent] = f.agents();
  assert.equal(agent.driver, "Kilo");
  assert.equal(agent.state, "active");
  const [target] = agent.targets;
  assert.equal(target.kind, "text");
  assert.deepEqual(target.heads, receipt.heads);
  assert.equal(resolvePeerSelection(f.doc(), target).quote, "Tuesday");
  // Cursors live only in the broadcast, never in a stored journal entry.
  const stored = JSON.stringify([...f.storage.values.values()]);
  assert.ok(!stored.includes(target.start));
  assert.ok(!stored.includes(target.end));
});

test("a retried patch replays its receipt without publishing a new caret", async (t) => {
  const f = await fixture(t);
  const auth = await f.call("read_page", { include_content: false });
  const args = {
    operations: [
      { op: "format_match", block_id: f.blockId(), match_text: "five", add: { strong: true } },
    ],
    base_heads: auth.heads,
    retry_token: auth.retry_token,
    idempotency_key: auth.retry_key_prefix + "retry-once",
  };
  const first = await f.call("patch_page", args);
  const seq = f.agents()[0].seq;
  const revision = f.broadcasts.filter((b) => b.kind === "page-activity").at(-1).revision;
  const again = await f.call("patch_page", args);
  assert.deepEqual(again, first);
  assert.equal(f.agents()[0].seq, seq);
  assert.equal(f.broadcasts.filter((b) => b.kind === "page-activity").at(-1).revision, revision);
});

test("block operations target the block; targeted reads show reading markers", async (t) => {
  const f = await fixture(t);
  await f.patch([{ op: "insert_markdown", markdown: "A new block." }]);
  let [agent] = f.agents();
  assert.deepEqual(Object.keys(agent.targets[0]).sort(), ["block_id", "kind"]);
  assert.equal(agent.targets[0].kind, "block");

  await f.call("read_page", { search: ["fade"] });
  [agent] = f.agents();
  assert.equal(agent.state, "reading");
  assert.equal(agent.targets[0].kind, "hit");
  assert.equal(resolvePeerSelection(f.doc(), agent.targets[0]).quote, "fade");

  // A whole-page read says nothing about intent and changes nothing.
  const revision = f.broadcasts.filter((b) => b.kind === "page-activity").at(-1).revision;
  await f.call("read_page", {});
  assert.equal(f.broadcasts.filter((b) => b.kind === "page-activity").at(-1).revision, revision);

  const presence = await f.call("read_page_presence", {});
  assert.equal(presence.agents[0].targets[0].quote, "fade");
});

test("a person's own browser tool calls publish no agent caret", async (t) => {
  const f = await fixture(t, "Browser");
  await f.patch([
    { op: "replace_match", block_id: f.blockId(), match_text: "Monday", replacement: "Friday" },
  ]);
  await f.call("read_page", { search: ["fade"] });
  assert.deepEqual(f.agents(), []);
});
