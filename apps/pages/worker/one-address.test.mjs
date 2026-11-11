// One address for agents: every block, node and image an agent reads or
// names is `node_id`, the id of the Automerge op that made it. No tool
// schema, result or refusal carries a block's key or an older address name,
// across a scripted MCP session through the whole host.
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./index.mjs";
import { tools } from "../mcp.mjs";
import { fixture, pageId } from "./trash-fixture.mjs";
import { ADDRESS_PATTERN } from "../model/addresses.mjs";

const OLD_KEYS = new Set([
  "block_id",
  "after_block_id",
  "block_ids",
  "node_index",
  "node_range",
  "image_id",
  "before_node_index",
  "blockId",
]);
// The only keys that carry an address, and what each holds.
const ADDRESS_KEYS = new Set(["node_id", "after_node_id", "before_node_id", "block", "image"]);
const ADDRESS_LISTS = new Set(["node_ids", "nodes"]);

/** Every key under `value`, with its path, depth first. */
function* keys(value, path = []) {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* keys(item, [...path, index]);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    yield [key, item, [...path, key]];
    yield* keys(item, [...path, key]);
  }
}

/** Assert `value` (a schema, result or refusal) names nothing by an old key
 * or a block's key, and that every address key holds an id. */
function assertAgentShape(value, keysOfBlocks, label) {
  const text = JSON.stringify(value);
  for (const key of keysOfBlocks) assert.ok(!text.includes(key), `${label} names block key ${key}`);
  for (const [key, item, path] of keys(value)) {
    assert.ok(!OLD_KEYS.has(key), `${label} has ${path.join(".")}`);
    if (ADDRESS_KEYS.has(key) && typeof item === "string")
      assert.match(item, ADDRESS_PATTERN, `${label} ${path.join(".")}`);
    if (ADDRESS_LISTS.has(key) && Array.isArray(item) && item.every((id) => typeof id !== "object"))
      for (const id of item)
        if (id !== null) assert.match(id, ADDRESS_PATTERN, `${label} ${path.join(".")}`);
  }
}

test("no tool schema takes or describes an old address name", () => {
  const forbidden = /\b(block_id|after_block_id|block_ids|node_index|node_range|image_id)\b/;
  for (const tool of tools) {
    for (const [key, , path] of keys(tool.inputSchema))
      assert.ok(!OLD_KEYS.has(key), `${tool.name} ${path.join(".")}`);
    assert.doesNotMatch(JSON.stringify(tool), forbidden, tool.name);
  }
});

const origin = "https://pages.invalid";
let nonces = 0;
const nonce = () => `address-${String(++nonces).padStart(4, "0")}-${crypto.randomUUID()}`;

test("a scripted session names everything by node_id, and nothing by a block's key", async (t) => {
  const f = await fixture(t, { env: { NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin } });
  const seen = [];
  let id = 0;
  const call = async (name, args, { ok = true } = {}) => {
    const response = await worker.fetch(
      new Request(`${origin}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${f.tokens.owner}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++id,
          method: "tools/call",
          params: { name, arguments: { page_id: pageId, ...args } },
        }),
      }),
      f.env,
    );
    assert.equal(response.status, 200, name);
    const { result } = await response.json();
    assert.equal(!result.isError, ok, `${name}: ${JSON.stringify(result.structuredContent)}`);
    seen.push([name, result.structuredContent]);
    return result.structuredContent;
  };

  let read = await call("read_page", { comments: "all" });
  const [first] = read.blocks;
  assert.match(first.node_id, ADDRESS_PATTERN);
  const { outline } = await call("read_page", { include_content: false });
  assert.equal(outline.entries[0].block, first.node_id);
  const [paragraph] = outline.entries.map((entry) => entry.node_id);

  // Inserts teach their ids; the next request uses them with no read.
  const inserted = await call("edit_page", {
    revision: read.revision,
    nonce: nonce(),
    operations: [
      {
        op: "insert_markdown",
        markdown: "## Plan\n\nShip it on Friday.",
        after_node_id: first.node_id,
      },
      { op: "replace_match", node_id: paragraph, match_text: "Friday", replacement: "Monday" },
    ],
  });
  const [added, replaced] = inserted.result.edits;
  assert.deepEqual(Object.keys(added).sort(), ["node_id", "nodes", "op"]);
  assert.deepEqual(replaced, { op: "replace_match", node_id: paragraph, matched: 1 });
  await call("edit_page", {
    revision: inserted.revision,
    nonce: nonce(),
    operations: [
      {
        op: "set_node",
        node_id: added.nodes[1],
        match_text: "Ship",
        type: "heading",
        attrs: { level: 3 },
      },
      { op: "move_block", node_id: added.node_id, after_node_id: null },
    ],
  });
  read = await call("read_page", { node_ids: [added.nodes[1], first.node_id] });
  assert.deepEqual(
    read.nodes.map((node) => [node.node_id, node.block, node.type]),
    [[added.nodes[1], added.node_id, "heading"]],
  );
  assert.deepEqual(
    read.blocks.map((block) => block.node_id),
    [first.node_id],
  );

  // Refusals name ids too.
  const wrongKind = await call(
    "edit_page",
    {
      revision: read.revision,
      nonce: nonce(),
      operations: [{ op: "delete_block", node_id: added.nodes[0] }],
    },
    { ok: false },
  );
  assert.equal(wrongKind.code, "wrong_address_kind");
  assert.match(wrongKind.error, /^This id names a heading; delete_node removes it/);
  // The node was retyped after the revision this edit names.
  const conflict = await call(
    "edit_page",
    {
      revision: inserted.revision,
      nonce: nonce(),
      conflict_scope: "target",
      operations: [
        { op: "replace_match", node_id: added.nodes[1], match_text: "Ship", replacement: "Send" },
      ],
    },
    { ok: false },
  );
  assert.equal(conflict.code, "edit_conflict");
  assert.equal(conflict.conflicts[0].node_id, added.nodes[1]);

  // Comments, presence and progress name the block by its id.
  const comment = await call("manage_page_comment", {
    nonce: nonce(),
    action: "add",
    node_id: added.node_id,
    selected_text: "Ship",
    revision: read.revision,
    body: "On a node's text",
  });
  const listed = await call("list_page_comments", { node_id: added.node_id });
  assert.deepEqual(
    listed.comments.map((thread) => [thread.id, thread.node_id]),
    [[comment.result.thread_id, added.node_id]],
  );
  assert.deepEqual(Object.keys(listed.comments[0].selectionContext.start), ["offsetUtf16"]);
  const byNode = await call("list_page_comments", { node_id: added.nodes[1] }, { ok: false });
  assert.equal(byNode.code, "wrong_address_kind");
  const progress = await call("report_page_progress", {
    message: "Reviewing the plan",
    revision: read.revision,
    targets: [{ node_id: added.node_id, match_text: "Plan" }],
  });
  assert.equal(progress.targets[0].node_id, added.node_id);
  const presence = await call("read_page_presence", {});
  assert.equal(presence.progress[0].targets[0].node_id, added.node_id);
  await call("read_page_changes", { since_revision: inserted.revision, comments: "all" });
  await call("read_page", {});

  const blockKeys = Object.keys(f.page.handle.doc().blocks);
  assert.ok(blockKeys.length >= 2);
  for (const [name, body] of seen) assertAgentShape(body, blockKeys, name);
});
