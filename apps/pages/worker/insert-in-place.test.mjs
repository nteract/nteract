// In-place inserts through the whole host: edit_page with a top-level node's
// id as after_node_id, over MCP, with the revision rules every insert has.
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./index.mjs";
import { fixture, pageId } from "./trash-fixture.mjs";
import { ADDRESS_PATTERN } from "../model/addresses.mjs";

const origin = "https://pages.invalid";
let nonces = 0;
const nonce = () => `in-place-${String(++nonces).padStart(4, "0")}-${crypto.randomUUID()}`;

async function session(t) {
  const f = await fixture(t, { env: { NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin } });
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
    return result.structuredContent;
  };
  return { f, call };
}

test("an insert after a node lands in its block; receipts chain the next request", async (t) => {
  const { f, call } = await session(t);
  const read = await call("read_page", {});
  const [block] = read.blocks;
  const written = await call("edit_page", {
    revision: read.revision,
    nonce: nonce(),
    operations: [
      { op: "replace_block_markdown", node_id: block.node_id, markdown: "First.\n\nLast." },
    ],
  });
  const [first, last] = written.result.edits[0].nodes;

  // One batch: two inserts after different nodes, applied in order.
  const batch = await call("edit_page", {
    revision: written.revision,
    nonce: nonce(),
    operations: [
      { op: "insert_markdown", markdown: "## Middle", after_node_id: first },
      { op: "insert_markdown", markdown: "Tail.", after_node_id: last },
    ],
  });
  for (const edit of batch.result.edits) {
    assert.deepEqual(Object.keys(edit).sort(), ["block", "nodes", "op"]);
    assert.equal(edit.block, block.node_id);
    for (const id of edit.nodes) assert.match(id, ADDRESS_PATTERN);
  }
  const middle = batch.result.edits[0].nodes[0];
  // The next request anchors on a node the last one inserted, with no read.
  const chained = await call("edit_page", {
    revision: batch.revision,
    nonce: nonce(),
    operations: [{ op: "insert_markdown", markdown: "Under the heading.", after_node_id: middle }],
  });
  const under = chained.result.edits[0].nodes[0];
  const after = await call("read_page", {});
  assert.equal(after.blocks.length, 1);
  assert.equal(
    after.blocks[0].markdown,
    "First.\n\n## Middle\n\nUnder the heading.\n\nLast.\n\nTail.",
  );
  const { outline } = await call("read_page", { include_content: false });
  assert.deepEqual(
    outline.entries.map((entry) => entry.node_id),
    [first, middle, under, last, batch.result.edits[1].nodes[0]],
  );
  const nodes = await call("read_page", { node_ids: [middle, under] });
  assert.deepEqual(
    nodes.nodes.map((node) => [node.node_id, node.block, node.type]),
    [
      [middle, block.node_id, "heading"],
      [under, block.node_id, "paragraph"],
    ],
  );
  // The block's key never reaches a result.
  const keys = Object.keys(f.page.handle.doc().blocks);
  for (const key of keys) assert.ok(!JSON.stringify([batch, chained]).includes(key));
});

test("an insert after a node needs the current revision, and target scope refuses it", async (t) => {
  const { call } = await session(t);
  const read = await call("read_page", { include_content: false });
  const node = read.outline.entries[0].node_id;
  const moved = await call("edit_page", {
    revision: read.revision,
    nonce: nonce(),
    operations: [{ op: "insert_markdown", markdown: "One.", after_node_id: node }],
  });
  // A revision the Page has moved past is refused, as for every insert.
  const stale = await call(
    "edit_page",
    {
      revision: read.revision,
      nonce: nonce(),
      operations: [{ op: "insert_markdown", markdown: "Two.", after_node_id: node }],
    },
    { ok: false },
  );
  assert.equal(stale.code, "stale_revision", JSON.stringify(stale));
  const scoped = await call(
    "edit_page",
    {
      revision: moved.revision,
      nonce: nonce(),
      conflict_scope: "target",
      operations: [{ op: "insert_markdown", markdown: "Two.", after_node_id: node }],
    },
    { ok: false },
  );
  assert.equal(scoped.code, "invalid_edit_selector");
  // A join refusal leaves the Page as it was.
  const listed = await call("edit_page", {
    revision: moved.revision,
    nonce: nonce(),
    operations: [{ op: "insert_markdown", markdown: "- a", after_node_id: node }],
  });
  const list = listed.result.edits[0].nodes[0];
  const joined = await call(
    "edit_page",
    {
      revision: listed.revision,
      nonce: nonce(),
      operations: [
        { op: "set_title", title: "Changed" },
        { op: "insert_markdown", markdown: "- b", after_node_id: list },
      ],
    },
    { ok: false },
  );
  assert.equal(joined.code, "nodes_would_join");
  const after = await call("read_page", { include_content: false });
  assert.equal(after.revision, listed.revision);
  assert.notEqual(after.title, "Changed");
});
