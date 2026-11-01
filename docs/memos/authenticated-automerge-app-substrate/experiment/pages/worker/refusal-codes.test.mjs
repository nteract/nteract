import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { fixture, trashArgs } from "./trash-fixture.mjs";
import { proposeAccessUpdate } from "./access.mjs";

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
  // Past the diff budget with nothing unique to split on, replace_match refuses
  // with its own code rather than detach anchors on words it would keep.
  const tooLarge = await f.tool("owner", "edit_page", {
    base_heads: f.heads(),
    idempotency_key: "selector-too-large",
    operations: [
      { op: "replace_block_markdown", block_id: f.blockId, markdown: "w ".repeat(3000).trim() },
    ],
  });
  assert.equal(tooLarge.status, 200, JSON.stringify(tooLarge.body));
  const refusedLarge = await f.tool("owner", "patch_page", {
    base_heads: tooLarge.body.heads,
    idempotency_key: "selector-too-large-replace",
    operations: [
      {
        op: "replace_match",
        block_id: f.blockId,
        match_text: "w ".repeat(3000).trim(),
        replacement: "v ".repeat(3000).trim(),
      },
    ],
  });
  assert.equal(refusedLarge.status, 400);
  assert.equal(refusedLarge.body.code, "replace_match_too_large");
  assert.deepEqual(f.heads(), tooLarge.body.heads, "nothing was written");
});

test("the host refuses every write to a Page stamped with a feature it lacks, and reads report the stamp", async (t) => {
  const plain = await fixture(t);
  // A new Page carries only the comments-doc stamp.
  const current = await plain.tool("owner", "read_page", { comments: "none" });
  assert.deepEqual(current.body.schema_features, ["comments-doc"]);
  const legacy = await plain.tool("owner", "read_page");
  assert.deepEqual(legacy.body.schema_features, ["comments-doc"]);

  const doc = A.change(A.load(A.save(plain.doc())), (draft) => {
    draft.schema = { features: ["comments-doc", "future-feature"] };
  });
  const f = await fixture(t, { auth: plain.auth, docBytes: A.save(doc) });
  A.free(doc);
  const read = await f.tool("owner", "read_page", { comments: "none" });
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.schema_features, ["comments-doc", "future-feature"]);
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

test("a receipt for edits the native gate refused answers schema_unsupported at once", async (t) => {
  const plain = await fixture(t);
  const doc = A.change(A.load(A.save(plain.doc())), (draft) => {
    draft.schema = { features: ["future-feature"] };
  });
  const f = await fixture(t, { auth: plain.auth, docBytes: A.save(doc) });
  A.free(doc);
  const missing = ["e".repeat(64)];
  for (const body of [{ heads: missing }, { heads: missing, schema_features: ["other"] }]) {
    const refused = await f.pageCall("owner", "/api/saved", body);
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.body, {
      error: "This Page uses features this version doesn't support. Reload to update.",
      code: "schema_unsupported",
    });
  }
  const malformed = await f.pageCall("owner", "/api/saved", {
    heads: missing,
    schema_features: ["Not An Id"],
  });
  assert.equal(malformed.status, 400);
});

test("a thread batch names unknown threads, refuses readers, and applies for editors", async (t) => {
  const f = await fixture(t);
  const [threadId] = Object.keys(f.commentsDoc().threads);
  const heads = f.heads();
  const unknown = await f.tool("owner", "manage_page_comment", {
    idempotency_key: "batch-unknown-thread",
    action: "resolve",
    thread_ids: [threadId, "no-such-thread"],
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, "invalid_comment_selector");
  assert.deepEqual(unknown.body.not_found_thread_ids, ["no-such-thread"]);
  const shape = await f.tool("owner", "manage_page_comment", {
    idempotency_key: "batch-both-fields",
    action: "resolve",
    thread_id: threadId,
    thread_ids: [threadId],
  });
  assert.equal(shape.status, 400);
  assert.equal(shape.body.code, "invalid_comment_selector");
  assert.equal(shape.body.not_found_thread_ids, undefined);

  // A viewer may read the thread but not change its status, alone or in a batch.
  const reader = "user:anaconda-fixture:stranger-user";
  const owner = { principal: f.owner, canWrite: true, expiresAt: Date.now() + 60_000 };
  f.setPage(
    f.build({
      ...f.page.metadata,
      acl: proposeAccessUpdate(f.page.metadata, owner, {
        principal: reader,
        role: "viewer",
        expected_revision: f.page.metadata.acl.revision,
      }).acl,
    }),
  );
  assert.equal((await f.tool("stranger", "list_page_comments")).status, 200);
  for (const args of [{ thread_id: threadId }, { thread_ids: [threadId] }]) {
    const denied = await f.tool("stranger", "manage_page_comment", {
      idempotency_key: `batch-reader-${Object.keys(args)[0]}`,
      action: "resolve",
      ...args,
    });
    assert.equal(denied.status, 403, Object.keys(args)[0]);
    assert.equal(denied.body.code, undefined, "uncoded 403 becomes MCP access_denied");
  }
  assert.deepEqual(f.heads(), heads, "nothing is written");

  // An editor resolves a thread someone else opened, in one batch and one receipt.
  const resolved = await f.tool("member", "manage_page_comment", {
    idempotency_key: "batch-editor-resolve",
    action: "resolve",
    thread_ids: [threadId],
  });
  assert.equal(resolved.status, 200);
  assert.deepEqual(resolved.body.result, {
    threads: [{ thread_id: threadId, outcome: "resolved" }],
  });
  // The Page is untouched: its heads hold, and the receipt names the
  // comments document's new revision.
  assert.deepEqual(resolved.body.heads, heads);
  assert.deepEqual(f.heads(), heads);
  assert.deepEqual(resolved.body.comment_heads, f.commentHeads());
  assert.equal(f.commentsDoc().threads[threadId].status.value, "resolved");
});
