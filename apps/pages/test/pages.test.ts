import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as A from "@automerge/automerge/slim";
import {
  blockHash,
  createPage,
  edit,
  patchText,
  selectSnapshot,
  snapshot,
  type Page,
} from "../src/document.ts";
import { PagesWorkspace, checkStorageBudget, type Storage } from "../src/workspace.ts";
import worker, { assertSameOrigin, type Env } from "../src/worker.ts";
import { oidcTokenFixture } from "../../notebook-cloud/test/oidc-jwt-fixture.ts";
await A.initializeWasm(
  await readFile(import.meta.resolve("@automerge/automerge/automerge.wasm").replace("file://", "")),
);

class MemoryStorage implements Storage {
  values = new Map<string, unknown>();
  fail = false;
  async get<T>(key: string) {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put(values: Record<string, unknown>) {
    if (this.fail) throw new Error("disk unavailable");
    for (const [key, value] of Object.entries(values)) this.values.set(key, structuredClone(value));
  }
}
const principal = "oidc:test:alice";
function call(workspace: PagesWorkspace, operation: string, args: Record<string, unknown> = {}) {
  return workspace.call(principal, { operation, arguments: args });
}
async function fixture() {
  const storage = new MemoryStorage(),
    workspace = new PagesWorkspace({ storage });
  const created = (await call(workspace, "create_page", {
    title: "A page",
    block_units: ["one", "two", { kind: "agent_instructions", markdown: "Ask before publishing" }],
    idempotency_key: "creation-1",
  })) as { page_id: string; content: Awaited<ReturnType<typeof snapshot>> };
  return { storage, workspace, ...created };
}
test("Automerge preserves identity, Unicode, metadata and independent concurrent text edits", async () => {
  const base = createPage("page_test", "Title", [
    { markdown: "Hello 🌍 world", metadata: { tags: ["a"], provenance: { imported: true } } },
  ]);
  const id = base.order[0];
  let left = A.clone(base),
    right = A.clone(base);
  left = A.change(left, (d) => A.splice(d, ["blocks", id, "markdown"], 0, 0, "Left "));
  right = A.change(right, (d) =>
    A.splice(d, ["blocks", id, "markdown"], d.blocks[id].markdown.length, 0, " right"),
  );
  const merged = A.merge(left, right);
  const loaded = A.load<Page>(A.save(merged));
  assert.equal(loaded.blocks[id].markdown, "Left Hello 🌍 world right");
  assert.deepEqual(loaded.blocks[id].metadata, { tags: ["a"], provenance: { imported: true } });
  assert.equal(loaded.order[0], id);
  A.free(base);
  A.free(merged);
  A.free(right);
  A.free(loaded);
});
test("atomic edits roll back when a later hash guard fails", async () => {
  const doc = createPage("page_test", "Title", ["one", "two"]),
    before = await snapshot(doc, 1);
  await assert.rejects(
    edit(doc, [
      {
        op: "replace_block_markdown",
        block_id: doc.order[0],
        expected_hash: before.blocks[0].hash,
        markdown: "changed",
      },
      { op: "delete_block", block_id: doc.order[1], expected_hash: "stale" },
    ]),
    /Block changed/,
  );
  assert.deepEqual(await snapshot(doc, 1), before);
  A.free(doc);
});
test("literal patches use original spans and reject ambiguous, overlapping, and empty needles", () => {
  assert.equal(
    patchText("one two", [
      { old: "one", new: "two" },
      { old: "two", new: "three" },
    ]),
    "two three",
  );
  assert.equal(patchText("🌍 café", [{ old: "🌍", new: "😀" }]), "😀 café");
  assert.throws(() => patchText("aaa", [{ old: "aa", new: "b" }]), /exactly once/);
  assert.throws(
    () =>
      patchText("abcd", [
        { old: "abc", new: "x" },
        { old: "bcd", new: "y" },
      ]),
    /overlap/,
  );
  assert.throws(() => patchText("abc", [{ old: "", new: "x" }]), /empty/);
});
test("patch batches retain successes and report rejected siblings", async () => {
  const doc = createPage("page_test", "Title", ["one", "two"]),
    before = await snapshot(doc, 1);
  const result = await edit(
    doc,
    before.blocks.map((b, index) => ({
      op: "patch_block_markdown",
      block_id: b.id,
      expected_hash: index === 0 ? b.hash : "stale",
      replacements: [{ old: b.markdown, new: "updated" }],
    })),
    true,
  );
  assert.deepEqual(
    result.receipts.map((r) => r.status),
    ["applied", "rejected"],
  );
  assert.deepEqual(
    result.doc.order.map((id) => result.doc.blocks[id].markdown),
    ["updated", "two"],
  );
  A.free(doc);
  A.free(result.doc);
});
test("search always returns instructions and missing targeted IDs are explicit", async () => {
  const { content } = await fixture();
  const result = selectSnapshot(content, { search: ["one"] });
  assert.deepEqual(
    result.content?.blocks.map((b) => b.markdown),
    ["one", "Ask before publishing"],
  );
  assert.equal(result.selection.whole_page_complete, false);
  assert.equal(
    selectSnapshot(content, { block_ids: ["missing"] }).selection.selection_complete,
    false,
  );
});
test("structural anchors reject stale adjacency; moves preserve block identity and metadata", async () => {
  const doc = createPage("page_test", "Title", ["one", "two"]),
    [a, b] = doc.order;
  await assert.rejects(
    edit(doc, [
      {
        op: "insert_markdown",
        at: { kind: "between_blocks", preceding_block_id: null, following_block_id: b },
        markdown: "x",
      },
    ]),
    /adjacent/,
  );
  const result = await edit(doc, [{ op: "move_block", block_id: b, after_block_id: null }]);
  assert.deepEqual(result.doc.order, [b, a]);
  assert.equal(await blockHash(result.doc.blocks[b]), await blockHash(doc.blocks[b]));
  A.free(doc);
  A.free(result.doc);
});
test("create retry returns the same Page after restart; changed payload with same key is rejected", async () => {
  const { storage, page_id } = await fixture(),
    restarted = new PagesWorkspace({ storage });
  const retry = (await call(restarted, "create_page", {
    title: "A page",
    block_units: ["one", "two", { kind: "agent_instructions", markdown: "Ask before publishing" }],
    idempotency_key: "creation-1",
  })) as { page_id: string };
  assert.equal(retry.page_id, page_id);
  await assert.rejects(
    call(restarted, "create_page", { title: "Different", idempotency_key: "creation-1" }),
    /different content/,
  );
});
test("write receipt and snapshot survive restart; retry does not apply twice", async () => {
  const { workspace, storage, page_id, content } = await fixture();
  const request = {
    page_id,
    base_sequence: 1,
    idempotency_key: "request-1",
    operations: [
      {
        op: "replace_block_markdown",
        block_id: content.blocks[0].id,
        expected_hash: content.blocks[0].hash,
        markdown: "updated",
      },
    ],
  };
  const receipt = await call(workspace, "edit_page", request);
  const restarted = new PagesWorkspace({ storage });
  assert.deepEqual(await call(restarted, "edit_page", request), receipt);
  const read = (await call(restarted, "read_page", { page_id })) as { content: typeof content };
  assert.equal(read.content.through_sequence, 2);
  assert.equal(read.content.blocks[0].markdown, "updated");
  await assert.rejects(
    call(restarted, "edit_page", { ...request, idempotency_key: "request-2" }),
    /Page changed/,
  );
});
test("storage failure leaves no speculative changes in memory or persisted state", async () => {
  const { workspace, storage, page_id, content } = await fixture();
  storage.fail = true;
  await assert.rejects(
    call(workspace, "edit_page", {
      page_id,
      base_sequence: 1,
      idempotency_key: "request-1",
      operations: [
        {
          op: "delete_block",
          block_id: content.blocks[0].id,
          expected_hash: content.blocks[0].hash,
        },
      ],
    }),
    /disk unavailable/,
  );
  storage.fail = false;
  const read = (await call(workspace, "read_page", { page_id })) as { content: typeof content };
  assert.deepEqual(read.content, content);
});
test("concurrent HTTP writers serialize across awaits and only one stale-base write wins", async () => {
  const { workspace, page_id, content } = await fixture();
  const request = (key: string) =>
    new Request("https://internal/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-pages-principal": principal },
      body: JSON.stringify({
        operation: "edit_page",
        arguments: {
          page_id,
          base_sequence: 1,
          idempotency_key: key,
          operations: [{ op: "set_title", expected_title_hash: content.title_hash, title: key }],
        },
      }),
    });
  const responses = await Promise.all([
    workspace.fetch(request("writer-one")),
    workspace.fetch(request("writer-two")),
  ]);
  assert.deepEqual(
    responses.map((r) => r.status),
    [200, 409],
  );
});
test("change reads return deletion and order, with resync for unknown future cursors", async () => {
  const { workspace, page_id, content } = await fixture();
  await call(workspace, "edit_page", {
    page_id,
    base_sequence: 1,
    idempotency_key: "request-1",
    operations: [
      { op: "delete_block", block_id: content.blocks[0].id, expected_hash: content.blocks[0].hash },
    ],
  });
  const changes = (await call(workspace, "read_page_changes", { page_id, since_sequence: 1 })) as {
    deleted_block_ids: string[];
    block_order: string[];
  };
  assert.deepEqual(changes.deleted_block_ids, [content.blocks[0].id]);
  assert.deepEqual(
    changes.block_order,
    content.blocks.slice(1).map((b) => b.id),
  );
  assert.deepEqual(await call(workspace, "read_page_changes", { page_id, since_sequence: 999 }), {
    resync_required: true,
    through_sequence: 2,
  });
});
test("workspace isolation, CSRF, and unsupported streams fail closed", async () => {
  const { workspace, page_id } = await fixture();
  await assert.rejects(
    workspace.call("oidc:test:bob", { operation: "list_pages" }),
    /identity mismatch/,
  );
  await assert.rejects(
    call(workspace, "read_page", { page_id, stream_kind: "scratch" }),
    /content stream/,
  );
  const env = {
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.example",
    PAGES_WORKSPACES: {
      idFromName() {
        throw new Error("must not route");
      },
    },
  } as unknown as Env;
  assert.throws(
    () =>
      assertSameOrigin(
        new Request("https://pages.example/api/tools", {
          headers: { Origin: "https://evil.example" },
        }),
        env,
      ),
    /same-origin/,
  );
  const denied = await worker.fetch(
    new Request("https://pages.example/api/tools", {
      method: "POST",
      headers: { Origin: "https://pages.example", "x-pages-principal": principal },
    }),
    env,
  );
  assert.equal(denied.status, 401);
  const localIssuer = await worker.fetch(new Request("https://pages.example/dev/oidc/authorize"), {
    ...env,
    NOTEBOOK_CLOUD_LOCAL_OIDC: "true",
  });
  assert.equal(localIssuer.status, 404);
});

test("verified OIDC bearer chooses the workspace; spoofed identity headers and invalid tokens cannot", async () => {
  const fixture = await oidcTokenFixture({ subject: "alice" });
  const names: string[] = [];
  let forwarded: string | null = null;
  const env: Env = {
    ...fixture.env,
    PAGES_ALLOW_PROVIDER_BEARER: "true",
    PAGES_WORKSPACES: {
      idFromName(name) {
        names.push(name);
        return { toString: () => name };
      },
      get() {
        return {
          async fetch(request) {
            forwarded = request.headers.get("x-pages-principal");
            return new Response("{}");
          },
        };
      },
    },
  };
  const response = await worker.fetch(
    new Request("https://pages.example/api/tools", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixture.token}`,
        "x-pages-principal": "admin",
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(names.length, 1);
  assert.equal(forwarded, names[0]);
  assert.match(names[0], /alice/);
  assert.match(names[0], /auth.stage.anaconda.com/);
  assert.doesNotMatch(names[0], /admin/);
  const sharedClientReplay = await worker.fetch(
    new Request("https://pages.example/api/tools", {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.token}`, Origin: "https://pages.example" },
      body: "{}",
    }),
    { ...env, NOTEBOOK_CLOUD_OIDC_FLOW: "server" },
  );
  assert.equal(sharedClientReplay.status, 401);
  assert.equal(
    names.length,
    1,
    "server mode must reject even valid provider tokens before routing",
  );
  for (const setting of [undefined, "false", "TRUE"]) {
    const withoutOptIn = await worker.fetch(
      new Request("https://pages.example/api/tools", {
        method: "POST",
        headers: { Authorization: `Bearer ${fixture.token}` },
        body: "{}",
      }),
      { ...env, PAGES_ALLOW_PROVIDER_BEARER: setting },
    );
    assert.equal(withoutOptIn.status, 401);
    assert.equal(names.length, 1, "provider bearer access requires an explicit opt-in");
  }
  const invalid = await worker.fetch(
    new Request("https://pages.example/api/tools", {
      method: "POST",
      headers: { Authorization: "Bearer invalid", "x-pages-principal": "admin" },
    }),
    env,
  );
  assert.equal(invalid.status, 401);
  assert.equal(names.length, 1);
});

test("all-rejected patches do not advance sequences or evict successful receipts", async () => {
  const { workspace, storage, page_id, content } = await fixture();
  const before = structuredClone(storage.values);
  const result = (await call(workspace, "patch_page", {
    page_id,
    base_sequence: 1,
    idempotency_key: "rejected-patch",
    operations: [
      {
        op: "patch_block_markdown",
        block_id: content.blocks[0].id,
        expected_hash: "stale",
        replacements: [{ old: "one", new: "updated" }],
      },
    ],
  })) as { commit_status: string; through_sequence: number };
  assert.equal(result.commit_status, "not_committed");
  assert.equal(result.through_sequence, 1);
  assert.deepEqual(storage.values, before);
});

test("the complete storage value is budgeted, including receipts and catalog", () => {
  assert.throws(
    () =>
      checkStorageBudget({ page: { bytes: new Uint8Array(1), receipts: "x".repeat(1536 * 1024) } }),
    /including history and receipts/,
  );
  assert.throws(() => checkStorageBudget({ catalog: "x".repeat(1536 * 1024) }), /budget/);
  checkStorageBudget({ page: { bytes: new Uint8Array(100), receipts: {} } });
});

test("metadata rejects non-finite JSON numbers and excessive nesting before Automerge", () => {
  assert.throws(
    () =>
      createPage("test", "Title", [{ markdown: "x", metadata: JSON.parse('{"amount":1e999}') }]),
    /finite/,
  );
  let nested: unknown = null;
  for (let i = 0; i < 34; i++) nested = { value: nested };
  assert.throws(
    () => createPage("test", "Title", [{ markdown: "x", metadata: nested }]),
    /nesting/,
  );
});
