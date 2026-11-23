// move_nodes through the whole host: a run of nodes moved over MCP, with the
// comment threads on the moved text re-anchored in the comments document.
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./index.mjs";
import { fixture, pageId } from "./trash-fixture.mjs";

const origin = "https://pages.invalid";
let nonces = 0;
const nonce = () => `move-${String(++nonces).padStart(4, "0")}-${crypto.randomUUID()}`;

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

test("a section move keeps its comments attached; a retry replays the receipt", async (t) => {
  const { call } = await session(t);
  const read = await call("read_page", {});
  const [block] = read.blocks;
  const written = await call("edit_page", {
    revision: read.revision,
    nonce: nonce(),
    operations: [
      {
        op: "replace_block_markdown",
        node_id: block.node_id,
        markdown: "## One\n\nFirst body.\n\n## Two\n\nSecond body.",
      },
    ],
  });
  const [one, firstBody, two, secondBody] = written.result.edits[0].nodes;
  const commented = await call("manage_page_comment", {
    nonce: nonce(),
    action: "add",
    node_id: block.node_id,
    selected_text: "Second body",
    revision: written.revision,
    body: "Check this",
  });
  const request = {
    revision: written.revision,
    nonce: nonce(),
    operations: [
      { op: "move_nodes", node_id: two, through_node_id: secondBody, after_node_id: null },
    ],
  };
  const moved = await call("edit_page", request);
  const [edit] = moved.result.edits;
  assert.equal(edit.op, "move_nodes");
  assert.equal(edit.block, block.node_id);
  assert.equal(edit.nodes.length, 2);
  assert.equal(edit.comments_moved, 1);
  assert.deepEqual(moved.comments, {
    reanchored: [commented.result.thread_id],
    detached: [],
  });
  assert.match(moved.comment_revision, /^c\d+$/);

  const after = await call("read_page", {});
  assert.equal(after.blocks[0].markdown, "## Two\n\nSecond body.\n\n## One\n\nFirst body.");
  const { outline } = await call("read_page", { include_content: false });
  assert.deepEqual(
    outline.entries.map((entry) => entry.node_id),
    [...edit.nodes, one, firstBody],
  );
  const listed = await call("list_page_comments", {});
  const thread = listed.comments.find((entry) => entry.id === commented.result.thread_id);
  assert.equal(thread.selectionContext.status, "attached");
  assert.equal(thread.selectionContext.text, "Second body");

  // An exact retry returns the Page receipt and writes nothing again.
  const retried = await call("edit_page", request);
  assert.deepEqual(retried.result, moved.result);
  assert.equal(retried.revision, moved.revision);
  const again = await call("read_page", {});
  assert.equal(again.blocks[0].markdown, after.blocks[0].markdown);
});

test("move_nodes needs the current revision and refuses target scope", async (t) => {
  const { call } = await session(t);
  const read = await call("read_page", {});
  const [block] = read.blocks;
  const written = await call("edit_page", {
    revision: read.revision,
    nonce: nonce(),
    operations: [{ op: "replace_block_markdown", node_id: block.node_id, markdown: "A\n\nB" }],
  });
  const [a, b] = written.result.edits[0].nodes;
  const stale = await call(
    "edit_page",
    {
      revision: read.revision,
      nonce: nonce(),
      operations: [{ op: "move_nodes", node_id: b, after_node_id: null }],
    },
    { ok: false },
  );
  assert.equal(stale.code, "stale_revision");
  const scoped = await call(
    "edit_page",
    {
      revision: written.revision,
      nonce: nonce(),
      conflict_scope: "target",
      operations: [{ op: "move_nodes", node_id: b, after_node_id: null }],
    },
    { ok: false },
  );
  assert.equal(scoped.code, "invalid_edit_selector");
  // A move that changes nothing has its own code, outside the catch-all.
  const noop = await call(
    "edit_page",
    {
      revision: written.revision,
      nonce: nonce(),
      operations: [{ op: "move_nodes", node_id: b, after_node_id: a }],
    },
    { ok: false },
  );
  assert.equal(noop.code, "invalid_move");
});
