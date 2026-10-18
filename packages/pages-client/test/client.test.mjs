import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PagesClient, pagesOrigin } from "../dist/index.js";
import { prepareConnection, saveConnection, loadConnection } from "../dist/node.js";
test("client preserves guards and uncertain outcomes without automatic mutation retries", async () => {
  const request = {
    page_id: "page_" + "a".repeat(32),
    base_sequence: 7,
    idempotency_key: "request-123",
    operations: [],
  };
  let calls = 0;
  const client = new PagesClient("https://pages.example", {
    token: "secret",
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, "https://pages.example/api/tools");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.Authorization, "Bearer secret");
      assert.deepEqual(JSON.parse(init.body), { operation: "patch_page", arguments: request });
      return Response.json(
        { error: { code: "storage_unavailable", message: "Read back", commit_status: "unknown" } },
        { status: 503 },
      );
    },
  });
  await assert.rejects(
    client.patchPage(request),
    (e) => e.commitStatus === "unknown" && e.status === 503,
  );
  assert.equal(calls, 1);
  const failed = new PagesClient("https://pages.example", {
    fetch: async () => {
      throw Error("secret leaked in underlying exception");
    },
  });
  await assert.rejects(
    failed.readPage(request.page_id),
    (e) => e.commitStatus === "unknown" && !e.message.includes("secret"),
  );
});
test("connection approval contains only a token hash; local credentials are private and never overwritten", async (t) => {
  const pending = prepareConnection("https://pages.example", "page_" + "b".repeat(32), "ChatGPT");
  assert.equal(pending.approvalUrl.includes(pending.config.token), false);
  assert.equal(
    JSON.parse(new URL(pending.approvalUrl).searchParams.get("connect")).token_hash.length,
    64,
  );
  const dir = await mkdtemp(path.join(tmpdir(), "pages-client-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "connection.json");
  await saveConnection(file, pending.config);
  assert.deepEqual(await loadConnection(file), pending.config);
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(saveConnection(file, pending.config), /EEXIST/);
  for (const origin of [
    "http://public.example",
    "https://user:pass@example.com",
    "https://example.com/path",
    "https://example.com/?x",
  ])
    assert.throws(() => pagesOrigin(origin));
});
