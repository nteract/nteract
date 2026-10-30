// Real local celld + OIDC + native Subduction exercise. No production credentials.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { purgeTrashedFixture } from "./purge-fixture.mjs";
const origin = process.env.PAGES_ORIGIN ?? "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost", "Generated fixture requires local OIDC");
export async function login(user) {
  const cookies = new Map();
  let url = `${origin}/api/auth/login`;
  for (let i = 0; i < 12; i++) {
    if (new URL(url).pathname === "/dev/oidc/authorize" && user) {
      const next = new URL(url);
      next.searchParams.set("login_hint", user);
      url = next.href;
    }
    const response = await fetch(url, {
      redirect: "manual",
      headers: { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0],
        at = pair.indexOf("=");
      cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    if (!response.headers.has("location")) {
      assert.equal(response.status, 200, await response.text());
      return [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    url = new URL(response.headers.get("location"), url).href;
    assert.equal(new URL(url).origin, origin);
  }
  throw Error("OIDC did not finish");
}
export async function tool(cookie, operation, args, status = 200) {
  const response = await fetch(`${origin}/api/tools`, {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ operation, arguments: args }),
  });
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
}
if (process.argv.includes("--verify-restart")) {
  const { page_id } = JSON.parse(
    await readFile(new URL("../test-results/page.json", import.meta.url)),
  );
  const recovered = await tool(await login(), "read_page", { page_id });
  assert.equal(recovered.blocks[0].markdown, "The **otter** crossed the garden.");
  assert.equal(recovered.comments.length, 1);
  assert.equal(recovered.comments[0].selectionContext.status, "attached");
  console.log(JSON.stringify({ processRestartRecovery: true, page_id }));
  process.exit(0);
}
const cookie = await login();
const other = await login("alice@localhost");
const key = crypto.randomUUID();
const page = await tool(cookie, "create_page", {
  title: "Native Pages fixture",
  markdown: "The **fox** crossed the garden.",
  idempotency_key: key,
});
assert.ok(page.page_id);
assert.equal(
  (await tool(cookie, "list_pages", {})).pages.some((p) => p.page_id === page.page_id),
  true,
);
await tool(other, "read_page", { page_id: page.page_id }, 403);
const read = await tool(cookie, "read_page", { page_id: page.page_id });
assert.equal(read.blocks[0].markdown, "The **fox** crossed the garden.");
console.log(JSON.stringify({ oidc: true, privateAccounts: true, page: page.page_id }));
await mkdir(new URL("../test-results/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../test-results/page.json", import.meta.url),
  JSON.stringify({ page_id: page.page_id }),
);
const repeated = await tool(cookie, "create_page", {
  title: "Native Pages fixture",
  markdown: "The **fox** crossed the garden.",
  idempotency_key: key,
});
assert.equal(repeated.page_id, page.page_id, "Create replay must reuse the same Page");
await tool(cookie, "create_page", { title: "Changed payload", idempotency_key: key }, 409);
const mutation = {
  page_id: page.page_id,
  base_heads: read.heads,
  idempotency_key: crypto.randomUUID(),
  operations: [
    { op: "replace_match", block_id: read.blocks[0].id, match_text: "fox", replacement: "otter" },
  ],
};
const edited = await tool(cookie, "patch_page", mutation);
const replay = await tool(cookie, "patch_page", mutation);
assert.deepEqual(replay, edited, "Mutation replay must return the same receipt");
await tool(cookie, "patch_page", { ...mutation, idempotency_key: crypto.randomUUID() }, 409);
const current = await tool(cookie, "read_page", { page_id: page.page_id });
assert.equal(current.blocks[0].markdown, "The **otter** crossed the garden.");
const comment = await tool(cookie, "manage_page_comment", {
  page_id: page.page_id,
  base_heads: current.heads,
  idempotency_key: crypto.randomUUID(),
  action: "add",
  block_id: current.blocks[0].id,
  selected_text: "otter",
  body: "A passage comment from the HTTP API.",
});
assert.ok(comment.result.thread_id);
const mcp = await fetch(`${origin}/mcp`, {
  method: "POST",
  headers: {
    Origin: origin,
    Cookie: cookie,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "resources/read",
    params: { uri: `${origin}/?page=${page.page_id}` },
  }),
});
const mcpResult = await mcp.json();
assert.ok(mcpResult.result?.contents, JSON.stringify(mcpResult));
assert.match(mcpResult.result.contents[0].text, /passage comment/);
const beforeInsert = JSON.parse(mcpResult.result.contents[0].text);
await tool(cookie, "edit_page", {
  page_id: page.page_id,
  base_heads: beforeInsert.heads,
  idempotency_key: crypto.randomUUID(),
  operations: [{ op: "insert_markdown", after_block_id: null, markdown: "A second block." }],
});
const beforeMove = await tool(cookie, "read_page", { page_id: page.page_id });
assert.equal(beforeMove.blocks[0].markdown, "A second block.");
const moveResponse = await fetch(origin + "/mcp", {
  method: "POST",
  headers: {
    Origin: origin,
    Cookie: cookie,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "edit_page",
      arguments: {
        page_id: page.page_id,
        base_heads: beforeMove.heads,
        idempotency_key: crypto.randomUUID(),
        operations: [{ op: "move_block", block_id: current.blocks[0].id, after_block_id: null }],
      },
    },
  }),
});
const movedResult = await moveResponse.json();
assert.equal(movedResult.result?.isError, undefined, JSON.stringify(movedResult));
const moved = await tool(cookie, "read_page", { page_id: page.page_id });
assert.equal(moved.blocks[0].id, current.blocks[0].id);
assert.equal(moved.blocks[0].markdown, "The **otter** crossed the garden.");
assert.equal(moved.blocks[1].markdown, "A second block.");
assert.equal(moved.comments[0].selectionContext.status, "attached");

console.log(
  JSON.stringify({
    idempotentCreate: true,
    idempotentEdit: true,
    staleEditRejected: true,
    anchoredComment: true,
    mcpRead: true,
    mcpBlockMovePreservesComment: true,
  }),
);
const disposable = await tool(cookie, "create_page", {
  title: "Delete guard fixture",
  markdown: "Keep newer content",
  idempotency_key: crypto.randomUUID(),
});
const initial = await tool(cookie, "read_page", { page_id: disposable.page_id });
await tool(cookie, "edit_page", {
  page_id: disposable.page_id,
  base_heads: initial.heads,
  idempotency_key: crypto.randomUUID(),
  operations: [{ op: "set_title", title: "Newer content" }],
});
await tool(
  cookie,
  "delete_page",
  { page_id: disposable.page_id, base_heads: initial.heads, idempotency_key: crypto.randomUUID() },
  409,
);
const surviving = await tool(cookie, "read_page", { page_id: disposable.page_id });
assert.equal(surviving.title, "Newer content");
const deletion = {
  page_id: disposable.page_id,
  base_heads: surviving.heads,
  idempotency_key: crypto.randomUUID(),
};
const deleted = await tool(cookie, "delete_page", deletion);
assert.equal(deleted.state, "trashed");
assert.deepEqual(await tool(cookie, "delete_page", deletion), deleted);
const trashed = await tool(cookie, "read_page", { page_id: disposable.page_id });
assert.equal(trashed.trash.state, "trashed");
const restored = await tool(cookie, "restore_page", {
  page_id: disposable.page_id,
  idempotency_key: crypto.randomUUID(),
});
assert.equal(restored.state, "active");
const restoredRead = await tool(cookie, "read_page", { page_id: disposable.page_id });
await tool(cookie, "delete_page", {
  page_id: disposable.page_id,
  base_heads: restoredRead.heads,
  idempotency_key: crypto.randomUUID(),
});
await purgeTrashedFixture(
  (operation, args) => tool(cookie, operation, args),
  disposable.page_id,
  () => ({ idempotency_key: crypto.randomUUID() }),
);
await tool(cookie, "read_page", { page_id: disposable.page_id }, 404);
console.log(
  JSON.stringify({
    staleDeleteRejected: true,
    idempotentDelete: true,
    restored: true,
    purged: true,
  }),
);
