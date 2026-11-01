import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { fixture, trashArgs } from "./trash-fixture.mjs";

const staleHeads = ["0".repeat(64)];

test("guarded writes refuse a stale or malformed revision with a code, not just a message", async (t) => {
  const f = await fixture(t);
  for (const [operation, args] of [
    ["edit_page", { operations: [{ op: "set_title", title: "Changed" }] }],
    [
      "patch_page",
      {
        operations: [
          { op: "replace_match", block_id: f.blockId, match_text: "Friday", replacement: "Monday" },
        ],
      },
    ],
  ]) {
    const stale = await f.tool("owner", operation, {
      ...args,
      base_heads: staleHeads,
      idempotency_key: `stale-${operation}`,
    });
    assert.equal(stale.status, 409, operation);
    assert.deepEqual(stale.body, {
      error: "Page changed; read_page again before editing",
      code: "stale_heads",
    });
    const missing = await f.tool("owner", operation, {
      ...args,
      idempotency_key: `missing-${operation}`,
    });
    assert.equal(missing.status, 400, operation);
    assert.equal(missing.body.code, "invalid_edit_selector", operation);
  }
  const badKey = await f.tool("owner", "edit_page", {
    base_heads: f.heads(),
    idempotency_key: "short",
    operations: [{ op: "set_title", title: "Changed" }],
  });
  assert.equal(badKey.status, 400);
  assert.equal(badKey.body.code, "invalid_idempotency_key");

  const trash = await f.catalogCall("owner", "delete_page", {
    ...trashArgs(f, "stale-trash"),
    base_heads: staleHeads,
  });
  assert.equal(trash.status, 409);
  assert.equal(trash.body.code, "stale_heads");
});

test("an edit batch that cannot apply names the selector, and nothing is written", async (t) => {
  const f = await fixture(t);
  const heads = f.heads();
  for (const [match_text, count] of [
    ["Tuesday", 0],
    ["i", 2],
  ]) {
    const refused = await f.tool("owner", "patch_page", {
      base_heads: heads,
      idempotency_key: `selector-${count}-matches`,
      operations: [{ op: "replace_match", block_id: f.blockId, match_text, replacement: "x" }],
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "invalid_edit_selector");
    assert.match(refused.body.error, new RegExp(`found ${count} matches`));
  }
  const unknownBlock = await f.tool("owner", "edit_page", {
    base_heads: heads,
    idempotency_key: "selector-unknown-block",
    operations: [{ op: "delete_block", block_id: "no-such-block" }],
  });
  assert.equal(unknownBlock.status, 400);
  assert.equal(unknownBlock.body.code, "invalid_edit_selector");
  const comment = await f.tool("owner", "manage_page_comment", {
    base_heads: heads,
    idempotency_key: "comment-unknown-thread",
    action: "reply",
    thread_id: "no-such-thread",
    body: "Hello",
  });
  assert.equal(comment.status, 400);
  assert.equal(comment.body.code, "invalid_comment_selector");
  assert.deepEqual(f.heads(), heads);
});

test("the host refuses every write to a Page stamped with a feature it lacks, and reads report the stamp", async (t) => {
  const plain = await fixture(t);
  const unstamped = await plain.tool("owner", "read_page", { comments: "none" });
  assert.deepEqual(unstamped.body.schema_features, []);
  const legacy = await plain.tool("owner", "read_page");
  assert.deepEqual(legacy.body.schema_features, []);

  const doc = A.change(A.load(A.save(plain.doc())), (draft) => {
    draft.schema = { features: ["future-feature"] };
  });
  const f = await fixture(t, { auth: plain.auth, docBytes: A.save(doc) });
  A.free(doc);
  const read = await f.tool("owner", "read_page", { comments: "none" });
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.schema_features, ["future-feature"]);
  const heads = f.heads();
  for (const [operation, args] of [
    ["edit_page", { operations: [{ op: "set_title", title: "Changed" }] }],
    [
      "patch_page",
      {
        operations: [
          { op: "replace_match", block_id: f.blockId, match_text: "Friday", replacement: "Monday" },
        ],
      },
    ],
    [
      "patch_page",
      {
        conflict_scope: "target",
        operations: [
          { op: "format_match", block_id: f.blockId, match_text: "Friday", add: { strong: true } },
        ],
      },
    ],
    ["manage_page_comment", { action: "add", block_id: f.blockId, body: "Hello" }],
  ]) {
    const refused = await f.tool("owner", operation, {
      ...args,
      base_heads: heads,
      idempotency_key: `schema-${operation}-${args.conflict_scope ?? "page"}`,
    });
    assert.equal(refused.status, 409, operation);
    assert.equal(refused.body.code, "unsupported_schema_feature", operation);
    assert.deepEqual(refused.body.unsupported_features, ["future-feature"], operation);
    assert.match(refused.body.error, /future-feature/);
  }
  assert.deepEqual(f.heads(), heads, "nothing is written");
});
